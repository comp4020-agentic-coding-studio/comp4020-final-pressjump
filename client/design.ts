// The design editor. The server is the authority: this file shows what the
// server says the design holds, plus the edits it has sent and not yet had
// answered, and puts a feature back (and says why) when an edit is refused.

import * as THREE from "three";
import { evaluate, height, worldGeometry, type Evaluated } from "../shared/evaluate.ts";
import {
  APPEARANCES,
  KIND_NAMES,
  PARAMS,
  PARAM_LABELS,
  checkReferences,
  featureOf,
  isBodyFeature,
  round,
  sameFeature,
  usedBy,
  validateFeature,
  type Body,
  type BodyKind,
  type CombineF,
  type Feature,
  type Profile,
  type Stored,
  type Vec3,
} from "../shared/model.ts";
import { cleanName, type ClientMessage, type Cursor, type Design, type Person, type ServerMessage } from "../shared/protocol.ts";
import { Viewport, type Display } from "./viewport.ts";

const designId = location.pathname.split("/")[2] ?? "";
const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;

const panel = $<HTMLElement>("panel");
const banner = $<HTMLElement>("banner");
const offline = $<HTMLElement>("offline");
const connLabel = $<HTMLElement>("conn");
const message = $<HTMLElement>("message");
const nameInput = $<HTMLInputElement>("design-name");
const peopleList = $<HTMLUListElement>("people");
const meButton = $<HTMLButtonElement>("me");
const tree = $<HTMLElement>("tree");
const track = $<HTMLOListElement>("track");
const labels = $<HTMLElement>("labels");
const undoButton = $<HTMLButtonElement>("undo");
const redoButton = $<HTMLButtonElement>("redo");
const dialog = $<HTMLDialogElement>("name-dialog");
const dialogInput = $<HTMLInputElement>("name-input");
const gridSelect = $<HTMLSelectElement>("grid");
const displaySelect = $<HTMLSelectElement>("display");

const vp = new Viewport($("viewport"), $("cube"), labels);

// ---------- who you are ----------
// A random token in this browser is the whole of identity: a second browser is
// a second person, and nobody signs up.

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // identity just will not outlive the tab
  }
}

function token(): string {
  let t = stored("bench.token");
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("bench.token", t);
  }
  return t;
}

function newId(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/[+/=]/g, "x");
}

// ---------- state ----------

let me: Person | null = null;
let design: Design | null = null;
let live = false;
let started = false;
const features = new Map<string, Stored>();
// features this client has changed and the server has not yet answered for
const optimistic = new Set<string>();
const online = new Map<string, Person>();
const known = new Map<string, Person>();
let holds: Record<string, string> = {};
// insertion order matters: the first body selected is a combine's target
const selection = new Set<string>();
const remote = new Map<string, Cursor>();
// what this client shows in place of stored features mid-drag
const overrides = new Map<string, Body>();
// hidden is a view choice, so it is yours alone and never sent
const hidden = new Set<string>();
// looking back along the timeline: show features up to this seq; null = all
let marker: number | null = null;
let following: string | null = null;
let grid = Number(stored("bench.grid3d") ?? 10);
gridSelect.value = String(grid);
if (gridSelect.value !== String(grid)) grid = 10;

type Change = { id: string; before: Feature | null; after: Feature | null };
const undoStack: Change[][] = [];
const redoStack: Change[][] = [];

type Mode =
  | { kind: "select" }
  | { kind: "place"; body: BodyKind }
  | { kind: "measure"; a: THREE.Vector3 | null; b: THREE.Vector3 | null }
  | { kind: "sketch"; stage: "plane" }
  | { kind: "sketch"; stage: "draw"; plane: SketchPlane; tool: SketchTool; pts: [number, number][]; cursor: [number, number] | null }
  | { kind: "extrude"; plane: SketchPlane; profile: Profile; depth: number; op: "new" | "join" | "cut"; name: string };

type SketchTool = "line" | "rect" | "circle";
type SketchPlane = { origin: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3; body: string | null };

let mode: Mode = { kind: "select" };
let moving = false;
let gizmoMode: "translate" | "rotate" = "translate";
let evaluated: Evaluated = { solids: [], consumed: new Map(), failed: new Map() };

// ---------- messages to the person ----------

let messageTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, warn = false): void {
  message.textContent = text;
  message.classList.toggle("warn", warn);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (message.textContent = ""), 8000);
}

function nameOf(id: string | undefined): string {
  if (!id) return "Someone";
  if (me && id === me.id) return "You";
  return known.get(id)?.name ?? "Someone";
}

function colourOf(id: string): string {
  return known.get(id)?.colour ?? "#888888";
}

function heldByOther(id: string): string | null {
  const h = holds[id];
  return h && h !== me?.id ? h : null;
}

function looking(): boolean {
  return marker !== null;
}

function canEdit(): boolean {
  if (!live) {
    say("Reconnecting; editing waits until the design is live.", true);
    return false;
  }
  if (looking()) {
    say("You are looking back along the timeline. Go to the end to edit.", true);
    return false;
  }
  return true;
}

// ---------- the connection ----------

let ws: WebSocket | null = null;
let retry = 500;

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?design=${encodeURIComponent(designId)}`);
  ws.addEventListener("open", () => send({ t: "hello", token: token(), name: stored("bench.name") ?? "" }));
  ws.addEventListener("message", (e) => {
    try {
      receive(JSON.parse(String(e.data)) as ServerMessage);
    } catch (err) {
      console.error(err);
    }
  });
  ws.addEventListener("close", () => {
    ws = null;
    setLive(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5000);
  });
}

function setLive(on: boolean): void {
  live = on;
  offline.hidden = on || !started;
  connLabel.textContent = on ? "Live" : "Reconnecting…";
  connLabel.classList.toggle("live", on);
  if (!on) {
    cancelMode();
    remote.clear();
    online.clear();
    renderPeople();
  }
  updateButtons();
  refresh();
}

function learn(p: Person): void {
  known.set(p.id, p);
}

function receive(msg: ServerMessage): void {
  switch (msg.t) {
    case "welcome": {
      me = msg.you;
      design = msg.design;
      retry = 500;
      features.clear();
      optimistic.clear();
      overrides.clear();
      for (const f of msg.features) features.set(f.id, f);
      msg.authors.forEach(learn);
      online.clear();
      for (const p of msg.people) {
        online.set(p.id, p);
        learn(p);
      }
      holds = msg.holds;
      for (const id of [...selection]) if (!features.has(id)) selection.delete(id);
      showDesign();
      renderMe();
      renderPeople();
      setLive(true);
      if (!started) {
        started = true;
        rebuild();
        vp.home();
        if (!stored("bench.name")) askName();
      }
      sendHold(true);
      refresh();
      return;
    }
    case "put": {
      const local = features.get(msg.feature.id);
      // an answer to an older edit of ours, overtaken by a newer one already
      // showing here: keep the newer one until its own answer comes
      if (local && optimistic.has(local.id) && msg.feature.v < local.v) return;
      if (!local || msg.feature.v >= local.v) optimistic.delete(msg.feature.id);
      features.set(msg.feature.id, msg.feature);
      refresh();
      return;
    }
    case "del": {
      features.delete(msg.id);
      optimistic.delete(msg.id);
      overrides.delete(msg.id);
      if (selection.delete(msg.id)) {
        if (msg.by !== me?.id) say(`${nameOf(msg.by)} deleted something you had selected.`, true);
        sendHold();
      }
      refresh();
      return;
    }
    case "people": {
      online.clear();
      for (const p of msg.people) {
        online.set(p.id, p);
        learn(p);
      }
      if (me) me = online.get(me.id) ?? me;
      for (const id of remote.keys()) if (!online.has(id)) remote.delete(id);
      if (following && !online.has(following)) stopFollowing();
      renderPeople();
      renderMe();
      refresh();
      return;
    }
    case "holds": {
      holds = msg.holds;
      let lost = "";
      for (const id of [...selection]) {
        const holder = heldByOther(id);
        if (holder) {
          selection.delete(id);
          lost = holder;
        }
      }
      if (lost) {
        endDrag(false);
        say(`${nameOf(lost)} picked that up first.`, true);
      }
      refresh();
      return;
    }
    case "cursors": {
      for (const c of msg.cursors) {
        if (c.id === me?.id) continue;
        remote.set(c.id, c);
        if (c.id === following && c.cam) vp.flyTo(c.cam, 120);
      }
      for (const id of msg.gone) remote.delete(id);
      drawRemote();
      return;
    }
    case "design": {
      design = msg.design;
      showDesign();
      return;
    }
    case "reject": {
      optimistic.delete(msg.id);
      if (msg.feature) features.set(msg.id, msg.feature);
      else {
        features.delete(msg.id);
        selection.delete(msg.id);
      }
      say(`Not applied: ${msg.message}.`, true);
      refresh();
      return;
    }
    case "error":
      say(msg.message, true);
      return;
  }
}

function showDesign(): void {
  if (!design) return;
  if (document.activeElement !== nameInput) nameInput.value = design.name;
  document.title = `${design.name} · Bench`;
  $<HTMLAnchorElement>("export").href = `/d/${design.id}/export.stl`;
}

// ---------- edits ----------
// Each is shown at once, sent with the version it was made against, and kept
// as pending until the server answers. The optimistic version is the one the
// server will give it if accepted, so a second edit sent before the first is
// answered still names the right base.

function clean(f: Feature): Feature | null {
  const v = validateFeature(f);
  if (typeof v === "string") {
    say(`Not applied: ${v}.`, true);
    return null;
  }
  return v;
}

function commitAdd(f: Feature, id = newId()): Change | null {
  if (!me) return null;
  const v = clean(f);
  if (!v) return null;
  const problem = checkReferences(features, v);
  if (problem) {
    say(`Not applied: ${problem}.`, true);
    return null;
  }
  const seq = Math.max(0, ...[...features.values()].map((x) => x.seq)) + 1;
  features.set(id, { ...v, id, v: 1, by: me.id, seq } as Stored);
  optimistic.add(id);
  send({ t: "add", id, f: v });
  return { id, before: null, after: v };
}

function commitUpdate(id: string, f: Feature): Change | null {
  const current = features.get(id);
  if (!me || !current) return null;
  const v = clean(f);
  if (!v) return null;
  const before = featureOf(current);
  if (sameFeature(before, v)) return null;
  features.set(id, { ...v, id, v: current.v + 1, by: me.id, seq: current.seq } as Stored);
  optimistic.add(id);
  send({ t: "update", id, base: current.v, f: v });
  return { id, before, after: v };
}

function commitDelete(id: string): Change | null {
  const current = features.get(id);
  if (!me || !current) return null;
  features.delete(id);
  optimistic.add(id);
  send({ t: "delete", id, base: current.v });
  return { id, before: featureOf(current), after: null };
}

function record(changes: (Change | null)[]): void {
  const real = changes.filter((c): c is Change => c !== null);
  if (!real.length) return;
  undoStack.push(real);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  updateButtons();
  refresh();
}

// Undo only undoes your own change, and only if the feature is still exactly
// what you left it as. If someone has touched it since, it says so.
function replay(from: Change[][], to: Change[][], undo: boolean): void {
  if (!canEdit()) return;
  const changes = from[from.length - 1];
  if (!changes) return;
  const verb = undo ? "undo" : "redo";
  for (const c of changes) {
    const expected = undo ? c.after : c.before;
    const cur = features.get(c.id);
    const curF = cur ? featureOf(cur) : null;
    const matches = expected === null ? curF === null : curF !== null && sameFeature(curF, expected);
    if (!matches) {
      from.pop();
      updateButtons();
      return say(cur ? `Can't ${verb}: ${nameOf(cur.by)} changed ${cur.name} since.` : `Can't ${verb}: someone deleted it since.`, true);
    }
    const holder = heldByOther(c.id);
    if (holder) return say(`Can't ${verb} yet: ${nameOf(holder)} is holding ${cur?.name ?? "it"}.`, true);
  }
  from.pop();
  const ordered = undo ? [...changes].reverse() : changes;
  for (const c of ordered) {
    const target = undo ? c.before : c.after;
    if (target === null) commitDelete(c.id);
    else if (!features.has(c.id)) commitAdd(target, c.id);
    else commitUpdate(c.id, target);
  }
  to.push(changes);
  for (const c of changes) if (!features.has(c.id)) selection.delete(c.id);
  sendHold();
  updateButtons();
  refresh();
}

function updateButtons(): void {
  undoButton.disabled = !live || undoStack.length === 0;
  redoButton.disabled = !live || redoStack.length === 0;
}

let lastHold = "";
function sendHold(force = false): void {
  const ids = [...selection].sort();
  const key = ids.join(",");
  if (key === lastHold && !force) return;
  lastHold = key;
  send({ t: "hold", ids });
}

function select(ids: Iterable<string>): void {
  selection.clear();
  for (const id of ids) {
    if (!features.has(id)) continue;
    const holder = heldByOther(id);
    if (holder) {
      say(`${nameOf(holder)} is holding ${features.get(id)?.name}. It is yours to edit once they let go.`);
      continue;
    }
    selection.add(id);
  }
  if (!selection.size) setMoving(false);
  sendHold();
  refresh();
}

function toggle(id: string): void {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  select(next);
}

function deleteSelection(): void {
  if (!selection.size || !canEdit()) return;
  const ids = new Set(selection);
  // combines go first, so the bodies they use are free to go after them
  const ordered = [...ids].map((id) => features.get(id)).filter((f): f is Stored => !!f).sort((a, b) => b.seq - a.seq);
  for (const f of ordered) {
    const user = usedBy(features, f.id);
    if (user && !ids.has(user.id)) return say(`${user.name} uses ${f.name}. Delete ${user.name} first, or select both.`, true);
  }
  record(ordered.map((f) => commitDelete(f.id)));
  select([]);
}

// ---------- evaluation ----------

function current(): Stored[] {
  return [...features.values()].map((f) => {
    const o = overrides.get(f.id);
    return o ? ({ ...f, ...o } as Stored) : f;
  });
}

function rebuild(): void {
  evaluated = evaluate(current(), marker ?? Infinity);
  vp.setSolids(
    evaluated.solids,
    (id) => ({ selected: selection.has(id), holder: heldByOther(id), hidden: hidden.has(id) }),
    colourOf,
  );
  drawGhosts();
}

let refreshQueued = false;
function refresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    rebuild();
    renderTree();
    renderTimeline();
    renderPanel();
    renderBanner();
    syncGizmo();
    drawOverlay();
    drawRemote();
    updateButtons();
  });
}

// Bodies used up by a combine are invisible; selecting one shows it as a
// ghost so you can still see and move the cutter. Other people's drags show
// in their colour, and what you are about to make shows in blue.
function drawGhosts(): void {
  const items: { geometry: THREE.BufferGeometry; colour: string; opacity?: number }[] = [];
  for (const id of selection) {
    const f = features.get(id);
    if (f && isBodyFeature(f) && evaluated.consumed.has(id)) {
      items.push({ geometry: worldGeometry({ ...f, ...overrides.get(id) } as Body), colour: "#0696d7", opacity: 0.18 });
    }
  }
  for (const [pid, c] of remote) {
    for (const f of c.draft ?? []) {
      if (isBodyFeature(f)) items.push({ geometry: worldGeometry(f), colour: colourOf(pid), opacity: 0.2 });
    }
  }
  const preview = previewBody();
  if (preview) items.push({ geometry: worldGeometry(preview.body), colour: preview.cut ? "#d6312b" : "#0696d7", opacity: 0.3 });
  vp.setGhosts(items);
}

// ---------- placing primitives ----------

const DEFAULTS: Record<Exclude<BodyKind, "extrude">, Record<string, number>> = {
  box: { w: 20, h: 20, d: 20, fillet: 0 },
  cylinder: { r: 10, h: 20 },
  sphere: { r: 10 },
  cone: { r1: 10, r2: 0, h: 20 },
  torus: { R: 15, r: 4 },
};

let hoverHit: { point: THREE.Vector3; normal: THREE.Vector3; id: string | null } | null = null;

function snapValue(n: number): number {
  return round(Math.round(n / grid) * grid);
}

// How far a fresh, unrotated primitive reaches along a direction, so it can
// sit on the face it is placed on rather than sink into it.
function reach(kind: BodyKind, p: Record<string, number>, n: THREE.Vector3): number {
  const side = Math.hypot(n.x, n.z);
  switch (kind) {
    case "box":
      return (Math.abs(n.x) * p.w + Math.abs(n.y) * p.h + Math.abs(n.z) * p.d) / 2;
    case "cylinder":
      return (Math.abs(n.y) * p.h) / 2 + side * p.r;
    case "cone":
      return (Math.abs(n.y) * p.h) / 2 + side * Math.max(p.r1, p.r2);
    case "sphere":
      return p.r;
    case "torus":
      return Math.abs(n.y) * p.r + side * (p.R + p.r);
    default:
      return 0;
  }
}

function placement(kind: Exclude<BodyKind, "extrude">, hit: { point: THREE.Vector3; normal: THREE.Vector3 }): Body {
  const p = DEFAULTS[kind];
  const at = hit.point.clone();
  // snap across the face, not along its normal
  for (const axis of ["x", "y", "z"] as const) if (Math.abs(hit.normal[axis]) < 0.9) at[axis] = snapValue(at[axis]);
  const centre = at.add(hit.normal.clone().multiplyScalar(reach(kind, p, hit.normal)));
  const count = [...features.values()].filter((f) => f.kind === kind).length + 1;
  const body = {
    kind,
    name: `${KIND_NAMES[kind]} ${count}`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    colour: APPEARANCES[0][1],
    ...p,
  } as Body;
  // a body's origin is the middle of its base
  body.pos = [round(centre.x), round(centre.y - height(body) / 2), round(centre.z)];
  return body;
}

function previewBody(): { body: Body; cut: boolean } | null {
  if (mode.kind === "place" && hoverHit && mode.body !== "extrude") return { body: placement(mode.body, hoverHit), cut: false };
  if (mode.kind === "extrude") return { body: extrudeBody(mode), cut: mode.op === "cut" };
  return null;
}

// ---------- sketching ----------

function planeFrom(hit: { point: THREE.Vector3; normal: THREE.Vector3; id: string | null }): SketchPlane {
  const n = hit.normal.clone().normalize();
  // the sketch's x axis: whichever world axis is least like the normal
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)];
  const ref = axes.reduce((a, b) => (Math.abs(a.dot(n)) <= Math.abs(b.dot(n)) ? a : b));
  const u = ref.clone().sub(n.clone().multiplyScalar(ref.dot(n))).normalize();
  const v = n.clone().cross(u).normalize();
  const origin = hit.id ? hit.point.clone() : new THREE.Vector3(0, 0, 0);
  return { origin, u, v, n, body: hit.id };
}

function toPlane(plane: SketchPlane, p: THREE.Vector3): [number, number] {
  const d = p.clone().sub(plane.origin);
  return [snapValue(d.dot(plane.u)), snapValue(d.dot(plane.v))];
}

function fromPlane(plane: SketchPlane, [x, y]: [number, number]): THREE.Vector3 {
  return plane.origin.clone().add(plane.u.clone().multiplyScalar(x)).add(plane.v.clone().multiplyScalar(y));
}

function extrudeBody(m: Extract<Mode, { kind: "extrude" }>): Body {
  const basis = new THREE.Matrix4().makeBasis(m.plane.u, m.plane.v, m.plane.n);
  const e = new THREE.Euler().setFromRotationMatrix(basis, "XYZ");
  const deg = (r: number): number => round(THREE.MathUtils.radToDeg(r));
  return {
    kind: "extrude",
    name: m.name,
    pos: [round(m.plane.origin.x), round(m.plane.origin.y), round(m.plane.origin.z)],
    rot: [deg(e.x), deg(e.y), deg(e.z)],
    colour: (m.plane.body && (features.get(m.plane.body) as Body | undefined)?.colour) || APPEARANCES[0][1],
    profile: m.profile,
    depth: m.op === "cut" ? -Math.abs(m.depth) : m.depth,
  };
}

function profileFrom(tool: SketchTool, pts: [number, number][]): Profile | null {
  if (tool === "circle" && pts.length === 2) {
    const r = round(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
    return r > 0 ? { type: "circle", cx: pts[0][0], cy: pts[0][1], r } : null;
  }
  if (tool === "rect" && pts.length === 2) {
    const [[x1, y1], [x2, y2]] = pts;
    if (x1 === x2 || y1 === y2) return null;
    return { type: "poly", pts: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] };
  }
  if (tool === "line" && pts.length >= 3) return { type: "poly", pts };
  return null;
}

function startSketch(): void {
  if (!canEdit()) return;
  select([]);
  mode = { kind: "sketch", stage: "plane" };
  say("Click a face of a body, or the ground, to sketch on.");
  refresh();
}

function sketchClick(hit: { point: THREE.Vector3; normal: THREE.Vector3; id: string | null }, e: PointerEvent): void {
  if (mode.kind !== "sketch") return;
  if (mode.stage === "plane") {
    const plane = planeFrom(hit);
    mode = { kind: "sketch", stage: "draw", plane, tool: "rect", pts: [], cursor: null };
    // look straight at the sketch, the way you would at a drawing
    const t = plane.origin.clone();
    const dist = Math.max(150, vp.camera.position.distanceTo(vp.controls.target));
    const p = t.clone().add(plane.n.clone().multiplyScalar(dist));
    vp.flyTo({ p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] });
    say("Rectangle: click two corners. Line: click points, then click the first again. Circle: centre, then edge.");
    refresh();
    return;
  }
  const p = sketchPoint(mode.plane, e);
  if (!p) return;
  const pts = mode.pts;
  if (mode.tool === "line" && pts.length >= 3 && p[0] === pts[0][0] && p[1] === pts[0][1]) {
    return finishProfile(profileFrom("line", pts));
  }
  if (pts.length && p[0] === pts[pts.length - 1][0] && p[1] === pts[pts.length - 1][1]) return;
  pts.push(p);
  if (mode.tool !== "line" && pts.length === 2) return finishProfile(profileFrom(mode.tool, pts));
  refresh();
}

function sketchPoint(plane: SketchPlane, e: { clientX: number; clientY: number }): [number, number] | null {
  const hit = vp.pickPlane(e, new THREE.Plane().setFromNormalAndCoplanarPoint(plane.n, plane.origin));
  return hit ? toPlane(plane, hit) : null;
}

function finishProfile(profile: Profile | null): void {
  if (mode.kind !== "sketch" || mode.stage !== "draw") return;
  if (!profile) {
    mode.pts = [];
    say("That shape has no area. Start it again.", true);
    refresh();
    return;
  }
  const count = [...features.values()].filter((f) => f.kind === "extrude").length + 1;
  mode = { kind: "extrude", plane: mode.plane, profile, depth: 10, op: mode.plane.body ? "join" : "new", name: `Extrude ${count}` };
  vp.home();
  refresh();
}

function commitExtrude(): void {
  if (mode.kind !== "extrude" || !canEdit()) return;
  const body = extrudeBody(mode);
  const target = mode.plane.body;
  const op = mode.op;
  const made = commitAdd(body);
  if (!made) return;
  const changes: (Change | null)[] = [made];
  if (op !== "new" && target) {
    const targetName = features.get(target)?.name ?? "body";
    changes.push(commitAdd({ kind: "combine", name: `${op === "cut" ? "Cut" : "Join"} ${targetName}`, op, target, tools: [made.id] }));
  }
  record(changes);
  mode = { kind: "select" };
  select([made.id]);
}

// ---------- moving ----------

function setMoving(on: boolean): void {
  moving = on;
  document.querySelector('[data-cmd="move"]')?.setAttribute("aria-pressed", String(on));
  syncGizmo();
}

function movable(): Stored & Body | null {
  if (selection.size !== 1) return null;
  const f = features.get([...selection][0]);
  return f && isBodyFeature(f) ? f : null;
}

function syncGizmo(): void {
  const f = movable();
  if (!moving || !f || looking() || !live) {
    vp.gizmo.detach();
    vp.schedule();
    return;
  }
  if (dragging) return;
  const shown = overrides.get(f.id) ?? f;
  vp.proxy.position.set(...shown.pos);
  vp.proxy.rotation.set(...(shown.rot.map((a) => THREE.MathUtils.degToRad(a)) as Vec3), "XYZ");
  vp.gizmo.setMode(gizmoMode);
  vp.gizmo.setTranslationSnap(grid);
  vp.gizmo.attach(vp.proxy);
  vp.schedule();
}

let dragging: { id: string; original: Body } | null = null;

vp.gizmo.addEventListener("mouseDown", () => {
  const f = movable();
  if (!f || !canEdit()) return;
  dragging = { id: f.id, original: featureOf(f) as Body };
});

vp.gizmo.addEventListener("objectChange", () => {
  if (!dragging) return;
  const r = vp.proxy.rotation;
  const deg = (a: number): number => round(THREE.MathUtils.radToDeg(a));
  overrides.set(dragging.id, {
    ...dragging.original,
    pos: [round(vp.proxy.position.x), round(vp.proxy.position.y), round(vp.proxy.position.z)],
    rot: [deg(r.x), deg(r.y), deg(r.z)],
  });
  sendCursor();
  refresh();
});

vp.gizmo.addEventListener("mouseUp", () => endDrag(true));

function endDrag(commit: boolean): void {
  if (!dragging) return;
  const o = overrides.get(dragging.id);
  const id = dragging.id;
  dragging = null;
  overrides.delete(id);
  if (commit && o) record([commitUpdate(id, o)]);
  sendCursor();
  refresh();
}

// ---------- the pointer in the viewport ----------

let downAt: { x: number; y: number } | null = null;

vp.canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  if (following) stopFollowing();
});

vp.canvas.addEventListener("pointerup", (e) => {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5 || vp.gizmo.dragging || (vp.gizmo.axis && vp.gizmo.object)) return;
  click(e);
});

function click(e: PointerEvent): void {
  switch (mode.kind) {
    case "select": {
      const hit = vp.pick(e);
      const id = hit?.id ?? null;
      if (!id) {
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) select([]);
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) toggle(id);
      else select([id]);
      return;
    }
    case "place": {
      if (!canEdit()) return;
      const hit = vp.pick(e);
      if (!hit || mode.body === "extrude") return;
      const body = placement(mode.body, hit);
      const made = commitAdd(body);
      if (!made) return;
      record([made]);
      mode = { kind: "select" };
      select([made.id]);
      return;
    }
    case "measure": {
      const hit = vp.pick(e);
      if (!hit) return;
      if (!mode.a || mode.b) mode = { kind: "measure", a: hit.point.clone(), b: null };
      else mode.b = hit.point.clone();
      refresh();
      return;
    }
    case "sketch": {
      const hit = vp.pick(e, mode.stage === "draw");
      if (hit) sketchClick(hit, e);
      return;
    }
    case "extrude":
      return;
  }
}

let lastPointer: { clientX: number; clientY: number } | null = null;

vp.canvas.addEventListener("pointermove", (e) => {
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
  if (mode.kind === "place") {
    hoverHit = vp.pick(e);
    drawGhosts();
  } else if (mode.kind === "sketch" && mode.stage === "draw") {
    mode.cursor = sketchPoint(mode.plane, e);
    drawOverlay();
  }
  sendCursor();
});

vp.canvas.addEventListener("pointerleave", () => {
  lastPointer = null;
  send({ t: "leave" });
});

vp.controls.addEventListener("change", () => sendCursor());

// Cursor, camera and drag preview go out together, at most every 50 ms.
let lastSent = 0;
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
function sendCursor(): void {
  if (!live) return;
  const wait = 50 - (performance.now() - lastSent);
  clearTimeout(cursorTimer);
  if (wait > 0) {
    cursorTimer = setTimeout(sendCursor, wait);
    return;
  }
  lastSent = performance.now();
  let at: Vec3 | null = null;
  if (lastPointer) {
    const hit = vp.pick(lastPointer);
    if (hit) at = [round(hit.point.x), round(hit.point.y), round(hit.point.z)];
  }
  const draft = [...overrides.values()];
  const preview = previewBody();
  if (preview) draft.push(preview.body);
  send({ t: "cursor", at, cam: vp.view(), draft: draft.length ? draft : undefined });
}

// ---------- overlays: sketch lines, measurement, labels ----------

const overlayMat = new THREE.LineBasicMaterial({ color: 0x0696d7, depthTest: false });
const pointMat = new THREE.PointsMaterial({ color: 0x0696d7, size: 8, sizeAttenuation: false, depthTest: false });

function drawOverlay(): void {
  vp.overlay.clear();
  if (mode.kind === "sketch" && mode.stage === "draw") {
    const { plane, pts, cursor, tool } = mode;
    const all = cursor ? [...pts, cursor] : pts;
    let outline: [number, number][] = [];
    if (tool === "line") outline = all;
    else if (all.length === 2) {
      const prof = profileFrom(tool, all);
      if (prof?.type === "poly") outline = [...prof.pts, prof.pts[0]];
      if (prof?.type === "circle") {
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          outline.push([prof.cx + Math.cos(a) * prof.r, prof.cy + Math.sin(a) * prof.r]);
        }
      }
    }
    const world = outline.map((p) => fromPlane(plane, p));
    if (world.length >= 2) vp.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(world), overlayMat));
    const dots = all.map((p) => fromPlane(plane, p));
    if (dots.length) vp.overlay.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(dots), pointMat));
    // the sketch plane itself, a faint square
    const s = 150;
    const corners = ([[-s, -s], [s, -s], [s, s], [-s, s], [-s, -s]] as [number, number][]).map((p) => fromPlane(plane, p));
    vp.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineDashedMaterial({ color: 0x0696d7, dashSize: 4, gapSize: 4 })));
  }
  if (mode.kind === "measure" && mode.a) {
    const pts = mode.b ? [mode.a, mode.b] : [mode.a];
    vp.overlay.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: 0xd6312b, size: 9, sizeAttenuation: false, depthTest: false })));
    if (mode.b) vp.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd6312b, depthTest: false })));
  }
  vp.schedule();
}

// Labels float over the 3D view as HTML, so they stay crisp and readable.
function drawLabels(): void {
  const out: HTMLElement[] = [];
  const label = (text: string, colour: string, p: THREE.Vector3, cls: string): void => {
    const at = vp.project(p);
    if (!at) return;
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    el.style.background = colour;
    el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    out.push(el);
  };
  for (const [pid, c] of remote) {
    if (c.at) label(nameOf(pid), colourOf(pid), new THREE.Vector3(...c.at), "name-label");
  }
  const tagged = new Set<string>();
  for (const s of evaluated.solids) {
    const holder = heldByOther(s.id);
    if (!holder || tagged.has(holder) || hidden.has(s.id)) continue;
    tagged.add(holder);
    s.geometry.computeBoundingBox();
    const b = s.geometry.boundingBox!;
    label(`${nameOf(holder)} has ${s.feature.name}`, colourOf(holder), new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2), "hold-label");
  }
  if (mode.kind === "measure" && mode.a && mode.b) {
    const d = mode.b.clone().sub(mode.a);
    const mm = (n: number): string => String(Math.round(n * 100) / 100);
    label(
      `${mm(d.length())} mm   Δx ${mm(Math.abs(d.x))}  Δy ${mm(Math.abs(d.y))}  Δz ${mm(Math.abs(d.z))}`,
      "#d6312b",
      mode.a.clone().add(mode.b).multiplyScalar(0.5),
      "measure-label",
    );
  }
  labels.replaceChildren(...out);
}

vp.onFrame = drawLabels;

const cursorGeo = new THREE.SphereGeometry(1, 16, 12);
function drawRemote(): void {
  vp.remote.clear();
  for (const [pid, c] of remote) {
    if (!c.at) continue;
    const p = new THREE.Vector3(...c.at);
    const dot = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color: colourOf(pid), depthTest: false }));
    dot.position.copy(p);
    dot.scale.setScalar(vp.pixels(p, 5));
    dot.renderOrder = 10;
    vp.remote.add(dot);
  }
  drawGhosts();
  vp.schedule();
}

// ---------- the browser tree ----------

function renderTree(): void {
  const bodies = [...features.values()].filter(isBodyFeature).sort((a, b) => a.seq - b.seq);
  const doc = document.createElement("details");
  doc.open = true;
  const docSummary = document.createElement("summary");
  docSummary.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-doc"/></svg>`;
  docSummary.append(design?.name ?? "Design");
  const bodiesNode = document.createElement("details");
  bodiesNode.open = true;
  const bodiesSummary = document.createElement("summary");
  bodiesSummary.textContent = `Bodies (${bodies.length})`;
  const list = document.createElement("ul");
  for (const f of bodies) {
    const li = document.createElement("li");
    li.className = "row";
    if (selection.has(f.id)) li.classList.add("selected");
    const used = evaluated.consumed.get(f.id);
    if (used) li.classList.add("used");
    if (marker !== null && f.seq > marker) li.classList.add("future");
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "eye";
    eye.setAttribute("aria-label", `${hidden.has(f.id) ? "Show" : "Hide"} ${f.name} (only for you)`);
    eye.innerHTML = `<svg aria-hidden="true"><use href="#${hidden.has(f.id) ? "i-eye-off" : "i-eye"}"/></svg>`;
    eye.addEventListener("click", () => {
      if (hidden.has(f.id)) hidden.delete(f.id);
      else hidden.add(f.id);
      refresh();
    });
    const name = document.createElement("button");
    name.type = "button";
    name.className = "name";
    name.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-body"/></svg>`;
    const text = document.createElement("span");
    text.textContent = f.name + (used ? ` · in ${features.get(used)?.name ?? "a combine"}` : "");
    name.append(text);
    name.addEventListener("click", (e) => (e.shiftKey || e.ctrlKey || e.metaKey ? toggle(f.id) : select([f.id])));
    li.append(eye, name);
    const holder = heldByOther(f.id);
    if (holder) {
      const dot = document.createElement("span");
      dot.className = "holder";
      dot.style.background = colourOf(holder);
      dot.textContent = nameOf(holder).slice(0, 1).toUpperCase();
      dot.setAttribute("aria-label", `${nameOf(holder)} is holding this`);
      li.append(dot);
    }
    list.append(li);
  }
  bodiesNode.append(bodiesSummary, list);
  doc.append(docSummary, bodiesNode);
  tree.replaceChildren(doc);
}

// ---------- the timeline ----------

const ICONS: Record<string, string> = {
  box: "i-box",
  cylinder: "i-cylinder",
  sphere: "i-sphere",
  cone: "i-cone",
  torus: "i-torus",
  extrude: "i-extrude",
  combine: "i-combine",
};

function ordered(): Stored[] {
  return [...features.values()].sort((a, b) => a.seq - b.seq);
}

function renderTimeline(): void {
  const items = ordered();
  track.replaceChildren(
    ...items.map((f, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "step";
      if (selection.has(f.id)) b.classList.add("selected");
      if (marker !== null && f.seq > marker) b.classList.add("future");
      const fail = evaluated.failed.get(f.id);
      if (fail) b.classList.add("failed");
      const holder = heldByOther(f.id);
      if (holder) b.style.borderColor = colourOf(holder);
      b.setAttribute("aria-label", `${i + 1}. ${f.name}${fail ? `, failed: ${fail}` : ""}, by ${nameOf(f.by)}`);
      b.innerHTML = `<svg aria-hidden="true"><use href="#${ICONS[f.kind]}"/></svg>`;
      b.addEventListener("click", (e) => (e.shiftKey || e.ctrlKey || e.metaKey ? toggle(f.id) : select([f.id])));
      b.addEventListener("dblclick", () => setMarker(f.seq));
      li.append(b);
      return li;
    }),
  );
  const end = document.createElement("li");
  end.className = "marker-end";
  end.setAttribute("aria-hidden", "true");
  if (marker === null) track.append(end);
  else {
    const at = items.findIndex((f) => f.seq > marker!);
    track.insertBefore(end, track.children[at] ?? null);
  }
}

function setMarker(seq: number | null): void {
  const items = ordered();
  marker = seq === null || seq >= (items[items.length - 1]?.seq ?? 0) ? null : seq;
  if (marker !== null) {
    endDrag(false);
    setMoving(false);
    if (mode.kind !== "select" && mode.kind !== "measure") mode = { kind: "select" };
  }
  refresh();
}

function step(dir: -1 | 1): void {
  const items = ordered();
  if (!items.length) return;
  const index = marker === null ? items.length - 1 : items.findIndex((f) => f.seq === marker);
  const next = Math.max(-1, Math.min(items.length - 1, index + dir));
  setMarker(next < 0 ? 0 : items[next].seq);
}

$<HTMLButtonElement>("tl-first").addEventListener("click", () => setMarker(0));
$<HTMLButtonElement>("tl-prev").addEventListener("click", () => step(-1));
$<HTMLButtonElement>("tl-next").addEventListener("click", () => step(1));
$<HTMLButtonElement>("tl-last").addEventListener("click", () => setMarker(null));

function renderBanner(): void {
  let text = "";
  if (marker !== null) {
    const items = ordered();
    const k = items.filter((f) => f.seq <= marker!).length;
    text = `Looking back: step ${k} of ${items.length}. Editing is off until you go to the end.`;
  } else if (following) text = `Following ${nameOf(following)}'s view. Drag to stop.`;
  else if (mode.kind === "place") text = `Click the ground or a face to place a ${KIND_NAMES[mode.body].toLowerCase()}. Esc to stop.`;
  else if (mode.kind === "measure") text = "Click two points to measure between them. Esc to stop.";
  else if (mode.kind === "sketch" && mode.stage === "plane") text = "Click a face, or the ground, to sketch on. Esc to stop.";
  banner.hidden = !text;
  banner.textContent = text;
  document.body.classList.toggle("sketching", mode.kind === "sketch" && mode.stage === "draw");
  $<HTMLElement>("groups-solid").hidden = mode.kind === "sketch" && mode.stage === "draw";
  $<HTMLElement>("groups-sketch").hidden = !(mode.kind === "sketch" && mode.stage === "draw");
  $<HTMLElement>("tab-sketch").hidden = !(mode.kind === "sketch" && mode.stage === "draw");
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-sketch]")) {
    b.setAttribute("aria-pressed", String(mode.kind === "sketch" && mode.stage === "draw" && mode.tool === b.dataset.sketch));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
    const cmd = b.dataset.cmd;
    const on =
      (cmd === "sketch" && mode.kind === "sketch") ||
      (cmd === `place:${mode.kind === "place" ? mode.body : ""}`) ||
      (cmd === "measure" && mode.kind === "measure") ||
      (cmd === "move" && moving);
    b.setAttribute("aria-pressed", String(on));
  }
}

// ---------- the properties panel ----------
// Every number of every feature can be typed here.

let panelKey = "";

function numberField(label: string, value: number, onChange: (n: number) => void, unit = "mm"): HTMLLabelElement {
  const l = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = label;
  const wrap = document.createElement("span");
  wrap.className = "input-unit";
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.inputMode = "decimal";
  input.value = String(value);
  const u = document.createElement("span");
  u.textContent = unit;
  u.setAttribute("aria-hidden", "true");
  wrap.append(input, u);
  input.setAttribute("aria-label", `${label} in ${unit === "°" ? "degrees" : "millimetres"}`);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) {
      input.value = String(value);
      return say("That needs to be a number.", true);
    }
    onChange(n);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  l.append(span, wrap);
  return l;
}

function head(title: string, onClose: () => void): HTMLElement {
  const h = document.createElement("div");
  h.className = "panel-head";
  const t = document.createElement("h2");
  t.textContent = title;
  const x = document.createElement("button");
  x.type = "button";
  x.className = "close";
  x.setAttribute("aria-label", "Close");
  x.textContent = "×";
  x.addEventListener("click", onClose);
  h.append(t, x);
  return h;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function apply(id: string, next: Feature): void {
  if (!canEdit()) return renderPanel(true);
  record([commitUpdate(id, next)]);
  renderPanel(true);
}

function renderPanel(force = false): void {
  if (mode.kind === "extrude") return renderExtrudePanel();
  if (selection.size === 0) {
    panel.hidden = true;
    panelKey = "";
    return;
  }
  panel.hidden = false;
  if (selection.size > 1) {
    const ids = [...selection];
    const key = `multi:${ids.join(",")}`;
    if (!force && key === panelKey) return;
    panelKey = key;
    const names = ids.map((id) => features.get(id)?.name ?? "").join(", ");
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = `${names}. Combine uses the first as the target and the rest as tools.`;
    const row = document.createElement("div");
    row.className = "panel-foot";
    row.append(button("Combine", "primary", openCombine), button("Delete", "danger", deleteSelection));
    panel.replaceChildren(head(`${ids.length} SELECTED`, () => select([])), p, row);
    return;
  }
  const id = [...selection][0];
  const f = features.get(id);
  if (!f) return;
  const key = `${id}:${f.v}:${looking()}`;
  if (!force && key === panelKey) return;
  // do not rebuild under someone's fingers while they are typing a number
  if (!force && panel.contains(document.activeElement) && panelKey.startsWith(`${id}:`)) return;
  panelKey = key;
  const body: HTMLElement[] = [head(KIND_NAMES[f.kind].toUpperCase(), () => select([]))];

  const nameLabel = document.createElement("label");
  nameLabel.className = "wide";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = "Name";
  const nameField = document.createElement("input");
  nameField.value = f.name;
  nameField.maxLength = 40;
  nameField.addEventListener("change", () => apply(id, { ...featureOf(f), name: nameField.value } as Feature));
  nameLabel.append(nameSpan, nameField);
  body.push(nameLabel);

  const base = featureOf(f);
  if (f.kind === "combine") {
    const opLabel = document.createElement("label");
    opLabel.className = "wide";
    const opSpan = document.createElement("span");
    opSpan.textContent = "Operation";
    const op = document.createElement("select");
    for (const [v, t] of [["join", "Join"], ["cut", "Cut"], ["intersect", "Intersect"]]) op.add(new Option(t, v, false, f.op === v));
    op.addEventListener("change", () => apply(id, { ...(base as CombineF), op: op.value as CombineF["op"] }));
    opLabel.append(opSpan, op);
    const info = document.createElement("p");
    info.className = "note";
    info.textContent = `Target: ${features.get(f.target)?.name ?? "missing"}. Tools: ${f.tools.map((t) => features.get(t)?.name ?? "missing").join(", ")}.`;
    body.push(opLabel, info);
    const fail = evaluated.failed.get(id);
    if (fail) {
      const warn = document.createElement("p");
      warn.className = "note warn";
      warn.textContent = `This combine could not be computed: ${fail}.`;
      body.push(warn);
    }
  } else {
    const b = base as Body;
    const fields = document.createElement("div");
    fields.className = "fields";
    const raw = b as unknown as Record<string, number>;
    for (const k of Object.keys(PARAMS[b.kind])) {
      fields.append(numberField(PARAM_LABELS[k], raw[k], (n) => apply(id, { ...b, [k]: n } as Body)));
    }
    if (b.kind === "extrude" && b.profile.type === "circle") {
      const prof = b.profile;
      fields.append(numberField("Sketch radius", prof.r, (n) => apply(id, { ...b, profile: { ...prof, r: n } })));
    }
    const section = (t: string): HTMLElement => {
      const h = document.createElement("h3");
      h.textContent = t;
      return h;
    };
    const pos = document.createElement("div");
    pos.className = "fields three";
    ["X", "Y", "Z"].forEach((axis, i) => {
      pos.append(
        numberField(axis, b.pos[i], (n) => {
          const next = [...b.pos] as Vec3;
          next[i] = n;
          apply(id, { ...b, pos: next });
        }),
      );
    });
    const rot = document.createElement("div");
    rot.className = "fields three";
    ["X", "Y", "Z"].forEach((axis, i) => {
      rot.append(
        numberField(
          axis,
          b.rot[i],
          (n) => {
            const next = [...b.rot] as Vec3;
            next[i] = n;
            apply(id, { ...b, rot: next });
          },
          "°",
        ),
      );
    });
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const [label, colour] of APPEARANCES) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "swatch";
      s.style.background = colour;
      s.setAttribute("aria-label", label);
      s.setAttribute("aria-pressed", String(b.colour === colour));
      s.addEventListener("click", () => apply(id, { ...b, colour }));
      swatches.append(s);
    }
    const moveRow = document.createElement("div");
    moveRow.className = "segmented";
    const t1 = button("Move", "", () => {
      gizmoMode = "translate";
      setMoving(true);
      renderPanel(true);
    });
    const t2 = button("Rotate", "", () => {
      gizmoMode = "rotate";
      setMoving(true);
      renderPanel(true);
    });
    t1.setAttribute("aria-pressed", String(moving && gizmoMode === "translate"));
    t2.setAttribute("aria-pressed", String(moving && gizmoMode === "rotate"));
    moveRow.append(t1, t2);
    body.push(section("Size"), fields, section("Position"), pos, section("Rotation"), rot, moveRow, section("Appearance"), swatches);
    if (evaluated.consumed.has(id)) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = `Used as a tool by ${features.get(evaluated.consumed.get(id)!)?.name}. Move it and the result follows.`;
      body.push(n);
    }
  }
  const by = document.createElement("p");
  by.className = "note";
  by.textContent = `Last changed by ${nameOf(f.by)}.`;
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  foot.append(button("Delete", "danger", deleteSelection), button("OK", "primary", () => select([])));
  body.push(by, foot);
  panel.replaceChildren(...body);
  if (looking()) for (const el of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, .swatch, .segmented button, .danger")) el.disabled = true;
}

function renderExtrudePanel(): void {
  if (mode.kind !== "extrude") return;
  const m = mode;
  panel.hidden = false;
  if (panelKey === "extrude" && panel.contains(document.activeElement)) return;
  panelKey = "extrude";
  const opLabel = document.createElement("label");
  opLabel.className = "wide";
  const opSpan = document.createElement("span");
  opSpan.textContent = "Operation";
  const op = document.createElement("select");
  op.add(new Option("New body", "new", false, m.op === "new"));
  if (m.plane.body) {
    op.add(new Option("Join", "join", false, m.op === "join"));
    op.add(new Option("Cut", "cut", false, m.op === "cut"));
  }
  op.addEventListener("change", () => {
    m.op = op.value as typeof m.op;
    refresh();
  });
  opLabel.append(opSpan, op);
  const fields = document.createElement("div");
  fields.className = "fields";
  fields.append(
    numberField("Distance", m.depth, (n) => {
      if (n <= 0) return say("Give the distance as a positive number; Cut goes into the body for you.", true);
      m.depth = n;
      refresh();
    }),
  );
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = m.plane.body
    ? `Sketched on ${features.get(m.plane.body)?.name ?? "a body"}. Join adds to it, Cut takes away from it.`
    : "Sketched on the ground.";
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  foot.append(button("Cancel", "", cancelMode), button("OK", "primary", commitExtrude));
  panel.replaceChildren(head("EXTRUDE", cancelMode), opLabel, fields, note, foot);
  panel.querySelector<HTMLInputElement>("input")?.focus();
}

function openCombine(): void {
  if (!canEdit()) return;
  const ids = [...selection].filter((id) => {
    const f = features.get(id);
    return f && isBodyFeature(f);
  });
  if (ids.length < 2) return say("Select the body to change first, then the bodies to combine with it (Shift-click).", true);
  const [target, ...tools] = ids;
  const name = `Combine ${[...features.values()].filter((f) => f.kind === "combine").length + 1}`;
  const made = commitAdd({ kind: "combine", name, op: "cut", target, tools });
  if (!made) return;
  record([made]);
  select([made.id]);
  say(`${name} cuts ${tools.length} ${tools.length === 1 ? "body" : "bodies"} from ${features.get(target)?.name}. Change the operation in the panel.`);
}

// ---------- commands ----------

function cancelMode(): void {
  endDrag(false);
  mode = { kind: "select" };
  hoverHit = null;
  panelKey = "";
  refresh();
}

function command(cmd: string): void {
  if (cmd === "measure") {
    mode = mode.kind === "measure" ? { kind: "select" } : { kind: "measure", a: null, b: null };
    return refresh();
  }
  if (!canEdit()) return;
  if (cmd === "sketch") return startSketch();
  if (cmd.startsWith("place:")) {
    select([]);
    mode = { kind: "place", body: cmd.slice(6) as BodyKind };
    return refresh();
  }
  if (cmd === "move") {
    if (!movable()) return say("Select one body to move it.", true);
    setMoving(!moving);
    return refresh();
  }
  if (cmd === "combine") return openCombine();
  if (cmd === "delete") return deleteSelection();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
  b.addEventListener("click", () => command(b.dataset.cmd ?? ""));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-sketch]")) {
  b.addEventListener("click", () => {
    if (mode.kind === "sketch" && mode.stage === "draw") {
      mode.tool = b.dataset.sketch as SketchTool;
      mode.pts = [];
      refresh();
    }
  });
}
$<HTMLButtonElement>("sketch-cancel").addEventListener("click", cancelMode);
undoButton.addEventListener("click", () => replay(undoStack, redoStack, true));
redoButton.addEventListener("click", () => replay(redoStack, undoStack, false));
$<HTMLButtonElement>("fit").addEventListener("click", () => vp.fit());
$<HTMLButtonElement>("home").addEventListener("click", () => vp.home());
gridSelect.addEventListener("change", () => {
  grid = Number(gridSelect.value);
  store("bench.grid3d", String(grid));
  vp.buildGrid(grid);
  syncGizmo();
});
displaySelect.value = stored("bench.display") ?? "edges";
vp.setDisplay(displaySelect.value as Display);
displaySelect.addEventListener("change", () => {
  vp.setDisplay(displaySelect.value as Display);
  store("bench.display", displaySelect.value);
  rebuild();
});
function setBrowser(open: boolean): void {
  const b = $<HTMLButtonElement>("browser-toggle");
  b.setAttribute("aria-expanded", String(open));
  b.textContent = open ? "‹" : "›";
  $<HTMLElement>("browser").classList.toggle("collapsed", !open);
}
$<HTMLButtonElement>("browser-toggle").addEventListener("click", (e) => {
  setBrowser((e.currentTarget as HTMLElement).getAttribute("aria-expanded") !== "true");
});
// on a phone the browser starts folded away, so the model gets the screen
if (matchMedia("(max-width: 760px)").matches) setBrowser(false);

nameInput.addEventListener("change", () => {
  const name = cleanName(nameInput.value);
  if (name && live) send({ t: "rename", name });
  else if (design) nameInput.value = design.name;
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
});

document.addEventListener("keydown", (e) => {
  if ((e.target as Element).closest?.("input, select, textarea, dialog")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    return e.shiftKey ? replay(redoStack, undoStack, false) : replay(undoStack, redoStack, true);
  }
  if (mod && k === "y") {
    e.preventDefault();
    return replay(redoStack, undoStack, false);
  }
  if (mod) return;
  if (e.key === "Escape") {
    if (mode.kind !== "select") return cancelMode();
    if (moving) return setMoving(false);
    return select([]);
  }
  if (e.key === "Enter" && mode.kind === "extrude") return commitExtrude();
  if (e.key === "Enter" && mode.kind === "sketch" && mode.stage === "draw" && mode.tool === "line") {
    return finishProfile(profileFrom("line", mode.pts));
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    return deleteSelection();
  }
  if (k === "s") return command("sketch");
  if (k === "m") return command("move");
  if (k === "f") return vp.fit();
  if (moving && k === "w") {
    gizmoMode = "translate";
    syncGizmo();
    return renderPanel(true);
  }
  if (moving && k === "e") {
    gizmoMode = "rotate";
    syncGizmo();
    return renderPanel(true);
  }
});

// ---------- people ----------

function askName(): void {
  dialogInput.value = me?.name ?? "";
  dialog.showModal();
  dialogInput.select();
}

$<HTMLFormElement>("name-form").addEventListener("submit", () => {
  const name = cleanName(dialogInput.value);
  if (!name) return;
  store("bench.name", name);
  send({ t: "name", name });
});
meButton.addEventListener("click", askName);

function renderMe(): void {
  if (!me) return;
  const dot = document.createElement("span");
  dot.className = "avatar";
  dot.style.background = me.colour;
  dot.textContent = me.name.slice(0, 1).toUpperCase();
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = me.name;
  meButton.replaceChildren(dot, label);
}

function follow(id: string): void {
  if (following === id) return stopFollowing();
  following = id;
  const c = remote.get(id);
  if (c?.cam) vp.flyTo(c.cam);
  renderPeople();
  refresh();
}

function stopFollowing(): void {
  following = null;
  renderPeople();
  refresh();
}

function renderPeople(): void {
  const others = [...online.values()].filter((p) => p.id !== me?.id);
  peopleList.replaceChildren(
    ...others.slice(0, 8).map((p) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "avatar";
      b.style.background = p.colour;
      b.textContent = p.name.slice(0, 1).toUpperCase();
      b.setAttribute("aria-label", following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}'s view`);
      b.setAttribute("aria-pressed", String(following === p.id));
      b.addEventListener("click", () => follow(p.id));
      const tip = document.createElement("span");
      tip.className = "tip";
      tip.textContent = following === p.id ? `Following ${p.name}` : `${p.name}: click to follow their view`;
      li.append(b, tip);
      return li;
    }),
  );
  if (others.length > 8) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = `+${others.length - 8}`;
    peopleList.append(li);
  }
}

// ---------- start ----------

if (!/^[A-Za-z0-9]{1,20}$/.test(designId)) say("This is not a design address.", true);
else connect();
updateButtons();

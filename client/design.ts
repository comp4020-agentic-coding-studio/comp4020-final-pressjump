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
  mirrorBody,
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
import { LIMITS, cleanName, type ClientMessage, type Cursor, type Design, type Person, type ServerMessage } from "../shared/protocol.ts";
import { installTips, seenTour, startTour, tourRunning, type Step } from "./tour.ts";
import { Viewport, type Display } from "./viewport.ts";
import { PRESSURE_KEY, SPEED_KEY, Wind, type WindDir } from "./wind.ts";
import { EXAMPLE_ID } from "../shared/example.ts";
import { ACCEPT, forgetImport, loadImports, placedGeometry, readModel, saveImport, standOnFloor, type Imported, type Unit } from "./importer.ts";

const designId = location.pathname.split("/")[2] ?? "";
const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;

const panel = $<HTMLElement>("panel");
const banner = $<HTMLElement>("banner");
const offline = $<HTMLElement>("offline");
const connLabel = $<HTMLElement>("conn");
const message = $<HTMLElement>("message");
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

// The wind preview starts on only in the example design, where it shows off
// what the editor does; everyone's own designs open with it off, and turning
// it on there lasts for that visit. A view choice: kept here, never sent.
const wind = new Wind(vp.scene, () => vp.schedule(), new THREE.Color("#f4f6fa"), matchMedia("(max-width: 760px)").matches);
const windButton = $<HTMLButtonElement>("wind");
const windDir = $<HTMLSelectElement>("wind-dir");
const windNote = $<HTMLElement>("wind-note");
let windOn = designId === EXAMPLE_ID;
windDir.value = stored("bench.windDir") ?? "+x";
if (!windDir.value) windDir.value = "+x";
// the key: what the colours mean, in stepped swatches, and what the wind is not
function keyRow(label: string, low: string, colours: string[], high: string): HTMLElement {
  const row = document.createElement("span");
  row.className = "wind-key";
  const name = document.createElement("b");
  name.textContent = label;
  const lo = document.createElement("span");
  lo.textContent = low;
  const steps = document.createElement("span");
  steps.className = "wind-steps";
  for (const c of colours) {
    const i = document.createElement("i");
    i.style.background = c;
    steps.append(i);
  }
  const hi = document.createElement("span");
  hi.textContent = high;
  row.append(name, lo, steps, hi);
  return row;
}
wind.onGrid = (mm) => {
  windNote.hidden = !windOn || mm === null;
  if (mm === null) return;
  const what = document.createElement("span");
  what.className = "wind-what";
  what.textContent = `Wind preview: a coarse air-flow simulation in ${Math.round(mm)} mm cells. It shows where air goes, not forces or numbers; the colours are relative.`;
  windNote.replaceChildren(
    keyRow("Air speed", "slow", SPEED_KEY, "fast"),
    keyRow("On the part", "pulled", PRESSURE_KEY, "pushed"),
    what,
  );
};
function setWind(on: boolean): void {
  windOn = on;
  windButton.setAttribute("aria-pressed", String(on));
  windDir.disabled = !on;
  if (!on) windNote.hidden = true;
  wind.setDirection(windDir.value as WindDir);
  wind.setOn(on);
}
windButton.addEventListener("click", () => setWind(!windOn));
windDir.addEventListener("change", () => {
  store("bench.windDir", windDir.value);
  wind.setDirection(windDir.value as WindDir);
});

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
  | { kind: "extrude"; plane: SketchPlane; profile: Profile; depth: number; op: "new" | "join" | "cut"; name: string }
  | { kind: "hole"; d: number; depth: number };

// Mirror and Pattern work on the selection, from a small panel of typed
// numbers; null when neither is open.
type ToolPanel = { kind: "mirror"; axis: "x" | "z"; at: number } | { kind: "pattern"; axis: "x" | "y" | "z"; count: number; spacing: number };
let toolPanel: ToolPanel | null = null;

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
        setWind(windOn);
        loadLocalModels();
        if (!stored("bench.name")) askName();
        if (!seenTour()) {
          // after the name, if it is being asked for, so the two don't overlap
          if (dialog.open) dialog.addEventListener("close", () => setTimeout(beginTour, 300), { once: true });
          else setTimeout(beginTour, 700);
        }
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
  importSel = null;
  for (const id of ids) {
    if (!features.has(id)) continue;
    const holder = heldByOther(id);
    if (holder) {
      say(`${nameOf(holder)} is holding ${features.get(id)?.name}. It is yours to edit once they let go.`);
      continue;
    }
    selection.add(id);
  }
  hideReadout();
  // one body selected: its arrows come up, ready to drag
  const one = selection.size === 1 ? features.get([...selection][0]) : undefined;
  if (one && isBodyFeature(one) && mode.kind === "select") setMoving(true);
  else if (!selection.size) setMoving(false);
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
  wind.setSolids([...evaluated.solids.filter((s) => !hidden.has(s.id)).map((s) => s.geometry), ...[...importGeo.values()]]);
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
    renderEmpty();
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
      items.push({ geometry: worldGeometry({ ...f, ...overrides.get(id) } as Body), colour: "#0c66e4", opacity: 0.18 });
    }
  }
  for (const [pid, c] of remote) {
    for (const f of c.draft ?? []) {
      if (isBodyFeature(f)) items.push({ geometry: worldGeometry(f), colour: colourOf(pid), opacity: 0.2 });
    }
  }
  // while a body is being moved, a faint copy stays where it started
  const moved = dragging ?? (slide?.started ? slide : null);
  if (moved) items.push({ geometry: worldGeometry(moved.original), colour: "#626f86", opacity: 0.12 });
  const preview = previewBody();
  if (preview) items.push({ geometry: worldGeometry(preview.body), colour: preview.cut ? "#d6312b" : "#0c66e4", opacity: 0.3 });
  vp.setGhosts(items);
}

// ---------- placing primitives ----------

const DEFAULTS: Record<Exclude<BodyKind, "extrude">, Record<string, number>> = {
  box: { w: 20, h: 20, d: 20, fillet: 0, chamfer: 0 },
  cylinder: { r: 10, h: 20, chamfer: 0 },
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
  if (mode.kind === "hole" && hoverHit) {
    const drillBody = holeDrill(mode, hoverHit);
    return drillBody ? { body: drillBody, cut: true } : null;
  }
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
  const m = importSel ? imported.get(importSel) : undefined;
  if (m) {
    if (draggingImport) return;
    vp.proxy.position.set(...m.pos);
    vp.proxy.rotation.set(...(m.rot.map((a) => THREE.MathUtils.degToRad(a)) as Vec3), "XYZ");
    vp.gizmo.setMode(gizmoMode);
    vp.gizmo.setTranslationSnap(grid);
    vp.gizmo.attach(vp.proxy);
    vp.schedule();
    return;
  }
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

// an imported model being dragged by its arrows: local, so no hold, no version
let draggingImport: string | null = null;
vp.gizmo.addEventListener("mouseDown", () => {
  if (importSel) draggingImport = importSel;
});
vp.gizmo.addEventListener("objectChange", () => {
  const m = draggingImport ? imported.get(draggingImport) : undefined;
  if (!m) return;
  const deg = (a: number): number => round(THREE.MathUtils.radToDeg(a));
  m.pos = [round(vp.proxy.position.x), round(vp.proxy.position.y), round(vp.proxy.position.z)];
  m.rot = [deg(vp.proxy.rotation.x), deg(vp.proxy.rotation.y), deg(vp.proxy.rotation.z)];
  placeImport(m);
});
vp.gizmo.addEventListener("mouseUp", () => {
  const m = draggingImport ? imported.get(draggingImport) : undefined;
  draggingImport = null;
  if (m) {
    saveImport(m);
    renderPanel(true);
  }
});

vp.gizmo.addEventListener("mouseDown", () => {
  if (importSel) return;
  const f = movable();
  if (!f || !canEdit()) return;
  dragging = { id: f.id, original: featureOf(f) as Body };
});

vp.gizmo.addEventListener("objectChange", () => {
  if (!dragging || draggingImport) return;
  const r = vp.proxy.rotation;
  const deg = (a: number): number => round(THREE.MathUtils.radToDeg(a));
  overrides.set(dragging.id, {
    ...dragging.original,
    pos: [round(vp.proxy.position.x), round(vp.proxy.position.y), round(vp.proxy.position.z)],
    rot: [deg(r.x), deg(r.y), deg(r.z)],
  });
  const axis = ({ X: 0, Y: 1, Z: 2 } as Record<string, 0 | 1 | 2>)[vp.gizmo.axis ?? ""] as 0 | 1 | 2 | undefined;
  if (gizmoMode === "translate" && axis !== undefined) {
    showReadout({ id: dragging.id, kind: "move", axis, base: dragging.original }, round(vp.proxy.position.getComponent(axis) - dragging.original.pos[axis]), true);
  } else if (gizmoMode === "rotate" && axis !== undefined) {
    const angle = (vp.gizmo as unknown as { rotationAngle: number }).rotationAngle;
    showReadout({ id: dragging.id, kind: "turn", axis, base: dragging.original }, round(THREE.MathUtils.radToDeg(angle)), true);
  } else {
    showReadout(null, 0, true, "Rotate freely");
  }
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
  // the readout stays, now a box to type the exact amount into
  if (commit && o && typed) showReadout(typed, readoutAmount, false);
  else hideReadout();
  sendCursor();
  refresh();
}

// ---------- the readout: how far, and a box to type how far ----------
// While you drag an arrow or a ring it says which axis and how far, in mm or
// degrees. When you let go it stays, as a box: type the exact amount (or just
// start typing digits) and press Enter, and the body goes exactly that far
// from where it started.

type Typed = { id: string; kind: "move" | "turn"; axis: 0 | 1 | 2; base: Body };
let typed: Typed | null = null;
let readoutAmount = 0;
const readout = document.createElement("div");
readout.className = "readout";
readout.hidden = true;
readout.innerHTML =
  '<span class="readout-axis"></span><span class="readout-label"></span><span class="input-unit"><input type="number" step="any" inputmode="decimal"><span class="readout-unit"></span></span><span class="readout-text"></span>';
$<HTMLElement>("viewport").append(readout);
const readoutAxis = readout.querySelector<HTMLElement>(".readout-axis")!;
const readoutLabel = readout.querySelector<HTMLElement>(".readout-label")!;
const readoutBox = readout.querySelector<HTMLElement>(".input-unit")!;
const readoutInput = readout.querySelector<HTMLInputElement>("input")!;
const readoutUnit = readout.querySelector<HTMLElement>(".readout-unit")!;
const readoutText = readout.querySelector<HTMLElement>(".readout-text")!;

function showReadout(t: Typed | null, amount: number, live: boolean, text = ""): void {
  typed = t;
  readoutAmount = amount;
  readout.hidden = false;
  readout.classList.toggle("live", live);
  readoutAxis.hidden = !t;
  readoutBox.hidden = !t;
  readoutText.textContent = text;
  if (t) {
    const name = "XYZ"[t.axis];
    readoutAxis.textContent = name;
    readoutAxis.dataset.axis = name;
    readoutLabel.textContent = t.kind === "move" ? "Move" : "Rotate";
    readoutUnit.textContent = t.kind === "move" ? "mm" : "°";
    readoutInput.setAttribute("aria-label", `${t.kind === "move" ? "Distance to move along" : "Angle to rotate about"} ${name}, in ${t.kind === "move" ? "millimetres" : "degrees"}`);
    if (document.activeElement !== readoutInput) readoutInput.value = String(amount);
    readoutInput.readOnly = live;
  } else readoutLabel.textContent = "";
  vp.schedule();
}

function hideReadout(): void {
  typed = null;
  readout.hidden = true;
}

// the body as it would be, `amount` along (or about) the readout's axis from
// where the drag began
function typedBody(t: Typed, amount: number): Body {
  if (t.kind === "move") {
    const pos = [...t.base.pos] as Vec3;
    pos[t.axis] = round(pos[t.axis] + amount);
    return { ...t.base, pos };
  }
  const axis = new THREE.Vector3().setComponent(t.axis, 1);
  const start = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(t.base.rot.map((a) => THREE.MathUtils.degToRad(a)) as Vec3), "XYZ"));
  const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(amount)).multiply(start);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return { ...t.base, rot: [e.x, e.y, e.z].map((a) => round(THREE.MathUtils.radToDeg(a))) as Vec3 };
}

readoutInput.addEventListener("change", () => {
  const t = typed;
  const n = Number(readoutInput.value);
  if (!t || readoutInput.readOnly) return;
  if (readoutInput.value.trim() === "" || !Number.isFinite(n)) {
    readoutInput.value = String(readoutAmount);
    return say("That needs to be a number.", true);
  }
  if (!canEdit()) return;
  if (heldByOther(t.id)) return say(`${nameOf(heldByOther(t.id)!)} is holding ${features.get(t.id)?.name} now.`, true);
  record([commitUpdate(t.id, typedBody(t, n))]);
  readoutAmount = n;
});
readoutInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") readoutInput.blur();
  if (e.key === "Escape") {
    readoutInput.value = String(readoutAmount);
    readoutInput.blur();
  }
});

// follows the body round the screen, beside its arrows
function placeReadout(): void {
  if (readout.hidden) return;
  const id = typed?.id ?? dragging?.id ?? slide?.id;
  const f = id ? (overrides.get(id) ?? features.get(id)) : undefined;
  if (!f || !isBodyFeature(f as Feature)) return hideReadout();
  const at = vp.project(new THREE.Vector3(...(f as Body).pos));
  if (!at) return;
  readout.style.transform = `translate(${Math.round(at.x + 28)}px, ${Math.round(at.y + 24)}px)`;
}

// ---------- dragging a body directly ----------
// Press on a body and drag: it slides across the floor (Alt: up and down),
// snapping to the grid, and everyone sees it move before you let go. It goes
// through the same hold and versioned update as any other edit. With a mouse
// any body can be grabbed; on a touch screen only the selected one, so one
// finger on the model still orbits.

let slide: {
  id: string;
  original: Body;
  plane: THREE.Plane;
  from: THREE.Vector3;
  vertical: boolean;
  down: { x: number; y: number };
  started: boolean;
} | null = null;
const viewportEl = $<HTMLElement>("viewport");

vp.canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || mode.kind !== "select" || !live || looking()) return;
  if (vp.gizmo.axis) return; // on a gizmo handle: the gizmo has it
  const hit = vp.pick(e);
  const f = hit?.id ? features.get(hit.id) : undefined;
  if (!hit || !f || !isBodyFeature(f) || heldByOther(f.id)) return;
  if (e.pointerType !== "mouse" && !selection.has(f.id)) return;
  const vertical = e.altKey;
  let plane: THREE.Plane;
  if (vertical) {
    // an upright plane through the point, facing the camera
    const n = vp.camera.position.clone().sub(hit.point).setY(0);
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), hit.point);
  } else {
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
  }
  slide = { id: f.id, original: featureOf(f) as Body, plane, from: hit.point.clone(), vertical, down: { x: e.clientX, y: e.clientY }, started: false };
  vp.controls.enabled = false;
});

vp.canvas.addEventListener("pointermove", (e) => {
  if (!slide) {
    // say what a press would do: grab a body, or orbit
    if (e.pointerType === "mouse" && mode.kind === "select" && !e.buttons && live && !looking()) {
      const hit = vp.pick(e);
      viewportEl.classList.toggle("can-grab", !!hit?.id && !heldByOther(hit.id));
    }
    return;
  }
  if (!slide.started) {
    if (Math.hypot(e.clientX - slide.down.x, e.clientY - slide.down.y) < 4) return;
    slide.started = true;
    if (!selection.has(slide.id) || selection.size !== 1) select([slide.id]);
    if (!selection.has(slide.id)) {
      // someone else got there first; select() has said who
      slide = null;
      vp.controls.enabled = true;
      return;
    }
    viewportEl.classList.add("grabbing");
  }
  const at = vp.pickPlane(e, slide.plane);
  if (!at) return;
  const d = at.sub(slide.from);
  const [x, y, z] = slide.original.pos;
  const pos: Vec3 = slide.vertical ? [x, Math.max(-LIMIT_Y, snapValue(y + d.y)), z] : [snapValue(x + d.x), y, snapValue(z + d.z)];
  overrides.set(slide.id, { ...slide.original, pos });
  const mm = (n: number) => `${n > 0 ? "+" : ""}${round(n)}`;
  const [ox, oy, oz] = slide.original.pos;
  showReadout(null, 0, true, slide.vertical ? `Y ${mm(pos[1] - oy)} mm` : `X ${mm(pos[0] - ox)}  Z ${mm(pos[2] - oz)} mm`);
  sendCursor();
  refresh();
});

function endSlide(commit: boolean): void {
  if (!slide) return;
  const { id, started } = slide;
  slide = null;
  vp.controls.enabled = true;
  viewportEl.classList.remove("grabbing");
  if (!started) return;
  hideReadout();
  const o = overrides.get(id);
  overrides.delete(id);
  if (commit && o && canEdit()) record([commitUpdate(id, o)]);
  sendCursor();
  refresh();
}

vp.canvas.addEventListener("pointerup", () => endSlide(true));
vp.canvas.addEventListener("pointercancel", () => endSlide(false));

// Nudging with the keys: arrows move the selection one grid step across the
// floor, the way the view is facing; Page Up and Page Down lift and lower it.
// Shift moves ten steps.
const LIMIT_Y = 10_000;
function nudge(key: string, big: boolean): boolean {
  const steps: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  const bodies = [...selection].map((id) => features.get(id)).filter((f): f is Stored & Body => !!f && isBodyFeature(f));
  if (!bodies.length || !(key in steps || key === "PageUp" || key === "PageDown")) return false;
  if (!canEdit()) return true;
  const n = grid * (big ? 10 : 1);
  const move = new THREE.Vector3();
  if (key === "PageUp" || key === "PageDown") move.y = key === "PageUp" ? n : -n;
  else {
    // the floor axis nearest the camera's right, and nearest its forward
    const fwd = vp.controls.target.clone().sub(vp.camera.position).setY(0);
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const axis = (v: THREE.Vector3) => (Math.abs(v.x) >= Math.abs(v.z) ? new THREE.Vector3(Math.sign(v.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(v.z)));
    const [sx, sy] = steps[key];
    move.addScaledVector(axis(right), sx * n).addScaledVector(axis(fwd), sy * n);
  }
  record(bodies.map((f) => commitUpdate(f.id, { ...(featureOf(f) as Body), pos: [round(f.pos[0] + move.x), round(f.pos[1] + move.y), round(f.pos[2] + move.z)] })));
  return true;
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
      if (hit?.id?.startsWith("import:")) return selectImport(hit.id.slice(7));
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
    case "hole":
      return drill(e);
    case "extrude":
      return;
  }
}

let lastPointer: { clientX: number; clientY: number } | null = null;

vp.canvas.addEventListener("pointermove", (e) => {
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
  if (mode.kind === "place" || mode.kind === "hole") {
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

const overlayMat = new THREE.LineBasicMaterial({ color: 0x0c66e4, depthTest: false });
const pointMat = new THREE.PointsMaterial({ color: 0x0c66e4, size: 8, sizeAttenuation: false, depthTest: false });

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
    vp.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineDashedMaterial({ color: 0x0c66e4, dashSize: 4, gapSize: 4 })));
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
  drawPointers();
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

vp.onFrame = () => {
  drawLabels();
  placeReadout();
};

// Other people's pointers: an arrow in their colour, with their name and,
// while they drag or place something, what it is. Positions arrive at most
// every 50 ms, so each pointer glides to the latest one rather than jumping.
const pointerLayer = document.createElement("div");
pointerLayer.className = "pointers";
pointerLayer.setAttribute("aria-hidden", "true");
labels.after(pointerLayer);
const pointers = new Map<string, { el: HTMLElement; tag: HTMLElement; arrow: SVGPathElement; shown: THREE.Vector3 | null }>();

function pointerFor(pid: string) {
  let p = pointers.get(pid);
  if (!p) {
    const el = document.createElement("div");
    el.className = "pointer away";
    el.innerHTML =
      '<svg viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.6 17.8 L7.7 11.5 L13 11.5 Z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><b></b>';
    pointerLayer.append(el);
    p = { el, tag: el.querySelector("b")!, arrow: el.querySelector("path")!, shown: null };
    pointers.set(pid, p);
  }
  return p;
}

function drawPointers(): void {
  let moving = false;
  for (const [pid, p] of pointers) {
    if (!remote.has(pid)) {
      p.el.remove();
      pointers.delete(pid);
    }
  }
  for (const [pid, c] of remote) {
    const p = pointerFor(pid);
    const colour = colourOf(pid);
    p.arrow.setAttribute("fill", colour);
    p.tag.style.background = colour;
    const doing = c.draft?.[0]?.name;
    const text = doing ? `${nameOf(pid)} · ${doing}` : nameOf(pid);
    if (p.tag.textContent !== text) p.tag.textContent = text;
    if (!c.at) {
      p.el.classList.add("away");
      continue;
    }
    const target = new THREE.Vector3(...c.at);
    if (!p.shown) p.shown = target.clone();
    else {
      p.shown.lerp(target, 0.35);
      if (p.shown.distanceToSquared(target) > 0.0004) moving = true;
      else p.shown.copy(target);
    }
    const at = vp.project(p.shown);
    if (!at) {
      p.el.classList.add("away");
      continue;
    }
    p.el.classList.remove("away");
    p.el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
  }
  if (moving) vp.schedule();
}

function drawRemote(): void {
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
  if (imported.size) {
    const node = document.createElement("details");
    node.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `Imported, only you (${imported.size})`;
    const ul = document.createElement("ul");
    for (const m of imported.values()) {
      const li = document.createElement("li");
      li.className = "row imported";
      if (importSel === m.id) li.classList.add("selected");
      const name = document.createElement("button");
      name.type = "button";
      name.className = "name";
      name.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-import"/></svg>`;
      const text = document.createElement("span");
      text.textContent = m.name;
      name.append(text);
      name.addEventListener("click", () => selectImport(m.id));
      li.append(name);
      ul.append(li);
    }
    node.append(summary, ul);
    doc.append(node);
  }
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
  else if (mode.kind === "hole") text = "Click a face of a body to drill a hole into it. Esc when done.";
  else if (moving && movable() && !dragging && readout.hidden) {
    text =
      gizmoMode === "translate"
        ? "Drag an arrow to move along X, Y or Z, or drag the body itself. Then type a number to make it exact. E for rotate."
        : "Drag a ring to turn the body. Then type a number for an exact angle. W for move.";
  }
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
      (cmd === "hole" && mode.kind === "hole") ||
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
  if (mode.kind === "hole") return renderHolePanel();
  if (importSel && imported.has(importSel)) return renderImportPanel(imported.get(importSel)!, force);
  if (toolPanel && selectedBodies().length) return renderToolPanel(toolPanel);
  if (toolPanel) {
    toolPanel = null;
    force = true;
  }
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
      fields.append(numberField(PARAM_LABELS[k], raw[k] ?? 0, (n) => apply(id, { ...b, [k]: n } as Body)));
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
    body.push(section("Size"), fields, section("Position · mm"), pos, section("Rotation · degrees"), rot, moveRow, section("Appearance"), swatches);
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

// ---------- tools that make features: duplicate, mirror, pattern, hole ----------
// Each makes ordinary bodies (and, for a hole, a cut), through commitAdd, so
// holds, versions, undo and the STL treat them like anything else.

function selectedBodies(): (Stored & Body)[] {
  return [...selection].map((id) => features.get(id)).filter((f): f is Stored & Body => !!f && isBodyFeature(f));
}

function boundsOf(bodies: Body[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const b of bodies) {
    const g = worldGeometry(b);
    g.computeBoundingBox();
    box.union(g.boundingBox!);
    g.dispose();
  }
  return box;
}

function roomFor(n: number): boolean {
  if (features.size + n <= LIMITS.featuresPerDesign) return true;
  say(`That would make ${features.size + n} features; a design holds at most ${LIMITS.featuresPerDesign}.`, true);
  return false;
}

// Bodies a combine uses are copied as plain bodies; say so, so nobody expects
// the copy to carry the cut.
function copiesNote(bodies: Stored[]): string {
  return bodies.some((b) => usedBy(features, b.id)) ? " The copies are plain bodies: combines aren't copied." : "";
}

function makeAll(made: Body[], verb: string, from: Stored[]): void {
  if (!roomFor(made.length)) return;
  const changes = made.map((b) => commitAdd(b));
  record(changes);
  const ids = changes.filter((c): c is Change => !!c).map((c) => c.id);
  toolPanel = null;
  select(ids);
  if (ids.length) say(`${verb} ${ids.length} ${ids.length === 1 ? "body" : "bodies"}.${copiesNote(from)}`);
}

function duplicate(): void {
  const bodies = selectedBodies();
  if (!bodies.length) return say("Select the bodies to duplicate first.", true);
  // beside the originals, one grid step clear of them, as a group
  const size = boundsOf(bodies).getSize(new THREE.Vector3());
  const dx = Math.ceil((size.x + grid) / grid) * grid;
  makeAll(
    bodies.map((f) => ({ ...(featureOf(f) as Body), name: `${f.name} copy`, pos: [round(f.pos[0] + dx), f.pos[1], round(f.pos[2])] as Vec3 })),
    "Duplicated",
    bodies,
  );
}

function applyMirror(t: Extract<ToolPanel, { kind: "mirror" }>): void {
  if (!canEdit()) return;
  const bodies = selectedBodies();
  makeAll(bodies.map((f) => mirrorBody(featureOf(f) as Body, t.axis, t.at)), "Mirrored", bodies);
}

function applyPattern(t: Extract<ToolPanel, { kind: "pattern" }>): void {
  if (!canEdit()) return;
  const bodies = selectedBodies();
  const count = Math.round(t.count);
  if (count < 2 || count > 50) return say("A pattern has between 2 and 50 in its row, counting the original.", true);
  const i = { x: 0, y: 1, z: 2 }[t.axis];
  const made: Body[] = [];
  for (let k = 1; k < count; k++) {
    for (const f of bodies) {
      const pos = [...f.pos] as Vec3;
      pos[i] = round(pos[i] + k * t.spacing);
      made.push({ ...(featureOf(f) as Body), name: `${f.name} ${k + 1}`, pos });
    }
  }
  makeAll(made, "Patterned", bodies);
}

function openTool(kind: ToolPanel["kind"]): void {
  const bodies = selectedBodies();
  if (!bodies.length) return say(`Select the bodies to ${kind} first.`, true);
  if (kind === "mirror") toolPanel = { kind, axis: "x", at: 0 };
  else {
    const size = boundsOf(bodies).getSize(new THREE.Vector3());
    toolPanel = { kind, axis: "x", count: 3, spacing: Math.ceil((size.x + grid) / grid) * grid };
  }
  setMoving(false);
  renderPanel(true);
}

// A hole: a cylinder drilled square into the face you click, from a
// millimetre proud of it (so the cut opens cleanly) to the typed depth, and a
// cut that takes it from the body. Two features, one undo step.
function holeDrill(m: Extract<Mode, { kind: "hole" }>, hit: { point: THREE.Vector3; normal: THREE.Vector3; id: string | null }): Body | null {
  if (!hit.id) return null;
  const n = hit.normal.clone().normalize();
  const at = hit.point.clone();
  // on a flat, square-on face, snap across it to the grid
  if (Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) > 0.999) {
    for (const axis of ["x", "y", "z"] as const) if (Math.abs(n[axis]) < 0.5) at[axis] = snapValue(at[axis]);
  }
  const start = at.add(n.clone().multiplyScalar(1));
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().negate()), "XYZ");
  const deg = (a: number) => round(THREE.MathUtils.radToDeg(a));
  const count = [...features.values()].filter((f) => f.kind === "combine" && f.name.startsWith("Hole")).length + 1;
  return {
    kind: "cylinder",
    name: `Hole ${count} drill`,
    pos: [round(start.x), round(start.y), round(start.z)],
    rot: [deg(e.x), deg(e.y), deg(e.z)],
    colour: APPEARANCES[0][1],
    r: round(m.d / 2),
    h: round(m.depth + 1),
    chamfer: 0,
  };
}

function drill(e: PointerEvent): void {
  if (mode.kind !== "hole" || !canEdit()) return;
  const hit = vp.pick(e);
  if (!hit?.id) return say("Click a face of a body to drill into it.", true);
  const holder = heldByOther(hit.id);
  if (holder) return say(`${nameOf(holder)} is holding ${features.get(hit.id)?.name}. Drill it once they let go.`, true);
  const cyl = holeDrill(mode, hit);
  if (!cyl || !roomFor(2)) return;
  const made = commitAdd(cyl);
  if (!made) return;
  const name = cyl.name.replace(/ drill$/, "");
  const cut = commitAdd({ kind: "combine", name, op: "cut", target: hit.id, tools: [made.id] });
  record([made, cut]);
  say(`${name}: ${mode.d} mm across, ${mode.depth} mm deep, into ${features.get(hit.id)?.name}. Click again for another, Esc when done.`);
}

function renderToolPanel(t: ToolPanel): void {
  panel.hidden = false;
  if (panelKey === `tool:${t.kind}` && panel.contains(document.activeElement)) return;
  panelKey = `tool:${t.kind}`;
  const close = () => {
    toolPanel = null;
    renderPanel(true);
  };
  const choose = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
    const l = document.createElement("label");
    l.className = "wide";
    const span = document.createElement("span");
    span.textContent = label;
    const sel = document.createElement("select");
    for (const [v, text] of options) sel.add(new Option(text, v, false, v === value));
    sel.addEventListener("change", () => onChange(sel.value));
    l.append(span, sel);
    return l;
  };
  const names = selectedBodies().map((f) => f.name).join(", ");
  const note = document.createElement("p");
  note.className = "note";
  const fields = document.createElement("div");
  fields.className = "fields";
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  let title: string;
  let axisRow: HTMLElement;
  if (t.kind === "mirror") {
    title = "MIRROR";
    axisRow = choose("Across", [["x", "Left to right (X)"], ["z", "Front to back (Z)"]], t.axis, (v) => (t.axis = v as "x" | "z"));
    fields.append(numberField("Mirror plane at", t.at, (n) => (t.at = n)));
    note.textContent = `Makes a mirrored copy of ${names}. The originals stay.`;
    foot.append(button("Cancel", "", close), button("Mirror", "primary", () => applyMirror(t)));
  } else {
    title = "PATTERN";
    axisRow = choose("Along", [["x", "X"], ["y", "Y (up)"], ["z", "Z"]], t.axis, (v) => (t.axis = v as "x" | "y" | "z"));
    fields.append(
      numberField("Count", t.count, (n) => (t.count = n), "pcs"),
      numberField("Spacing", t.spacing, (n) => (t.spacing = n)),
    );
    note.textContent = `A row of ${names}, the original first, each one the spacing further along.`;
    foot.append(button("Cancel", "", close), button("Pattern", "primary", () => applyPattern(t)));
  }
  panel.replaceChildren(head(title, close), axisRow, fields, note, foot);
}

function renderHolePanel(): void {
  if (mode.kind !== "hole") return;
  const m = mode;
  panel.hidden = false;
  if (panelKey === "hole" && panel.contains(document.activeElement)) return;
  panelKey = "hole";
  const fields = document.createElement("div");
  fields.className = "fields";
  fields.append(
    numberField("Diameter", m.d, (n) => {
      if (n <= 0) return say("A hole needs a diameter bigger than zero.", true);
      m.d = n;
      refresh();
    }),
    numberField("Depth", m.depth, (n) => {
      if (n <= 0) return say("A hole needs a depth bigger than zero.", true);
      m.depth = n;
      refresh();
    }),
  );
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Click a face of a body to drill square into it. Each hole is a cylinder and a cut, both in the timeline, so you can change them later.";
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  foot.append(button("Done", "primary", cancelMode));
  panel.replaceChildren(head("HOLE", cancelMode), fields, note, foot);
}

// ---------- imported models: in this browser only ----------
// Opened and kept in the browser (importer.ts says why): drawn, moved and
// blown on by the wind here, never sent, never in the STL.

const imported = new Map<string, Imported>();
const importGeo = new Map<string, THREE.BufferGeometry>();
const importMesh = new Map<string, THREE.Mesh>();
let importSel: string | null = null;
const importMat = () => new THREE.MeshStandardMaterial({ color: 0xa88a5c, metalness: 0.45, roughness: 0.45 });

function placeImport(m: Imported): void {
  importGeo.get(m.id)?.dispose();
  const g = placedGeometry(m);
  importGeo.set(m.id, g);
  let mesh = importMesh.get(m.id);
  if (!mesh) {
    mesh = new THREE.Mesh(g, importMat());
    mesh.userData.id = `import:${m.id}`;
    importMesh.set(m.id, mesh);
    vp.bodies.add(mesh);
  }
  mesh.geometry = g;
  (mesh.material as THREE.MeshStandardMaterial).emissive.set(importSel === m.id ? 0x0c66e4 : 0x000000);
  (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = importSel === m.id ? 0.35 : 0;
  refresh();
}

function addImport(m: Imported): void {
  imported.set(m.id, m);
  placeImport(m);
  saveImport(m);
}

function removeImport(id: string): void {
  const mesh = importMesh.get(id);
  if (mesh) {
    vp.bodies.remove(mesh);
    (mesh.material as THREE.Material).dispose();
  }
  importGeo.get(id)?.dispose();
  importMesh.delete(id);
  importGeo.delete(id);
  imported.delete(id);
  forgetImport(id);
  if (importSel === id) importSel = null;
  setMoving(false);
  refresh();
}

function selectImport(id: string): void {
  select([]);
  importSel = id;
  for (const m of imported.values()) placeImport(m);
  setMoving(true);
  panelKey = "";
  refresh();
}

async function importFile(file: File): Promise<void> {
  say(`Opening ${file.name}…`);
  try {
    const read = await readModel(file);
    const m: Imported = { id: newId(), design: designId, name: file.name, ...read, pos: [0, 0, 0], rot: [0, 0, 0], keep: true };
    m.pos = standOnFloor(m);
    addImport(m);
    selectImport(m.id);
    vp.fit();
    say(`Opened ${file.name}, ${(read.positions.length / 9).toLocaleString()} triangles. Only you can see it: it stays in this browser and isn't uploaded.`);
  } catch (err) {
    say(`Couldn't open ${file.name}: ${err instanceof Error ? err.message : String(err)}.`, true);
  }
}

// models kept from earlier visits, in this browser
async function loadLocalModels(): Promise<void> {
  for (const m of await loadImports(designId)) {
    imported.set(m.id, m);
    placeImport(m);
  }
}

function renderImportPanel(m: Imported, force: boolean): void {
  panel.hidden = false;
  const key = `import:${m.id}:${m.unit}:${m.zUp}:${m.pos}:${m.rot}`;
  if (!force && key === panelKey) return;
  if (!force && panel.contains(document.activeElement) && panelKey.startsWith(`import:${m.id}`)) return;
  panelKey = key;
  const close = () => {
    importSel = null;
    setMoving(false);
    for (const x of imported.values()) placeImport(x);
  };
  const g = importGeo.get(m.id)!;
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const choose = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
    const l = document.createElement("label");
    l.className = "wide";
    const span = document.createElement("span");
    span.textContent = label;
    const sel = document.createElement("select");
    for (const [v, t] of options) sel.add(new Option(t, v, false, v === value));
    sel.addEventListener("change", () => onChange(sel.value));
    l.append(span, sel);
    return l;
  };
  const update = (next: Partial<Imported>) => {
    Object.assign(m, next);
    placeImport(m);
    saveImport(m);
    renderPanel(true);
  };
  const sizeNote = document.createElement("p");
  sizeNote.className = "note";
  sizeNote.textContent = `${round(size.x)} × ${round(size.y)} × ${round(size.z)} mm, ${(m.positions.length / 9).toLocaleString()} triangles.`;
  const units = choose("File units", [["mm", "Millimetres"], ["cm", "Centimetres"], ["m", "Metres"], ["in", "Inches"]], m.unit, (v) => update({ unit: v as Unit }));
  const up = choose("Up in the file", [["z", "Z is up"], ["y", "Y is up"]], m.zUp ? "z" : "y", (v) => update({ zUp: v === "z" }));
  const section = (t: string) => {
    const h = document.createElement("h3");
    h.textContent = t;
    return h;
  };
  const row = (vals: Vec3, unit: string, set: (v: Vec3) => void) => {
    const div = document.createElement("div");
    div.className = "fields three";
    ["X", "Y", "Z"].forEach((axis, i) =>
      div.append(
        numberField(axis, vals[i], (n) => {
          const next = [...vals] as Vec3;
          next[i] = round(n);
          set(next);
        }, unit),
      ),
    );
    return div;
  };
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "Only in your browser: it isn't uploaded, nobody else in this design sees it, and the STL export leaves it out.";
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  foot.append(
    button("Remove", "danger", () => removeImport(m.id)),
    button("Stand on floor", "", () => update({ pos: [m.pos[0], standOnFloor(m)[1], m.pos[2]] })),
    button("OK", "primary", close),
  );
  panel.replaceChildren(
    head("IMPORTED MODEL", close),
    sizeNote,
    units,
    up,
    section("Position · mm"),
    row(m.pos, "mm", (pos) => update({ pos })),
    section("Rotation · degrees"),
    row(m.rot, "°", (rot) => update({ rot })),
    note,
    foot,
  );
}

const importInput = document.createElement("input");
importInput.type = "file";
importInput.accept = ACCEPT;
importInput.hidden = true;
document.body.append(importInput);
importInput.addEventListener("change", () => {
  const f = importInput.files?.[0];
  importInput.value = "";
  if (f) importFile(f);
});
viewportEl.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
viewportEl.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  e.preventDefault();
  importFile(f);
});

// ---------- commands ----------

function cancelMode(): void {
  hideReadout();
  endDrag(false);
  endSlide(false);
  toolPanel = null;
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
  if (cmd === "import") return importInput.click();
  if (cmd === "duplicate") return duplicate();
  if (cmd === "mirror" || cmd === "pattern") return openTool(cmd);
  if (cmd === "hole") {
    select([]);
    mode = { kind: "hole", d: 6, depth: 10 };
    panelKey = "";
    return refresh();
  }
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

installTips();


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
  if (!readout.hidden && typed && !readoutInput.readOnly && /^[0-9.-]$/.test(e.key)) {
    e.preventDefault();
    readoutInput.value = e.key;
    readoutInput.focus();
    return;
  }
  if (e.key === "Escape" && !readout.hidden) return hideReadout();
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
  if (e.key.startsWith("Arrow") || e.key === "PageUp" || e.key === "PageDown") {
    if (nudge(e.key, e.shiftKey)) return e.preventDefault();
  }
  if (k === "d" && selection.size) return command("duplicate");
  if (k === "h") return command("hole");
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

// ---------- help for people new to it ----------

const emptyCard = $<HTMLElement>("empty");
function renderEmpty(): void {
  emptyCard.hidden = !started || features.size > 0 || imported.size > 0 || marker !== null || mode.kind !== "select";
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-start]")) {
  b.addEventListener("click", () => command(b.dataset.start ?? ""));
}

const helpButton = $<HTMLButtonElement>("help-button");
const helpList = $<HTMLElement>("help-list");
function setHelp(open: boolean): void {
  helpList.hidden = !open;
  helpButton.setAttribute("aria-expanded", String(open));
}
helpButton.addEventListener("click", () => setHelp(helpList.hidden === true));
document.addEventListener("pointerdown", (e) => {
  if (!helpList.hidden && !(e.target as Element).closest(".helpmenu")) setHelp(false);
});
$<HTMLButtonElement>("tour-again").addEventListener("click", () => {
  setHelp(false);
  beginTour();
});
$<HTMLButtonElement>("show-keys").addEventListener("click", () => {
  setHelp(false);
  $<HTMLDialogElement>("keys-dialog").showModal();
});
$<HTMLButtonElement>("empty-tour").addEventListener("click", beginTour);

// The tour. Steps that ask you to do something wait until you have, by
// watching the editor's own state; you can always skip on.
function beginTour(): void {
  if (tourRunning()) return;
  cancelMode();
  const touch = matchMedia("(pointer: coarse)").matches;
  const q = (sel: string) => () => document.querySelector(sel);
  const mine = () => [...features.values()].filter((f) => f.by === me?.id && isBodyFeature(f));
  let placedBefore = 0;
  let watching: { id: string; v: number } | null = null;
  const steps: Step[] = [
    {
      target: () => null,
      title: "Welcome to Bench",
      body: "Bench is 3D CAD you share: everyone with this link sees the same part, live. This tour takes about a minute and shows you the basics. You can leave it at any time.",
    },
    {
      target: q('[data-cmd="place:box"]'),
      title: "Add a shape",
      body: "Parts start from simple shapes. Click Box.",
      done: () => mode.kind === "place",
    },
    {
      target: q("#viewport"),
      title: "Put it down",
      body: "Now click anywhere on the grid. The faint blue box shows where it will go.",
      enter: () => (placedBefore = mine().length),
      done: () => mine().length > placedBefore,
    },
    {
      target: q("#viewport"),
      title: "Move it",
      body: `Drag one of the coloured arrows: red moves it along X, green up along Y, blue along Z. When you let go, type a number to move it exactly that far. ${touch ? "You can also drag the selected body with your finger." : "You can also drag the body itself across the floor."}`,
      enter: () => {
        const f = mine().sort((a, b) => b.seq - a.seq)[0];
        watching = f ? { id: f.id, v: f.v } : null;
        if (f && !selection.has(f.id)) select([f.id]);
      },
      done: () => !!watching && (features.get(watching.id)?.v ?? 0) > watching.v,
    },
    {
      target: () => (panel.hidden ? null : panel),
      title: "Every number can be typed",
      body: "The panel shows the selected body's sizes and position, in millimetres. Type a new width or height and press Enter. Chamfer bevels the edges.",
    },
    {
      target: () => document.querySelector('[data-cmd="duplicate"]')?.closest(".group") ?? null,
      title: "Make more from what you have",
      body: "Duplicate, Mirror and Pattern make copies. Hole drills a round hole into a face. Combine joins bodies into one, or cuts one out of another. Hover any button to see what it does.",
    },
    {
      target: q("#viewport"),
      title: "Look around",
      body: touch
        ? "One finger on empty space turns the view; two fingers pan and zoom. The cube in the corner jumps to front, top and side views."
        : "Drag empty space to turn the view, right-drag to pan, scroll to zoom. The cube in the corner jumps to front, top and side views. F fits the whole part.",
    },
    {
      target: q(".people"),
      title: "Working together",
      body: "Everyone in this design shows here. Their pointers, and anything they're holding, appear in their colour. Click someone to follow their view. Nobody can change a body you're holding.",
    },
    {
      target: q(".timeline"),
      title: "Undo, history and printing",
      body: "Every step is kept in order along the bottom; step back through it to see how the part was made. Undo takes back your own changes. STL in the ribbon downloads the part for a 3D printer. The ? up top brings this tour back.",
    },
  ];
  startTour(steps, () => say("That's the tour. The ? at the top has it again, and the keys."));
}

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

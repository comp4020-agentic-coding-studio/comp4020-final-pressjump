// The sheet editor. The server is the authority: this file shows what the
// server says the sheet holds, plus the edits it has sent and not yet had
// answered, and it puts a shape back (and says why) when an edit is refused.

import {
  FIELDS,
  KIND_NAMES,
  bounds,
  dimensionLine,
  geometryOf,
  mm,
  round,
  sameGeometry,
  snapPoints,
  translate,
  validateGeometry,
  type Geometry,
  type Kind,
  type Point,
  type Shape,
} from "../shared/geometry.ts";
import { cleanName, type ClientMessage, type Draft, type Person, type ServerMessage, type Sheet } from "../shared/protocol.ts";

const SVG = "http://www.w3.org/2000/svg";
const sheetId = location.pathname.split("/")[2] ?? "";

const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
const svg = $<SVGSVGElement>("canvas");
const stage = $<HTMLElement>("stage");
const panel = $<HTMLElement>("panel");
const offline = $<HTMLElement>("offline");
const coords = $<HTMLElement>("coords");
const connLabel = $<HTMLElement>("conn");
const message = $<HTMLElement>("message");
const nameInput = $<HTMLInputElement>("sheet-name");
const peopleList = $<HTMLUListElement>("people");
const meButton = $<HTMLButtonElement>("me");
const gridSelect = $<HTMLSelectElement>("grid");
const undoButton = $<HTMLButtonElement>("undo");
const redoButton = $<HTMLButtonElement>("redo");
const dialog = $<HTMLDialogElement>("name-dialog");
const dialogInput = $<HTMLInputElement>("name-input");

// ---------- who you are ----------
// A random token in this browser is the whole of identity: a second browser is
// a second person, and nobody signs up. Storage can be unavailable (a private
// window with storage blocked), in which case you are a new person each visit.

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
    // nothing to do: identity just will not outlive the tab
  }
}

function token(): string {
  let t = stored("bench.token");
  if (!t) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    store("bench.token", t);
  }
  return t;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x");
}

// ---------- state ----------

let me: Person | null = null;
let sheet: Sheet | null = null;
let live = false;
let fitted = false;
const shapes = new Map<string, Shape>();
// Shapes this client has changed and the server has not yet answered for.
const optimistic = new Set<string>();
const online = new Map<string, Person>();
const known = new Map<string, Person>();
let holds: Record<string, string> = {};
const selection = new Set<string>();
const remote = new Map<string, { x: number; y: number; draft?: Draft }>();
// What this client is showing in place of the stored geometry mid-drag.
const overrides = new Map<string, Geometry>();

type Change = { id: string; before: Geometry | null; after: Geometry | null };
const undoStack: Change[][] = [];
const redoStack: Change[][] = [];

type Tool = "select" | "line" | "rect" | "circle" | "dim";
let tool: Tool = "select";
let grid = Number(stored("bench.grid") ?? 5);
gridSelect.value = String(grid);
if (gridSelect.value !== String(grid)) grid = 5;

// screen = (mm - view.x) * view.k
const view = { x: 0, y: 0, k: 2 };

// ---------- messages to the person ----------

let messageTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, warn = false): void {
  message.textContent = text;
  message.classList.toggle("warn", warn);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.textContent = "";
  }, 7000);
}

function nameOf(id: string | undefined): string {
  if (!id) return "Someone";
  if (me && id === me.id) return "You";
  return known.get(id)?.name ?? online.get(id)?.name ?? "Someone";
}

function colourOf(id: string): string {
  return known.get(id)?.colour ?? online.get(id)?.colour ?? "#888";
}

// ---------- the connection ----------

let ws: WebSocket | null = null;
let retry = 500;

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?sheet=${encodeURIComponent(sheetId)}`);
  ws.addEventListener("open", () => {
    send({ t: "hello", token: token(), name: stored("bench.name") ?? "" });
  });
  ws.addEventListener("message", (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(e.data)) as ServerMessage;
    } catch {
      return;
    }
    receive(msg);
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
  offline.hidden = on || !fitted;
  connLabel.textContent = on ? "Live" : "Reconnecting…";
  connLabel.classList.toggle("live", on);
  if (!on) {
    cancelGesture();
    remote.clear();
    online.clear();
    renderPeople();
  }
  updateButtons();
  schedule();
}

function receive(msg: ServerMessage): void {
  switch (msg.t) {
    case "welcome": {
      me = msg.you;
      sheet = msg.sheet;
      retry = 500;
      shapes.clear();
      optimistic.clear();
      overrides.clear();
      for (const s of msg.shapes) shapes.set(s.id, s);
      for (const p of msg.authors) known.set(p.id, p);
      online.clear();
      for (const p of msg.people) {
        online.set(p.id, p);
        known.set(p.id, p);
      }
      holds = msg.holds;
      for (const id of [...selection]) if (!shapes.has(id)) selection.delete(id);
      showSheet();
      renderMe();
      renderPeople();
      if (!fitted) {
        fitted = true;
        fit();
        if (!stored("bench.name")) askName();
      }
      setLive(true);
      sendHold();
      renderPanel();
      return;
    }
    case "put": {
      const local = shapes.get(msg.shape.id);
      // An answer to an older edit of ours, overtaken by a newer one already
      // showing here: keep showing the newer one until its own answer comes.
      if (local && optimistic.has(local.id) && msg.shape.v < local.v) return;
      if (!local || msg.shape.v >= local.v) optimistic.delete(msg.shape.id);
      shapes.set(msg.shape.id, msg.shape);
      if (!known.has(msg.shape.by)) known.set(msg.shape.by, { id: msg.shape.by, name: "Someone", colour: "#888" });
      schedule();
      renderPanel();
      return;
    }
    case "del": {
      shapes.delete(msg.id);
      optimistic.delete(msg.id);
      if (selection.delete(msg.id)) {
        if (msg.by !== me?.id) say(`${nameOf(msg.by)} deleted a shape you had selected.`, true);
        if (gesture.kind === "move" || gesture.kind === "handle") cancelGesture();
        sendHold();
        renderPanel();
      }
      schedule();
      return;
    }
    case "people": {
      online.clear();
      for (const p of msg.people) {
        online.set(p.id, p);
        known.set(p.id, p);
      }
      if (me) {
        const updated = online.get(me.id);
        if (updated) me = updated;
      }
      for (const id of remote.keys()) if (!online.has(id)) remote.delete(id);
      renderPeople();
      renderMe();
      schedule();
      return;
    }
    case "holds": {
      holds = msg.holds;
      // Anything we had selected that someone else now holds is theirs.
      let lost = "";
      for (const id of [...selection]) {
        const holder = holds[id];
        if (holder && holder !== me?.id) {
          selection.delete(id);
          lost = holder;
        }
      }
      if (lost) {
        if (gesture.kind === "move" || gesture.kind === "handle") cancelGesture();
        say(`${nameOf(lost)} picked that up first.`, true);
        renderPanel();
      }
      schedule();
      return;
    }
    case "cursors": {
      for (const c of msg.cursors) if (c.id !== me?.id) remote.set(c.id, { x: c.x, y: c.y, draft: c.draft });
      for (const id of msg.gone) remote.delete(id);
      schedule();
      return;
    }
    case "sheet": {
      sheet = msg.sheet;
      showSheet();
      return;
    }
    case "reject": {
      // Put back what the server has, and say why in words.
      optimistic.delete(msg.id);
      if (msg.shape) shapes.set(msg.id, msg.shape);
      else shapes.delete(msg.id);
      if (!msg.shape) selection.delete(msg.id);
      say(`Not applied: ${msg.message}.`, true);
      schedule();
      renderPanel();
      return;
    }
    case "error": {
      say(msg.message, true);
      return;
    }
  }
}

function showSheet(): void {
  if (!sheet) return;
  if (document.activeElement !== nameInput) nameInput.value = sheet.name;
  document.title = `${sheet.name} · Bench`;
  ($<HTMLAnchorElement>("export-svg")).href = `/s/${sheet.id}/export.svg`;
  ($<HTMLAnchorElement>("export-dxf")).href = `/s/${sheet.id}/export.dxf`;
  schedule();
}

// ---------- edits ----------
// Each one is shown at once, sent with the version it was made against, and
// counted as pending until the server answers. The optimistic version is the
// one the server will give it if it is accepted, so a second edit sent before
// the first is answered still names the right base.

function commitAdd(g: Geometry): void {
  if (!me || !live) return;
  const id = newId();
  shapes.set(id, { ...g, id, v: 1, by: me.id });
  optimistic.add(id);
  send({ t: "add", id, g });
  record([{ id, before: null, after: g }]);
}

function commitUpdate(id: string, g: Geometry): Change | null {
  const current = shapes.get(id);
  if (!me || !live || !current) return null;
  const before = geometryOf(current);
  if (sameGeometry(before, g)) return null;
  shapes.set(id, { ...g, id, v: current.v + 1, by: me.id });
  optimistic.add(id);
  send({ t: "update", id, base: current.v, g });
  return { id, before, after: g };
}

function commitDelete(id: string): Change | null {
  const current = shapes.get(id);
  if (!me || !live || !current) return null;
  shapes.delete(id);
  optimistic.add(id);
  send({ t: "delete", id, base: current.v });
  return { id, before: geometryOf(current), after: null };
}

function record(changes: (Change | null)[]): void {
  const real = changes.filter((c): c is Change => c !== null);
  if (!real.length) return;
  undoStack.push(real);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  updateButtons();
  schedule();
}

function heldByOther(id: string): string | null {
  const h = holds[id];
  return h && h !== me?.id ? h : null;
}

// Undo only undoes your own change, and only if the shape is still exactly
// what you left it as. If someone has touched it since, it says so.
function replay(from: Change[][], to: Change[][], undo: boolean): void {
  if (!live) return say("Reconnecting; undo waits until the sheet is live.", true);
  const changes = from[from.length - 1];
  if (!changes) return;
  for (const c of changes) {
    const expected = undo ? c.after : c.before;
    const cur = shapes.get(c.id);
    const curG = cur ? geometryOf(cur) : null;
    const matches = expected === null ? curG === null : curG !== null && sameGeometry(curG, expected);
    if (!matches) {
      from.pop();
      updateButtons();
      return say(
        cur
          ? `Can't ${undo ? "undo" : "redo"}: ${nameOf(cur.by)} changed that ${KIND_NAMES[cur.kind].toLowerCase()} since.`
          : `Can't ${undo ? "undo" : "redo"}: someone deleted that shape since.`,
        true,
      );
    }
    const holder = heldByOther(c.id);
    if (holder) return say(`Can't ${undo ? "undo" : "redo"} yet: ${nameOf(holder)} is holding that shape.`, true);
  }
  from.pop();
  const ordered = undo ? [...changes].reverse() : changes;
  for (const c of ordered) {
    const target = undo ? c.before : c.after;
    if (target === null) commitDelete(c.id);
    else if (!shapes.has(c.id)) {
      if (!me) return;
      shapes.set(c.id, { ...target, id: c.id, v: 1, by: me.id });
      optimistic.add(c.id);
      send({ t: "add", id: c.id, g: target });
    } else commitUpdate(c.id, target);
  }
  to.push(changes);
  for (const c of changes) if (!shapes.has(c.id)) selection.delete(c.id);
  sendHold();
  updateButtons();
  renderPanel();
  schedule();
}

function updateButtons(): void {
  undoButton.disabled = !live || undoStack.length === 0;
  redoButton.disabled = !live || redoStack.length === 0;
}

let lastHold = "";
function sendHold(): void {
  const ids = [...selection].sort();
  const key = ids.join(",");
  if (key === lastHold && live) return;
  lastHold = key;
  send({ t: "hold", ids });
}

function select(ids: Iterable<string>): void {
  selection.clear();
  for (const id of ids) if (shapes.has(id) && !heldByOther(id)) selection.add(id);
  sendHold();
  renderPanel();
  schedule();
}

function deleteSelection(): void {
  if (!selection.size || !live) return;
  record([...selection].map(commitDelete));
  select([]);
}

function nudge(dx: number, dy: number): void {
  if (!selection.size || !live) return;
  record([...selection].map((id) => {
    const s = shapes.get(id);
    return s ? commitUpdate(id, translate(geometryOf(s), dx, dy)) : null;
  }));
  renderPanel();
}

// ---------- view ----------

function toScreen(p: Point): Point {
  return { x: (p.x - view.x) * view.k, y: (p.y - view.y) * view.k };
}

function toMm(sx: number, sy: number): Point {
  return { x: sx / view.k + view.x, y: sy / view.k + view.y };
}

function local(e: { clientX: number; clientY: number }): Point {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function fit(): void {
  if (!sheet) return;
  const r = svg.getBoundingClientRect();
  const margin = 24;
  const k = Math.min((r.width - margin * 2) / sheet.w, (r.height - margin * 2) / sheet.h);
  view.k = Math.max(0.05, k);
  view.x = sheet.w / 2 - r.width / 2 / view.k;
  view.y = sheet.h / 2 - r.height / 2 / view.k;
  schedule();
}

function zoomAt(screen: Point, factor: number): void {
  const before = toMm(screen.x, screen.y);
  view.k = Math.min(200, Math.max(0.05, view.k * factor));
  view.x = before.x - screen.x / view.k;
  view.y = before.y - screen.y / view.k;
  schedule();
}

// ---------- snapping ----------

type Snapped = { p: Point; kind: "point" | "grid" | "free" };

function displayed(id: string): Geometry | null {
  const o = overrides.get(id);
  if (o) return o;
  const s = shapes.get(id);
  return s ? geometryOf(s) : null;
}

function snap(raw: Point, exclude?: Set<string>): Snapped {
  const tolerance = 10 / view.k;
  let best: Point | null = null;
  let bestD = tolerance;
  for (const s of shapes.values()) {
    if (exclude?.has(s.id)) continue;
    const g = displayed(s.id);
    if (!g) continue;
    for (const p of snapPoints(g)) {
      const d = Math.hypot(p.x - raw.x, p.y - raw.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  if (best) return { p: { x: round(best.x), y: round(best.y) }, kind: "point" };
  if (grid > 0) return { p: { x: round(Math.round(raw.x / grid) * grid), y: round(Math.round(raw.y / grid) * grid) }, kind: "grid" };
  return { p: { x: Math.round(raw.x * 100) / 100, y: Math.round(raw.y * 100) / 100 }, kind: "free" };
}

// Shift holds a line to the nearest 45 degrees, and a rectangle square.
function constrain(from: Point, to: Point, kind: Tool): Point {
  if (kind === "rect") {
    const side = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    return { x: round(from.x + Math.sign(to.x - from.x || 1) * side), y: round(from.y + Math.sign(to.y - from.y || 1) * side) };
  }
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: round(from.x + Math.cos(a) * len), y: round(from.y + Math.sin(a) * len) };
}

function geometryFor(kind: Tool, a: Point, b: Point): Geometry | null {
  let g: unknown;
  switch (kind) {
    case "line":
      g = { kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      break;
    case "rect":
      g = { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      break;
    case "circle":
      g = { kind: "circle", cx: a.x, cy: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) };
      break;
    case "dim":
      g = { kind: "dim", x1: a.x, y1: a.y, x2: b.x, y2: b.y, off: 8 };
      break;
    default:
      return null;
  }
  const v = validateGeometry(g);
  return typeof v === "string" ? null : v;
}

// ---------- handles ----------

type Handle = { x: number; y: number; apply: (g: Geometry, p: Point) => Geometry };

function handlesFor(g: Geometry): Handle[] {
  switch (g.kind) {
    case "line":
      return [
        { x: g.x1, y: g.y1, apply: (h, p) => ({ ...(h as typeof g), x1: p.x, y1: p.y }) },
        { x: g.x2, y: g.y2, apply: (h, p) => ({ ...(h as typeof g), x2: p.x, y2: p.y }) },
      ];
    case "dim": {
      const d = dimensionLine(g);
      return [
        { x: g.x1, y: g.y1, apply: (h, p) => ({ ...(h as typeof g), x1: p.x, y1: p.y }) },
        { x: g.x2, y: g.y2, apply: (h, p) => ({ ...(h as typeof g), x2: p.x, y2: p.y }) },
        {
          x: (d.a.x + d.b.x) / 2,
          y: (d.a.y + d.b.y) / 2,
          apply: (h, p) => {
            const dg = h as typeof g;
            const n = dimensionLine({ ...dg, off: 0 });
            const mx = (dg.x1 + dg.x2) / 2;
            const my = (dg.y1 + dg.y2) / 2;
            return { ...dg, off: round((p.x - mx) * n.nx + (p.y - my) * n.ny) };
          },
        },
      ];
    }
    case "rect": {
      const corners = [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x + g.w, g.y + g.h],
        [g.x, g.y + g.h],
      ];
      return corners.map(([x, y], i) => {
        const [ox, oy] = corners[(i + 2) % 4];
        return {
          x,
          y,
          apply: (_h, p) => ({
            kind: "rect",
            x: Math.min(ox, p.x),
            y: Math.min(oy, p.y),
            w: round(Math.abs(p.x - ox)),
            h: round(Math.abs(p.y - oy)),
          }),
        };
      });
    }
    case "circle":
      return [
        {
          x: g.cx + g.r,
          y: g.cy,
          apply: (h, p) => {
            const c = h as typeof g;
            return { ...c, r: round(Math.hypot(p.x - c.cx, p.y - c.cy)) };
          },
        },
      ];
  }
}

// ---------- gestures ----------

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; pointer: number; from: Point; view: { x: number; y: number } }
  | { kind: "pinch"; d0: number; mid0: Point; view: { x: number; y: number; k: number } }
  | { kind: "move"; pointer: number; start: Point; anchor: Point; originals: Map<string, Geometry>; moved: boolean }
  | { kind: "handle"; pointer: number; id: string; index: number; original: Geometry }
  | { kind: "draw"; pointer: number | null; tool: Tool; a: Point; b: Point; down: Point };

let gesture: Gesture = { kind: "none" };
const pointers = new Map<number, Point>();
let snapMark: Snapped | null = null;
let spaceDown = false;
let lastPointer: Point | null = null;

function cancelGesture(): void {
  overrides.clear();
  gesture = { kind: "none" };
  snapMark = null;
  svg.classList.remove("panning");
  schedule();
}

function draft(): Draft | undefined {
  if (gesture.kind === "draw") {
    const g = geometryFor(gesture.tool, gesture.a, gesture.b);
    return g ? [g] : undefined;
  }
  if (overrides.size) return [...overrides.values()].slice(0, 50);
  return undefined;
}

let lastCursorSent = 0;
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
function sendCursor(): void {
  if (!lastPointer || !live) return;
  const now = performance.now();
  const wait = 40 - (now - lastCursorSent);
  clearTimeout(cursorTimer);
  if (wait > 0) {
    cursorTimer = setTimeout(sendCursor, wait);
    return;
  }
  lastCursorSent = now;
  const p = toMm(lastPointer.x, lastPointer.y);
  send({ t: "cursor", x: round(p.x), y: round(p.y), draft: draft() });
}

function itemAt(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.("[data-id]");
  return el ? el.getAttribute("data-id") : null;
}

svg.addEventListener("pointerdown", (e) => {
  const at = local(e);
  pointers.set(e.pointerId, at);
  svg.setPointerCapture(e.pointerId);

  if (pointers.size === 2) {
    // A second finger turns whatever was happening into pan and zoom.
    if (gesture.kind === "draw" && gesture.pointer === null) {
      // a click-click shape in progress survives a pinch
    } else cancelGesture();
    const [p, q] = [...pointers.values()];
    gesture = {
      kind: "pinch",
      d0: Math.hypot(p.x - q.x, p.y - q.y) || 1,
      mid0: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      view: { ...view },
    };
    return;
  }
  if (pointers.size > 2) return;

  if (e.button === 1 || e.button === 2 || spaceDown) {
    if (e.button === 2 && gesture.kind === "draw") return cancelGesture();
    gesture = { kind: "pan", pointer: e.pointerId, from: at, view: { x: view.x, y: view.y } };
    svg.classList.add("panning");
    return;
  }

  const raw = toMm(at.x, at.y);

  if (tool === "select") {
    const handle = (e.target as Element).closest?.("[data-handle]");
    if (handle && live) {
      const id = handle.getAttribute("data-handle-id") ?? "";
      const g = displayed(id);
      if (g && !heldByOther(id)) {
        gesture = { kind: "handle", pointer: e.pointerId, id, index: Number(handle.getAttribute("data-handle")), original: g };
        return;
      }
    }
    const id = itemAt(e.target);
    if (id && live) {
      const holder = heldByOther(id);
      if (holder) {
        say(`${nameOf(holder)} is holding that. It is yours to edit once they let go.`);
        return;
      }
      if (e.shiftKey) {
        const next = new Set(selection);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        select(next);
        if (!selection.has(id)) return;
      } else if (!selection.has(id)) select([id]);
      const originals = new Map<string, Geometry>();
      for (const sid of selection) {
        const g = displayed(sid);
        if (g) originals.set(sid, g);
      }
      // Drag by the snap point nearest the pointer, so a corner lands on a
      // corner, not wherever the shape happened to be grabbed.
      let anchor = raw;
      let best = 12 / view.k;
      for (const g of originals.values()) {
        for (const p of snapPoints(g)) {
          const d = Math.hypot(p.x - raw.x, p.y - raw.y);
          if (d < best) {
            best = d;
            anchor = p;
          }
        }
      }
      gesture = { kind: "move", pointer: e.pointerId, start: raw, anchor, originals, moved: false };
      return;
    }
    if (!e.shiftKey && selection.size) select([]);
    gesture = { kind: "pan", pointer: e.pointerId, from: at, view: { x: view.x, y: view.y } };
    svg.classList.add("panning");
    return;
  }

  if (!live) {
    say("Reconnecting; drawing is paused.", true);
    return;
  }
  const s = snap(raw);
  if (gesture.kind === "draw" && gesture.pointer === null) {
    // second click of a click-click shape
    const b = e.shiftKey ? constrain(gesture.a, s.p, gesture.tool) : s.p;
    finishDraw(gesture.a, b);
    return;
  }
  gesture = { kind: "draw", pointer: e.pointerId, tool, a: s.p, b: s.p, down: at };
  snapMark = s;
  schedule();
});

function finishDraw(a: Point, b: Point): void {
  if (gesture.kind !== "draw") return;
  const g = geometryFor(gesture.tool, a, b);
  if (!g) return; // zero length: keep waiting for a real second point
  commitAdd(g);
  if (gesture.tool === "line") {
    // Lines chain, end to start, until Escape or a double click.
    gesture = { kind: "draw", pointer: null, tool: "line", a: b, b, down: { x: 0, y: 0 } };
  } else {
    gesture = { kind: "none" };
  }
  sendCursor();
  schedule();
}

svg.addEventListener("pointermove", (e) => {
  const at = local(e);
  lastPointer = at;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, at);
  const raw = toMm(at.x, at.y);
  coords.textContent = `x ${mm(raw.x)}  y ${mm(raw.y)} mm`;

  switch (gesture.kind) {
    case "pinch": {
      if (pointers.size < 2) break;
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const g = gesture;
      const anchor = { x: g.mid0.x / g.view.k + g.view.x, y: g.mid0.y / g.view.k + g.view.y };
      view.k = Math.min(200, Math.max(0.05, g.view.k * (d / g.d0)));
      view.x = anchor.x - mid.x / view.k;
      view.y = anchor.y - mid.y / view.k;
      schedule();
      break;
    }
    case "pan": {
      if (e.pointerId !== gesture.pointer) break;
      view.x = gesture.view.x - (at.x - gesture.from.x) / view.k;
      view.y = gesture.view.y - (at.y - gesture.from.y) / view.k;
      schedule();
      break;
    }
    case "move": {
      if (e.pointerId !== gesture.pointer) break;
      const target = { x: raw.x + gesture.anchor.x - gesture.start.x, y: raw.y + gesture.anchor.y - gesture.start.y };
      const s = snap(target, new Set(gesture.originals.keys()));
      const dx = s.p.x - gesture.anchor.x;
      const dy = s.p.y - gesture.anchor.y;
      if (!gesture.moved && Math.hypot(raw.x - gesture.start.x, raw.y - gesture.start.y) * view.k < 3) break;
      gesture.moved = true;
      for (const [id, g] of gesture.originals) overrides.set(id, translate(g, dx, dy));
      snapMark = s;
      schedule();
      break;
    }
    case "handle": {
      if (e.pointerId !== gesture.pointer) break;
      const s = snap(raw, new Set([gesture.id]));
      const h = handlesFor(gesture.original)[gesture.index];
      if (h) {
        const g = validateGeometry(h.apply(gesture.original, s.p));
        if (typeof g !== "string") overrides.set(gesture.id, g);
      }
      snapMark = s;
      schedule();
      break;
    }
    case "draw": {
      if (gesture.pointer !== null && e.pointerId !== gesture.pointer) break;
      const s = snap(raw);
      gesture.b = e.shiftKey ? constrain(gesture.a, s.p, gesture.tool) : s.p;
      snapMark = s;
      schedule();
      break;
    }
    case "none": {
      if (tool !== "select") {
        snapMark = snap(raw);
        schedule();
      } else if (snapMark) {
        snapMark = null;
        schedule();
      }
      break;
    }
  }
  sendCursor();
});

function endPointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  switch (gesture.kind) {
    case "pinch":
      if (pointers.size < 2) gesture = { kind: "none" };
      break;
    case "pan":
      if (e.pointerId === gesture.pointer) {
        gesture = { kind: "none" };
        svg.classList.remove("panning");
      }
      break;
    case "move":
      if (e.pointerId !== gesture.pointer) break;
      if (gesture.moved && e.type === "pointerup") {
        const changes: (Change | null)[] = [];
        for (const [id, g] of overrides) changes.push(commitUpdate(id, g));
        record(changes);
      }
      overrides.clear();
      gesture = { kind: "none" };
      snapMark = null;
      renderPanel();
      break;
    case "handle":
      if (e.pointerId !== gesture.pointer) break;
      if (e.type === "pointerup") {
        const g = overrides.get(gesture.id);
        if (g) record([commitUpdate(gesture.id, g)]);
      }
      overrides.clear();
      gesture = { kind: "none" };
      snapMark = null;
      renderPanel();
      break;
    case "draw": {
      if (gesture.pointer !== e.pointerId) break;
      if (e.type !== "pointerup") return cancelGesture();
      const at = local(e);
      const dragged = Math.hypot(at.x - gesture.down.x, at.y - gesture.down.y) > 6;
      if (dragged) {
        finishDraw(gesture.a, gesture.b);
        if (gesture.kind === "draw" && gesture.tool === "line") gesture = { kind: "none" };
      } else {
        // a click, not a drag: the next click places the other end
        gesture.pointer = null;
      }
      break;
    }
  }
  schedule();
  sendCursor();
}

svg.addEventListener("pointerup", endPointer);
svg.addEventListener("pointercancel", endPointer);
svg.addEventListener("pointerleave", () => {
  coords.textContent = "x – y –";
  if (gesture.kind === "none") {
    snapMark = null;
    send({ t: "leave" });
    schedule();
  }
});
svg.addEventListener("dblclick", () => {
  if (gesture.kind === "draw") cancelGesture();
});
svg.addEventListener("contextmenu", (e) => e.preventDefault());

svg.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    zoomAt(local(e), factor);
  },
  { passive: false },
);

// ---------- keyboard ----------

function setTool(next: Tool): void {
  if (gesture.kind === "draw") cancelGesture();
  tool = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === next));
  }
  svg.classList.toggle("select", next === "select");
  if (next !== "select") snapMark = null;
  schedule();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
}

const KEYS: Record<string, Tool> = { v: "select", l: "line", r: "rect", c: "circle", d: "dim" };

document.addEventListener("keydown", (e) => {
  const typing = (e.target as Element).closest?.("input, select, textarea, dialog");
  if (e.key === " " && !typing) {
    spaceDown = true;
    e.preventDefault();
    return;
  }
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) replay(redoStack, undoStack, false);
    else replay(undoStack, redoStack, true);
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    replay(redoStack, undoStack, false);
    return;
  }
  if (mod) return;
  if (e.key === "Escape") {
    if (gesture.kind !== "none") cancelGesture();
    else select([]);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelection();
    return;
  }
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (arrows[e.key] && selection.size) {
    e.preventDefault();
    const step = (grid || 1) * (e.shiftKey ? 10 : 1);
    nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
    return;
  }
  const t = KEYS[e.key.toLowerCase()];
  if (t) setTool(t);
});

document.addEventListener("keyup", (e) => {
  if (e.key === " ") spaceDown = false;
});

undoButton.addEventListener("click", () => replay(undoStack, redoStack, true));
redoButton.addEventListener("click", () => replay(redoStack, undoStack, false));
$<HTMLButtonElement>("fit").addEventListener("click", fit);
gridSelect.addEventListener("change", () => {
  grid = Number(gridSelect.value);
  store("bench.grid", String(grid));
  schedule();
});

nameInput.addEventListener("change", () => {
  const name = cleanName(nameInput.value);
  if (name && live) send({ t: "rename", name });
  else if (sheet) nameInput.value = sheet.name;
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
});

// ---------- your name ----------

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
  dot.className = "dot";
  dot.style.background = me.colour;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = me.name;
  meButton.replaceChildren(dot, label);
}

function renderPeople(): void {
  const others = [...online.values()].filter((p) => p.id !== me?.id);
  peopleList.replaceChildren(
    ...others.slice(0, 8).map((p) => {
      const li = document.createElement("li");
      li.style.background = p.colour;
      const initial = document.createElement("span");
      initial.setAttribute("aria-hidden", "true");
      initial.textContent = p.name.slice(0, 1).toUpperCase();
      const name = document.createElement("span");
      name.className = "visually-hidden";
      name.textContent = p.name;
      li.append(initial, name);
      return li;
    }),
  );
  if (others.length > 8) {
    const li = document.createElement("li");
    li.style.background = "var(--muted)";
    li.textContent = `+${others.length - 8}`;
    peopleList.append(li);
  }
  peopleList.setAttribute(
    "aria-label",
    others.length ? `Also here: ${others.map((p) => p.name).join(", ")}` : "Nobody else is here yet",
  );
}

// ---------- the properties panel ----------
// Every geometric field of every shape can be typed here, plus the numbers a
// person thinks in (a line's length, a circle's diameter).

const LABELS: Record<string, string> = {
  x1: "X1",
  y1: "Y1",
  x2: "X2",
  y2: "Y2",
  x: "X",
  y: "Y",
  w: "Width",
  h: "Height",
  cx: "Centre X",
  cy: "Centre Y",
  r: "Radius",
  off: "Offset",
};

let panelFor = "";

function field(label: string, value: number, onChange: (n: number) => void): HTMLLabelElement {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.inputMode = "decimal";
  input.value = mm(value);
  input.dataset.value = mm(value);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) {
      input.value = input.dataset.value ?? "";
      return say("That needs to be a number of millimetres.", true);
    }
    onChange(n);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  l.append(input);
  return l;
}

function apply(id: string, next: Record<string, unknown>): void {
  const g = validateGeometry(next);
  if (typeof g === "string") {
    renderPanel(true);
    return say(`Not applied: ${g}.`, true);
  }
  record([commitUpdate(id, g)]);
  renderPanel(true);
}

function renderPanel(force = false): void {
  if (selection.size === 0) {
    panel.hidden = true;
    panelFor = "";
    return;
  }
  panel.hidden = false;
  if (selection.size > 1) {
    const h = document.createElement("h2");
    h.textContent = `${selection.size} shapes selected`;
    const row = document.createElement("div");
    row.className = "row";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", deleteSelection);
    row.append(del);
    const hint = document.createElement("p");
    hint.className = "by";
    hint.textContent = "Drag to move them together, or nudge with the arrow keys.";
    panel.replaceChildren(h, hint, row);
    panelFor = "";
    return;
  }
  const id = [...selection][0];
  const s = shapes.get(id);
  if (!s) return;
  const key = `${id}:${s.v}`;
  // Do not rebuild under someone's fingers while they are typing a number.
  if (!force && panelFor === key) return;
  if (!force && panel.contains(document.activeElement) && panelFor.startsWith(`${id}:`)) {
    for (const input of panel.querySelectorAll<HTMLInputElement>("input[data-field]")) {
      if (input === document.activeElement) continue;
      const v = (s as unknown as Record<string, number>)[input.dataset.field ?? ""];
      if (typeof v === "number") input.value = input.dataset.value = mm(v);
    }
    panelFor = key;
    return;
  }
  panelFor = key;
  const g = geometryOf(s);
  const raw = g as unknown as Record<string, number>;
  const h = document.createElement("h2");
  h.textContent = KIND_NAMES[g.kind];
  const fields = document.createElement("div");
  fields.className = "fields";
  for (const f of FIELDS[g.kind as Kind]) {
    const el = field(`${LABELS[f]} mm`, raw[f], (n) => apply(id, { ...g, [f]: n }));
    el.querySelector("input")!.dataset.field = f;
    fields.append(el);
  }
  const extra = document.createElement("div");
  extra.className = "fields";
  if (g.kind === "line" || g.kind === "dim") {
    const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    const angle = (Math.atan2(-(g.y2 - g.y1), g.x2 - g.x1) * 180) / Math.PI;
    extra.append(
      field("Length mm", len, (n) => {
        if (n <= 0) return say("A length has to be more than zero.", true);
        const k = n / len;
        apply(id, { ...g, x2: g.x1 + (g.x2 - g.x1) * k, y2: g.y1 + (g.y2 - g.y1) * k });
      }),
      field("Angle °", angle, (deg) => {
        const a = (deg * Math.PI) / 180;
        apply(id, { ...g, x2: g.x1 + Math.cos(a) * len, y2: g.y1 - Math.sin(a) * len });
      }),
    );
  } else if (g.kind === "circle") {
    extra.append(field("Diameter mm", g.r * 2, (n) => apply(id, { ...g, r: n / 2 })));
  }
  const by = document.createElement("p");
  by.className = "by";
  by.textContent = `Last changed by ${nameOf(s.by)}.`;
  const row = document.createElement("div");
  row.className = "row";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = "Delete";
  del.addEventListener("click", deleteSelection);
  row.append(del);
  panel.replaceChildren(h, fields, ...(extra.childElementCount ? [extra] : []), by, row);
}

// ---------- drawing the sheet ----------

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const world = el("g", {});
const sheetBg = el("rect", { class: "sheet-bg", x: 0, y: 0, width: 0, height: 0 });
const gridMinor = el("path", { fill: "none" });
const gridMajor = el("path", { fill: "none" });
const shapeLayer = el("g", {});
const draftLayer = el("g", {});
const previewLayer = el("g", {});
const overlay = el("g", {});
gridMinor.style.stroke = "var(--grid)";
gridMajor.style.stroke = "var(--grid-major)";
for (const g of [gridMinor, gridMajor]) g.setAttribute("vector-effect", "non-scaling-stroke");
world.append(sheetBg, gridMinor, gridMajor, shapeLayer, draftLayer, previewLayer);
svg.append(world, overlay);

function geometryElements(g: Geometry, cls: string): SVGElement[] {
  switch (g.kind) {
    case "line":
      return [el("line", { class: cls, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 })];
    case "rect":
      return [el("rect", { class: cls, x: g.x, y: g.y, width: g.w, height: g.h })];
    case "circle":
      return [el("circle", { class: cls, cx: g.cx, cy: g.cy, r: g.r })];
    case "dim": {
      const d = dimensionLine(g);
      const over = Math.sign(g.off || 1) * Math.min(2, 4 / view.k);
      const path =
        `M${g.x1} ${g.y1}L${d.a.x + d.nx * over} ${d.a.y + d.ny * over}` +
        `M${g.x2} ${g.y2}L${d.b.x + d.nx * over} ${d.b.y + d.ny * over}` +
        `M${d.a.x} ${d.a.y}L${d.b.x} ${d.b.y}`;
      const out: SVGElement[] = [el("path", { class: `${cls} dim`, d: path })];
      if (cls === "shape") {
        const fs = 12 / view.k;
        const side = Math.sign(g.off || 1);
        const mx = (d.a.x + d.b.x) / 2 + d.nx * side * fs * 0.7;
        const my = (d.a.y + d.b.y) / 2 + d.ny * side * fs * 0.7;
        let angle = (Math.atan2(d.b.y - d.a.y, d.b.x - d.a.x) * 180) / Math.PI;
        if (angle > 90 || angle < -90) angle += 180;
        const text = el("text", {
          class: "dim-text",
          x: mx,
          y: my,
          "font-size": fs,
          "dominant-baseline": "middle",
          transform: `rotate(${angle.toFixed(2)} ${mx} ${my})`,
        });
        text.textContent = mm(d.length);
        out.push(text);
      }
      return out;
    }
  }
}

const rendered = new Map<string, { node: SVGGElement; sig: string }>();

function renderShapes(): void {
  const seen = new Set<string>();
  let index = 0;
  for (const s of shapes.values()) {
    const g = displayed(s.id);
    if (!g) continue;
    seen.add(s.id);
    const holder = heldByOther(s.id);
    const cls = selection.has(s.id) ? "item selected" : holder ? "item held" : "item";
    const sig = `${JSON.stringify(g)}|${cls}|${holder ?? ""}|${g.kind === "dim" ? view.k.toFixed(3) : ""}`;
    let entry = rendered.get(s.id);
    if (!entry || entry.sig !== sig) {
      const node = el("g", { class: cls, "data-id": s.id });
      node.append(...geometryElements(g, "shape"), ...geometryElements(g, "hit"));
      if (holder) {
        for (const child of node.querySelectorAll<SVGElement>(".shape")) child.style.stroke = colourOf(holder);
      }
      if (entry) entry.node.replaceWith(node);
      entry = { node, sig };
      rendered.set(s.id, entry);
    }
    // keep stacking order the same as the server's
    if (shapeLayer.children[index] !== entry.node) shapeLayer.insertBefore(entry.node, shapeLayer.children[index] ?? null);
    index++;
  }
  for (const [id, entry] of rendered) {
    if (!seen.has(id)) {
      entry.node.remove();
      rendered.delete(id);
    }
  }
}

function renderGrid(): void {
  if (!sheet) return;
  sheetBg.setAttribute("width", String(sheet.w));
  sheetBg.setAttribute("height", String(sheet.h));
  let step = grid || 10;
  while (step * view.k < 8) step *= step === 1 || step === 10 || step === 100 ? 5 : 2;
  const major = step * (step === 5 || step === 50 ? 10 : 10);
  const lines = (s: number, skip: number): string => {
    let d = "";
    for (let x = 0; x <= sheet!.w + 1e-9; x += s) {
      if (skip && Math.abs(x / skip - Math.round(x / skip)) < 1e-6) continue;
      d += `M${round(x)} 0V${sheet!.h}`;
    }
    for (let y = 0; y <= sheet!.h + 1e-9; y += s) {
      if (skip && Math.abs(y / skip - Math.round(y / skip)) < 1e-6) continue;
      d += `M0 ${round(y)}H${sheet!.w}`;
    }
    return d;
  };
  gridMinor.setAttribute("d", lines(step, major));
  gridMajor.setAttribute("d", lines(major, 0));
}

function tag(x: number, y: number, text: string, colour: string, cls: string): SVGGElement {
  const g = el("g", { class: cls, transform: `translate(${Math.round(x)} ${Math.round(y)})` });
  const t = el("text", { class: "tag", x: 6, y: 13 });
  t.textContent = text;
  const bg = el("rect", { x: 0, y: 0, rx: 4, height: 18, width: Math.max(24, text.length * 6.6 + 12) });
  bg.style.fill = colour;
  g.append(bg, t);
  return g;
}

let gridKey = "";

function render(): void {
  world.setAttribute("transform", `matrix(${view.k} 0 0 ${view.k} ${-view.x * view.k} ${-view.y * view.k})`);
  const gk = `${view.k}|${grid}|${sheet?.w}|${sheet?.h}`;
  if (gk !== gridKey) {
    gridKey = gk;
    renderGrid();
  }
  renderShapes();

  // what other people are drawing or dragging, in their colour
  draftLayer.replaceChildren();
  for (const [id, c] of remote) {
    if (!c.draft) continue;
    for (const g of c.draft) {
      for (const node of geometryElements(g, "draft")) {
        node.style.stroke = colourOf(id);
        draftLayer.append(node);
      }
    }
  }

  // what you are drawing
  previewLayer.replaceChildren();
  if (gesture.kind === "draw") {
    const g = geometryFor(gesture.tool, gesture.a, gesture.b);
    if (g) previewLayer.append(...geometryElements(g, "preview"));
  }

  overlay.replaceChildren();

  // who is holding what
  const labelled = new Set<string>();
  for (const [id, holder] of Object.entries(holds)) {
    if (holder === me?.id || labelled.has(holder)) continue;
    const g = displayed(id);
    if (!g) continue;
    labelled.add(holder);
    const b = bounds(g);
    const p = toScreen({ x: b.x0, y: b.y0 });
    overlay.append(tag(p.x, p.y - 22, nameOf(holder), colourOf(holder), "hold-label"));
  }

  // handles on a single selected shape
  if (tool === "select" && selection.size === 1 && gesture.kind !== "move") {
    const id = [...selection][0];
    const g = displayed(id);
    if (g) {
      handlesFor(g).forEach((h, i) => {
        const p = toScreen(h);
        overlay.append(
          el("rect", { class: "handle", x: p.x - 6, y: p.y - 6, width: 12, height: 12, "data-handle": i, "data-handle-id": id }),
        );
      });
    }
  }

  if (snapMark && snapMark.kind === "point") {
    const p = toScreen(snapMark.p);
    overlay.append(el("rect", { class: "snap-mark", x: p.x - 5, y: p.y - 5, width: 10, height: 10 }));
  } else if (snapMark && snapMark.kind === "grid" && tool !== "select") {
    const p = toScreen(snapMark.p);
    overlay.append(el("circle", { class: "snap-mark", cx: p.x, cy: p.y, r: 3 }));
  }

  // everyone else's cursor
  for (const [id, c] of remote) {
    const p = toScreen(c);
    const colour = colourOf(id);
    const g = el("g", { class: "cursor-label", transform: `translate(${Math.round(p.x)} ${Math.round(p.y)})` });
    const arrow = el("path", { d: "M0 0L0 16L4.5 12L8 19L10.5 18L7 11L13 11Z", stroke: "#fff", "stroke-width": 1 });
    arrow.style.fill = colour;
    g.append(arrow, tag(12, 16, nameOf(id), colour, "name-label"));
    overlay.append(g);
  }
}

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

new ResizeObserver(() => schedule()).observe(stage);

if (!/^[A-Za-z0-9]{1,20}$/.test(sheetId)) {
  say("This is not a sheet address.", true);
} else {
  connect();
}
setTool("select");
updateButtons();

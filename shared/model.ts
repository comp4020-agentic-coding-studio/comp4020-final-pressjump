// The design model, shared by server and client. Every length is millimetres,
// every angle degrees, Y is up. A design is an ordered list of features (the
// timeline): bodies, each a primitive or an extruded sketch, and combines that
// join, cut or intersect bodies made earlier. The server runs validateFeature
// and checkReferences on everything it accepts; the client runs them too, but
// only so it can refuse early and say why.

export type Vec3 = [number, number, number];

export type Profile =
  | { type: "poly"; pts: [number, number][] }
  | { type: "circle"; cx: number; cy: number; r: number };

type Placed = { name: string; pos: Vec3; rot: Vec3; colour: string };

export type BoxF = Placed & { kind: "box"; w: number; h: number; d: number; fillet: number };
export type CylinderF = Placed & { kind: "cylinder"; r: number; h: number };
export type SphereF = Placed & { kind: "sphere"; r: number };
export type ConeF = Placed & { kind: "cone"; r1: number; r2: number; h: number };
export type TorusF = Placed & { kind: "torus"; R: number; r: number };
export type ExtrudeF = Placed & { kind: "extrude"; profile: Profile; depth: number };
export type CombineF = { kind: "combine"; name: string; op: "join" | "cut" | "intersect"; target: string; tools: string[] };

export type Body = BoxF | CylinderF | SphereF | ConeF | TorusF | ExtrudeF;
export type Feature = Body | CombineF;
export type Kind = Feature["kind"];
export type BodyKind = Body["kind"];

// What the server stores and sends: the feature plus who last changed it, the
// version it is at (up by exactly one on every accepted change) and its place
// in the timeline (fixed when it is made).
export type Meta = { id: string; v: number; by: string; seq: number };
export type Stored = Feature & Meta;

// The numbers each body kind carries besides its placement, with the smallest
// value each may take. Lengths below a micron are not lengths.
export const PARAMS = {
  box: { w: 0.001, h: 0.001, d: 0.001, fillet: 0 },
  cylinder: { r: 0.001, h: 0.001 },
  sphere: { r: 0.001 },
  cone: { r1: 0, r2: 0, h: 0.001 },
  torus: { R: 0.001, r: 0.001 },
  extrude: { depth: -Infinity },
} as const satisfies Record<BodyKind, Record<string, number>>;

export const KIND_NAMES: Record<Kind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  cone: "Cone",
  torus: "Torus",
  extrude: "Extrude",
  combine: "Combine",
};

export const PARAM_LABELS: Record<string, string> = {
  w: "Width",
  h: "Height",
  d: "Depth",
  fillet: "Fillet",
  r: "Radius",
  r1: "Bottom radius",
  r2: "Top radius",
  R: "Ring radius",
  depth: "Distance",
};

// Appearances, named the way a workshop names them.
export const APPEARANCES: [string, string][] = [
  ["Aluminium", "#b9bec4"],
  ["Steel", "#8a9097"],
  ["Black plastic", "#2b2d31"],
  ["White plastic", "#eceae4"],
  ["Blue anodised", "#2f6db5"],
  ["Red anodised", "#b8322e"],
  ["Brass", "#c9a44a"],
  ["Plywood", "#c8a57a"],
];

// A metre either way of the origin is far beyond anything this is for.
export const LIMIT = 10_000;
export const MAX_POINTS = 200;
export const MAX_TOOLS = 20;
export const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;

export const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;

const isBody = (k: string): k is BodyKind => k in PARAMS;

function num(raw: unknown, name: string, min = -LIMIT, max = LIMIT): number | string {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return `${name} must be a number`;
  if (raw < min) return min > 0 ? `${name} must be more than zero` : `${name} cannot be less than ${min}`;
  if (raw > max) return `${name} cannot be more than ${max} mm`;
  return round(raw);
}

function vec(raw: unknown, name: string): Vec3 | string {
  if (!Array.isArray(raw) || raw.length !== 3) return `${name} must be three numbers`;
  const out: number[] = [];
  for (const [i, axis] of ["X", "Y", "Z"].entries()) {
    const n = num(raw[i], `${name} ${axis}`);
    if (typeof n === "string") return n;
    out.push(n);
  }
  return out as Vec3;
}

export function cleanText(raw: unknown, max = 40): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Twice the signed area of a polygon.
export function area2(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

function profile(raw: unknown): Profile | string {
  if (typeof raw !== "object" || raw === null) return "a sketch profile is missing";
  const p = raw as Record<string, unknown>;
  if (p.type === "circle") {
    const cx = num(p.cx, "Centre X");
    const cy = num(p.cy, "Centre Y");
    const r = num(p.r, "Radius", 0.001);
    for (const n of [cx, cy, r]) if (typeof n === "string") return n;
    return { type: "circle", cx: cx as number, cy: cy as number, r: r as number };
  }
  if (p.type === "poly") {
    if (!Array.isArray(p.pts) || p.pts.length < 3) return "a sketch needs at least three points";
    if (p.pts.length > MAX_POINTS) return `a sketch holds at most ${MAX_POINTS} points`;
    const pts: [number, number][] = [];
    for (const pt of p.pts as unknown[]) {
      if (!Array.isArray(pt) || pt.length !== 2) return "each sketch point is two numbers";
      const x = num(pt[0], "Sketch X");
      const y = num(pt[1], "Sketch Y");
      if (typeof x === "string") return x;
      if (typeof y === "string") return y;
      pts.push([x, y]);
    }
    if (Math.abs(area2(pts)) < 0.002) return "a sketch profile has to enclose some area";
    return { type: "poly", pts };
  }
  return "unknown kind of sketch profile";
}

// Returns the cleaned feature, or a sentence saying what is wrong with it.
// References between features are checked separately, by checkReferences,
// because only the design knows what exists.
export function validateFeature(input: unknown): Feature | string {
  if (typeof input !== "object" || input === null) return "a feature has to be an object";
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(kind in KIND_NAMES)) return "unknown kind of feature";
  const name = cleanText(raw.name) || KIND_NAMES[kind as Kind];

  if (kind === "combine") {
    if (raw.op !== "join" && raw.op !== "cut" && raw.op !== "intersect") return "a combine joins, cuts or intersects";
    if (typeof raw.target !== "string" || !ID_PATTERN.test(raw.target)) return "a combine needs a target body";
    if (!Array.isArray(raw.tools) || raw.tools.length === 0) return "a combine needs at least one tool body";
    if (raw.tools.length > MAX_TOOLS) return `a combine takes at most ${MAX_TOOLS} tool bodies`;
    const tools = raw.tools.filter((t): t is string => typeof t === "string" && ID_PATTERN.test(t));
    if (tools.length !== raw.tools.length) return "a combine's tools are body ids";
    if (new Set(tools).size !== tools.length) return "a body can only be a tool once in a combine";
    if (tools.includes(raw.target)) return "a body cannot combine with itself";
    return { kind, name, op: raw.op, target: raw.target, tools };
  }

  if (!isBody(kind)) return "unknown kind of feature";
  const pos = vec(raw.pos, "Position");
  if (typeof pos === "string") return pos;
  const rotRaw = vec(raw.rot, "Rotation");
  if (typeof rotRaw === "string") return rotRaw;
  // angles are kept in (-180, 180] so the same orientation is the same numbers
  const rot = rotRaw.map((a) => round(((((a + 180) % 360) + 360) % 360) - 180 || 0)).map((a) => (a === -180 ? 180 : a)) as Vec3;
  const colour = typeof raw.colour === "string" && /^#[0-9a-f]{6}$/i.test(raw.colour) ? raw.colour.toLowerCase() : APPEARANCES[0][1];
  const out: Record<string, unknown> = { kind, name, pos, rot, colour };

  const params: Record<string, number> = PARAMS[kind];
  for (const [key, min] of Object.entries(params)) {
    const n = num(raw[key], PARAM_LABELS[key] ?? key, min === -Infinity ? -LIMIT : min);
    if (typeof n === "string") return n;
    out[key] = n;
  }
  if (kind === "box") {
    const b = out as BoxF;
    if (b.fillet * 2 >= Math.min(b.w, b.h, b.d)) return "a fillet has to be less than half the box's smallest side";
  }
  if (kind === "cone") {
    const c = out as ConeF;
    if (c.r1 < 0.001 && c.r2 < 0.001) return "a cone needs at least one radius";
  }
  if (kind === "torus") {
    const t = out as TorusF;
    if (t.r >= t.R) return "a torus's tube has to be thinner than its ring";
  }
  if (kind === "extrude") {
    const e = out as ExtrudeF;
    if (Math.abs(e.depth) < 0.001) return "an extrude has to go some distance";
    const p = profile(raw.profile);
    if (typeof p === "string") return p;
    e.profile = p;
  }
  return out as Feature;
}

export const isBodyFeature = (f: Feature): f is Body => f.kind !== "combine";

// The combine that uses this body as a tool or target, if any.
export function usedBy(design: Map<string, Stored>, id: string): Stored | undefined {
  for (const f of design.values()) {
    if (f.kind === "combine" && (f.target === id || f.tools.includes(id))) return f;
  }
  return undefined;
}

// Checks a feature against the design it is joining or changing. `self` is
// the feature being changed, absent for a new one. Returns a reason or null.
export function checkReferences(design: Map<string, Stored>, f: Feature, self?: Stored): string | null {
  if (f.kind !== "combine") return null;
  const seq = self?.seq ?? Infinity;
  const name = (id: string): string => design.get(id)?.name ?? "that body";
  for (const id of [f.target, ...f.tools]) {
    const ref = design.get(id);
    if (!ref) return "a body this combine uses has been deleted";
    if (ref.kind === "combine") return "a combine works on bodies, not on other combines";
    if (ref.seq >= seq) return `${ref.name} comes after this combine in the timeline`;
  }
  for (const other of design.values()) {
    if (other.kind !== "combine" || other.id === self?.id) continue;
    for (const t of f.tools) {
      if (other.tools.includes(t)) return `${name(t)} is already used up by ${other.name}`;
    }
    if (other.tools.includes(f.target)) return `${name(f.target)} is already used up by ${other.name}`;
    // a tool cannot be a body that later combines target, or the order breaks
    for (const t of f.tools) {
      if (other.target === t && other.seq > seq) return `${name(t)} is changed later by ${other.name}`;
    }
  }
  return null;
}

export function sameFeature(a: Feature, b: Feature): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function featureOf(s: Stored): Feature {
  const { id: _id, v: _v, by: _by, seq: _seq, ...f } = s;
  return f as Feature;
}

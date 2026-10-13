// The drawing model, shared by server and client. Every number is millimetres.
// The server runs validateGeometry on everything it accepts; the client runs it
// too, but only so it can refuse early and say why.

export type LineGeom = { kind: "line"; x1: number; y1: number; x2: number; y2: number };
export type RectGeom = { kind: "rect"; x: number; y: number; w: number; h: number };
export type CircleGeom = { kind: "circle"; cx: number; cy: number; r: number };
export type DimGeom = { kind: "dim"; x1: number; y1: number; x2: number; y2: number; off: number };
export type Geometry = LineGeom | RectGeom | CircleGeom | DimGeom;
export type Kind = Geometry["kind"];

// What the server stores and sends: geometry plus who last changed it and the
// version it is at. `v` goes up by exactly one on every accepted change.
export type Shape = Geometry & { id: string; v: number; by: string };

export type Point = { x: number; y: number };

export const FIELDS = {
  line: ["x1", "y1", "x2", "y2"],
  rect: ["x", "y", "w", "h"],
  circle: ["cx", "cy", "r"],
  dim: ["x1", "y1", "x2", "y2", "off"],
} as const satisfies Record<Kind, readonly string[]>;

export const KIND_NAMES: Record<Kind, string> = {
  line: "Line",
  rect: "Rectangle",
  circle: "Circle",
  dim: "Dimension",
};

// A metre either way of the origin is far beyond any machine bed this is for,
// and keeps a typo like 10000000 from producing a sheet nobody can find.
export const LIMIT = 10_000;
// Shortest length and smallest radius accepted: one micron.
export const EPS = 0.001;

export const round = (n: number): number => Math.round(n * 1000) / 1000;

export const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;

// Returns the cleaned geometry, or a sentence saying what is wrong with it.
export function validateGeometry(input: unknown): Geometry | string {
  if (typeof input !== "object" || input === null) return "a shape has to be an object";
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(kind in FIELDS)) return "unknown kind of shape";
  const fields: readonly string[] = FIELDS[kind as Kind];
  const out: Record<string, unknown> = { kind };
  for (const f of fields) {
    const n = raw[f];
    if (typeof n !== "number" || !Number.isFinite(n)) return `${f} must be a number`;
    if (Math.abs(n) > LIMIT) return `${f} is more than ${LIMIT} mm from the origin`;
    out[f] = round(n);
  }
  const g = out as Geometry;
  switch (g.kind) {
    case "line":
    case "dim":
      if (Math.hypot(g.x2 - g.x1, g.y2 - g.y1) < EPS) return "a line needs two different ends";
      break;
    case "rect":
      if (g.w < EPS || g.h < EPS) return "a rectangle needs a positive width and height";
      break;
    case "circle":
      if (g.r < EPS) return "a circle needs a positive radius";
      break;
  }
  return g;
}

export function geometryOf(s: Shape): Geometry {
  const out: Record<string, unknown> = { kind: s.kind };
  for (const f of FIELDS[s.kind]) out[f] = (s as unknown as Record<string, number>)[f];
  return out as Geometry;
}

export function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (a.kind !== b.kind) return false;
  const ra = a as unknown as Record<string, number>;
  const rb = b as unknown as Record<string, number>;
  return FIELDS[a.kind].every((f) => ra[f] === rb[f]);
}

export function translate(g: Geometry, dx: number, dy: number): Geometry {
  switch (g.kind) {
    case "line":
      return { ...g, x1: round(g.x1 + dx), y1: round(g.y1 + dy), x2: round(g.x2 + dx), y2: round(g.y2 + dy) };
    case "dim":
      return { ...g, x1: round(g.x1 + dx), y1: round(g.y1 + dy), x2: round(g.x2 + dx), y2: round(g.y2 + dy) };
    case "rect":
      return { ...g, x: round(g.x + dx), y: round(g.y + dy) };
    case "circle":
      return { ...g, cx: round(g.cx + dx), cy: round(g.cy + dy) };
  }
}

// Points a cursor snaps to: ends, corners, middles and centres.
export function snapPoints(g: Geometry): Point[] {
  switch (g.kind) {
    case "line":
    case "dim":
      return [
        { x: g.x1, y: g.y1 },
        { x: g.x2, y: g.y2 },
        { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 },
      ];
    case "rect":
      return [
        { x: g.x, y: g.y },
        { x: g.x + g.w, y: g.y },
        { x: g.x + g.w, y: g.y + g.h },
        { x: g.x, y: g.y + g.h },
        { x: g.x + g.w / 2, y: g.y + g.h / 2 },
      ];
    case "circle":
      return [
        { x: g.cx, y: g.cy },
        { x: g.cx + g.r, y: g.cy },
        { x: g.cx - g.r, y: g.cy },
        { x: g.cx, y: g.cy + g.r },
        { x: g.cx, y: g.cy - g.r },
      ];
  }
}

// A dimension's drawn line sits `off` millimetres to the left of the measured
// segment (looking from point 1 to point 2). Shared so the editor and the SVG
// export draw it in the same place.
export function dimensionLine(g: DimGeom): { a: Point; b: Point; nx: number; ny: number; length: number } {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const length = Math.hypot(dx, dy) || 1;
  const nx = dy / length;
  const ny = -dx / length;
  return {
    a: { x: g.x1 + nx * g.off, y: g.y1 + ny * g.off },
    b: { x: g.x2 + nx * g.off, y: g.y2 + ny * g.off },
    nx,
    ny,
    length: Math.hypot(dx, dy),
  };
}

// Millimetres as a person reads them: up to two decimals, no trailing zeros.
export function mm(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function bounds(g: Geometry): { x0: number; y0: number; x1: number; y1: number } {
  switch (g.kind) {
    case "line":
    case "dim":
      return {
        x0: Math.min(g.x1, g.x2),
        y0: Math.min(g.y1, g.y2),
        x1: Math.max(g.x1, g.x2),
        y1: Math.max(g.y1, g.y2),
      };
    case "rect":
      return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    case "circle":
      return { x0: g.cx - g.r, y0: g.cy - g.r, x1: g.cx + g.r, y1: g.cy + g.r };
  }
}

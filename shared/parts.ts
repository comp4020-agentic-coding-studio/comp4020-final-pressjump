// Ready-made parts and features: bolts, nuts, washers, gears, brackets,
// countersunk holes and the rest. Each is a recipe that turns a few typed
// numbers into ordinary features (primitives, extruded sketches and cut or
// join combines), so the server, holds, undo and the STL treat them like
// anything drawn by hand, and every number stays typeable afterwards on the
// pieces they made.
//
// A recipe works in its own frame: Y up, the origin where you click. A part
// stands on the face you click; a feature that cuts into a face ("into")
// has its +Y pointing into the body and starts a millimetre proud of the
// surface, so the cut opens cleanly. placeSteps turns that frame to the face.
//
// What is not modelled is said, not faked: threads (a bolt's shank is its
// nominal diameter) and true involute gear teeth.

import * as THREE from "three";
import type { Body, Feature, Vec3 } from "./model.ts";

export type Param = { key: string; label: string; unit: "mm" | "°" | "pcs"; min: number; max?: number; whole?: boolean };
// a combine names what it uses by these refs, turned into ids when it is made
export type Step = { ref: string; f: Feature };
export type PartDef = {
  id: string;
  name: string;
  into: boolean; // cuts into the face clicked, rather than standing on it
  note: string;
  params: Param[];
  defaults: Record<string, number>;
  presets?: { label: string; values: Record<string, number> }[];
  build: (v: Record<string, number>) => Step[];
  check?: (v: Record<string, number>) => string | null;
};

const STEEL = "#8a9097", ALU = "#b9bec4", BLACK = "#2b2d31", BRASS = "#c9a44a";
const base = (name: string, colour: string, pos: Vec3, rot: Vec3 = [0, 0, 0]) => ({ name, colour, pos, rot });

const cyl = (name: string, colour: string, r: number, h: number, y = 0, x = 0, z = 0, rot: Vec3 = [0, 0, 0]): Body => ({
  ...base(name, colour, [x, y, z], rot),
  kind: "cylinder",
  r,
  h,
  chamfer: 0,
});
const box = (name: string, colour: string, w: number, h: number, d: number, pos: Vec3): Body => ({ ...base(name, colour, pos), kind: "box", w, h, d, fillet: 0, chamfer: 0 });
// a sketch standing up: its outline lies on the floor, pulled up by `h`
const prism = (name: string, colour: string, pts: [number, number][], h: number, y = 0): Body => ({
  ...base(name, colour, [0, y, 0], [-90, 0, 0]),
  kind: "extrude",
  depth: h,
  profile: { type: "poly", pts: pts.map(([x, z]) => [x, -z] as [number, number]) },
});
const polygon = (n: number, r: number, turn = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = turn + (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
  });
// a hexagon by its width across flats, as spanners measure it
const hexagon = (s: number) => polygon(6, s / Math.sqrt(3), Math.PI / 6);
const cut = (name: string, target: string, tools: string[]): Feature => ({ kind: "combine", name, op: "cut", target, tools });
const join = (name: string, target: string, tools: string[]): Feature => ({ kind: "combine", name, op: "join", target, tools });

const P = (key: string, label: string, unit: Param["unit"], min: number, extra: Partial<Param> = {}): Param => ({ key, label, unit, min, ...extra });

// ISO metric sizes: hex bolts ISO 4017, socket caps ISO 4762, nuts ISO 4032,
// washers ISO 7089 (normal series)
const SIZES = ["M3", "M4", "M5", "M6", "M8", "M10", "M12"];
const D = [3, 4, 5, 6, 8, 10, 12];
const HEX_S = [5.5, 7, 8, 10, 13, 16, 18];
const HEX_K = [2, 2.8, 3.5, 4, 5.3, 6.4, 7.5];
const CAP_DK = [5.5, 7, 8.5, 10, 13, 16, 18];
const CAP_K = [3, 4, 5, 6, 8, 10, 12];
const CAP_S = [2.5, 3, 4, 5, 6, 8, 10];
const NUT_M = [2.4, 3.2, 4.7, 5.2, 6.8, 8.4, 10.8];
const WASH = [[3.2, 7, 0.5], [4.3, 9, 0.8], [5.3, 10, 1], [6.4, 12, 1.6], [8.4, 16, 1.6], [10.5, 20, 2], [13, 24, 2.5]];
const presets = (f: (i: number) => Record<string, number>) => SIZES.map((label, i) => ({ label, values: f(i) }));

const THREADS = "Threads aren't modelled: the shank is the nominal diameter, which is what a clearance hole and a printed fit need.";

export const PARTS: PartDef[] = [
  {
    id: "bolt",
    name: "Hex bolt",
    into: false,
    note: `ISO 4017 sizes. ${THREADS}`,
    params: [P("d", "Diameter", "mm", 0.5), P("L", "Length", "mm", 1), P("s", "Head across flats", "mm", 1), P("k", "Head height", "mm", 0.5)],
    defaults: { d: 6, L: 20, s: 10, k: 4 },
    presets: presets((i) => ({ d: D[i], s: HEX_S[i], k: HEX_K[i] })),
    check: (v) => (v.s <= v.d ? "the head has to be wider than the shank" : null),
    build: (v) => [
      { ref: "shank", f: cyl("Bolt", STEEL, v.d / 2, v.L) },
      { ref: "head", f: prism("Bolt head", STEEL, hexagon(v.s), v.k, v.L) },
      { ref: "j", f: join("Bolt", "shank", ["head"]) },
    ],
  },
  {
    id: "screw",
    name: "Socket screw",
    into: false,
    note: `ISO 4762 socket head cap screw sizes. ${THREADS}`,
    params: [P("d", "Diameter", "mm", 0.5), P("L", "Length", "mm", 1), P("dk", "Head diameter", "mm", 1), P("k", "Head height", "mm", 0.5), P("sk", "Hex key size", "mm", 0.5)],
    defaults: { d: 6, L: 20, dk: 10, k: 6, sk: 5 },
    presets: presets((i) => ({ d: D[i], dk: CAP_DK[i], k: CAP_K[i], sk: CAP_S[i] })),
    check: (v) => (v.dk <= v.d ? "the head has to be wider than the shank" : v.sk >= v.dk ? "the hex socket has to fit inside the head" : null),
    build: (v) => [
      { ref: "shank", f: cyl("Socket screw", BLACK, v.d / 2, v.L) },
      { ref: "head", f: cyl("Screw head", BLACK, v.dk / 2, v.k, v.L) },
      { ref: "j", f: join("Socket screw", "shank", ["head"]) },
      { ref: "socket", f: prism("Hex socket", BLACK, hexagon(v.sk), v.k * 0.6 + 1, v.L + v.k * 0.4) },
      { ref: "c", f: cut("Hex socket", "shank", ["socket"]) },
    ],
  },
  {
    id: "nut",
    name: "Hex nut",
    into: false,
    note: `ISO 4032 sizes. ${THREADS.replace("the shank is the nominal diameter", "the hole is the nominal diameter")}`,
    params: [P("d", "Hole diameter", "mm", 0.5), P("s", "Across flats", "mm", 1), P("m", "Height", "mm", 0.5)],
    defaults: { d: 6, s: 10, m: 5.2 },
    presets: presets((i) => ({ d: D[i], s: HEX_S[i], m: NUT_M[i] })),
    check: (v) => (v.d >= v.s ? "the hole has to be smaller than the nut" : null),
    build: (v) => [
      { ref: "nut", f: prism("Nut", STEEL, hexagon(v.s), v.m) },
      { ref: "hole", f: cyl("Nut hole", STEEL, v.d / 2, v.m + 2, -1) },
      { ref: "c", f: cut("Nut", "nut", ["hole"]) },
    ],
  },
  {
    id: "washer",
    name: "Washer",
    into: false,
    note: "ISO 7089 normal series sizes.",
    params: [P("d1", "Hole diameter", "mm", 0.5), P("d2", "Outside diameter", "mm", 1), P("h", "Thickness", "mm", 0.1)],
    defaults: { d1: 6.4, d2: 12, h: 1.6 },
    presets: presets((i) => ({ d1: WASH[i][0], d2: WASH[i][1], h: WASH[i][2] })),
    check: (v) => (v.d1 >= v.d2 ? "the hole has to be smaller than the washer" : null),
    build: (v) => [
      { ref: "w", f: cyl("Washer", STEEL, v.d2 / 2, v.h) },
      { ref: "hole", f: cyl("Washer hole", STEEL, v.d1 / 2, v.h + 2, -1) },
      { ref: "c", f: cut("Washer", "w", ["hole"]) },
    ],
  },
  {
    id: "standoff",
    name: "Standoff",
    into: false,
    note: "A hex spacer with a hole through, for lifting a board off a plate.",
    params: [P("d", "Hole diameter", "mm", 0.5), P("s", "Across flats", "mm", 1), P("L", "Length", "mm", 1)],
    defaults: { d: 3.2, s: 5.5, L: 10 },
    check: (v) => (v.d >= v.s ? "the hole has to be smaller than the standoff" : null),
    build: (v) => [
      { ref: "body", f: prism("Standoff", BRASS, hexagon(v.s), v.L) },
      { ref: "hole", f: cyl("Standoff hole", BRASS, v.d / 2, v.L + 2, -1) },
      { ref: "c", f: cut("Standoff", "body", ["hole"]) },
    ],
  },
  {
    id: "tube",
    name: "Tube",
    into: false,
    note: "A round tube or pipe, standing up.",
    params: [P("od", "Outside diameter", "mm", 1), P("id", "Inside diameter", "mm", 0.1), P("L", "Length", "mm", 1)],
    defaults: { od: 20, id: 16, L: 50 },
    check: (v) => (v.id >= v.od ? "the inside has to be smaller than the outside" : null),
    build: (v) => [
      { ref: "t", f: cyl("Tube", ALU, v.od / 2, v.L) },
      { ref: "bore", f: cyl("Tube bore", ALU, v.id / 2, v.L + 2, -1) },
      { ref: "c", f: cut("Tube", "t", ["bore"]) },
    ],
  },
  {
    id: "plate",
    name: "Mounting plate",
    into: false,
    note: "A flat plate with a hole near each corner.",
    params: [P("w", "Width", "mm", 1), P("d", "Depth", "mm", 1), P("t", "Thickness", "mm", 0.5), P("hole", "Hole diameter", "mm", 0.5), P("inset", "Hole inset", "mm", 0.5)],
    defaults: { w: 80, d: 60, t: 4, hole: 3.4, inset: 6 },
    check: (v) => (v.inset * 2 >= Math.min(v.w, v.d) || v.hole / 2 >= v.inset ? "the holes have to sit inside the plate" : null),
    build: (v) => {
      const hx = v.w / 2 - v.inset, hz = v.d / 2 - v.inset;
      const holes = [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]].map(([x, z], i) => ({ ref: `h${i}`, f: cyl("Plate hole", ALU, v.hole / 2, v.t + 2, -1, x, z) }));
      return [{ ref: "plate", f: { ...box("Plate", ALU, v.w, v.t, v.d, [0, 0, 0]), chamfer: Math.min(0.5, v.t / 4) } as Body }, ...holes, { ref: "c", f: cut("Plate", "plate", holes.map((h) => h.ref)) }];
    },
  },
  {
    id: "bracket",
    name: "L-bracket",
    into: false,
    note: "An angle bracket: a foot and an upright, each with a hole.",
    params: [P("w", "Width", "mm", 1), P("a", "Leg length", "mm", 1), P("t", "Thickness", "mm", 0.5), P("hole", "Hole diameter", "mm", 0.5)],
    defaults: { w: 30, a: 30, t: 3, hole: 4.3 },
    check: (v) => (v.t * 2 >= v.a ? "the legs have to be longer than twice the thickness" : v.hole >= Math.min(v.w, v.a - v.t) ? "the holes have to fit on the legs" : null),
    build: (v) => [
      { ref: "foot", f: box("Bracket", ALU, v.w, v.t, v.a, [0, 0, 0]) },
      { ref: "up", f: box("Bracket upright", ALU, v.w, v.a - v.t, v.t, [0, v.t, -v.a / 2 + v.t / 2]) },
      { ref: "j", f: join("Bracket", "foot", ["up"]) },
      { ref: "h1", f: cyl("Bracket hole", ALU, v.hole / 2, v.t + 2, -1, 0, (v.t + v.a / 2) / 2) },
      { ref: "h2", f: cyl("Bracket hole", ALU, v.hole / 2, v.t + 2, v.t + (v.a - v.t) / 2, 0, -v.a / 2 - 1, [90, 0, 0]) },
      { ref: "c", f: cut("Bracket holes", "foot", ["h1", "h2"]) },
    ],
  },
  {
    id: "gear",
    name: "Spur gear",
    into: false,
    note: "Teeth are simple trapezoids at the right module and count, not involute curves: good for looks and rough fits, not for gears that must mesh smoothly.",
    params: [P("n", "Teeth", "pcs", 6, { max: 50, whole: true }), P("m", "Module", "mm", 0.2), P("b", "Thickness", "mm", 0.5), P("bore", "Bore diameter", "mm", 0.5)],
    defaults: { n: 20, m: 2, b: 8, bore: 5 },
    check: (v) => (v.bore >= v.m * (v.n - 2.5) ? "the bore has to be smaller than the gear's root" : null),
    build: (v) => {
      const n = Math.round(v.n), r = (v.m * n) / 2, tip = r + v.m, root = r - 1.25 * v.m, step = (Math.PI * 2) / n;
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = i * step;
        for (const [da, rr] of [[0, root], [0.14, tip], [0.36, tip], [0.5, root]] as [number, number][]) pts.push([Math.cos(a + da * step) * rr, Math.sin(a + da * step) * rr]);
      }
      return [
        { ref: "g", f: prism("Gear", BRASS, pts, v.b) },
        { ref: "bore", f: cyl("Gear bore", BRASS, v.bore / 2, v.b + 2, -1) },
        { ref: "c", f: cut("Gear", "g", ["bore"]) },
      ];
    },
  },
  {
    id: "pulley",
    name: "Pulley",
    into: false,
    note: "A grooved wheel for a round belt or cord, with a bore for its shaft.",
    params: [P("D", "Diameter", "mm", 2), P("w", "Width", "mm", 1), P("g", "Groove radius", "mm", 0.3), P("bore", "Bore diameter", "mm", 0.5)],
    defaults: { D: 40, w: 10, g: 3, bore: 5 },
    check: (v) => (v.g * 2 >= v.w ? "the groove has to be narrower than the pulley" : v.bore >= v.D - 2 * v.g ? "the bore has to be inside the groove" : null),
    build: (v) => [
      { ref: "p", f: cyl("Pulley", ALU, v.D / 2, v.w) },
      { ref: "groove", f: { ...base("Pulley groove", ALU, [0, v.w / 2 - v.g, 0]), kind: "torus", R: v.D / 2, r: v.g } as Body },
      { ref: "bore", f: cyl("Pulley bore", ALU, v.bore / 2, v.w + 2, -1) },
      { ref: "c", f: cut("Pulley", "p", ["groove", "bore"]) },
    ],
  },
  {
    id: "knob",
    name: "Knob",
    into: false,
    note: "A round knob with finger grips round its edge and a hole for its shaft.",
    params: [P("D", "Diameter", "mm", 4), P("h", "Height", "mm", 1), P("grips", "Grips", "pcs", 3, { max: 18, whole: true }), P("shaft", "Shaft hole", "mm", 0.5)],
    defaults: { D: 30, h: 15, grips: 12, shaft: 6 },
    check: (v) => (v.shaft >= v.D * 0.6 ? "the shaft hole has to leave room for the grips" : null),
    build: (v) => {
      const n = Math.round(v.grips), gr = Math.min(v.D * 0.09, (Math.PI * v.D) / n / 3);
      const grips = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return { ref: `g${i}`, f: cyl("Knob grip", BLACK, gr, v.h + 2, -1, (Math.cos(a) * v.D) / 2, (Math.sin(a) * v.D) / 2) };
      });
      return [
        { ref: "k", f: { ...cyl("Knob", BLACK, v.D / 2, v.h), chamfer: Math.min(1, v.h / 4) } as Body },
        ...grips,
        { ref: "shaft", f: cyl("Knob shaft hole", BLACK, v.shaft / 2, v.h * 0.7 + 1, -1) },
        { ref: "c", f: cut("Knob", "k", [...grips.map((g) => g.ref), "shaft"]) },
      ];
    },
  },
  {
    id: "shaft",
    name: "Keyed shaft",
    into: false,
    note: "A round shaft with a keyway down one side, for a key to lock a gear or pulley to it.",
    params: [P("d", "Diameter", "mm", 1), P("L", "Length", "mm", 1), P("b", "Key width", "mm", 0.5), P("t", "Key depth", "mm", 0.2)],
    defaults: { d: 12, L: 60, b: 4, t: 2.5 },
    check: (v) => (v.b >= v.d || v.t * 2 >= v.d ? "the keyway has to fit in the shaft" : null),
    build: (v) => [
      { ref: "s", f: cyl("Shaft", STEEL, v.d / 2, v.L) },
      { ref: "key", f: box("Keyway", STEEL, v.b, v.L + 2, v.t * 2, [0, -1, v.d / 2]) },
      { ref: "c", f: cut("Shaft", "s", ["key"]) },
    ],
  },
  {
    id: "wedge",
    name: "Wedge",
    into: false,
    note: "A ramp: full height at one end, nothing at the other.",
    params: [P("w", "Length", "mm", 1), P("d", "Width", "mm", 1), P("h", "Height", "mm", 1)],
    defaults: { w: 40, d: 20, h: 15 },
    build: (v) => [{ ref: "w", f: { ...base("Wedge", ALU, [0, 0, -v.d / 2]), kind: "extrude", depth: v.d, profile: { type: "poly", pts: [[-v.w / 2, 0], [v.w / 2, 0], [-v.w / 2, v.h]] } } as Body }],
  },
  {
    id: "prism",
    name: "Polygon prism",
    into: false,
    note: "A straight prism on a regular polygon: three sides for a triangle, six for a hexagon.",
    params: [P("n", "Sides", "pcs", 3, { max: 48, whole: true }), P("r", "Corner radius", "mm", 0.5), P("h", "Height", "mm", 0.5)],
    defaults: { n: 6, r: 15, h: 20 },
    build: (v) => [{ ref: "p", f: prism("Prism", ALU, polygon(Math.round(v.n), v.r, Math.PI / 2), v.h) }],
  },
  {
    id: "gusset",
    name: "Gusset",
    into: false,
    note: "A triangular rib to brace a corner: it stands on the floor and leans against a wall behind it.",
    params: [P("a", "Leg length", "mm", 1), P("t", "Thickness", "mm", 0.5)],
    defaults: { a: 20, t: 3 },
    build: (v) => [{ ref: "g", f: { ...base("Gusset", ALU, [v.t / 2, 0, 0], [0, -90, 0]), kind: "extrude", depth: v.t, profile: { type: "poly", pts: [[0, 0], [v.a, 0], [0, v.a]] } } as Body }],
  },
  // ---------- cut into a face ----------
  {
    id: "countersink",
    name: "Countersunk hole",
    into: true,
    note: "A hole with a 90° cone at the top, so a flat-head screw sits flush.",
    params: [P("d", "Hole diameter", "mm", 0.5), P("D", "Countersink diameter", "mm", 1), P("depth", "Hole depth", "mm", 0.5)],
    defaults: { d: 3.4, D: 6.5, depth: 10 },
    check: (v) => (v.D <= v.d ? "the countersink has to be wider than the hole" : null),
    build: (v) => {
      const cone = (v.D - v.d) / 2; // a 90° cone is as deep as it narrows
      return [
        { ref: "hole", f: cyl("Countersunk hole", ALU, v.d / 2, v.depth + 1, -1) },
        { ref: "cone", f: { ...base("Countersink", ALU, [0, -1, 0]), kind: "cone", r1: v.D / 2 + 1, r2: v.d / 2, h: cone + 1 } as Body },
        { ref: "c", f: cut("Countersunk hole", "@face", ["hole", "cone"]) },
      ];
    },
  },
  {
    id: "counterbore",
    name: "Counterbored hole",
    into: true,
    note: "A hole with a wider, flat-bottomed pocket at the top, so a cap screw's head sits below the surface.",
    params: [P("d", "Hole diameter", "mm", 0.5), P("D", "Counterbore diameter", "mm", 1), P("cb", "Counterbore depth", "mm", 0.2), P("depth", "Hole depth", "mm", 0.5)],
    defaults: { d: 6.4, D: 11, cb: 6.5, depth: 20 },
    check: (v) => (v.D <= v.d ? "the counterbore has to be wider than the hole" : v.cb >= v.depth ? "the counterbore has to be shallower than the hole" : null),
    build: (v) => [
      { ref: "hole", f: cyl("Counterbored hole", ALU, v.d / 2, v.depth + 1, -1) },
      { ref: "bore", f: cyl("Counterbore", ALU, v.D / 2, v.cb + 1, -1) },
      { ref: "c", f: cut("Counterbored hole", "@face", ["hole", "bore"]) },
    ],
  },
  {
    id: "slot",
    name: "Slot",
    into: true,
    note: "A slot with round ends, for a part that has to slide or be adjusted. Turn sets its direction across the face.",
    params: [P("L", "Length", "mm", 1), P("w", "Width", "mm", 0.5), P("depth", "Depth", "mm", 0.5)],
    defaults: { L: 20, w: 5, depth: 5 },
    check: (v) => (v.w >= v.L ? "a slot has to be longer than it is wide" : null),
    build: (v) => {
      const e = (v.L - v.w) / 2;
      return [
        { ref: "a", f: cyl("Slot end", ALU, v.w / 2, v.depth + 1, -1, -e) },
        { ref: "b", f: cyl("Slot end", ALU, v.w / 2, v.depth + 1, -1, e) },
        { ref: "mid", f: box("Slot", ALU, v.L - v.w, v.depth + 1, v.w, [0, -1, 0]) },
        { ref: "c", f: cut("Slot", "@face", ["a", "b", "mid"]) },
      ];
    },
  },
];

export const TURN: Param = P("turn", "Turn", "°", -360, { max: 360 });

// The recipe's features placed: each body's position and rotation turned by
// q about the origin, then moved to `at`. Combines keep their refs.
export function placeSteps(steps: Step[], q: THREE.Quaternion, at: THREE.Vector3): Step[] {
  const deg = THREE.MathUtils.radToDeg, rad = THREE.MathUtils.degToRad;
  const r = (n: number) => Math.round(n * 1000) / 1000 + 0;
  return steps.map(({ ref, f }) => {
    if (f.kind === "combine") return { ref, f };
    const p = new THREE.Vector3(...f.pos).applyQuaternion(q).add(at);
    const own = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(f.rot[0]), rad(f.rot[1]), rad(f.rot[2]), "XYZ"));
    const e = new THREE.Euler().setFromQuaternion(q.clone().multiply(own), "XYZ");
    return { ref, f: { ...f, pos: [r(p.x), r(p.y), r(p.z)], rot: [r(deg(e.x)), r(deg(e.y)), r(deg(e.z))] } as Body };
  });
}

// The frame a recipe is placed in on a face: +Y along the face's normal
// (outward for a part, inward for a feature cut into the face), turned
// about that normal by `turn` degrees.
export function faceFrame(normal: THREE.Vector3, into: boolean, turn: number): THREE.Quaternion {
  const up = into ? normal.clone().negate() : normal.clone();
  return new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.normalize())
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(turn)));
}

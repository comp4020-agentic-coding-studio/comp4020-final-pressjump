// The angle bracket on the home page, and how its mesh travels to the page.
//
// The hero shows a real part: this timeline, built by shared/evaluate.ts like
// any design. Building it takes seconds (its cuts and joins are most of the
// work), far too long to make a visitor wait for, and it is the same every
// time. So `pnpm build` builds it once per height the hero shows
// (scripts/bake-hero.ts) and the page loads the mesh. spec/hero.test.ts checks
// that what is served is what evaluate makes.
//
// The mesh is packed small: positions to a hundredth of a millimetre in 16
// bits (enough to draw; the numbers the hero shows are the timeline's own),
// normals in 8, shared corners merged, and the crease lines alongside.

import type { Stored, Vec3 } from "./model.ts";

// the upright's heights the hero shows: as built, and as Ana retypes it
export const HERO_HEIGHTS = [70, 95] as const;

export const bracketMeshUrl = (h: number) => `/build/bracket-${h}.bin`;

// An angle bracket: 140 mm wide base plate, an upright of the given height,
// a boss, two mounting holes and a bore through the upright.
export function bracket(uprightH: number): Stored[] {
  let n = 0;
  const meta = (id: string) => ({ id, v: 1, by: "demo", seq: ++n });
  const box = (id: string, w: number, h: number, d: number, pos: Vec3, fillet = 0): Stored => ({
    ...meta(id), kind: "box", name: id, w, h, d, fillet, chamfer: 0, pos, rot: [0, 0, 0], colour: "#c9ced6",
  });
  const cyl = (id: string, r: number, h: number, pos: Vec3, rot: Vec3 = [0, 0, 0]): Stored => ({
    ...meta(id), kind: "cylinder", name: id, r, h, chamfer: 0, pos, rot, colour: "#c9ced6",
  });
  const combine = (id: string, op: "join" | "cut", target: string, tools: string[]): Stored => ({
    ...meta(id), kind: "combine", name: id, op, target, tools,
  });
  return [
    box("base", 140, 10, 90, [0, 0, 0], 4),
    box("upright", 140, uprightH, 10, [0, 10, -40]),
    combine("join1", "join", "base", ["upright"]),
    cyl("boss", 18, 10, [0, 10, 10]),
    combine("join2", "join", "base", ["boss"]),
    cyl("hole1", 6, 30, [-48, -5, 20]),
    cyl("hole2", 6, 30, [48, -5, 20]),
    cyl("hole3", 9, 30, [0, -5, 10]),
    cyl("bore", 16, 30, [0, 45, -60], [90, 0, 0]),
    combine("cut1", "cut", "base", ["hole1", "hole2", "hole3", "bore"]),
  ];
}

export type BracketMesh = {
  position: Float32Array; // mm
  normal: Float32Array;
  index: Uint16Array | Uint32Array;
  edges: Float32Array; // pairs of points, mm
};

// to a hundredth of a millimetre
const SCALE = 100;
const pad4 = (n: number) => (n + 3) & ~3;

// header: four 32-bit counts (corners, index entries, edge points, index
// width in bytes), then positions, the index, edges and normals
export function packBracket(m: BracketMesh): Uint8Array {
  const verts = m.position.length / 3;
  const wide = m.index instanceof Uint32Array ? 4 : 2;
  const posBytes = pad4(m.position.length * 2);
  const idxBytes = pad4(m.index.length * wide);
  const edgeBytes = pad4(m.edges.length * 2);
  const out = new ArrayBuffer(16 + posBytes + idxBytes + edgeBytes + m.normal.length);
  new Uint32Array(out, 0, 4).set([verts, m.index.length, m.edges.length / 3, wide]);
  const q = (src: Float32Array, at: number) => {
    const dst = new Int16Array(out, at, src.length);
    for (let i = 0; i < src.length; i++) {
      const v = Math.round(src[i] * SCALE);
      if (v < -32768 || v > 32767) throw new Error(`the bracket is too big to pack: ${src[i]} mm`);
      dst[i] = v;
    }
  };
  let at = 16;
  q(m.position, at);
  at += posBytes;
  (wide === 4 ? new Uint32Array(out, at, m.index.length) : new Uint16Array(out, at, m.index.length)).set(m.index);
  at += idxBytes;
  q(m.edges, at);
  at += edgeBytes;
  const n = new Int8Array(out, at, m.normal.length);
  for (let i = 0; i < m.normal.length; i++) n[i] = Math.round(Math.max(-1, Math.min(1, m.normal[i])) * 127);
  return new Uint8Array(out);
}

export function unpackBracket(buf: ArrayBuffer): BracketMesh {
  const [verts, count, edgePts, wide] = new Uint32Array(buf, 0, 4);
  const posBytes = pad4(verts * 6);
  const idxBytes = pad4(count * wide);
  const edgeBytes = pad4(edgePts * 6);
  const f = (src: Int16Array) => Float32Array.from(src, (v) => v / SCALE);
  let at = 16;
  const position = f(new Int16Array(buf, at, verts * 3));
  at += posBytes;
  const index = wide === 4 ? new Uint32Array(buf.slice(at, at + count * 4)) : new Uint16Array(buf.slice(at, at + count * 2));
  at += idxBytes;
  const edges = f(new Int16Array(buf, at, edgePts * 3));
  at += edgeBytes;
  const normal = Float32Array.from(new Int8Array(buf, at, verts * 3), (v) => v / 127);
  return { position, normal, index, edges };
}

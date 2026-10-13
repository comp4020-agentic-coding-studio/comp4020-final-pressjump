// Turns the timeline into solids. The same code runs in the browser, to draw
// the design, and on the server, to export it, so what you see is what comes
// out. Every body is built in its own frame, then baked into world space; a
// combine then joins, cuts or intersects world-space solids in timeline order.
// Because combines are re-run from the current numbers every time, moving a
// cutting body moves the hole: the design is parametric.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { MeshBVH } from "three-mesh-bvh";
import type { Body, Stored, Vec3 } from "./model.ts";

const DEG = Math.PI / 180;
const SEGMENTS = 64;

export function frame(pos: Vec3, rot: Vec3): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, "XYZ"));
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, new THREE.Vector3(1, 1, 1));
}

// A body's solid in its own frame. Primitives stand on their origin, the way
// a part sits on a bench: the origin is the middle of the base, and the body
// grows upward (+Y), so making one taller never pushes it through what it
// stands on. An extrude's sketch lies on its local XY plane and runs along
// local +Z (or -Z for a negative distance).
export function localGeometry(f: Body): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (f.kind) {
    case "box":
      g = f.fillet > 0 ? new RoundedBoxGeometry(f.w, f.h, f.d, 4, f.fillet) : new THREE.BoxGeometry(f.w, f.h, f.d);
      g.translate(0, f.h / 2, 0);
      break;
    case "cylinder":
      g = new THREE.CylinderGeometry(f.r, f.r, f.h, SEGMENTS).translate(0, f.h / 2, 0);
      break;
    case "cone":
      g = new THREE.CylinderGeometry(f.r2, f.r1, f.h, SEGMENTS).translate(0, f.h / 2, 0);
      break;
    case "sphere":
      g = new THREE.SphereGeometry(f.r, SEGMENTS, SEGMENTS / 2).translate(0, f.r, 0);
      break;
    case "torus":
      g = new THREE.TorusGeometry(f.R, f.r, 24, SEGMENTS).rotateX(-Math.PI / 2).translate(0, f.r, 0);
      break;
    case "extrude": {
      const shape = new THREE.Shape();
      if (f.profile.type === "circle") {
        shape.absarc(f.profile.cx, f.profile.cy, f.profile.r, 0, Math.PI * 2, false);
      } else {
        const [first, ...rest] = f.profile.pts;
        shape.moveTo(first[0], first[1]);
        for (const [x, y] of rest) shape.lineTo(x, y);
        shape.closePath();
      }
      g = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(f.depth), bevelEnabled: false, curveSegments: SEGMENTS });
      if (f.depth < 0) g.translate(0, 0, f.depth);
      break;
    }
  }
  return g;
}

// How tall a body stands above its origin, before rotation.
export function height(f: Body): number {
  switch (f.kind) {
    case "box":
    case "cylinder":
    case "cone":
      return f.h;
    case "sphere":
      return f.r * 2;
    case "torus":
      return f.r * 2;
    case "extrude":
      return 0;
  }
}

export function worldGeometry(f: Body): THREE.BufferGeometry {
  const g = localGeometry(f);
  g.applyMatrix4(frame(f.pos, f.rot));
  if (!g.attributes.uv) {
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g;
}

export type Solid = {
  id: string;
  feature: Stored & Body;
  geometry: THREE.BufferGeometry;
};

export type Evaluated = {
  // the bodies left standing at the end, in timeline order
  solids: Solid[];
  // bodies a combine has used up as tools, by id, and which combine did it
  consumed: Map<string, string>;
  // combines that could not be computed, by id, with why
  failed: Map<string, string>;
};

const cache = new Map<string, THREE.BufferGeometry>();

// Building a body is cheap but not free, and the editor re-evaluates on every
// frame of a drag, so built bodies are kept by their exact numbers.
function cachedWorld(f: Body): THREE.BufferGeometry {
  const key = JSON.stringify(f);
  let g = cache.get(key);
  if (!g) {
    g = worldGeometry(f);
    cache.set(key, g);
    if (cache.size > 400) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.get(oldest)?.dispose();
        cache.delete(oldest);
      }
    }
  }
  return g;
}

const evaluator = new Evaluator();
evaluator.useGroups = false;
evaluator.attributes = ["position", "uv", "normal"];

const OPS = { join: ADDITION, cut: SUBTRACTION, intersect: INTERSECTION } as const;

// `upto` stops the timeline after that sequence number, for looking back.
export function evaluate(features: Stored[], upto = Infinity): Evaluated {
  const ordered = [...features].sort((a, b) => a.seq - b.seq).filter((f) => f.seq <= upto);
  const geometry = new Map<string, THREE.BufferGeometry>();
  const owner = new Map<string, Stored & Body>();
  const consumed = new Map<string, string>();
  const failed = new Map<string, string>();

  for (const f of ordered) {
    if (f.kind !== "combine") {
      geometry.set(f.id, cachedWorld(f));
      owner.set(f.id, f);
      continue;
    }
    const target = geometry.get(f.target);
    const tools = f.tools.map((t) => geometry.get(t));
    if (!target || tools.some((t) => !t)) {
      failed.set(f.id, "a body it uses is missing at this point in the timeline");
      continue;
    }
    try {
      let result = new Brush(target);
      result.updateMatrixWorld();
      for (const t of tools) {
        const tool = new Brush(t);
        tool.updateMatrixWorld();
        result = evaluator.evaluate(result, tool, OPS[f.op]);
      }
      const merged = result.geometry;
      geometry.set(f.target, merged);
      for (const t of f.tools) {
        geometry.delete(t);
        consumed.set(t, f.id);
      }
    } catch (err) {
      failed.set(f.id, err instanceof Error ? err.message : "the solids could not be combined");
    }
  }

  const solids: Solid[] = [];
  for (const [id, g] of geometry) {
    const feature = owner.get(id);
    if (feature) solids.push({ id, feature, geometry: g });
  }
  return { solids, consumed, failed };
}

// Triangles of a solid as flat world-space coordinates, nine numbers each.
export function triangles(g: THREE.BufferGeometry): Float32Array {
  const flat = g.index ? g.toNonIndexed() : g;
  return flat.attributes.position.array as Float32Array;
}

// Signed volume by the divergence theorem. Positive for a closed solid whose
// faces point outward; the spec uses it to check exports hold what was drawn.
export function volume(tris: Float32Array): number {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(i, i + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// The edges a person would draw: creases where the surface turns by more
// than `degrees`. Boolean results are hard on three's EdgesGeometry in two
// ways. They are full of long, thin sliver triangles whose normals are noise,
// which it draws as lines across flat faces; and they have T-junctions, where
// one face's edge meets two shorter edges on the other side, which it either
// misses or draws as an open boundary. So slivers are left out, and an edge
// with no partner is settled by looking at what actually lies just across it.
export function creases(g: THREE.BufferGeometry, degrees = 25): THREE.BufferGeometry {
  const only = new THREE.BufferGeometry();
  only.setAttribute("position", g.attributes.position);
  if (g.index) only.setIndex(g.index);
  const w = mergeVertices(only, 1e-4);
  const pos = w.attributes.position;
  const index = w.index!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cos = Math.cos(THREE.MathUtils.degToRad(degrees));
  const out: number[] = [];

  const normalOf = (geo: THREE.BufferGeometry, t: number, target: THREE.Vector3): number => {
    const ix = geo.index!;
    const p = geo.attributes.position;
    a.fromBufferAttribute(p, ix.getX(t * 3));
    b.fromBufferAttribute(p, ix.getX(t * 3 + 1));
    c.fromBufferAttribute(p, ix.getX(t * 3 + 2));
    const n = target.subVectors(b, a).cross(c.clone().sub(a));
    const area2 = n.length();
    const longest = Math.max(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a));
    if (area2 < 1e-9 || area2 / longest < 1e-3) return 0;
    n.divideScalar(area2);
    return area2;
  };

  type Side = { n: THREE.Vector3; count: number; i: number; j: number; k: number };
  const edges = new Map<string, Side>();
  for (let t = 0; t < index.count / 3; t++) {
    const n = new THREE.Vector3();
    if (!normalOf(w, t, n)) continue;
    const ids = [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)];
    for (let e = 0; e < 3; e++) {
      const i = ids[e], j = ids[(e + 1) % 3], k = ids[(e + 2) % 3];
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      const seen = edges.get(key);
      if (!seen) edges.set(key, { n, count: 1, i, j, k });
      else if (seen.count === 1) {
        seen.count = 2;
        if (seen.n.dot(n) < cos) push(i, j);
      }
    }
  }

  function push(i: number, j: number): void {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, j);
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  const lonely = [...edges.values()].filter((e) => e.count === 1);
  if (lonely.length) {
    const bvh = new MeshBVH(w.clone());
    const pi = new THREE.Vector3(), pj = new THREE.Vector3(), pk = new THREE.Vector3();
    const probe = new THREE.Vector3(), across = new THREE.Vector3();
    const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    for (const e of lonely) {
      pi.fromBufferAttribute(pos, e.i);
      pj.fromBufferAttribute(pos, e.j);
      pk.fromBufferAttribute(pos, e.k);
      const dir = pj.clone().sub(pi).normalize();
      const mid = pi.clone().add(pj).multiplyScalar(0.5);
      // in the face's plane, perpendicular to the edge, pointing away from the face
      across.subVectors(mid, pk);
      across.sub(dir.clone().multiplyScalar(across.dot(dir))).normalize();
      // just across the edge, and a hair outside the surface on the face's side
      probe.copy(mid).addScaledVector(across, 0.02).addScaledVector(e.n, 0.005);
      if (!bvh.closestPointToPoint(probe, hit as never)) continue;
      const other = new THREE.Vector3();
      if (!normalOf(bvh.geometry, hit.faceIndex, other)) continue;
      if (e.n.dot(other) < cos) push(e.i, e.j);
    }
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
}

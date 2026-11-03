// The ready-made parts keep promise 1 like anything else: every one, at every
// listed size and on any face, is made of features the server would accept,
// and comes out the size its numbers say.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PARTS, faceFrame, placeSteps } from "../shared/parts.ts";
import { evaluate } from "../shared/evaluate.ts";
import { checkReferences, validateFeature, type Feature, type Stored } from "../shared/model.ts";

// a recipe placed on a tilted face and made into stored features
function make(id: string, values: Record<string, number> = {}, normal = new THREE.Vector3(0, 1, 0), at = new THREE.Vector3()): Stored[] {
  const def = PARTS.find((p) => p.id === id)!;
  const v = { ...def.defaults, ...values };
  expect(def.check?.(v) ?? null).toBeNull();
  const steps = placeSteps(def.build(v), faceFrame(normal, def.into, 30), at);
  const design = new Map<string, Stored>();
  if (def.into) design.set("face-body", { ...(validateFeature({ kind: "box", name: "Block", pos: [0, -50, 0], rot: [0, 0, 0], colour: "#b9bec4", w: 100, h: 50, d: 100, fillet: 0, chamfer: 0 }) as Feature), id: "face-body", v: 1, by: "x", seq: 0 } as Stored);
  const ids = new Map(steps.map((s, i) => [s.ref, `part-${id}-${i}`]));
  ids.set("@face", "face-body");
  for (const [i, { ref, f }] of steps.entries()) {
    const real = f.kind === "combine" ? { ...f, target: ids.get(f.target)!, tools: f.tools.map((t) => ids.get(t)!) } : f;
    const valid = validateFeature(real);
    expect(valid, `${def.name}: ${String(valid)}`).not.toBeTypeOf("string");
    expect(checkReferences(design, valid as Feature), def.name).toBeNull();
    design.set(ids.get(ref)!, { ...(valid as Feature), id: ids.get(ref)!, v: 1, by: "x", seq: i + 1 } as Stored);
  }
  return [...design.values()];
}

const volume = (g: THREE.BufferGeometry): number => {
  const p = g.attributes.position, idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  const n = idx ? idx.count : p.count;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2);
    v += a.dot(b.cross(c)) / 6;
  }
  return Math.abs(v);
};

describe("every ready-made part", () => {
  it("there are eighteen recipes, three of them cut into a face", () => {
    expect(PARTS).toHaveLength(18);
    expect(PARTS.filter((p) => p.into).map((p) => p.id)).toEqual(["countersink", "counterbore", "slot"]);
  });

  for (const def of PARTS) {
    it(`${def.name}: valid at every size, on a tilted face`, () => {
      const tilted = new THREE.Vector3(0.3, 1, -0.2).normalize();
      make(def.id, {}, tilted, new THREE.Vector3(12, 5, -7));
      for (const p of def.presets ?? []) make(def.id, p.values, tilted);
    });
  }
});

describe("they come out the size they say", () => {
  it("an M6 washer is a 12 mm ring with a 6.4 mm hole, 1.6 mm thick", () => {
    const [solid] = evaluate(make("washer", { d1: 6.4, d2: 12, h: 1.6 })).solids;
    const ring = (r: number) => 0.5 * 64 * r * r * Math.sin((2 * Math.PI) / 64); // the 64-sided circle
    expect(volume(solid.geometry)).toBeCloseTo((ring(6) - ring(3.2)) * 1.6, 1);
  });

  it("an M8 x 30 hex bolt stands 30 mm of shank plus a 5.3 mm head, 13 mm across flats", () => {
    const [solid] = evaluate(make("bolt", { d: 8, L: 30, s: 13, k: 5.3 })).solids;
    solid.geometry.computeBoundingBox();
    const size = solid.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(35.3, 3);
    // the hexagon's corners are stored to a thousandth of a millimetre, as every
    // number is, so across flats is 13 to within a hundredth
    expect(Math.min(size.x, size.z)).toBeCloseTo(13, 2);
  });

  it("a countersunk hole cuts into the face, not out of it", () => {
    const solids = evaluate(make("countersink")).solids;
    expect(solids).toHaveLength(1);
    expect(volume(solids[0].geometry)).toBeLessThan(100 * 50 * 100);
    solids[0].geometry.computeBoundingBox();
    expect(solids[0].geometry.boundingBox!.max.y).toBeCloseTo(0, 3);
  });
});

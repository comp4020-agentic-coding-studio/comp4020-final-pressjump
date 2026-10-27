// Promise 1 again, for the editor's Mirror tool: a mirrored copy is the exact
// reflection of the original, not something that merely looks close. Mirror
// writes an ordinary feature (a reflected position, flipped rotations, and a
// reflected sketch for an extrude), so the check is on the geometry that
// feature builds: every vertex of the original, reflected across the plane,
// is a vertex of the copy, and the other way round.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { worldGeometry } from "../shared/evaluate.ts";
import { mirrorBody, validateFeature, type Body } from "../shared/model.ts";

const placed = { name: "Part", pos: [12, 5, -7], rot: [30, 40, 50], colour: "#b9bec4" };
const bodies: Body[] = [
  { ...placed, kind: "box", w: 30, h: 12, d: 18, fillet: 0, chamfer: 2 },
  { ...placed, kind: "cylinder", r: 9, h: 25, chamfer: 1 },
  { ...placed, kind: "cone", r1: 10, r2: 3, h: 20 },
  { ...placed, kind: "torus", R: 15, r: 4 },
  { ...placed, kind: "sphere", r: 8 },
  { ...placed, kind: "extrude", depth: 14, profile: { type: "poly", pts: [[0, 0], [30, 0], [30, 8], [8, 20]] } },
  { ...placed, kind: "extrude", depth: -9, profile: { type: "circle", cx: 6, cy: -3, r: 5 } },
] as Body[];

function vertices(b: Body): THREE.Vector3[] {
  const g = worldGeometry(b);
  const p = g.attributes.position;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
  return out;
}

// the largest distance from any point in `from` to its nearest point in `to`
function farthest(from: THREE.Vector3[], to: THREE.Vector3[]): number {
  let worst = 0;
  for (const a of from) {
    let best = Infinity;
    for (const b of to) best = Math.min(best, a.distanceToSquared(b));
    worst = Math.max(worst, best);
  }
  return Math.sqrt(worst);
}

describe("Mirror", () => {
  for (const b of bodies) {
    for (const [axis, at] of [["x", 3], ["z", -2]] as const) {
      it(`reflects ${b.kind === "extrude" ? "an" : "a"} ${b.kind}${b.kind === "extrude" ? ` (${b.profile.type})` : ""} across ${axis} = ${at} exactly`, () => {
        const m = validateFeature(mirrorBody(b, axis, at));
        expect(typeof m).not.toBe("string");
        const i = axis === "x" ? "x" : "z";
        const reflected = vertices(b).map((v) => v.setComponent(i === "x" ? 0 : 2, 2 * at - v[i]));
        const copy = vertices(m as Body);
        // positions and angles are stored to a thousandth, so allow a hundredth of a millimetre
        expect(farthest(reflected, copy)).toBeLessThan(0.01);
        expect(farthest(copy, reflected)).toBeLessThan(0.01);
      });
    }
  }

  it("leaves the original where it was", () => {
    const before = JSON.stringify(bodies[5]);
    mirrorBody(bodies[5], "x", 0);
    expect(JSON.stringify(bodies[5])).toBe(before);
  });
});

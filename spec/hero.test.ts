// Promise 1 holds on the home page too: the bracket in the hero is the part
// its timeline makes. The page no longer builds it (that took seconds); it
// loads a mesh `pnpm build` made. These check that what the server hands out
// is what shared/evaluate.ts builds from shared/bracket.ts, at every height
// the hero shows, so the mesh can never drift from the numbers on it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { HERO_HEIGHTS, bracket, bracketMeshUrl, unpackBracket } from "../shared/bracket.ts";
import { evaluate } from "../shared/evaluate.ts";
import { baseUrl } from "./people.ts";

function area(position: ArrayLike<number>, index: ArrayLike<number>): number {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < index.length; i += 3) {
    a.fromArray(position, index[i] * 3);
    b.fromArray(position, index[i + 1] * 3);
    c.fromArray(position, index[i + 2] * 3);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

function bounds(position: ArrayLike<number>): number[] {
  const box = new THREE.Box3().setFromArray(position as number[]);
  return [...box.min.toArray(), ...box.max.toArray()];
}

describe("the home page's bracket", () => {
  for (const h of HERO_HEIGHTS) {
    it(`is the part its timeline makes, at ${h} mm`, async () => {
      const res = await fetch(new URL(bracketMeshUrl(h), baseUrl));
      expect(res.status).toBe(200);
      const served = unpackBracket(await res.arrayBuffer());
      const built = evaluate(bracket(h)).solids[0].geometry;
      const pos = built.attributes.position.array;
      const index = built.index ? built.index.array : Array.from({ length: pos.length / 3 }, (_, i) => i);
      // the same triangles, the same size, the same surface
      expect(served.index.length).toBe(index.length);
      const want = bounds(pos), got = bounds(served.position);
      for (let i = 0; i < 6; i++) expect(Math.abs(got[i] - want[i]), `bound ${i}`).toBeLessThan(0.006);
      // the upright's top is where the hero's dimension says
      expect(got[4]).toBeCloseTo(10 + h, 2);
      expect(Math.abs(area(served.position, served.index) / area(pos, index) - 1)).toBeLessThan(1e-4);
      expect(served.edges.length).toBeGreaterThan(0);
    }, 30_000);
  }

  it("is not sent again to a browser that already has it", async () => {
    const url = new URL(bracketMeshUrl(HERO_HEIGHTS[0]), baseUrl);
    const first = await fetch(url);
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();
    await first.arrayBuffer();
    const again = await fetch(url, { headers: { "If-None-Match": tag! } });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });
});

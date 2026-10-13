// Exports are made here, from the stored timeline, by the same evaluator the
// browser draws with, never from what a browser happens to be showing.
// Millimetres, Z up: STL has no units field, and every slicer and CAM tool
// reads it as millimetres with Z up, while the model is Y up, so Y and Z are
// swapped (with one sign flipped, so the part is not mirrored).

import { evaluate, triangles } from "../shared/evaluate.ts";
import type { Stored } from "../shared/model.ts";

export function toStl(name: string, features: Stored[]): Buffer {
  const { solids } = evaluate(features);
  const parts = solids.map((s) => triangles(s.geometry));
  const count = parts.reduce((n, t) => n + t.length / 9, 0);
  const out = Buffer.alloc(84 + count * 50);
  out.write(`Bench design: ${name}`.slice(0, 79), 0, "ascii");
  out.writeUInt32LE(count, 80);
  let o = 84;
  for (const tris of parts) {
    for (let i = 0; i < tris.length; i += 9) {
      // model (x, y, z) with Y up -> STL (x, -z, y) with Z up
      const p = [0, 3, 6].map((k) => [tris[i + k], -tris[i + k + 2], tris[i + k + 1]]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
      const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      for (const n of [nx, ny, nz]) {
        out.writeFloatLE(n, o);
        o += 4;
      }
      for (const v of p) {
        for (const n of v) {
          out.writeFloatLE(n, o);
          o += 4;
        }
      }
      out.writeUInt16LE(0, o);
      o += 2;
    }
  }
  return out;
}

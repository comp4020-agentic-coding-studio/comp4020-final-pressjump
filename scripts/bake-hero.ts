// Builds the home page's bracket once per height, with shared/evaluate.ts,
// and writes each mesh to public/build for the hero to load (see
// shared/bracket.ts for why). Run by `pnpm build`, after esbuild.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { HERO_HEIGHTS, bracket, bracketMeshUrl, packBracket } from "../shared/bracket.ts";
import { creases, evaluate } from "../shared/evaluate.ts";

const ROOT = join(import.meta.dirname, "..");

for (const h of HERO_HEIGHTS) {
  const start = performance.now();
  const solid = evaluate(bracket(h)).solids[0].geometry;
  const edges = creases(solid);
  // corners that share a place and a normal are one corner
  const plain = new THREE.BufferGeometry();
  plain.setAttribute("position", solid.attributes.position);
  plain.setAttribute("normal", solid.attributes.normal);
  if (solid.index) plain.setIndex(solid.index);
  const merged = mergeVertices(plain, 1e-4);
  const index = merged.index!.array;
  const bytes = packBracket({
    position: merged.attributes.position.array as Float32Array,
    normal: merged.attributes.normal.array as Float32Array,
    index: merged.attributes.position.count > 65535 ? Uint32Array.from(index) : Uint16Array.from(index),
    edges: edges.attributes.position.array as Float32Array,
  });
  writeFileSync(join(ROOT, "public", bracketMeshUrl(h)), bytes);
  console.log(`bracket at ${h} mm: ${index.length / 3} triangles, ${bytes.length} bytes, ${Math.round(performance.now() - start)} ms`);
}

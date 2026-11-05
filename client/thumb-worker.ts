// Builds a design's bodies off the page's thread, for the pictures on the
// home page: thumbnails of whole designs (the example alone is over a hundred
// features, with cuts) and the little parts turning in the sections. The
// same shared/evaluate.ts the editor and the STL export use, so a picture
// never shows a part Bench would not make.

import { creases, evaluate } from "../shared/evaluate.ts";
import type { Stored } from "../shared/model.ts";
import { unpack } from "../shared/protocol.ts";

export type Built = {
  colour: string;
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array | null;
  edges: Float32Array;
};

self.onmessage = (e: MessageEvent<{ job: number; features: Stored[] }>) => {
  const { job, features } = e.data;
  try {
    const { solids } = evaluate(features.map((f) => unpack(f)));
    const out: Built[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const s of solids) {
      const g = s.geometry;
      const position = new Float32Array(g.attributes.position.array);
      const normal = g.attributes.normal ? new Float32Array(g.attributes.normal.array) : null;
      const index = g.index ? new Uint32Array(g.index.array) : null;
      const lines = creases(g);
      const flat = lines.index ? lines.toNonIndexed() : lines;
      const edges = new Float32Array(flat.attributes.position.array);
      out.push({ colour: s.feature.colour, position, normal, index, edges });
      transfer.push(position.buffer as ArrayBuffer, edges.buffer as ArrayBuffer);
      if (normal) transfer.push(normal.buffer as ArrayBuffer);
      if (index) transfer.push(index.buffer as ArrayBuffer);
    }
    (self as unknown as Worker).postMessage({ job, solids: out }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ job, error: err instanceof Error ? err.message : String(err) });
  }
};

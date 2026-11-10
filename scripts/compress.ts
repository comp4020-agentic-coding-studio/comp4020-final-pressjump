// Compresses what `pnpm build` made, once, at the highest setting, so the
// server sends each file small without spending a 256 MB machine's time
// compressing it per request. server/main.ts sends `<file>.br` to any browser
// that takes brotli and the file itself to any other. Run last in the build.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const BUILD = join(import.meta.dirname, "..", "public", "build");

let before = 0, after = 0;
for (const name of readdirSync(BUILD)) {
  // source maps are only ever opened by developer tools
  if (!/\.(js|bin)$/.test(name)) continue;
  const raw = readFileSync(join(BUILD, name));
  const small = brotliCompressSync(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  });
  writeFileSync(join(BUILD, `${name}.br`), small);
  before += raw.length;
  after += small.length;
}
console.log(`compressed the build: ${Math.round(before / 1024)} KB to ${Math.round(after / 1024)} KB`);

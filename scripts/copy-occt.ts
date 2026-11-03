// Part of `pnpm build`: puts the STEP reader (occt-import-js, LGPL-2.1, with
// the OpenCascade licence it carries) beside the bundles, unmodified, so the
// browser loads it from this server and nothing comes from a CDN.
import { copyFileSync } from "node:fs";

const from = "node_modules/occt-import-js/dist/";
for (const f of ["occt-import-js.js", "occt-import-js.wasm", "license.occt-import-js.txt", "license.occt.txt"]) {
  copyFileSync(from + f, "public/build/" + f);
}

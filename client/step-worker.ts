// Reads a STEP file into triangles, off the main thread: OpenCascade (through
// occt-import-js) is several megabytes of WebAssembly and a big part takes
// seconds to tessellate. A classic worker, because the library loads the
// classic way. Nothing here touches the network except fetching the reader
// itself from this server.

declare function importScripts(...urls: string[]): void;
declare function occtimportjs(o: { locateFile: (p: string) => string }): Promise<{
  ReadStepFile: (content: Uint8Array, params: unknown) => {
    success: boolean;
    meshes: { attributes: { position: { array: number[] } }; index: { array: number[] } }[];
  };
}>;

importScripts("/build/occt-import-js.js");
const ready = occtimportjs({ locateFile: (p: string) => `/build/${p}` });

onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const occt = await ready;
    const result = occt.ReadStepFile(new Uint8Array(e.data), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
    if (!result.success) throw new Error("the STEP file could not be read");
    let count = 0;
    for (const m of result.meshes) count += m.index.array.length;
    const out = new Float32Array(count * 3);
    let o = 0;
    for (const m of result.meshes) {
      const p = m.attributes.position.array;
      for (const i of m.index.array) {
        out[o++] = p[i * 3];
        out[o++] = p[i * 3 + 1];
        out[o++] = p[i * 3 + 2];
      }
    }
    postMessage({ ok: true, positions: out }, { transfer: [out.buffer] });
  } catch (err) {
    postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};

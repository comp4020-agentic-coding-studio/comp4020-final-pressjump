// The server is a small free machine and a full room is the case Bench is for,
// so what crosses the socket is kept to what someone needs to know: your own
// edit comes back as a short "ok", not the whole feature; cursor news carries
// only what changed and never comes back to its sender; features leave their
// default numbers off. The multiplayer promises (seeing each other, versions,
// holds) are checked elsewhere and hold with all of this on.

import { describe, expect, it } from "vitest";
import { exampleFeatures } from "../shared/example.ts";
import { PARTS, faceFrame, placeSteps } from "../shared/parts.ts";
import { validateFeature, type Feature } from "../shared/model.ts";
import { pack, unpack } from "../shared/protocol.ts";
import * as THREE from "three";
import { add, box, newDesign, visit } from "./people.ts";

describe("what crosses the socket", () => {
  it("an edit comes back to its maker as a short ok; everyone else gets the feature", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const b = await visit(design.id);
    const f = await add(a, box({ w: 33 }));
    expect((await b.next("put", (m) => m.feature.id === f.id)).feature).toMatchObject({ w: 33, v: 1 });
    await expect(a.next("put", (m) => m.feature.id === f.id, 300)).rejects.toThrow();
    a.send({ t: "update", id: f.id, base: 1, f: box({ w: 34 }) });
    expect(await a.next("ok", (m) => m.id === f.id)).toMatchObject({ v: 2, seq: f.seq });
    expect((await b.next("put", (m) => m.feature.id === f.id)).feature).toMatchObject({ w: 34, v: 2 });
    await Promise.all([a.close(), b.close()]);
  });

  it("cursor news is only what changed, never echoed to its sender, and a newcomer still sees everyone", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const b = await visit(design.id);
    const cam = { p: [200, 150, 200] as [number, number, number], t: [0, 0, 0] as [number, number, number] };
    a.send({ t: "cursor", at: [1, 0, 1], cam });
    const first = await b.next("cursors", (m) => m.cursors.some((c) => c.id === a.you.id));
    expect(first.cursors[0]).toMatchObject({ at: [1, 0, 1], cam });
    // only the pointer moved: only the pointer is news
    a.send({ t: "cursor", at: [2, 0, 2] });
    const second = await b.next("cursors", (m) => m.cursors.some((c) => c.id === a.you.id));
    expect(second.cursors[0]).toEqual({ id: a.you.id, at: [2, 0, 2] });
    // and none of it came back to Ada
    await expect(a.next("cursors", (m) => m.cursors.some((c) => c.id === a.you.id), 300)).rejects.toThrow();
    // someone arriving now still sees where Ada is and what she sees
    const c = await visit(design.id);
    const here = await c.next("cursors", (m) => m.cursors.some((x) => x.id === a.you.id));
    expect(here.cursors.find((x) => x.id === a.you.id)).toMatchObject({ at: [2, 0, 2], cam });
    await Promise.all([a.close(), b.close(), c.close()]);
  });
});

describe("features on the wire", () => {
  // every feature of the example turbine and of every ready-made part
  const all: Feature[] = [
    ...exampleFeatures().map((x) => x.f),
    ...PARTS.flatMap((p) => placeSteps(p.build(p.defaults), faceFrame(new THREE.Vector3(0, 1, 0), p.into, 0), new THREE.Vector3()).map((s) => s.f)),
  ].map((f) => validateFeature(f) as Feature);

  it("come back exactly as they were sent, defaults and all", () => {
    for (const f of all) expect(unpack(pack(f)), f.name).toEqual(f);
  });

  it("are shorter for it", () => {
    // measured at about 15% shorter: sketch points and real rotations, which
    // carry information, are most of a part; this catches packing being lost
    const whole = all.reduce((n, f) => n + JSON.stringify(f).length, 0);
    const packed = all.reduce((n, f) => n + JSON.stringify(pack(f)).length, 0);
    expect(packed / whole).toBeLessThan(0.9);
  });
});

// Bench imports no models (docs/adr/0006-no-import.md), and the server must
// never become a place to put one: it is a small free machine, and a gigabyte
// model sent to it would sink it. So no route accepts a file, and every
// message and request body is capped well below the size of any real model. The example design's
// model is a file that ships with Bench, served like a script or a font.

import { describe, expect, it } from "vitest";
import { EXAMPLE_ID, exampleFeatures } from "../shared/example.ts";
import { checkReferences, validateFeature, type Feature, type Stored } from "../shared/model.ts";
import { LIMITS } from "../shared/protocol.ts";
import { baseUrl, id, newDesign, readStl, signUp, stored, visit } from "./people.ts";

// a model-sized payload: a few thousand triangles of numbers
const bulk = () => Array.from({ length: 30_000 }, (_, i) => i * 1.5);

describe("models are never kept by the server", () => {
  it("closes a connection that sends a model-sized message, and stores nothing", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    a.send({ t: "add", id: id(), f: { kind: "box", name: "Big", pos: [0, 0, 0], rot: [0, 0, 0], colour: "#b9bec4", w: 1, h: 1, d: 1, fillet: 0, chamfer: 0, mesh: bulk() } as never });
    expect(JSON.stringify(bulk()).length).toBeGreaterThan(LIMITS.messageBytes);
    expect((await a.closed).code).toBe(1009);
    expect(await stored(design.id)).toEqual([]);
  });

  it("refuses a model-sized request body, even from an account", async () => {
    const { cookie } = await signUp();
    const res = await fetch(new URL("/api/designs", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Big", mesh: bulk() }),
    });
    expect(res.status).toBe(413);
  });

  it("has nowhere to put a file", async () => {
    for (const path of [`/d/${EXAMPLE_ID}`, `/api/designs/${EXAMPLE_ID}`, "/build/design.js", "/upload"]) {
      for (const method of ["POST", "PUT"]) {
        const res = await fetch(new URL(path, baseUrl), { method, body: "solid x\nendsolid x\n" });
        expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("the example turbine", () => {
  it("is made only of features the server would accept, using the editor's tools", () => {
    const made = new Map<string, Stored>();
    for (const [i, { id, f }] of exampleFeatures().entries()) {
      const v = validateFeature(f);
      expect(v, f.name).not.toBeTypeOf("string");
      expect(checkReferences(made, v as Feature), f.name).toBeNull();
      made.set(id, { ...(v as Feature), id, v: 1, by: "x", seq: i + 1 } as Stored);
    }
    const names = new Set([...made.values()].map((f) => f.name));
    for (const n of ["Bolt", "Nut", "Washer", "Standoff", "Plate", "Tube", "Gusset", "Countersunk hole", "Counterbored hole", "Socket screw", "Slot", "Shaft", "Gear", "Bracket", "Blade"]) {
      expect(names, n).toContain(n);
    }
  });

  it("is there to open, and exports a part", async () => {
    expect((await fetch(new URL(`/d/${EXAMPLE_ID}`, baseUrl))).status).toBe(200);
    const { features } = (await (await fetch(new URL(`/api/designs/${EXAMPLE_ID}`, baseUrl))).json()) as { features: Stored[] };
    expect(features.length).toBeGreaterThan(50);
    const stl = readStl(await (await fetch(new URL(`/d/${EXAMPLE_ID}/export.stl`, baseUrl))).arrayBuffer());
    expect(stl.triangles).toBeGreaterThan(1000);
    // the turbine stands about 300 mm tall: Z up in the STL
    expect(stl.max[2] - stl.min[2]).toBeGreaterThan(250);
  });
});

describe("no importing", () => {
  it("offers no way to open a model, and nothing anywhere may build code from strings", async () => {
    const design = await newDesign();
    const page = await (await fetch(new URL(`/d/${design.id}`, baseUrl))).text();
    expect(page).not.toMatch(/Import a model|type="file"/);
    for (const path of ["/", `/d/${design.id}`, "/readme/", "/build/design.js"]) {
      const csp = (await fetch(new URL(path, baseUrl))).headers.get("content-security-policy") ?? "";
      expect(csp, path).not.toContain("unsafe-eval");
    }
    const script = await (await fetch(new URL("/build/design.js", baseUrl))).text();
    expect(script).not.toMatch(/\.step,|\.3mf|accept=/);
    // the STEP reader is not shipped
    for (const path of ["/build/step-worker.js", "/build/occt-import-js.wasm"]) {
      expect((await fetch(new URL(path, baseUrl))).status, path).toBe(404);
    }
  });
});

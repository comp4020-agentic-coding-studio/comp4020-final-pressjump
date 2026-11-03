// Models never live on the server. An imported model is opened in the
// browser and kept there (client/importer.ts); the server is a small free
// machine, and a gigabyte model sent to it would sink it. So the server has
// no way to take one: no route accepts a file, and every message and request
// body is capped well below the size of any real model. The example design's
// model is a file that ships with Bench, served like a script or a font.

import { describe, expect, it } from "vitest";
import { EXAMPLE_ID } from "../shared/example.ts";
import { LIMITS } from "../shared/protocol.ts";
import { baseUrl, id, newDesign, stored, visit } from "./people.ts";

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

  it("refuses a model-sized request body", async () => {
    const res = await fetch(new URL("/api/designs", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Big", mesh: bulk() }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
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

describe("the STEP reader's exception", () => {
  it("only the STEP worker may build code from strings; every page stays strict", async () => {
    const design = await newDesign();
    for (const path of ["/", `/d/${design.id}`, "/readme/", "/build/design.js", "/build/importer.js"]) {
      const csp = (await fetch(new URL(path, baseUrl))).headers.get("content-security-policy") ?? "";
      expect(csp, path).not.toContain("unsafe-eval");
    }
    const worker = (await fetch(new URL("/build/step-worker.js", baseUrl))).headers.get("content-security-policy") ?? "";
    expect(worker).toContain("'unsafe-eval'");
    expect(worker).toContain("default-src 'self'");
  });
});

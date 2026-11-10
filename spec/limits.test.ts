// A full room is the case this is designed for, so the server has to survive
// the people in it. A limit that is hit gets an answer, never a crash.

import { expect, it } from "vitest";
import { baseUrl, newDesign, signUp, token, visit } from "./people.ts";

it("closes a connection that floods it, and keeps serving everyone else", async () => {
  const design = await newDesign();
  const a = await visit(design.id);
  const b = await visit(design.id);
  for (let i = 0; i < 300; i++) a.send({ t: "cursor", at: [i, 0, i] });
  expect((await a.closed).code).toBe(1008);
  b.send({ t: "cursor", at: [1, 0, 1] });
  await b.next("cursors");
  await b.close();
});

it("refuses a design with no name", async () => {
  const { cookie } = await signUp();
  const res = await fetch(new URL("/api/designs", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "   " }),
  });
  expect(res.status).toBe(400);
});

it("answers 404 for a design that does not exist, page, export and socket alike", async () => {
  expect((await fetch(new URL("/d/doesnotexist", baseUrl))).status).toBe(404);
  expect((await fetch(new URL("/d/doesnotexist/export.stl", baseUrl))).status).toBe(404);
  await expect(visit("doesnotexist", token())).rejects.toThrow();
});

it("loads nothing from anywhere but itself", async () => {
  const design = await newDesign();
  const { cookie } = await signUp();
  for (const path of ["/", `/d/${design.id}`, "/readme/", "/signin", "/signup", "/projects"]) {
    const res = await fetch(new URL(path, baseUrl), { headers: path === "/projects" ? { Cookie: cookie } : {} });
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await res.text();
    // a script, image or stylesheet from elsewhere; a link a reader may follow is not a load
    expect(html).not.toMatch(/src="(https?:)?\/\//);
    expect(html).not.toMatch(/<link[^>]+href="(https?:)?\/\//);
  }
});

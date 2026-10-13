// A full room is the case this is designed for, so the server has to survive
// the people in it. A limit that is hit gets an answer, never a crash.

import { expect, it } from "vitest";
import { baseUrl, newSheet, token, visit } from "./people.ts";

it("closes a connection that floods it, and keeps serving everyone else", async () => {
  const sheet = await newSheet();
  const a = await visit(sheet.id);
  const b = await visit(sheet.id);
  for (let i = 0; i < 300; i++) a.send({ t: "cursor", x: i, y: i });
  expect((await a.closed).code).toBe(1008);
  b.send({ t: "cursor", x: 1, y: 1 });
  await b.next("cursors");
  await b.close();
});

it("refuses a sheet with a silly size", async () => {
  const res = await fetch(new URL("/api/sheets", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "huge", w: 50_000, h: 10 }),
  });
  expect(res.status).toBe(400);
});

it("answers 404 for a sheet that does not exist, page and socket alike", async () => {
  expect((await fetch(new URL("/s/doesnotexist", baseUrl))).status).toBe(404);
  await expect(visit("doesnotexist", token())).rejects.toThrow();
});

it("loads nothing from anywhere but itself", async () => {
  const sheet = await newSheet();
  for (const path of ["/", `/s/${sheet.id}`, "/readme/"]) {
    const res = await fetch(new URL(path, baseUrl));
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await res.text();
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  }
});

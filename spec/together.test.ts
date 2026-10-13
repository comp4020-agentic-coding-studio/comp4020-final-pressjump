// Promise 3, and the brief's multi-user and real-time requirements: two
// people on one sheet are told apart, and each sees what the other does
// within a second, without doing anything.

import { describe, expect, it } from "vitest";
import { add, newSheet, token, visit } from "./people.ts";

describe("two people on one sheet", () => {
  it("are told apart, and the same browser is the same person", async () => {
    const sheet = await newSheet();
    const t = token();
    const a = await visit(sheet.id, t, "Ada");
    const b = await visit(sheet.id, token(), "Bo");
    const a2 = await visit(sheet.id, t, "");
    expect(a.you.id).not.toBe(b.you.id);
    expect(a2.you.id).toBe(a.you.id);
    expect(a2.you.name).toBe("Ada");
    await Promise.all([a.close(), b.close(), a2.close()]);
  });

  it("see each other arrive", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id, token(), "Ada");
    const b = await visit(sheet.id, token(), "Bo");
    const seen = await a.next("people", (m) => m.people.some((p) => p.id === b.you.id));
    expect(seen.people.map((p) => p.name).sort()).toEqual(["Ada", "Bo"]);
    await Promise.all([a.close(), b.close()]);
  });

  it("see a shape the other adds within a second, credited to them", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id);
    const b = await visit(sheet.id);
    const started = Date.now();
    const shape = await add(a, { kind: "circle", cx: 50, cy: 50, r: 10 });
    const arrived = await b.next("put", (m) => m.shape.id === shape.id, 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(arrived.shape).toMatchObject({ kind: "circle", cx: 50, cy: 50, r: 10, by: a.you.id, v: 1 });
    await Promise.all([a.close(), b.close()]);
  });

  it("see each other's cursor, and what they are drawing before it is committed", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id);
    const b = await visit(sheet.id);
    a.send({ t: "cursor", x: 12, y: 34, draft: [{ kind: "line", x1: 0, y1: 0, x2: 12, y2: 34 }] });
    const c = await b.next("cursors", (m) => m.cursors.some((x) => x.id === a.you.id), 1000);
    expect(c.cursors.find((x) => x.id === a.you.id)).toMatchObject({
      x: 12,
      y: 34,
      draft: [{ kind: "line", x2: 12, y2: 34 }],
    });
    await Promise.all([a.close(), b.close()]);
  });
});

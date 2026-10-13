// Promise 3, and the brief's multi-user and real-time requirements: two
// people in one design are told apart, and each sees what the other does
// within a second, without doing anything.

import { describe, expect, it } from "vitest";
import { add, box, newDesign, token, visit } from "./people.ts";

describe("two people in one design", () => {
  it("are told apart, and the same browser is the same person", async () => {
    const design = await newDesign();
    const t = token();
    const a = await visit(design.id, t, "Ada");
    const b = await visit(design.id, token(), "Bo");
    const a2 = await visit(design.id, t, "");
    expect(a.you.id).not.toBe(b.you.id);
    expect(a2.you.id).toBe(a.you.id);
    expect(a2.you.name).toBe("Ada");
    await Promise.all([a.close(), b.close(), a2.close()]);
  });

  it("see each other arrive", async () => {
    const design = await newDesign();
    const a = await visit(design.id, token(), "Ada");
    const b = await visit(design.id, token(), "Bo");
    const seen = await a.next("people", (m) => m.people.some((p) => p.id === b.you.id));
    expect(seen.people.map((p) => p.name).sort()).toEqual(["Ada", "Bo"]);
    await Promise.all([a.close(), b.close()]);
  });

  it("see a body the other adds within a second, credited to them, at the end of the timeline", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const b = await visit(design.id);
    const first = await add(a, box());
    const started = Date.now();
    const second = await add(a, box({ w: 40 }));
    const arrived = await b.next("put", (m) => m.feature.id === second.id, 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(arrived.feature).toMatchObject({ kind: "box", w: 40, by: a.you.id, v: 1 });
    expect(arrived.feature.seq).toBeGreaterThan(first.seq);
    await Promise.all([a.close(), b.close()]);
  });

  it("see each other's cursor, view, and what they are dragging before they let go", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const b = await visit(design.id);
    a.send({ t: "cursor", at: [12, 0, 34], cam: { p: [200, 150, 200], t: [0, 0, 0] }, draft: [box({ pos: [5, 0, 5] })] });
    const c = await b.next("cursors", (m) => m.cursors.some((x) => x.id === a.you.id), 1000);
    expect(c.cursors.find((x) => x.id === a.you.id)).toMatchObject({
      at: [12, 0, 34],
      cam: { p: [200, 150, 200], t: [0, 0, 0] },
      draft: [{ kind: "box", pos: [5, 0, 5] }],
    });
    await Promise.all([a.close(), b.close()]);
  });
});

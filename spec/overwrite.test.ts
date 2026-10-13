// Promise 2: nobody's work is overwritten without them seeing it. A held
// shape refuses everyone but its holder, an edit made against an old version
// is refused rather than applied, and every refusal says why.

import { describe, expect, it } from "vitest";
import { add, newSheet, stored, visit } from "./people.ts";

const box = { kind: "rect", x: 10, y: 10, w: 40, h: 20 } as const;

describe("a held shape", () => {
  it("refuses an edit from anyone but the person holding it, and names them", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id, undefined, "Ada");
    const b = await visit(sheet.id, undefined, "Bo");
    const shape = await add(a, box);
    a.send({ t: "hold", ids: [shape.id] });
    await b.next("holds", (m) => m.holds[shape.id] === a.you.id);

    b.send({ t: "update", id: shape.id, base: 1, g: { ...box, w: 99 } });
    const no = await b.next("reject");
    expect(no.reason).toBe("held");
    expect(no.who).toBe(a.you.id);
    expect(no.message).toContain("Ada");
    expect(no.shape).toMatchObject({ w: 40, v: 1 });

    b.send({ t: "delete", id: shape.id, base: 1 });
    expect((await b.next("reject")).reason).toBe("held");

    // the holder can still edit it
    a.send({ t: "update", id: shape.id, base: 1, g: { ...box, w: 41 } });
    await b.next("put", (m) => m.shape.id === shape.id && m.shape.kind === "rect" && m.shape.w === 41);
    expect((await stored(sheet.id))[0]).toMatchObject({ w: 41, v: 2, by: a.you.id });
    await Promise.all([a.close(), b.close()]);
  });

  it("cannot be taken by someone else, and is let go when its holder leaves", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id);
    const b = await visit(sheet.id);
    const shape = await add(a, box);
    a.send({ t: "hold", ids: [shape.id] });
    await b.next("holds", (m) => m.holds[shape.id] === a.you.id);

    b.send({ t: "hold", ids: [shape.id] });
    const answer = await b.next("holds");
    expect(answer.holds[shape.id]).toBe(a.you.id);

    await a.close();
    await b.next("holds", (m) => !(shape.id in m.holds));
    b.send({ t: "update", id: shape.id, base: 1, g: { ...box, h: 5 } });
    await b.next("put", (m) => m.shape.id === shape.id && m.shape.kind === "rect" && m.shape.h === 5);
    await b.close();
  });
});

describe("an edit made against an old version", () => {
  it("is refused, not applied over the newer one", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id, undefined, "Ada");
    const b = await visit(sheet.id, undefined, "Bo");
    const shape = await add(a, box);
    await b.next("put", (m) => m.shape.id === shape.id);

    // Ada moves it. Bo, on a slow connection, still sees version 1.
    a.send({ t: "update", id: shape.id, base: 1, g: { ...box, x: 100 } });
    await b.next("put", (m) => m.shape.id === shape.id && m.shape.v === 2);
    b.send({ t: "update", id: shape.id, base: 1, g: { ...box, y: 100 } });
    const no = await b.next("reject");
    expect(no.reason).toBe("stale");
    expect(no.message).toContain("Ada");
    expect(no.shape).toMatchObject({ x: 100, y: 10, v: 2 });
    expect((await stored(sheet.id))[0]).toMatchObject({ x: 100, y: 10, v: 2 });

    // a stale delete is refused too
    b.send({ t: "delete", id: shape.id, base: 1 });
    expect((await b.next("reject")).reason).toBe("stale");
    expect(await stored(sheet.id)).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });

  it("is accepted when edits follow each other in order, each on the last", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id);
    const shape = await add(a, box);
    // sent back to back without waiting, the way the editor does
    a.send({ t: "update", id: shape.id, base: 1, g: { ...box, x: 11 } });
    a.send({ t: "update", id: shape.id, base: 2, g: { ...box, x: 12 } });
    a.send({ t: "update", id: shape.id, base: 3, g: { ...box, x: 13 } });
    await a.next("put", (m) => m.shape.v === 4);
    expect((await stored(sheet.id))[0]).toMatchObject({ x: 13, v: 4 });
    await a.close();
  });
});

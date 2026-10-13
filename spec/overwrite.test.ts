// Promise 2: nobody's work is overwritten without them seeing it. A held
// feature refuses everyone but its holder, an edit made against an old
// version is refused rather than applied, a body that a combine uses cannot
// be pulled out from under it, and every refusal says why.

import { describe, expect, it } from "vitest";
import { add, box, cylinder, newDesign, stored, visit } from "./people.ts";

describe("a held body", () => {
  it("refuses an edit from anyone but the person holding it, and names them", async () => {
    const design = await newDesign();
    const a = await visit(design.id, undefined, "Ada");
    const b = await visit(design.id, undefined, "Bo");
    const f = await add(a, box());
    a.send({ t: "hold", ids: [f.id] });
    await b.next("holds", (m) => m.holds[f.id] === a.you.id);

    b.send({ t: "update", id: f.id, base: 1, f: box({ w: 99 }) });
    const no = await b.next("reject");
    expect(no.reason).toBe("held");
    expect(no.who).toBe(a.you.id);
    expect(no.message).toContain("Ada");
    expect(no.feature).toMatchObject({ w: 10, v: 1 });

    b.send({ t: "delete", id: f.id, base: 1 });
    expect((await b.next("reject")).reason).toBe("held");

    // the holder can still edit it
    a.send({ t: "update", id: f.id, base: 1, f: box({ w: 41 }) });
    await b.next("put", (m) => m.feature.id === f.id && m.feature.v === 2);
    expect((await stored(design.id))[0]).toMatchObject({ w: 41, v: 2, by: a.you.id });
    await Promise.all([a.close(), b.close()]);
  });

  it("cannot be taken by someone else, and is let go when its holder leaves", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const b = await visit(design.id);
    const f = await add(a, box());
    a.send({ t: "hold", ids: [f.id] });
    await b.next("holds", (m) => m.holds[f.id] === a.you.id);

    b.send({ t: "hold", ids: [f.id] });
    expect((await b.next("holds")).holds[f.id]).toBe(a.you.id);

    await a.close();
    await b.next("holds", (m) => !(f.id in m.holds));
    b.send({ t: "update", id: f.id, base: 1, f: box({ h: 5 }) });
    await b.next("put", (m) => m.feature.id === f.id && m.feature.v === 2);
    await b.close();
  });

  it("cannot be pulled into someone else's combine", async () => {
    const design = await newDesign();
    const a = await visit(design.id, undefined, "Ada");
    const b = await visit(design.id, undefined, "Bo");
    const target = await add(a, box());
    const tool = await add(a, cylinder());
    a.send({ t: "hold", ids: [tool.id] });
    await b.next("holds", (m) => m.holds[tool.id] === a.you.id);
    b.send({ t: "add", id: "combineByBo", f: { kind: "combine", name: "Cut", op: "cut", target: target.id, tools: [tool.id] } });
    const no = await b.next("reject");
    expect(no.reason).toBe("held");
    expect(no.message).toContain("Ada");
    expect(await stored(design.id)).toHaveLength(2);
    await Promise.all([a.close(), b.close()]);
  });
});

describe("an edit made against an old version", () => {
  it("is refused, not applied over the newer one", async () => {
    const design = await newDesign();
    const a = await visit(design.id, undefined, "Ada");
    const b = await visit(design.id, undefined, "Bo");
    const f = await add(a, box());
    await b.next("put", (m) => m.feature.id === f.id);

    // Ada moves it. Bo, on a slow connection, still sees version 1.
    a.send({ t: "update", id: f.id, base: 1, f: box({ pos: [100, 0, 0] }) });
    await b.next("put", (m) => m.feature.id === f.id && m.feature.v === 2);
    b.send({ t: "update", id: f.id, base: 1, f: box({ pos: [0, 0, 100] }) });
    const no = await b.next("reject");
    expect(no.reason).toBe("stale");
    expect(no.message).toContain("Ada");
    expect(no.feature).toMatchObject({ pos: [100, 0, 0], v: 2 });
    expect((await stored(design.id))[0]).toMatchObject({ pos: [100, 0, 0], v: 2 });

    b.send({ t: "delete", id: f.id, base: 1 });
    expect((await b.next("reject")).reason).toBe("stale");
    expect(await stored(design.id)).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });

  it("is accepted when edits follow each other in order, each on the last", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const f = await add(a, box());
    // sent back to back without waiting, the way a drag does
    a.send({ t: "update", id: f.id, base: 1, f: box({ pos: [1, 0, 0] }) });
    a.send({ t: "update", id: f.id, base: 2, f: box({ pos: [2, 0, 0] }) });
    a.send({ t: "update", id: f.id, base: 3, f: box({ pos: [3, 0, 0] }) });
    await a.next("put", (m) => m.feature.v === 4);
    expect((await stored(design.id))[0]).toMatchObject({ pos: [3, 0, 0], v: 4 });
    await a.close();
  });
});

describe("a body a combine uses", () => {
  it("cannot be deleted while the combine needs it; deleting the combine frees it", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const target = await add(a, box());
    const tool = await add(a, cylinder());
    const cut = await add(a, { kind: "combine", name: "Hole", op: "cut", target: target.id, tools: [tool.id] });

    a.send({ t: "delete", id: tool.id, base: 1 });
    const no = await a.next("reject");
    expect(no.reason).toBe("used");
    expect(no.message).toContain("Hole");

    a.send({ t: "delete", id: cut.id, base: 1 });
    await a.next("del", (m) => m.id === cut.id);
    a.send({ t: "delete", id: tool.id, base: 1 });
    await a.next("del", (m) => m.id === tool.id);
    expect((await stored(design.id)).map((f) => f.id)).toEqual([target.id]);
    await a.close();
  });
});

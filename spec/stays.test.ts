// Promise 4: it stays. What one person did is there for the next person who
// opens the design, in the same order, and in what the server reads back from
// disk. Surviving a restart cannot be checked from here, against a server
// that stays up; see CLAUDE.md for the by-hand check.

import { expect, it } from "vitest";
import { add, box, cylinder, newDesign, stored, visit } from "./people.ts";

it("a body is there for whoever opens the design next, as it was last left", async () => {
  const design = await newDesign();
  const a = await visit(design.id, undefined, "Ada");
  const f = await add(a, box());
  a.send({ t: "update", id: f.id, base: 1, f: box({ w: 55, colour: "#2f6db5" }) });
  await a.next("put", (m) => m.feature.v === 2);
  await a.close();

  const b = await visit(design.id);
  expect(b.welcome.features).toEqual([{ ...box({ w: 55, colour: "#2f6db5" }), id: f.id, v: 2, by: a.you.id, seq: f.seq }]);
  // and who made it, though they have gone
  expect(b.welcome.authors.find((p) => p.id === a.you.id)?.name).toBe("Ada");
  expect(await stored(design.id)).toEqual(b.welcome.features);
  await b.close();
});

it("the timeline keeps its order across visits", async () => {
  const design = await newDesign();
  const a = await visit(design.id);
  const one = await add(a, box());
  const two = await add(a, cylinder());
  const three = await add(a, { kind: "combine", name: "Cut", op: "cut", target: one.id, tools: [two.id] });
  // editing the first feature does not move it to the end
  a.send({ t: "update", id: one.id, base: 1, f: box({ w: 30 }) });
  await a.next("put", (m) => m.feature.id === one.id && m.feature.v === 2);
  const order = (fs: { id: string; seq: number }[]): string[] => [...fs].sort((x, y) => x.seq - y.seq).map((f) => f.id);
  // someone arriving while the design is open gets it from the server's memory
  const b = await visit(design.id);
  expect(order(b.welcome.features)).toEqual([one.id, two.id, three.id]);
  await Promise.all([a.close(), b.close()]);
  // and someone arriving after everyone has gone gets it from disk
  const c = await visit(design.id);
  expect(order(c.welcome.features)).toEqual([one.id, two.id, three.id]);
  await c.close();
});

it("a deleted body stays deleted", async () => {
  const design = await newDesign();
  const a = await visit(design.id);
  const f = await add(a, box());
  a.send({ t: "delete", id: f.id, base: 1 });
  await a.next("del");
  await a.close();
  const b = await visit(design.id);
  expect(b.welcome.features).toEqual([]);
  await b.close();
});

it("holds do not outlive the connection: a fresh visitor finds nothing held", async () => {
  const design = await newDesign();
  const a = await visit(design.id);
  const f = await add(a, box());
  a.send({ t: "hold", ids: [f.id] });
  await a.next("holds", (m) => f.id in m.holds);
  await a.close();
  const b = await visit(design.id);
  expect(b.welcome.holds).toEqual({});
  await b.close();
});

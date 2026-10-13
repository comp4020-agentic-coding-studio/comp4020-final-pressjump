// Promise 4: it stays. What one person did is there for the next person who
// opens the sheet, and in what the server reads back from disk. Surviving a
// restart cannot be checked from here, against a server that stays up; see
// CLAUDE.md for the by-hand check.

import { expect, it } from "vitest";
import { add, newSheet, stored, visit } from "./people.ts";

it("a shape is there for whoever opens the sheet next, as it was last left", async () => {
  const sheet = await newSheet();
  const a = await visit(sheet.id, undefined, "Ada");
  const shape = await add(a, { kind: "line", x1: 1, y1: 2, x2: 3, y2: 4 });
  a.send({ t: "update", id: shape.id, base: 1, g: { kind: "line", x1: 1, y1: 2, x2: 30, y2: 40 } });
  await a.next("put", (m) => m.shape.v === 2);
  await a.close();

  const b = await visit(sheet.id);
  expect(b.welcome.shapes).toEqual([{ kind: "line", x1: 1, y1: 2, x2: 30, y2: 40, id: shape.id, v: 2, by: a.you.id }]);
  // and who drew it, though they have gone
  expect(b.welcome.authors.find((p) => p.id === a.you.id)?.name).toBe("Ada");
  expect(await stored(sheet.id)).toEqual(b.welcome.shapes);
  await b.close();
});

it("a deleted shape stays deleted", async () => {
  const sheet = await newSheet();
  const a = await visit(sheet.id);
  const shape = await add(a, { kind: "circle", cx: 1, cy: 1, r: 1 });
  a.send({ t: "delete", id: shape.id, base: 1 });
  await a.next("del");
  await a.close();
  const b = await visit(sheet.id);
  expect(b.welcome.shapes).toEqual([]);
  await b.close();
});

it("holds do not outlive the connection: a fresh visitor finds nothing held", async () => {
  const sheet = await newSheet();
  const a = await visit(sheet.id);
  const shape = await add(a, { kind: "circle", cx: 1, cy: 1, r: 1 });
  a.send({ t: "hold", ids: [shape.id] });
  await a.next("holds", (m) => shape.id in m.holds);
  await a.close();
  const b = await visit(sheet.id);
  expect(b.welcome.holds).toEqual({});
  await b.close();
});

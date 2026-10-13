// Promise 1: the numbers are true. A feature the server cannot build at size
// is refused with a reason, a combine that refers to something it cannot use
// is refused, and the STL export is the stored timeline in millimetres: the
// spec measures its volume and size.

import { describe, expect, it } from "vitest";
import { validateFeature } from "../shared/model.ts";
import { add, baseUrl, box, cylinder, id, newDesign, readStl, stored, visit } from "./people.ts";

const place = { name: "x", pos: [0, 0, 0], rot: [0, 0, 0], colour: "#b9bec4" };

describe("features the server refuses", () => {
  const bad: [string, unknown][] = [
    ["a negative radius", { ...place, kind: "cylinder", r: -1, h: 10 }],
    ["a box with no height", { ...place, kind: "box", w: 10, h: 0, d: 10, fillet: 0 }],
    ["a fillet bigger than the box", { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 5 }],
    ["a torus tube thicker than its ring", { ...place, kind: "torus", R: 5, r: 6 }],
    ["a sketch with no area", { ...place, kind: "extrude", depth: 5, profile: { type: "poly", pts: [[0, 0], [10, 0], [20, 0]] } }],
    ["an extrude that goes nowhere", { ...place, kind: "extrude", depth: 0, profile: { type: "circle", cx: 0, cy: 0, r: 5 } }],
    ["a string for a number", { ...place, kind: "sphere", r: "5" }],
    ["a position a kilometre away", { ...place, kind: "sphere", r: 5, pos: [1_000_000, 0, 0] }],
    ["an unknown kind", { ...place, kind: "spline" }],
  ];

  for (const [what, f] of bad) {
    it(`refuses ${what}, says why, and stores nothing`, async () => {
      const design = await newDesign();
      const a = await visit(design.id);
      a.send({ t: "add", id: id(), f: f as never });
      const no = await a.next("reject");
      expect(no.reason).toBe("invalid");
      expect(no.message.length).toBeGreaterThan(5);
      expect(await stored(design.id)).toEqual([]);
      await a.close();
    });
  }

  it("refuses a combine whose bodies do not exist, or are already used up", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const target = await add(a, box());
    const tool = await add(a, cylinder());
    a.send({ t: "add", id: id(), f: { kind: "combine", name: "C", op: "cut", target: target.id, tools: ["nosuchbody"] } });
    expect((await a.next("reject")).message).toContain("deleted");
    const first = await add(a, { kind: "combine", name: "First", op: "cut", target: target.id, tools: [tool.id] });
    a.send({ t: "add", id: id(), f: { kind: "combine", name: "Again", op: "join", target: target.id, tools: [tool.id] } });
    expect((await a.next("reject")).message).toContain("used up by First");
    a.send({ t: "add", id: id(), f: { kind: "combine", name: "Of", op: "join", target: first.id, tools: [tool.id] } });
    expect((await a.next("reject")).reason).toBe("invalid");
    expect(await stored(design.id)).toHaveLength(3);
    await a.close();
  });

  it("refuses changing a box into a sphere", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const f = await add(a, box());
    a.send({ t: "update", id: f.id, base: 1, f: { ...place, kind: "sphere", r: 3 } as never });
    expect((await a.next("reject")).reason).toBe("invalid");
    await a.close();
  });
});

it("rounds to a thousandth of a millimetre, and keeps angles in (-180, 180]", () => {
  expect(validateFeature({ ...place, kind: "sphere", r: 2.0005, pos: [1.23456, 0, 0], rot: [370, -190, 180] })).toMatchObject({
    r: 2.001,
    pos: [1.235, 0, 0],
    rot: [10, 170, 180],
  });
});

describe("the STL export", () => {
  async function stl(design: string) {
    const res = await fetch(new URL(`/d/${design}/export.stl`, baseUrl));
    expect(res.headers.get("content-disposition")).toContain(".stl");
    return readStl(await res.arrayBuffer());
  }

  it("is the body at size in millimetres, standing Z up", async () => {
    const design = await newDesign("Block");
    const a = await visit(design.id);
    await add(a, box({ w: 10, h: 20, d: 30 }));
    await a.close();
    const s = await stl(design.id);
    expect(s.volume).toBeCloseTo(6000, 1);
    // model Y (height, 20) is STL Z; model Z (depth, 30) is STL Y
    expect(s.max[0] - s.min[0]).toBeCloseTo(10, 3);
    expect(s.max[1] - s.min[1]).toBeCloseTo(30, 3);
    expect(s.max[2] - s.min[2]).toBeCloseTo(20, 3);
    expect(s.min[2]).toBeCloseTo(0, 3);
  });

  it("carries a cut, and follows the cutter when it moves", async () => {
    const design = await newDesign("Plate with a hole");
    const a = await visit(design.id);
    await add(a, box({ w: 40, h: 10, d: 40 }));
    const plate = (await stored(design.id))[0];
    const drill = await add(a, cylinder({ r: 5, h: 20, pos: [0, -5, 0] }));
    await add(a, { kind: "combine", name: "Hole", op: "cut", target: plate.id, tools: [drill.id] });
    // a 64-sided hole of radius 5 through 10 mm
    const hole = 0.5 * 64 * 25 * Math.sin((2 * Math.PI) / 64) * 10;
    expect((await stl(design.id)).volume).toBeCloseTo(16000 - hole, 0);

    // move the drill clear of the plate: the hole goes with it
    a.send({ t: "update", id: drill.id, base: 1, f: cylinder({ r: 5, h: 20, pos: [100, -5, 0] }) });
    await a.next("put", (m) => m.feature.id === drill.id && m.feature.v === 2);
    expect((await stl(design.id)).volume).toBeCloseTo(16000, 0);
    await a.close();
  });

  it("leaves out bodies a combine has used up", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    const target = await add(a, box({ w: 10, h: 10, d: 10 }));
    const tool = await add(a, box({ w: 10, h: 10, d: 10, pos: [5, 0, 0] }));
    await add(a, { kind: "combine", name: "Join", op: "join", target: target.id, tools: [tool.id] });
    await a.close();
    expect((await stl(design.id)).volume).toBeCloseTo(1500, 0);
  });
});

// Promise 1: the numbers are true. A feature the server cannot build at size
// is refused with a reason, a combine that refers to something it cannot use
// is refused, and the STL export is the stored timeline in millimetres: the
// spec measures its volume and size.

import { describe, expect, it } from "vitest";
import { segments } from "../shared/evaluate.ts";
import { validateFeature } from "../shared/model.ts";
import type { Body } from "../shared/model.ts";
import { add, baseUrl, box, cylinder, id, newDesign, readStl, stored, visit } from "./people.ts";

const place = { name: "x", pos: [0, 0, 0], rot: [0, 0, 0], colour: "#b9bec4" };

describe("features the server refuses", () => {
  const bad: [string, unknown][] = [
    ["a negative radius", { ...place, kind: "cylinder", r: -1, h: 10 }],
    ["a box with no height", { ...place, kind: "box", w: 10, h: 0, d: 10, fillet: 0 }],
    ["a fillet bigger than the box", { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 5 }],
    ["a chamfer bigger than the box", { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 0, chamfer: 5 }],
    ["a box with both a fillet and a chamfer", { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 1, chamfer: 1 }],
    ["a negative chamfer", { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 0, chamfer: -1 }],
    ["a cylinder chamfer as wide as its radius", { ...place, kind: "cylinder", r: 5, h: 20, chamfer: 5 }],
    ["a cylinder chamfer taller than half the cylinder", { ...place, kind: "cylinder", r: 20, h: 10, chamfer: 5 }],
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

  it("bevels every edge of a chamfered box by exactly the chamfer", async () => {
    const design = await newDesign("Chamfered block");
    const a = await visit(design.id);
    await add(a, box({ w: 20, h: 20, d: 20, chamfer: 2 } as Partial<Body>));
    await a.close();
    const s = await stl(design.id);
    // Each edge loses a c x c / 2 prism, 2c^2 (W + H + D) in all. Where three
    // edges meet, the prisms overlap (+6c^3 back, by inclusion-exclusion), and
    // the corner is cut flat by a triangle through the three chamfer ends,
    // taking a further c^3 / 12 pyramid at each of the 8 corners:
    // 8000 - 2c^2 (60) + 6c^3 - 8c^3 / 12, with c = 2.
    const c = 2;
    expect(s.volume).toBeCloseTo(8000 - 2 * c * c * 60 + 6 * c ** 3 - (8 * c ** 3) / 12, 1);
    expect(s.max[0] - s.min[0]).toBeCloseTo(20, 3);
    expect(s.max[2] - s.min[2]).toBeCloseTo(20, 3);
  });

  it("bevels both rims of a chamfered cylinder", async () => {
    const design = await newDesign("Chamfered puck");
    const a = await visit(design.id);
    await add(a, cylinder({ r: 10, h: 10, chamfer: 2 } as Partial<Body>));
    await a.close();
    // a prism of segments(10) sides less two rings, each a 2 x 2 / 2 triangle
    // swept round its centroid (Pappus), on the same sides
    const n = segments(10);
    const k = 0.5 * n * Math.sin((2 * Math.PI) / n) / Math.PI;
    const expected = k * (Math.PI * 100 * 10 - 2 * 2 * Math.PI * (10 - 2 / 3) * 2);
    expect((await stl(design.id)).volume).toBeCloseTo(expected, 0);
  });

  it("keeps a design made before chamfers existed: a missing chamfer is none", () => {
    const old = { ...place, kind: "box", w: 10, h: 10, d: 10, fillet: 0 };
    expect(validateFeature(old)).toMatchObject({ chamfer: 0 });
  });

  it("carries a cut, and follows the cutter when it moves", async () => {
    const design = await newDesign("Plate with a hole");
    const a = await visit(design.id);
    await add(a, box({ w: 40, h: 10, d: 40 }));
    const plate = (await stored(design.id))[0];
    const drill = await add(a, cylinder({ r: 5, h: 20, pos: [0, -5, 0] }));
    await add(a, { kind: "combine", name: "Hole", op: "cut", target: plate.id, tools: [drill.id] });
    // a hole of radius 5, drawn with segments(5) sides, through 10 mm
    const hole = 0.5 * segments(5) * 25 * Math.sin((2 * Math.PI) / segments(5)) * 10;
    expect((await stl(design.id)).volume).toBeCloseTo(16000 - hole, 0);

    // move the drill clear of the plate: the hole goes with it
    a.send({ t: "update", id: drill.id, base: 1, f: cylinder({ r: 5, h: 20, pos: [100, -5, 0] }) });
    await a.next("ok", (m) => m.id === drill.id && m.v === 2);
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

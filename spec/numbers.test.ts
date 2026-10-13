// Promise 1: the numbers are true. Geometry the server cannot draw at size is
// refused with a reason, everything is rounded to the micron, and the exports
// are the stored shapes in millimetres.

import { describe, expect, it } from "vitest";
import { validateGeometry } from "../shared/geometry.ts";
import { add, baseUrl, id, newSheet, stored, visit } from "./people.ts";

describe("geometry the server refuses", () => {
  const bad: [string, unknown][] = [
    ["a negative radius", { kind: "circle", cx: 0, cy: 0, r: -1 }],
    ["a zero-length line", { kind: "line", x1: 5, y1: 5, x2: 5, y2: 5 }],
    ["a flat rectangle", { kind: "rect", x: 0, y: 0, w: 10, h: 0 }],
    ["a string for a number", { kind: "line", x1: "0", y1: 0, x2: 10, y2: 0 }],
    ["a missing field", { kind: "circle", cx: 0, cy: 0 }],
    ["a point a kilometre away", { kind: "circle", cx: 1_000_000, cy: 0, r: 1 }],
    ["an unknown kind", { kind: "spline", x: 0 }],
  ];

  for (const [what, g] of bad) {
    it(`refuses ${what}, says why, and stores nothing`, async () => {
      const sheet = await newSheet();
      const a = await visit(sheet.id);
      a.send({ t: "add", id: id(), g: g as never });
      const no = await a.next("reject");
      expect(no.reason).toBe("invalid");
      expect(no.message.length).toBeGreaterThan(5);
      expect(await stored(sheet.id)).toEqual([]);
      await a.close();
    });
  }

  it("refuses changing a circle into a line", async () => {
    const sheet = await newSheet();
    const a = await visit(sheet.id);
    const shape = await add(a, { kind: "circle", cx: 0, cy: 0, r: 3 });
    a.send({ t: "update", id: shape.id, base: 1, g: { kind: "line", x1: 0, y1: 0, x2: 1, y2: 1 } });
    expect((await a.next("reject")).reason).toBe("invalid");
    await a.close();
  });
});

it("rounds every coordinate to a thousandth of a millimetre", () => {
  expect(validateGeometry({ kind: "circle", cx: 1.23456, cy: 7.0004, r: 2.0005 })).toEqual({
    kind: "circle",
    cx: 1.235,
    cy: 7,
    r: 2.001,
  });
});

describe("exports", () => {
  async function drawn() {
    const sheet = await newSheet("Box lid", 100, 50);
    const a = await visit(sheet.id);
    await add(a, { kind: "circle", cx: 20, cy: 10, r: 5 });
    await add(a, { kind: "rect", x: 40, y: 5, w: 30, h: 20 });
    await add(a, { kind: "line", x1: 0, y1: 45, x2: 100, y2: 45 });
    await add(a, { kind: "dim", x1: 40, y1: 25, x2: 70, y2: 25, off: -6 });
    await a.close();
    return sheet;
  }

  it("SVG is the sheet at size in millimetres, with every shape", async () => {
    const sheet = await drawn();
    const res = await fetch(new URL(`/s/${sheet.id}/export.svg`, baseUrl));
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-disposition")).toContain("box-lid.svg");
    const svg = await res.text();
    expect(svg).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
    expect(svg).toContain('<circle cx="20" cy="10" r="5"/>');
    expect(svg).toContain('<rect x="40" y="5" width="30" height="20"/>');
    expect(svg).toContain('<line x1="0" y1="45" x2="100" y2="45"/>');
    expect(svg).toMatch(/<g id="dimensions"[^>]*>.*>30<\/text>/s);
  });

  it("DXF is in millimetres, not mirrored, and carries cut lines only", async () => {
    const sheet = await drawn();
    const dxf = await (await fetch(new URL(`/s/${sheet.id}/export.dxf`, baseUrl))).text();
    const lines = dxf.split("\r\n");
    const units = lines.indexOf("$INSUNITS");
    expect(lines.slice(units + 1, units + 3)).toEqual(["70", "4"]);
    // the circle's centre is 10 mm from the top of a 50 mm sheet, so y = 40
    // DXF is code/value pairs; read the circle's pairs up to the next entity
    const circle = lines.indexOf("CIRCLE");
    const pairs = new Map<string, string>();
    for (let i = circle + 1; i + 1 < lines.length && lines[i] !== "0"; i += 2) pairs.set(lines[i], lines[i + 1]);
    expect([pairs.get("10"), pairs.get("20"), pairs.get("40")]).toEqual(["20", "40", "5"]);
    // one line plus four rectangle sides; the dimension is a note, not a cut
    expect(lines.filter((l) => l === "LINE")).toHaveLength(5);
    expect(dxf).not.toContain("TEXT");
  });
});

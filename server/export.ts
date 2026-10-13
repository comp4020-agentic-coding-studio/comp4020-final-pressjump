// Exports are made here, from the stored shapes, never from what a browser is
// showing. Both are millimetres at size.

import { dimensionLine, mm, type Shape } from "../shared/geometry.ts";
import type { Sheet } from "../shared/protocol.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// SVG keeps the sheet's own coordinates (y down), so one user unit is one
// millimetre and width/height say so. Cut geometry and dimensions are separate
// groups, so a laser cutter's software can drop the notes.
export function toSvg(sheet: Sheet, shapes: Shape[]): string {
  const cut: string[] = [];
  const notes: string[] = [];
  for (const s of shapes) {
    switch (s.kind) {
      case "line":
        cut.push(`<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/>`);
        break;
      case "rect":
        cut.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"/>`);
        break;
      case "circle":
        cut.push(`<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}"/>`);
        break;
      case "dim": {
        const d = dimensionLine(s);
        const mx = (d.a.x + d.b.x) / 2 + d.nx * 1.5;
        const my = (d.a.y + d.b.y) / 2 + d.ny * 1.5;
        let angle = (Math.atan2(d.b.y - d.a.y, d.b.x - d.a.x) * 180) / Math.PI;
        if (angle > 90 || angle < -90) angle += 180;
        notes.push(
          `<line x1="${s.x1}" y1="${s.y1}" x2="${d.a.x}" y2="${d.a.y}"/>` +
            `<line x1="${s.x2}" y1="${s.y2}" x2="${d.b.x}" y2="${d.b.y}"/>` +
            `<line x1="${d.a.x}" y1="${d.a.y}" x2="${d.b.x}" y2="${d.b.y}"/>` +
            `<text x="${mx}" y="${my}" transform="rotate(${angle.toFixed(3)} ${mx} ${my})">${mm(d.length)}</text>`,
        );
        break;
      }
    }
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">`,
    `<title>${esc(sheet.name)}</title>`,
    `<g id="cut" fill="none" stroke="#000" stroke-width="0.1">${cut.join("")}</g>`,
    `<g id="dimensions" fill="none" stroke="#1f5fbf" stroke-width="0.1" font-family="sans-serif" font-size="3" text-anchor="middle">${notes
      .join("")
      .replace(/<text /g, '<text fill="#1f5fbf" stroke="none" ')}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

// DXF R12, the version every laser cutter and CAM tool reads. Dimensions are
// notes, not cuts, so they stay out. DXF's y axis points up, so y is flipped
// against the sheet height or the part comes out mirrored.
export function toDxf(sheet: Sheet, shapes: Shape[]): string {
  const out: (string | number)[] = [];
  const pair = (code: number, value: string | number): void => {
    out.push(code, value);
  };
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  const y = (v: number): number => r(sheet.h - v);
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    pair(0, "LINE");
    pair(8, "CUT");
    pair(10, r(x1));
    pair(20, y(y1));
    pair(30, 0);
    pair(11, r(x2));
    pair(21, y(y2));
    pair(31, 0);
  };

  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$ACADVER");
  pair(1, "AC1009");
  pair(9, "$INSUNITS");
  pair(70, 4);
  pair(9, "$MEASUREMENT");
  pair(70, 1);
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const s of shapes) {
    switch (s.kind) {
      case "line":
        line(s.x1, s.y1, s.x2, s.y2);
        break;
      case "rect":
        line(s.x, s.y, s.x + s.w, s.y);
        line(s.x + s.w, s.y, s.x + s.w, s.y + s.h);
        line(s.x + s.w, s.y + s.h, s.x, s.y + s.h);
        line(s.x, s.y + s.h, s.x, s.y);
        break;
      case "circle":
        pair(0, "CIRCLE");
        pair(8, "CUT");
        pair(10, s.cx);
        pair(20, y(s.cy));
        pair(30, 0);
        pair(40, s.r);
        break;
      case "dim":
        break;
    }
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

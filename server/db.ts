// SQLite on the /data volume, through node:sqlite (no native module to build).
// Every write here is synchronous and finishes before the caller broadcasts,
// which is the whole of the "it stays" promise.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Geometry, Shape } from "../shared/geometry.ts";
import type { Person, Sheet } from "../shared/protocol.ts";

const dir = process.env.DATA_DIR ?? "./data";
mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(join(dir, "bench.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shapes (
    sheet TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    v INTEGER NOT NULL,
    by TEXT NOT NULL,
    geom TEXT NOT NULL,
    PRIMARY KEY (sheet, id)
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
`);

type SheetRow = { id: string; name: string; w: number; h: number; updated: number; shapes: number };

const q = {
  sheets: db.prepare(
    `SELECT s.id, s.name, s.w, s.h, s.updated, (SELECT COUNT(*) FROM shapes WHERE sheet = s.id) AS shapes
     FROM sheets s ORDER BY s.updated DESC LIMIT 200`,
  ),
  sheet: db.prepare(`SELECT id, name, w, h FROM sheets WHERE id = ?`),
  addSheet: db.prepare(`INSERT INTO sheets (id, name, w, h, created, updated) VALUES (?, ?, ?, ?, ?, ?)`),
  renameSheet: db.prepare(`UPDATE sheets SET name = ?, updated = ? WHERE id = ?`),
  touchSheet: db.prepare(`UPDATE sheets SET updated = ? WHERE id = ?`),
  shapes: db.prepare(`SELECT id, v, by, geom FROM shapes WHERE sheet = ? ORDER BY seq`),
  maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM shapes WHERE sheet = ?`),
  putShape: db.prepare(
    `INSERT INTO shapes (sheet, id, seq, v, by, geom) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (sheet, id) DO UPDATE SET v = excluded.v, by = excluded.by, geom = excluded.geom`,
  ),
  delShape: db.prepare(`DELETE FROM shapes WHERE sheet = ? AND id = ?`),
  person: db.prepare(`SELECT id, name FROM people WHERE id = ?`),
  putPerson: db.prepare(
    `INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
  ),
};

export function listSheets(): SheetRow[] {
  return q.sheets.all() as SheetRow[];
}

export function getSheet(id: string): Sheet | undefined {
  return q.sheet.get(id) as Sheet | undefined;
}

export function addSheet(sheet: Sheet): void {
  const now = Date.now();
  q.addSheet.run(sheet.id, sheet.name, sheet.w, sheet.h, now, now);
}

export function renameSheet(id: string, name: string): void {
  q.renameSheet.run(name, Date.now(), id);
}

export function loadShapes(sheet: string): Shape[] {
  const rows = q.shapes.all(sheet) as { id: string; v: number; by: string; geom: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.geom) as Geometry), id: r.id, v: r.v, by: r.by }));
}

// seq orders shapes bottom to top; it is set when a shape is first written and
// an update keeps it, so editing a shape does not lift it above the others.
export function putShape(sheet: string, shape: Shape): void {
  const { id, v, by, ...geom } = shape;
  const seq = (q.maxSeq.get(sheet) as { seq: number }).seq + 1;
  q.putShape.run(sheet, id, seq, v, by, JSON.stringify(geom));
  q.touchSheet.run(Date.now(), sheet);
}

export function deleteShape(sheet: string, id: string): void {
  q.delShape.run(sheet, id);
  q.touchSheet.run(Date.now(), sheet);
}

export function getPerson(id: string): { id: string; name: string } | undefined {
  return q.person.get(id) as { id: string; name: string } | undefined;
}

export function putPerson(id: string, name: string): void {
  q.putPerson.run(id, name);
}

export function close(): void {
  db.close();
}

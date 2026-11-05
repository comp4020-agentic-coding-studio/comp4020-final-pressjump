// SQLite on the /data volume, through node:sqlite (no native module to build).
// Every write here is synchronous and finishes before the caller broadcasts,
// which is the whole of the "it stays" promise.

import { EXAMPLE_ID } from "../shared/example.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Feature, Stored } from "../shared/model.ts";
import type { Design } from "../shared/protocol.ts";

const dir = process.env.DATA_DIR ?? "./data";
mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(join(dir, "bench3d.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS designs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS features (
    design TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    v INTEGER NOT NULL,
    by TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (design, id)
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
`);

// Every design has a second, view-only link: its own random id, which says
// nothing about the edit id. Designs made before there were view links get
// one here, once, the first time the server starts with this code.
const columns = db.prepare(`PRAGMA table_info(designs)`).all() as { name: string }[];
if (!columns.some((c) => c.name === "view")) db.exec(`ALTER TABLE designs ADD COLUMN view TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS designs_view ON designs (view)`);
const viewId = (): string => randomBytes(12).toString("base64url").replace(/[-_]/g, "x").slice(0, 16);
for (const row of db.prepare(`SELECT id FROM designs WHERE view IS NULL`).all() as { id: string }[]) {
  db.prepare(`UPDATE designs SET view = ? WHERE id = ?`).run(viewId(), row.id);
}

type DesignRow = { id: string; view: string; name: string; updated: number; features: number };

const q = {
  designs: db.prepare(
    `SELECT d.id, d.view, d.name, d.updated, (SELECT COUNT(*) FROM features WHERE design = d.id) AS features
     FROM designs d ORDER BY d.id = ? DESC, d.updated DESC LIMIT 200`,
  ),
  design: db.prepare(`SELECT id, name FROM designs WHERE id = ?`),
  byView: db.prepare(`SELECT id, name FROM designs WHERE view = ?`),
  viewOf: db.prepare(`SELECT view FROM designs WHERE id = ?`),
  addDesign: db.prepare(`INSERT INTO designs (id, name, created, updated, view) VALUES (?, ?, ?, ?, ?)`),
  renameDesign: db.prepare(`UPDATE designs SET name = ?, updated = ? WHERE id = ?`),
  touch: db.prepare(`UPDATE designs SET updated = ? WHERE id = ?`),
  features: db.prepare(`SELECT id, seq, v, by, body FROM features WHERE design = ? ORDER BY seq`),
  put: db.prepare(
    `INSERT INTO features (design, id, seq, v, by, body) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (design, id) DO UPDATE SET v = excluded.v, by = excluded.by, body = excluded.body`,
  ),
  del: db.prepare(`DELETE FROM features WHERE design = ? AND id = ?`),
  person: db.prepare(`SELECT id, name FROM people WHERE id = ?`),
  putPerson: db.prepare(`INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name`),
};

export function listDesigns(): DesignRow[] {
  // the example first, so it is never pushed off the end of the list
  return q.designs.all(EXAMPLE_ID) as DesignRow[];
}

export function getDesign(id: string): Design | undefined {
  return q.design.get(id) as Design | undefined;
}

// a new design, with its view-only link's id
export function addDesign(design: Design): string {
  const now = Date.now();
  const view = viewId();
  q.addDesign.run(design.id, design.name, now, now, view);
  return view;
}

// the design a view-only link opens
export function getDesignByView(view: string): Design | undefined {
  return q.byView.get(view) as Design | undefined;
}

export function viewOf(id: string): string {
  return (q.viewOf.get(id) as { view: string }).view;
}

export function renameDesign(id: string, name: string): void {
  q.renameDesign.run(name, Date.now(), id);
}

export function loadFeatures(design: string): Stored[] {
  const rows = q.features.all(design) as { id: string; seq: number; v: number; by: string; body: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.body) as Feature), id: r.id, v: r.v, by: r.by, seq: r.seq }));
}

// seq is the feature's place in the timeline: set when it is first written,
// kept by every update.
export function putFeature(design: string, f: Stored): void {
  const { id, v, by, seq, ...body } = f;
  q.put.run(design, id, seq, v, by, JSON.stringify(body));
  q.touch.run(Date.now(), design);
}

export function deleteFeature(design: string, id: string): void {
  q.del.run(design, id);
  q.touch.run(Date.now(), design);
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

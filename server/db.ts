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

// Accounts: an email, a password kept only as a scrypt hash, and the name
// shown on the cursor. A session is a random token in an HttpOnly cookie; only
// its hash is stored, so the table cannot be used to sign in as anyone.
// `opened` is each account's list of projects: the designs it made and the
// ones it has opened, with how far it may go in each. Guests opening a link
// leave nothing here.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS opened (
    user TEXT NOT NULL,
    design TEXT NOT NULL,
    access TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user, design)
  );
`);
if (!columns.some((c) => c.name === "owner")) db.exec(`ALTER TABLE designs ADD COLUMN owner TEXT`);
db.prepare(`DELETE FROM sessions WHERE expires < ?`).run(Date.now());

type DesignRow = { id: string; view: string; name: string; updated: number; features: number };

const q = {
  designs: db.prepare(
    `SELECT d.id, d.view, d.name, d.updated, (SELECT COUNT(*) FROM features WHERE design = d.id) AS features
     FROM designs d ORDER BY d.id = ? DESC, d.updated DESC LIMIT 200`,
  ),
  design: db.prepare(`SELECT id, name FROM designs WHERE id = ?`),
  byView: db.prepare(`SELECT id, name FROM designs WHERE view = ?`),
  viewOf: db.prepare(`SELECT view FROM designs WHERE id = ?`),
  addDesign: db.prepare(`INSERT INTO designs (id, name, created, updated, view, owner) VALUES (?, ?, ?, ?, ?, ?)`),
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
  addUser: db.prepare(`INSERT INTO users (id, email, name, hash, created) VALUES (?, ?, ?, ?, ?)`),
  userByEmail: db.prepare(`SELECT id, email, name, hash FROM users WHERE email = ?`),
  user: db.prepare(`SELECT id, email, name FROM users WHERE id = ?`),
  renameUser: db.prepare(`UPDATE users SET name = ? WHERE id = ?`),
  addSession: db.prepare(`INSERT INTO sessions (hash, user, expires) VALUES (?, ?, ?)`),
  session: db.prepare(`SELECT user FROM sessions WHERE hash = ? AND expires > ?`),
  dropSession: db.prepare(`DELETE FROM sessions WHERE hash = ?`),
  // an edit link once recorded is kept, even if the design is later opened by its view link
  open: db.prepare(
    `INSERT INTO opened (user, design, access, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user, design) DO UPDATE SET at = excluded.at,
       access = CASE WHEN opened.access = 'edit' THEN 'edit' ELSE excluded.access END`,
  ),
  forget: db.prepare(`DELETE FROM opened WHERE user = ? AND design = (SELECT id FROM designs WHERE view = ?)`),
  projects: db.prepare(
    `SELECT d.id, d.view, d.name, d.updated, o.access, o.at AS opened, d.owner = o.user AS mine,
       (SELECT COUNT(*) FROM features WHERE design = d.id) AS features
     FROM opened o JOIN designs d ON d.id = o.design WHERE o.user = ? ORDER BY o.at DESC LIMIT 500`,
  ),
};

export function listDesigns(): DesignRow[] {
  // the example first, so it is never pushed off the end of the list
  return q.designs.all(EXAMPLE_ID) as DesignRow[];
}

export function getDesign(id: string): Design | undefined {
  return q.design.get(id) as Design | undefined;
}

// a new design, with its view-only link's id; an account that makes one
// owns it and has it in its projects from the start
export function addDesign(design: Design, owner: string | null = null): string {
  const now = Date.now();
  const view = viewId();
  q.addDesign.run(design.id, design.name, now, now, view, owner);
  if (owner) q.open.run(owner, design.id, "edit", now);
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

export type User = { id: string; email: string; name: string };

export function addUser(id: string, email: string, name: string, hash: string): void {
  q.addUser.run(id, email, name, hash, Date.now());
}

export function userByEmail(email: string): (User & { hash: string }) | undefined {
  return q.userByEmail.get(email) as (User & { hash: string }) | undefined;
}

export function getUser(id: string): User | undefined {
  return q.user.get(id) as User | undefined;
}

export function renameUser(id: string, name: string): void {
  q.renameUser.run(name, id);
}

export function addSession(hash: string, user: string, expires: number): void {
  q.addSession.run(hash, user, expires);
}

export function sessionUser(hash: string): string | undefined {
  return (q.session.get(hash, Date.now()) as { user: string } | undefined)?.user;
}

export function dropSession(hash: string): void {
  q.dropSession.run(hash);
}

export function markOpened(user: string, design: string, access: "edit" | "view"): void {
  q.open.run(user, design, access, Date.now());
}

export function forgetProject(user: string, view: string): void {
  q.forget.run(user, view);
}

export type ProjectRow = { id: string; view: string; name: string; updated: number; access: "edit" | "view"; opened: number; mine: number; features: number };

export function projectsOf(user: string): ProjectRow[] {
  return q.projects.all(user) as ProjectRow[];
}

export function close(): void {
  db.close();
}

// One room per open sheet: the people in it, what they hold, and the shapes as
// the server knows them. The server is the only authority on a sheet. Every
// edit is checked against holds and versions here, written to disk, and only
// then sent to everyone.

import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ID_PATTERN,
  KIND_NAMES,
  LIMIT,
  validateGeometry,
  type Shape,
} from "../shared/geometry.ts";
import {
  LIMITS,
  PEOPLE_COLOURS,
  cleanName,
  type ClientMessage,
  type Draft,
  type Person,
  type Reason,
  type ServerMessage,
  type Sheet,
} from "../shared/protocol.ts";
import * as db from "./db.ts";

type Conn = {
  key: number;
  ws: WebSocket;
  person: Person | null;
  lastSeen: number;
  // rate limiting: messages counted in the current one-second window
  window: number;
  count: number;
};

let nextKey = 1;
const rooms = new Map<string, Room>();

export function personFor(token: string, name: string): Person {
  const id = createHash("sha256").update(token).digest("hex").slice(0, 12);
  const colour = PEOPLE_COLOURS[parseInt(id.slice(0, 8), 16) % PEOPLE_COLOURS.length];
  const known = db.getPerson(id);
  const chosen = cleanName(name) || known?.name || `Guest ${id.slice(0, 4).toUpperCase()}`;
  if (!known || known.name !== chosen) db.putPerson(id, chosen);
  return { id, name: chosen, colour };
}

function personById(id: string): Person {
  const known = db.getPerson(id);
  const colour = PEOPLE_COLOURS[parseInt(id.slice(0, 8), 16) % PEOPLE_COLOURS.length] ?? PEOPLE_COLOURS[0];
  return { id, name: known?.name ?? "Someone", colour };
}

export function roomFor(sheet: Sheet): Room {
  let room = rooms.get(sheet.id);
  if (!room) {
    room = new Room(sheet);
    rooms.set(sheet.id, room);
  }
  return room;
}

export function onlineCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, room] of rooms) out.set(id, room.people().length);
  return out;
}

export class Room {
  sheet: Sheet;
  shapes = new Map<string, Shape>();
  conns = new Set<Conn>();
  // shape id -> the connection holding it
  holds = new Map<string, Conn>();
  cursors = new Map<string, { x: number; y: number; draft?: Draft }>();
  gone = new Set<string>();
  flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sheet: Sheet) {
    this.sheet = sheet;
    for (const s of db.loadShapes(sheet.id)) this.shapes.set(s.id, s);
  }

  join(ws: WebSocket): void {
    const conn: Conn = { key: nextKey++, ws, person: null, lastSeen: Date.now(), window: 0, count: 0 };
    this.conns.add(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.close(conn, 1003, "text only");
      const second = Math.floor(Date.now() / 1000);
      if (second !== conn.window) {
        conn.window = second;
        conn.count = 0;
      }
      if (++conn.count > LIMITS.messagesPerSecond) return this.close(conn, 1008, "too many messages");
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return this.send(conn, { t: "error", message: "messages are JSON" });
      }
      if (typeof msg !== "object" || msg === null) return;
      conn.lastSeen = Date.now();
      try {
        this.handle(conn, msg);
      } catch (err) {
        console.error("message failed", err);
        this.send(conn, { t: "error", message: "the server could not apply that" });
      }
    });
    ws.on("close", () => this.leave(conn));
    ws.on("error", () => this.leave(conn));
  }

  handle(conn: Conn, msg: ClientMessage): void {
    if (msg.t === "hello") {
      if (conn.person) return;
      if (typeof msg.token !== "string" || msg.token.length < 16 || msg.token.length > 128) {
        return this.close(conn, 1008, "a hello needs a token");
      }
      conn.person = personFor(msg.token, msg.name);
      const authorIds = new Set([...this.shapes.values()].map((s) => s.by));
      this.send(conn, {
        t: "welcome",
        you: conn.person,
        sheet: this.sheet,
        shapes: [...this.shapes.values()],
        people: this.people(),
        authors: [...authorIds].map(personById),
        holds: this.holdMap(),
      });
      this.broadcastPeople();
      return;
    }
    const me = conn.person;
    if (!me) return this.close(conn, 1008, "say hello first");

    switch (msg.t) {
      case "add": {
        if (typeof msg.id !== "string" || !ID_PATTERN.test(msg.id)) {
          return this.reject(conn, String(msg.id), "invalid", "that shape id is not valid");
        }
        if (this.shapes.has(msg.id)) {
          return this.reject(conn, msg.id, "exists", "a shape with that id already exists");
        }
        if (this.shapes.size >= LIMITS.shapesPerSheet) {
          return this.reject(conn, msg.id, "full", `a sheet holds at most ${LIMITS.shapesPerSheet} shapes`);
        }
        const g = validateGeometry(msg.g);
        if (typeof g === "string") return this.reject(conn, msg.id, "invalid", g);
        this.commit({ ...g, id: msg.id, v: 1, by: me.id });
        return;
      }
      case "update":
      case "delete": {
        const current = typeof msg.id === "string" ? this.shapes.get(msg.id) : undefined;
        if (!current) return this.reject(conn, String(msg.id), "missing", "that shape has been deleted");
        const holder = this.holds.get(current.id);
        if (holder && holder.person && holder.person.id !== me.id) {
          return this.reject(
            conn,
            current.id,
            "held",
            `${holder.person.name} is holding that ${KIND_NAMES[current.kind].toLowerCase()}`,
            holder.person.id,
          );
        }
        if (msg.base !== current.v) {
          const by = personById(current.by);
          return this.reject(
            conn,
            current.id,
            "stale",
            `${by.name} changed that ${KIND_NAMES[current.kind].toLowerCase()} before your edit arrived`,
            by.id,
          );
        }
        if (msg.t === "delete") {
          db.deleteShape(this.sheet.id, current.id);
          this.shapes.delete(current.id);
          if (this.holds.delete(current.id)) this.broadcastHolds();
          this.broadcast({ t: "del", id: current.id, by: me.id });
          return;
        }
        const g = validateGeometry(msg.g);
        if (typeof g === "string") return this.reject(conn, current.id, "invalid", g);
        if (g.kind !== current.kind) {
          return this.reject(conn, current.id, "invalid", "a shape cannot change kind");
        }
        this.commit({ ...g, id: current.id, v: current.v + 1, by: me.id });
        return;
      }
      case "hold": {
        if (!Array.isArray(msg.ids)) return;
        const wanted = new Set(msg.ids.filter((id): id is string => typeof id === "string").slice(0, 1000));
        let changed = false;
        for (const [id, holder] of this.holds) {
          if (holder === conn && !wanted.has(id)) {
            this.holds.delete(id);
            changed = true;
          }
        }
        for (const id of wanted) {
          if (!this.shapes.has(id)) continue;
          const holder = this.holds.get(id);
          // Another tab of the same person may take it over; another person may not.
          if (holder && holder !== conn && holder.person?.id !== me.id) continue;
          if (holder !== conn) {
            this.holds.set(id, conn);
            changed = true;
          }
        }
        // Always answer, so a client whose request was partly refused learns
        // which shapes it did not get.
        if (changed) this.broadcastHolds();
        else this.send(conn, { t: "holds", holds: this.holdMap() });
        return;
      }
      case "cursor": {
        const { x, y } = msg;
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (Math.abs(x) > LIMIT * 2 || Math.abs(y) > LIMIT * 2) return;
        let draft: Draft | undefined;
        if (Array.isArray(msg.draft)) {
          draft = [];
          for (const raw of msg.draft.slice(0, LIMITS.draftShapes)) {
            const g = validateGeometry(raw);
            if (typeof g !== "string") draft.push(g);
          }
        }
        this.cursors.set(me.id, { x, y, draft });
        this.gone.delete(me.id);
        this.scheduleFlush();
        return;
      }
      case "leave": {
        this.cursors.delete(me.id);
        this.gone.add(me.id);
        this.scheduleFlush();
        return;
      }
      case "name": {
        const name = cleanName(msg.name);
        if (!name) return;
        db.putPerson(me.id, name);
        // Every open connection of this person, in any room, takes the new name.
        for (const room of rooms.values()) {
          let touched = false;
          for (const c of room.conns) {
            if (c.person?.id === me.id) {
              c.person = { ...c.person, name };
              touched = true;
            }
          }
          if (touched) room.broadcastPeople();
        }
        return;
      }
      case "rename": {
        const name = cleanName(msg.name);
        if (!name) return;
        db.renameSheet(this.sheet.id, name);
        this.sheetRenamed({ ...this.sheet, name });
        return;
      }
    }
  }

  // Disk first, then everyone. Never the other way round.
  commit(shape: Shape): void {
    db.putShape(this.sheet.id, shape);
    this.shapes.set(shape.id, shape);
    this.broadcast({ t: "put", shape });
  }

  sheetRenamed(sheet: Sheet): void {
    this.sheet = sheet;
    this.broadcast({ t: "sheet", sheet });
  }

  reject(conn: Conn, id: string, reason: Reason, message: string, who?: string): void {
    this.send(conn, { t: "reject", id, reason, message, shape: this.shapes.get(id) ?? null, who });
  }

  holdMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, conn] of this.holds) if (conn.person) out[id] = conn.person.id;
    return out;
  }

  people(): Person[] {
    const seen = new Map<string, Person>();
    for (const c of this.conns) if (c.person) seen.set(c.person.id, c.person);
    return [...seen.values()];
  }

  broadcastPeople(): void {
    this.broadcast({ t: "people", people: this.people() });
  }

  broadcastHolds(): void {
    this.broadcast({ t: "holds", holds: this.holdMap() });
  }

  // Cursors and drafts are batched: at most one message per client per flush
  // interval however many people are moving, because a full room is the case
  // this is designed for.
  scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const cursors = [...this.cursors].map(([id, c]) => ({ id, ...c }));
      const gone = [...this.gone];
      this.cursors.clear();
      this.gone.clear();
      if (cursors.length || gone.length) this.broadcast({ t: "cursors", cursors, gone });
    }, LIMITS.cursorFlushMs);
  }

  // Holds that have gone quiet are let go, so a person who walks away from the
  // table does not lock what they last touched.
  sweep(now: number): void {
    let changed = false;
    for (const [id, conn] of this.holds) {
      if (now - conn.lastSeen > LIMITS.holdIdleMs) {
        this.holds.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcastHolds();
  }

  leave(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    let changed = false;
    for (const [id, holder] of this.holds) {
      if (holder === conn) {
        this.holds.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcastHolds();
    if (conn.person && !this.people().some((p) => p.id === conn.person?.id)) {
      this.cursors.delete(conn.person.id);
      this.gone.add(conn.person.id);
      this.scheduleFlush();
    }
    this.broadcastPeople();
    if (this.conns.size === 0) rooms.delete(this.sheet.id);
  }

  close(conn: Conn, code: number, reason: string): void {
    conn.ws.close(code, reason);
    this.leave(conn);
  }

  send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) if (c.person && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) room.sweep(now);
}, 10_000).unref();

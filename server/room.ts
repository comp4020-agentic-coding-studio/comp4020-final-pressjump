// One room per open design: the people in it, what they hold, and the
// timeline as the server knows it. The server is the only authority on a
// design. Every edit is checked against holds, versions and the features it
// refers to here, written to disk, and only then sent to everyone.

import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ID_PATTERN,
  LIMIT,
  checkReferences,
  usedBy,
  validateFeature,
  type Stored,
  type Vec3,
} from "../shared/model.ts";
import {
  LIMITS,
  PEOPLE_COLOURS,
  cleanName,
  type Camera,
  type ClientMessage,
  type Cursor,
  type Design,
  type Draft,
  type Person,
  type Reason,
  type ServerMessage,
} from "../shared/protocol.ts";
import * as db from "./db.ts";

type Conn = {
  ws: WebSocket;
  person: Person | null;
  lastSeen: number;
  // rate limiting: messages counted in the current one-second window
  window: number;
  count: number;
};

const rooms = new Map<string, Room>();

const colourFor = (id: string): string => PEOPLE_COLOURS[parseInt(id.slice(0, 8), 16) % PEOPLE_COLOURS.length];

export function personFor(token: string, name: string): Person {
  const id = createHash("sha256").update(token).digest("hex").slice(0, 12);
  const known = db.getPerson(id);
  const chosen = cleanName(name) || known?.name || `Guest ${id.slice(0, 4).toUpperCase()}`;
  if (!known || known.name !== chosen) db.putPerson(id, chosen);
  return { id, name: chosen, colour: colourFor(id) };
}

function personById(id: string): Person {
  return { id, name: db.getPerson(id)?.name ?? "Someone", colour: colourFor(id) };
}

export function roomFor(design: Design): Room {
  let room = rooms.get(design.id);
  if (!room) {
    room = new Room(design);
    rooms.set(design.id, room);
  }
  return room;
}

export function onlineCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, room] of rooms) out.set(id, room.people().length);
  return out;
}

const finite = (n: unknown, bound: number): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= bound;
const vec3 = (v: unknown, bound: number): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => finite(n, bound));

export class Room {
  design: Design;
  features = new Map<string, Stored>();
  nextSeq = 1;
  conns = new Set<Conn>();
  // feature id -> the connection holding it
  holds = new Map<string, Conn>();
  cursors = new Map<string, Cursor>();
  gone = new Set<string>();
  flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(design: Design) {
    this.design = design;
    for (const f of db.loadFeatures(design.id)) {
      this.features.set(f.id, f);
      this.nextSeq = Math.max(this.nextSeq, f.seq + 1);
    }
  }

  join(ws: WebSocket): void {
    const conn: Conn = { ws, person: null, lastSeen: Date.now(), window: 0, count: 0 };
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
      const authorIds = new Set([...this.features.values()].map((f) => f.by));
      this.send(conn, {
        t: "welcome",
        you: conn.person,
        design: this.design,
        features: [...this.features.values()],
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
          return this.reject(conn, String(msg.id), "invalid", "that feature id is not valid");
        }
        if (this.features.has(msg.id)) {
          return this.reject(conn, msg.id, "exists", "a feature with that id already exists");
        }
        if (this.features.size >= LIMITS.featuresPerDesign) {
          return this.reject(conn, msg.id, "full", `a design holds at most ${LIMITS.featuresPerDesign} features`);
        }
        const f = validateFeature(msg.f);
        if (typeof f === "string") return this.reject(conn, msg.id, "invalid", f);
        const problem = checkReferences(this.features, f);
        if (problem) return this.reject(conn, msg.id, "invalid", problem);
        // the bodies a combine uses must not be in someone else's hands
        if (f.kind === "combine") {
          for (const ref of [f.target, ...f.tools]) {
            const holder = this.holds.get(ref);
            if (holder?.person && holder.person.id !== me.id) {
              return this.reject(conn, msg.id, "held", `${holder.person.name} is holding ${this.features.get(ref)?.name}`, holder.person.id);
            }
          }
        }
        this.commit({ ...f, id: msg.id, v: 1, by: me.id, seq: this.nextSeq++ });
        return;
      }
      case "update":
      case "delete": {
        const current = typeof msg.id === "string" ? this.features.get(msg.id) : undefined;
        if (!current) return this.reject(conn, String(msg.id), "missing", "that feature has been deleted");
        const holder = this.holds.get(current.id);
        if (holder?.person && holder.person.id !== me.id) {
          return this.reject(conn, current.id, "held", `${holder.person.name} is holding ${current.name}`, holder.person.id);
        }
        if (msg.base !== current.v) {
          const by = personById(current.by);
          return this.reject(conn, current.id, "stale", `${by.name} changed ${current.name} before your edit arrived`, by.id);
        }
        if (msg.t === "delete") {
          const user = usedBy(this.features, current.id);
          if (user) {
            return this.reject(conn, current.id, "used", `${user.name} uses ${current.name}; delete or edit ${user.name} first`);
          }
          db.deleteFeature(this.design.id, current.id);
          this.features.delete(current.id);
          if (this.holds.delete(current.id)) this.broadcastHolds();
          this.broadcast({ t: "del", id: current.id, by: me.id });
          return;
        }
        const f = validateFeature(msg.f);
        if (typeof f === "string") return this.reject(conn, current.id, "invalid", f);
        if (f.kind !== current.kind) return this.reject(conn, current.id, "invalid", "a feature cannot change kind");
        const problem = checkReferences(this.features, f, current);
        if (problem) return this.reject(conn, current.id, "invalid", problem);
        this.commit({ ...f, id: current.id, v: current.v + 1, by: me.id, seq: current.seq });
        return;
      }
      case "hold": {
        if (!Array.isArray(msg.ids)) return;
        const wanted = new Set(msg.ids.filter((id): id is string => typeof id === "string").slice(0, 400));
        let changed = false;
        for (const [id, holder] of this.holds) {
          if (holder === conn && !wanted.has(id)) {
            this.holds.delete(id);
            changed = true;
          }
        }
        for (const id of wanted) {
          if (!this.features.has(id)) continue;
          const holder = this.holds.get(id);
          // Another tab of the same person may take it over; another person may not.
          if (holder && holder !== conn && holder.person?.id !== me.id) continue;
          if (holder !== conn) {
            this.holds.set(id, conn);
            changed = true;
          }
        }
        // Always answer, so a client whose request was partly refused learns
        // which features it did not get.
        if (changed) this.broadcastHolds();
        else this.send(conn, { t: "holds", holds: this.holdMap() });
        return;
      }
      case "cursor": {
        const at = msg.at === null ? null : vec3(msg.at, LIMIT * 4) ? msg.at : undefined;
        if (at === undefined) return;
        let cam: Camera | undefined;
        if (msg.cam && vec3(msg.cam.p, LIMIT * 20) && vec3(msg.cam.t, LIMIT * 20)) cam = { p: msg.cam.p, t: msg.cam.t };
        let draft: Draft | undefined;
        if (Array.isArray(msg.draft)) {
          draft = [];
          for (const raw of msg.draft.slice(0, LIMITS.draftFeatures)) {
            const f = validateFeature(raw);
            if (typeof f !== "string" && f.kind !== "combine") draft.push(f);
          }
        }
        this.cursors.set(me.id, { id: me.id, at, cam, draft });
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
        db.renameDesign(this.design.id, name);
        this.design = { ...this.design, name };
        this.broadcast({ t: "design", design: this.design });
        return;
      }
    }
  }

  // Disk first, then everyone. Never the other way round.
  commit(f: Stored): void {
    db.putFeature(this.design.id, f);
    this.features.set(f.id, f);
    this.broadcast({ t: "put", feature: f });
  }

  reject(conn: Conn, id: string, reason: Reason, message: string, who?: string): void {
    this.send(conn, { t: "reject", id, reason, message, feature: this.features.get(id) ?? null, who });
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

  // Cursors, cameras and drafts are batched: at most one message per client
  // per flush interval however many people are moving, because a full room is
  // the case this is designed for.
  scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const cursors = [...this.cursors.values()];
      const gone = [...this.gone];
      this.cursors.clear();
      this.gone.clear();
      if (cursors.length || gone.length) this.broadcast({ t: "cursors", cursors, gone });
    }, LIMITS.cursorFlushMs);
  }

  // Holds that have gone quiet are let go, so a person who walks away does not
  // lock what they last touched.
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
    if (this.conns.size === 0) rooms.delete(this.design.id);
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

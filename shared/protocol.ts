// What travels over the WebSocket at /ws?design=<id>. JSON, one object per
// message, `t` says which. The first message a client sends must be `hello`.

import { APPEARANCES, type Feature, type Stored, type Vec3 } from "./model.ts";

export type Person = { id: string; name: string; colour: string };
export type Design = { id: string; name: string };

// Where someone is looking from and at, so others can follow their view.
export type Camera = { p: Vec3; t: Vec3 };

// Bodies someone is dragging and has not let go of yet. Never stored.
export type Draft = Feature[];

export type ClientMessage =
  | { t: "hello"; token: string; name: string }
  | { t: "add"; id: string; f: Feature }
  | { t: "update"; id: string; base: number; f: Feature }
  | { t: "delete"; id: string; base: number }
  | { t: "hold"; ids: string[] }
  // only what changed since the last one: a pointer moved (null when it has
  // left the view), a camera moved, a drag changed (null when it ended)
  | { t: "cursor"; at?: Vec3 | null; cam?: Camera; draft?: Draft | null }
  | { t: "leave" }
  | { t: "name"; name: string }
  | { t: "rename"; name: string };

export type Reason = "held" | "stale" | "missing" | "exists" | "invalid" | "used" | "full" | "readonly";

// What a link lets you do: change the design, or only watch it (point,
// follow, export). Each person is told theirs, and the links they may pass on:
// an editor both, a viewer only the view link.
export type Access = "edit" | "view";
export type Links = { edit?: string; view: string };

// One person's cursor news, again only what changed: a field that is absent
// is as it was.
export type Cursor = { id: string; at?: Vec3 | null; cam?: Camera; draft?: Draft | null };

export type ServerMessage =
  | {
      t: "welcome";
      you: Person;
      design: Design;
      features: Stored[];
      people: Person[];
      authors: Person[];
      holds: Record<string, string>;
      access: Access;
      links: Links;
    }
  | { t: "put"; feature: Stored }
  // to the person whose edit it was, instead of the whole feature back: it is
  // stored, at this version and place in the timeline
  | { t: "ok"; id: string; v: number; seq: number }
  | { t: "del"; id: string; by: string }
  | { t: "people"; people: Person[] }
  | { t: "holds"; holds: Record<string, string> }
  | { t: "cursors"; cursors: Cursor[]; gone: string[] }
  | { t: "design"; design: Design }
  // Sent only to the person whose edit was refused. `feature` is what the
  // server holds now (null if it no longer exists), so the client can put it
  // back, and `who` is the person responsible, where there is one.
  | { t: "reject"; id: string; reason: Reason; message: string; feature: Stored | null; who?: string }
  | { t: "error"; message: string };

// The people palette. Colours are how people tell each other apart in the
// viewport, so they stay distinct from each other and from the appearances.
export const PEOPLE_COLOURS = [
  "#e5484d",
  "#0091a8",
  "#f5a524",
  "#8e4ec6",
  "#30a46c",
  "#f76b15",
  "#3e63dd",
  "#d6409f",
  "#7c8a00",
  "#6e56cf",
];

export const LIMITS = {
  messageBytes: 32 * 1024,
  featuresPerDesign: 400,
  messagesPerSecond: 120,
  draftFeatures: 20,
  nameLength: 32,
  holdIdleMs: 120_000,
  cursorFlushMs: 50,
} as const;

export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameLength);
}

// ---------- features on the wire ----------
// Most numbers on most features are their defaults: no rotation, no fillet
// or chamfer, the first appearance. On the wire they are left out, and put
// back on arrival, before anything checks or shows the feature; the server's
// checks are unchanged because they always see the whole feature.

const DEFAULTS: Record<string, unknown> = { rot: [0, 0, 0], fillet: 0, chamfer: 0, colour: APPEARANCES[0][1] };
const BODY_KEYS = new Set(["box", "cylinder", "sphere", "cone", "torus", "extrude"]);
const KIND_HAS: Record<string, string[]> = { box: ["fillet", "chamfer"], cylinder: ["chamfer"] };

export function pack<T extends Feature | Stored>(f: T): T {
  if (!BODY_KEYS.has(f.kind)) return f;
  const out: Record<string, unknown> = { ...f };
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (k in out && JSON.stringify(out[k]) === JSON.stringify(d)) delete out[k];
  }
  return out as T;
}

export function unpack<T extends Feature | Stored>(raw: T): T {
  if (typeof raw !== "object" || raw === null || !BODY_KEYS.has((raw as Feature).kind)) return raw;
  const out: Record<string, unknown> = { ...raw };
  const kind = (raw as Feature).kind;
  if (!("rot" in out)) out.rot = [0, 0, 0];
  if (!("colour" in out)) out.colour = DEFAULTS.colour;
  for (const k of KIND_HAS[kind] ?? []) if (!(k in out)) out[k] = 0;
  return out as T;
}

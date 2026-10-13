// What travels over the WebSocket at /ws?design=<id>. JSON, one object per
// message, `t` says which. The first message a client sends must be `hello`.

import type { Feature, Stored, Vec3 } from "./model.ts";

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
  | { t: "cursor"; at: Vec3 | null; cam?: Camera; draft?: Draft }
  | { t: "leave" }
  | { t: "name"; name: string }
  | { t: "rename"; name: string };

export type Reason = "held" | "stale" | "missing" | "exists" | "invalid" | "used" | "full";

export type Cursor = { id: string; at: Vec3 | null; cam?: Camera; draft?: Draft };

export type ServerMessage =
  | {
      t: "welcome";
      you: Person;
      design: Design;
      features: Stored[];
      people: Person[];
      authors: Person[];
      holds: Record<string, string>;
    }
  | { t: "put"; feature: Stored }
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

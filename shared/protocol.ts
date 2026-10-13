// What travels over the WebSocket at /ws?sheet=<id>. JSON, one object per
// message, `t` says which. The first message a client sends must be `hello`.

import type { Geometry, Shape } from "./geometry.ts";

export type Person = { id: string; name: string; colour: string };
export type Sheet = { id: string; name: string; w: number; h: number };

// What someone is drawing or dragging and has not let go of yet. Never stored.
export type Draft = Geometry[];

export type ClientMessage =
  | { t: "hello"; token: string; name: string }
  | { t: "add"; id: string; g: Geometry }
  | { t: "update"; id: string; base: number; g: Geometry }
  | { t: "delete"; id: string; base: number }
  | { t: "hold"; ids: string[] }
  | { t: "cursor"; x: number; y: number; draft?: Draft }
  | { t: "leave" }
  | { t: "name"; name: string }
  | { t: "rename"; name: string };

export type Reason = "held" | "stale" | "missing" | "exists" | "invalid" | "full" | "busy";

export type ServerMessage =
  | {
      t: "welcome";
      you: Person;
      sheet: Sheet;
      shapes: Shape[];
      people: Person[];
      authors: Person[];
      holds: Record<string, string>;
    }
  | { t: "put"; shape: Shape }
  | { t: "del"; id: string; by: string }
  | { t: "people"; people: Person[] }
  | { t: "holds"; holds: Record<string, string> }
  | { t: "cursors"; cursors: { id: string; x: number; y: number; draft?: Draft }[]; gone: string[] }
  | { t: "sheet"; sheet: Sheet }
  // Sent only to the person whose edit was refused. `shape` is what the server
  // holds now (null if it no longer exists), so the client can put it back, and
  // `who` is the person responsible, where there is one.
  | { t: "reject"; id: string; reason: Reason; message: string; shape: Shape | null; who?: string }
  | { t: "error"; message: string };

// The people palette. Colours are how people tell each other apart on the
// sheet, so they are picked to stay distinct from each other and from the ink.
export const PEOPLE_COLOURS = [
  "#d1495b",
  "#00798c",
  "#edae49",
  "#7b2cbf",
  "#2a9d8f",
  "#e76f51",
  "#3a86ff",
  "#8ac926",
  "#ff4fa3",
  "#6d597a",
];

export const LIMITS = {
  messageBytes: 16 * 1024,
  shapesPerSheet: 5000,
  messagesPerSecond: 120,
  draftShapes: 50,
  nameLength: 32,
  holdIdleMs: 120_000,
  cursorFlushMs: 50,
} as const;

export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameLength);
}

// A person in a browser, as far as the server can tell: a WebSocket on a
// sheet, a token, and the messages that arrive. The spec uses these to act out
// two or three people at once against the running app.

import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import type { Geometry, Shape } from "../shared/geometry.ts";
import type { ClientMessage, Person, ServerMessage, Sheet } from "../shared/protocol.ts";

export const baseUrl = inject("baseUrl");

type Welcome = Extract<ServerMessage, { t: "welcome" }>;
type Of<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

export type Visitor = {
  you: Person;
  welcome: Welcome;
  send: (msg: ClientMessage) => void;
  // the next message of type `t` matching `match`, waiting at most `ms`
  next: <T extends ServerMessage["t"]>(t: T, match?: (m: Of<T>) => boolean, ms?: number) => Promise<Of<T>>;
  closed: Promise<{ code: number }>;
  close: () => Promise<void>;
};

export function token(): string {
  return randomBytes(16).toString("hex");
}

export function id(): string {
  return randomBytes(9).toString("base64url").replace(/[-_]/g, "x");
}

export async function newSheet(name = "spec", w = 300, h = 200): Promise<Sheet> {
  const res = await fetch(new URL("/api/sheets", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, w, h }),
  });
  if (res.status !== 201) throw new Error(`could not make a sheet: ${res.status}`);
  return (await res.json()) as Sheet;
}

// What the server reads back from disk for a sheet.
export async function stored(sheet: string): Promise<Shape[]> {
  const res = await fetch(new URL(`/api/sheets/${sheet}`, baseUrl));
  return ((await res.json()) as { shapes: Shape[] }).shapes;
}

export async function visit(sheet: string, as = token(), name = "Spec"): Promise<Visitor> {
  const url = new URL(`/ws?sheet=${sheet}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiting = new Set<() => void>();
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(String(e.data)) as ServerMessage);
    for (const wake of [...waiting]) wake();
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket did not open")));
  });
  const send = (msg: ClientMessage): void => ws.send(JSON.stringify(msg));

  const next = <T extends ServerMessage["t"]>(t: T, match?: (m: Of<T>) => boolean, ms = 1000): Promise<Of<T>> =>
    new Promise((resolve, reject) => {
      const look = (): boolean => {
        const i = inbox.findIndex((m) => m.t === t && (!match || match(m as Of<T>)));
        if (i === -1) return false;
        const [m] = inbox.splice(i, 1);
        clearTimeout(timer);
        waiting.delete(wake);
        resolve(m as Of<T>);
        return true;
      };
      const wake = (): void => void look();
      const timer = setTimeout(() => {
        waiting.delete(wake);
        reject(new Error(`no "${t}" message within ${ms} ms`));
      }, ms);
      if (!look()) waiting.add(wake);
    });

  send({ t: "hello", token: as, name });
  const welcome = await next("welcome");
  return {
    you: welcome.you,
    welcome,
    send,
    next,
    closed,
    close: async () => {
      ws.close();
      await closed;
    },
  };
}

// Adds a shape and waits for the server to confirm it.
export async function add(v: Visitor, g: Geometry): Promise<Shape> {
  const shapeId = id();
  v.send({ t: "add", id: shapeId, g });
  const put = await v.next("put", (m) => m.shape.id === shapeId);
  return put.shape;
}

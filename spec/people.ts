// A person in a browser, as far as the server can tell: a WebSocket on a
// design, a token, and the messages that arrive. The spec uses these to act
// out two or three people at once against the running app.

import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import type { Body, Feature, Stored } from "../shared/model.ts";
import type { ClientMessage, Design, Person, ServerMessage } from "../shared/protocol.ts";

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

export const box = (over: Partial<Body> = {}): Body =>
  ({ kind: "box", name: "Box", pos: [0, 0, 0], rot: [0, 0, 0], colour: "#b9bec4", w: 10, h: 20, d: 30, fillet: 0, ...over }) as Body;

export const cylinder = (over: Partial<Body> = {}): Body =>
  ({ kind: "cylinder", name: "Cylinder", pos: [0, 0, 0], rot: [0, 0, 0], colour: "#8a9097", r: 5, h: 10, ...over }) as Body;

export async function newDesign(name = "spec"): Promise<Design> {
  const res = await fetch(new URL("/api/designs", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`could not make a design: ${res.status}`);
  return (await res.json()) as Design;
}

// What the server reads back from disk for a design.
export async function stored(design: string): Promise<Stored[]> {
  const res = await fetch(new URL(`/api/designs/${design}`, baseUrl));
  return ((await res.json()) as { features: Stored[] }).features;
}

export async function visit(design: string, as = token(), name = "Spec"): Promise<Visitor> {
  const url = new URL(`/ws?design=${design}`, baseUrl);
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

// Adds a feature and waits for the server to confirm it.
export async function add(v: Visitor, f: Feature): Promise<Stored> {
  const featureId = id();
  v.send({ t: "add", id: featureId, f });
  const put = await v.next("put", (m) => m.feature.id === featureId);
  return put.feature;
}

// A binary STL, read back: its triangles' volume and how far it reaches.
export function readStl(buf: ArrayBuffer): { triangles: number; volume: number; min: number[]; max: number[] } {
  const view = new DataView(buf);
  const triangles = view.getUint32(80, true);
  let volume = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triangles; t++) {
    const o = 84 + t * 50 + 12;
    const v = Array.from({ length: 9 }, (_, i) => view.getFloat32(o + i * 4, true));
    for (let p = 0; p < 9; p += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[p + k]);
        max[k] = Math.max(max[k], v[p + k]);
      }
    }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = v;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { triangles, volume, min, max };
}

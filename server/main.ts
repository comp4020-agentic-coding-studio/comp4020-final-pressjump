// The whole server: static pages, a small JSON API, the exports, /readme/ and
// the WebSocket each open sheet talks through. One process, one SQLite file.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { WebSocketServer } from "ws";
import { LIMITS, cleanName, type Sheet } from "../shared/protocol.ts";
import * as db from "./db.ts";
import { toDxf, toSvg } from "./export.ts";
import { onlineCounts, roomFor } from "./room.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = process.cwd();
const PUBLIC = join(ROOT, "public");
const DOCS = join(ROOT, "docs");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// Everything the pages load comes from this server; the CSP says so, so a
// stray CDN link fails loudly in development instead of quietly in production.
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

// The sheet a fresh install opens with, so a room full of people has one
// obvious place to start.
if (db.listSheets().length === 0) {
  db.addSheet({ id: newId(), name: "The big sheet", w: 600, h: 400 });
}

function newId(): string {
  return randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, 10);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra = {}): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", ...HEADERS, ...extra });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function file(res: ServerResponse, base: string, rel: string): boolean {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base + sep)) return false;
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  send(res, 200, TYPES[extname(path)] ?? "application/octet-stream", readFileSync(path));
  return true;
}

function notFound(res: ServerResponse): void {
  const page = readFileSync(join(PUBLIC, "404.html"), "utf8");
  send(res, 404, TYPES[".html"], page);
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.messageBytes) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sheet";
}

// README.md, rendered on the server so every heading is in the HTML before any
// script runs. Read on every request: it is small, and a stale copy is worse.
function readmePage(): string {
  const md = readFileSync(join(ROOT, "README.md"), "utf8");
  const html = marked.parse(md, { async: false });
  const shell = readFileSync(join(PUBLIC, "readme.html"), "utf8");
  return shell.replace("<!--README-->", html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/") return file(res, PUBLIC, "index.html") || notFound(res);
    if (req.method === "GET" && path === "/readme") return send(res, 301, "text/plain", "", { Location: "/readme/" });
    if (req.method === "GET" && path === "/readme/") return send(res, 200, TYPES[".html"], readmePage());
    if (req.method === "GET" && path.startsWith("/readme/docs/")) {
      return file(res, DOCS, decodeURIComponent(path.slice("/readme/docs/".length))) || notFound(res);
    }

    if (path === "/api/sheets" && req.method === "GET") {
      const online = onlineCounts();
      return json(
        res,
        200,
        db.listSheets().map((s) => ({ ...s, online: online.get(s.id) ?? 0 })),
      );
    }
    if (path === "/api/sheets" && req.method === "POST") {
      let input: { name?: unknown; w?: unknown; h?: unknown };
      try {
        input = (await body(req)) as typeof input;
      } catch {
        return json(res, 400, { error: "send a JSON object" });
      }
      const name = cleanName(input.name);
      const w = Number(input.w);
      const h = Number(input.h);
      if (!name) return json(res, 400, { error: "a sheet needs a name" });
      if (!(w >= 10 && w <= 2000 && h >= 10 && h <= 2000)) {
        return json(res, 400, { error: "width and height are between 10 and 2000 mm" });
      }
      const sheet: Sheet = { id: newId(), name, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
      db.addSheet(sheet);
      return json(res, 201, sheet);
    }

    const api = path.match(/^\/api\/sheets\/([A-Za-z0-9]{1,20})$/);
    if (api && req.method === "GET") {
      const sheet = db.getSheet(api[1]);
      if (!sheet) return json(res, 404, { error: "no such sheet" });
      return json(res, 200, { sheet, shapes: db.loadShapes(sheet.id) });
    }
    const page = path.match(/^\/s\/([A-Za-z0-9]{1,20})\/?(export\.svg|export\.dxf)?$/);
    if (page && req.method === "GET") {
      const sheet = db.getSheet(page[1]);
      if (!sheet) return notFound(res);
      if (!page[2]) return file(res, PUBLIC, "sheet.html") || notFound(res);
      const shapes = db.loadShapes(sheet.id);
      const svg = page[2] === "export.svg";
      return send(
        res,
        200,
        svg ? "image/svg+xml; charset=utf-8" : "application/dxf",
        svg ? toSvg(sheet, shapes) : toDxf(sheet, shapes),
        { "Content-Disposition": `attachment; filename="${slug(sheet.name)}.${svg ? "svg" : "dxf"}"` },
      );
    }

    if (req.method === "GET" && !path.endsWith(".html") && file(res, PUBLIC, decodeURIComponent(path.slice(1)))) {
      return;
    }
    notFound(res);
  } catch (err) {
    console.error(req.method, path, err);
    if (!res.headersSent) json(res, 500, { error: "the server failed on that request" });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.messageBytes });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://local");
  const sheet = url.pathname === "/ws" ? db.getSheet(url.searchParams.get("sheet") ?? "") : undefined;
  if (!sheet) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Pings keep Fly's proxy from closing a quiet connection and find the ones
    // whose other end has gone without saying so.
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);
    ws.on("close", () => clearInterval(ping));
    roomFor(sheet).join(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`bench listening on :${PORT}, data in ${process.env.DATA_DIR ?? "./data"}`);
});

function shutdown(): void {
  wss.clients.forEach((ws) => ws.close(1001, "server restarting"));
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

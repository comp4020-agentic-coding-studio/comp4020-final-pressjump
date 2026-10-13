// The whole server: static pages, a small JSON API, the STL export, /readme/
// and the WebSocket each open design talks through. One process, one SQLite file.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { WebSocketServer } from "ws";
import { LIMITS, cleanName, type Design } from "../shared/protocol.ts";
import * as db from "./db.ts";
import { toStl } from "./export.ts";
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
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

// The design a fresh install opens with, so a room full of people has one
// obvious place to start.
if (db.listDesigns().length === 0) {
  db.addDesign({ id: newId(), name: "Workshop" });
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
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";
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

    if (path === "/api/designs" && req.method === "GET") {
      const online = onlineCounts();
      return json(
        res,
        200,
        db.listDesigns().map((d) => ({ ...d, online: online.get(d.id) ?? 0 })),
      );
    }
    if (path === "/api/designs" && req.method === "POST") {
      let input: { name?: unknown };
      try {
        input = (await body(req)) as typeof input;
      } catch {
        return json(res, 400, { error: "send a JSON object" });
      }
      const name = cleanName(input.name);
      if (!name) return json(res, 400, { error: "a design needs a name" });
      const design: Design = { id: newId(), name };
      db.addDesign(design);
      return json(res, 201, design);
    }

    const api = path.match(/^\/api\/designs\/([A-Za-z0-9]{1,20})$/);
    if (api && req.method === "GET") {
      const design = db.getDesign(api[1]);
      if (!design) return json(res, 404, { error: "no such design" });
      return json(res, 200, { design, features: db.loadFeatures(design.id) });
    }

    const page = path.match(/^\/d\/([A-Za-z0-9]{1,20})\/?(export\.stl)?$/);
    if (page && req.method === "GET") {
      const design = db.getDesign(page[1]);
      if (!design) return notFound(res);
      if (!page[2]) return file(res, PUBLIC, "design.html") || notFound(res);
      return send(res, 200, "model/stl", toStl(design.name, db.loadFeatures(design.id)), {
        "Content-Disposition": `attachment; filename="${slug(design.name)}.stl"`,
      });
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
  const design = url.pathname === "/ws" ? db.getDesign(url.searchParams.get("design") ?? "") : undefined;
  if (!design) {
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
    roomFor(design).join(ws);
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

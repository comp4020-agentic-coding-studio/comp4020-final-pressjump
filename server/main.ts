// The whole server: static pages, a small JSON API, the STL export, /readme/
// and the WebSocket each open design talks through. One process, one SQLite file.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { WebSocketServer } from "ws";
import { LIMITS, cleanName, pack, type Design } from "../shared/protocol.ts";
import { EXAMPLE_ID, EXAMPLE_NAME, exampleFeatures } from "../shared/example.ts";
import { checkReferences, validateFeature, type Stored } from "../shared/model.ts";
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
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".stl": "model/stl",
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

// The example design, at /d/example: a wind turbine made of ordinary
// features (shared/example.ts). Made whenever the design is missing or has
// been emptied, through the same checks as any edit, before anyone can open it.
if (!db.getDesign(EXAMPLE_ID)) db.addDesign({ id: EXAMPLE_ID, name: EXAMPLE_NAME });
if (db.loadFeatures(EXAMPLE_ID).length === 0) {
  const made = new Map<string, Stored>();
  const author = "bench-example";
  db.putPerson(author, "Bench example");
  db.renameDesign(EXAMPLE_ID, EXAMPLE_NAME);
  for (const [i, { id, f }] of exampleFeatures().entries()) {
    const v = validateFeature(f);
    const problem = typeof v === "string" ? v : checkReferences(made, v);
    if (typeof v === "string" || problem) throw new Error(`the example's ${f.name} is not a valid feature: ${problem ?? v}`);
    const stored = { ...v, id, v: 1, by: author, seq: i + 1 } as Stored;
    db.putFeature(EXAMPLE_ID, stored);
    made.set(id, stored);
  }
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
  send(res, 200, TYPES[extname(path)] ?? "application/octet-stream", readFileSync(path), WORKER_POLICY[rel] ?? {});
  return true;
}

// The STEP reader is OpenCascade compiled to WebAssembly, and its loader
// builds functions from strings. A worker runs under the policy sent with its
// own script, so only that worker gets eval and WebAssembly: it has no page
// to reach, loads only from here, and sees only the file someone chose.
// Every page keeps the strict policy above.
const WORKER_POLICY: Record<string, Record<string, string>> = {
  "build/step-worker.js": {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'",
  },
};

function notFound(res: ServerResponse): void {
  const page = readFileSync(join(PUBLIC, "404.html"), "utf8");
  send(res, 404, TYPES[".html"], page);
}

class TooLarge extends Error {}

// A request body, read up to the message limit and no further: nothing the
// server takes is anywhere near the size of a model.
async function body(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > LIMITS.messageBytes) throw new TooLarge();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.messageBytes) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Too big: say so, then hang up, so the rest of the upload is never read and
// the connection is not left half full for the next request.
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.on("finish", () => req.destroy());
  send(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: `requests are limited to ${LIMITS.messageBytes / 1024} KB; models stay in your browser and are never uploaded` }), { Connection: "close" });
}

// The home page, greeting a returning guest by the name in their cookie, so
// the page is right before any script runs. The cookie is the browser's own
// note of what it called itself; the server keeps nothing of it.
function homePage(req: IncomingMessage): string {
  const page = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith("bench_guest="));
  let name = "";
  try {
    name = raw ? cleanName(decodeURIComponent(raw.slice("bench_guest=".length))) : "";
  } catch {
    name = "";
  }
  if (!name) return page;
  const safe = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return page.replace('<body class="land">', '<body class="land known">').replaceAll("<!--guest-->", safe);
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
    if (req.method === "GET" && path === "/") return send(res, 200, TYPES[".html"], homePage(req), { Vary: "Cookie" });
    if (req.method === "GET" && path === "/readme") return send(res, 301, "text/plain", "", { Location: "/readme/" });
    if (req.method === "GET" && path === "/readme/") return send(res, 200, TYPES[".html"], readmePage());
    if (req.method === "GET" && path.startsWith("/readme/docs/")) {
      return file(res, DOCS, decodeURIComponent(path.slice("/readme/docs/".length))) || notFound(res);
    }

    // The public list gives out view links only, so it cannot be used to get
    // an edit link; the example is the one design anyone may edit.
    if (path === "/api/designs" && req.method === "GET") {
      const online = onlineCounts();
      return json(
        res,
        200,
        db.listDesigns().map((d) => ({
          link: d.id === EXAMPLE_ID ? `/d/${d.id}` : `/v/${d.view}`,
          // for its thumbnail, from /api/views/<view>
          view: d.view,
          name: d.name,
          updated: d.updated,
          features: d.features,
          online: online.get(d.id) ?? 0,
          editable: d.id === EXAMPLE_ID,
        })),
      );
    }
    if (path === "/api/designs" && req.method === "POST") {
      let input: { name?: unknown };
      try {
        input = (await body(req)) as typeof input;
      } catch (err) {
        if (err instanceof TooLarge) return tooLarge(req, res);
        return json(res, 400, { error: "send a JSON object" });
      }
      const name = cleanName(input.name);
      if (!name) return json(res, 400, { error: "a design needs a name" });
      const design: Design = { id: newId(), name };
      const view = db.addDesign(design);
      return json(res, 201, { ...design, view });
    }

    const api = path.match(/^\/api\/designs\/([A-Za-z0-9]{1,20})$/);
    if (api && req.method === "GET") {
      const design = db.getDesign(api[1]);
      if (!design) return json(res, 404, { error: "no such design" });
      return json(res, 200, { design, features: db.loadFeatures(design.id) });
    }

    // A design's features by its view link, for the thumbnails on the home
    // page: what anyone holding that link could watch anyway, packed, and
    // never the edit id.
    const viewApi = path.match(/^\/api\/views\/([A-Za-z0-9]{1,20})$/);
    if (viewApi && req.method === "GET") {
      const design = db.getDesignByView(viewApi[1]);
      if (!design) return json(res, 404, { error: "no such design" });
      const features = db.loadFeatures(design.id).map((f) => pack(f));
      return json(res, 200, { name: design.name, features });
    }

    // /d/<id> edits, /v/<view> only watches; both open the editor and export
    const page = path.match(/^\/(d|v)\/([A-Za-z0-9]{1,20})\/?(export\.stl)?$/);
    if (page && req.method === "GET") {
      const design = page[1] === "d" ? db.getDesign(page[2]) : db.getDesignByView(page[2]);
      if (!design) return notFound(res);
      if (!page[3]) return file(res, PUBLIC, "design.html") || notFound(res);
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
  // ?design=<id> comes in to edit, ?view=<view> to watch
  const viewing = url.searchParams.has("view");
  const design =
    url.pathname !== "/ws" ? undefined : viewing ? db.getDesignByView(url.searchParams.get("view") ?? "") : db.getDesign(url.searchParams.get("design") ?? "");
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
    roomFor(design).join(ws, viewing ? "view" : "edit");
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

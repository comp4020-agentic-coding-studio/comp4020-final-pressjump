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
import * as auth from "./auth.ts";
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
  send(res, 200, TYPES[extname(path)] ?? "application/octet-stream", readFileSync(path));
  return true;
}

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
  send(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: `requests are limited to ${LIMITS.messageBytes / 1024} KB; Bench takes no files` }), { Connection: "close" });
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The home page, greeting someone signed in by their account's name, so the
// page is right before any script runs.
function homePage(user: db.User | undefined): string {
  const page = readFileSync(join(PUBLIC, "index.html"), "utf8");
  if (!user) return page;
  return page.replace('<body class="land">', '<body class="land known">').replaceAll("<!--guest-->", escape(user.name));
}

// /projects, with the account's name and email in it before any script runs
function projectsPage(user: db.User): string {
  const page = readFileSync(join(PUBLIC, "projects.html"), "utf8");
  return page.replaceAll("<!--name-->", escape(user.name)).replaceAll("<!--email-->", escape(user.email));
}

// Where to go after signing in: a path on this site, never another one.
function nextPath(raw: string | null): string {
  return raw && /^\/(?!\/)[\w\-./#?=&]*$/.test(raw) ? raw : "/projects";
}

// A JSON object from a request body, or undefined once the refusal is sent.
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await body(req);
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TooLarge) {
      tooLarge(req, res);
      return undefined;
    }
  }
  json(res, 400, { error: "send a JSON object" });
  return undefined;
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
    const user = auth.userOf(req);
    if (req.method === "GET" && path === "/") return send(res, 200, TYPES[".html"], homePage(user), { Vary: "Cookie" });

    // ---- accounts: see server/auth.ts and docs/adr/0005-accounts.md
    if (req.method === "GET" && (path === "/signin" || path === "/signup")) {
      if (user) return send(res, 302, "text/plain", "", { Location: nextPath(url.searchParams.get("next")) });
      const page = readFileSync(join(PUBLIC, "account.html"), "utf8");
      return send(res, 200, TYPES[".html"], path === "/signup" ? page.replace('<body class="account">', '<body class="account signup">') : page);
    }
    if (req.method === "GET" && (path === "/projects" || path === "/projects/")) {
      if (!user) return send(res, 302, "text/plain", "", { Location: "/signin?next=/projects" });
      return send(res, 200, TYPES[".html"], projectsPage(user), { Vary: "Cookie" });
    }
    if (path.startsWith("/api/") && req.method !== "GET" && !auth.sameOrigin(req)) {
      return json(res, 403, { error: "that request came from another site" });
    }
    if (path === "/api/signup" && req.method === "POST") {
      if (auth.blocked(req, "signup", auth.MAX_SIGNUPS)) return json(res, 429, { error: "too many new accounts from here in the last minute; wait a minute and try again" });
      const input = await readJson(req, res);
      if (!input) return;
      const form = auth.readSignup(input);
      if (typeof form === "string") return json(res, 400, { error: form });
      auth.note(req, "signup");
      const made = await auth.signUp(form.email, form.password, form.name);
      if (typeof made === "string") return json(res, 409, { error: made });
      return send(res, 201, "application/json; charset=utf-8", JSON.stringify({ name: made.name, email: made.email }), {
        "Set-Cookie": auth.startSession(req, made.id),
      });
    }
    if (path === "/api/signin" && req.method === "POST") {
      const input = await readJson(req, res);
      if (!input) return;
      const kind = `signin|${auth.cleanEmail(input.email)}`;
      if (auth.blocked(req, kind, auth.MAX_FAILED_SIGNINS)) return json(res, 429, { error: "too many wrong passwords for that email; wait a minute and try again" });
      const found = await auth.signIn(String(input.email ?? ""), typeof input.password === "string" ? input.password : "");
      if (!found) {
        auth.note(req, kind);
        return json(res, 401, { error: "that email and password do not match an account" });
      }
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ name: found.name, email: found.email }), {
        "Set-Cookie": auth.startSession(req, found.id),
      });
    }
    if (path === "/api/signout" && req.method === "POST") {
      return send(res, 200, "application/json; charset=utf-8", "{}", { "Set-Cookie": auth.endSession(req) });
    }
    if (path === "/api/me" && req.method === "GET") {
      if (!user) return json(res, 401, { error: "not signed in" });
      return json(res, 200, { name: user.name, email: user.email });
    }

    // An account's projects: the designs it made and the ones it opened, each
    // with the link it was given (the edit link only if it had it).
    if (path === "/api/projects" && req.method === "GET") {
      if (!user) return json(res, 401, { error: "sign in to see your projects" });
      const online = onlineCounts();
      return json(
        res,
        200,
        db.projectsOf(user.id).map((p) => ({
          link: p.access === "edit" ? `/d/${p.id}` : `/v/${p.view}`,
          view: p.view,
          name: p.name,
          access: p.access,
          mine: !!p.mine,
          opened: p.opened,
          updated: p.updated,
          features: p.features,
          online: online.get(p.id) ?? 0,
        })),
      );
    }
    // Add a design to your projects by a link you hold (say one kept from
    // before there were accounts): an edit link adds it to edit, a view link
    // to watch, as opening it would.
    if (path === "/api/projects" && req.method === "POST") {
      if (!user) return json(res, 401, { error: "sign in to keep projects" });
      const input = await readJson(req, res);
      if (!input) return;
      const m = String(input.link ?? "").match(/\/(d|v)\/([A-Za-z0-9]{1,20})\/?$/);
      const design = m ? (m[1] === "d" ? db.getDesign(m[2]) : db.getDesignByView(m[2])) : undefined;
      if (!m || !design) return json(res, 404, { error: "no design has that link" });
      if (design.id === EXAMPLE_ID) return json(res, 400, { error: "the example is everyone's, so it is not kept in anyone's projects" });
      db.markOpened(user.id, design.id, m[1] === "d" ? "edit" : "view");
      return json(res, 201, { view: db.viewOf(design.id) });
    }
    const forget = path.match(/^\/api\/projects\/([A-Za-z0-9]{1,20})$/);
    if (forget && req.method === "DELETE") {
      if (!user) return json(res, 401, { error: "sign in to change your projects" });
      db.forgetProject(user.id, forget[1]);
      return json(res, 200, {});
    }
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
    // Starting a design takes an account; joining one by its link does not.
    if (path === "/api/designs" && req.method === "POST") {
      if (!user) return json(res, 401, { error: "sign in or create an account to start a design; anyone can join one by its link" });
      const input = await readJson(req, res);
      if (!input) return;
      const name = cleanName(input.name);
      if (!name) return json(res, 400, { error: "a design needs a name" });
      const design: Design = { id: newId(), name };
      const view = db.addDesign(design, user.id);
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
    // a socket opened by another site's page is a guest, whatever cookie it carries
    roomFor(design).join(ws, viewing ? "view" : "edit", auth.sameOrigin(req) ? auth.userOf(req) : undefined);
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

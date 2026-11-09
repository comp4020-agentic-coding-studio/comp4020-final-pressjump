// Accounts and sessions. A password is kept only as a salted scrypt hash
// (node:crypto, so no native module); a session is 32 random bytes in an
// HttpOnly cookie, and the database holds only its SHA-256, so a copy of the
// database cannot be used to sign in. See docs/adr/0005-accounts.md.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cleanName } from "../shared/protocol.ts";
import * as db from "./db.ts";

export const SESSION_COOKIE = "bench_session";
const SESSION_DAYS = 30;
const KEY_LEN = 64;
// 16 MB of memory per hash: affordable on a 256 MB machine, a few at a time
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LEN, COST, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await derive(password, Buffer.from(salt, "base64"));
  return got.length === want.length && timingSafeEqual(got, want);
}

// A hash every refused sign-in is checked against when the email is unknown,
// so how long a refusal takes does not say whether the email has an account.
const decoy = hashPassword(randomBytes(12).toString("hex"));

export function cleanEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

// What a sign-up or sign-in form sends, checked; a string is the refusal.
export function readSignup(input: { email?: unknown; password?: unknown; name?: unknown }): { email: string; password: string; name: string } | string {
  const email = cleanEmail(input.email);
  if (!email) return "type an email address, like you@example.com";
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < 8) return "a password needs at least 8 characters";
  if (password.length > 200) return "a password can be at most 200 characters";
  const name = cleanName(input.name);
  if (!name) return "type the name people will see on your cursor";
  return { email, password, name };
}

export async function signUp(email: string, password: string, name: string): Promise<db.User | string> {
  if (db.userByEmail(email)) return "that email already has an account; sign in instead";
  const hash = await hashPassword(password);
  // checked again after the slow hash, in case the same email signed up meanwhile
  if (db.userByEmail(email)) return "that email already has an account; sign in instead";
  const id = randomBytes(9).toString("base64url");
  db.addUser(id, email, name, hash);
  return { id, email, name };
}

export async function signIn(email: string, password: string): Promise<db.User | null> {
  const user = db.userByEmail(cleanEmail(email));
  if (!user) {
    await checkPassword(password, await decoy);
    return null;
  }
  if (!(await checkPassword(password, user.hash))) return null;
  return { id: user.id, email: user.email, name: user.name };
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

// A new session for a user, and the Set-Cookie header that carries it.
export function startSession(req: IncomingMessage, user: string): string {
  const token = randomBytes(32).toString("base64url");
  const maxAge = SESSION_DAYS * 86400;
  db.addSession(tokenHash(token), user, Date.now() + maxAge * 1000);
  return cookieHeader(req, token, maxAge);
}

export function endSession(req: IncomingMessage): string {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.dropSession(tokenHash(token));
  return cookieHeader(req, "", 0);
}

function cookieHeader(req: IncomingMessage, value: string, maxAge: number): string {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function isHttps(req: IncomingMessage): boolean {
  return req.headers["x-forwarded-proto"] === "https" || ("encrypted" in req.socket && !!req.socket.encrypted);
}

export function readCookie(req: IncomingMessage, name: string): string {
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  if (!raw) return "";
  try {
    return decodeURIComponent(raw.slice(name.length + 1));
  } catch {
    return "";
  }
}

// The signed-in user making this request, if any.
export function userOf(req: IncomingMessage): db.User | undefined {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return undefined;
  const id = db.sessionUser(tokenHash(token));
  return id ? db.getUser(id) : undefined;
}

// A request that changes an account must come from a Bench page: the cookie
// is SameSite=Lax and the body JSON, and an Origin from elsewhere is refused.
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Failed sign-ins per address and email, and sign-ups per address, in a
// minute: enough for a typo or two, too few to guess a password or to keep the
// machine busy hashing. The map is swept so it cannot grow without bound.
const attempts = new Map<string, { n: number; since: number }>();
const WINDOW = 60_000;
export const MAX_FAILED_SIGNINS = 10;
export const MAX_SIGNUPS = 60;

function key(req: IncomingMessage, kind: string): string {
  return `${kind}|${String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "")}`;
}

export function blocked(req: IncomingMessage, kind: string, max: number): boolean {
  const a = attempts.get(key(req, kind));
  return !!a && Date.now() - a.since < WINDOW && a.n >= max;
}

export function note(req: IncomingMessage, kind: string): void {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (now - v.since > WINDOW) attempts.delete(k);
  const k = key(req, kind);
  const a = attempts.get(k);
  if (!a || now - a.since > WINDOW) attempts.set(k, { n: 1, since: now });
  else a.n++;
}

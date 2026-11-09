// The name this browser goes by in a design: a cookie and a copy in
// localStorage. Someone who joins by a link without an account is a guest
// under this name; someone signed in is their account (server/auth.ts), and
// the account's name is copied here so the editor reads one place.
//
// Before there were accounts this browser also kept a list of projects in
// localStorage. Accounts keep that list on the server now (/projects), so the
// old one is only read, once, to offer adding it to an account.

import { cleanName } from "../shared/protocol.ts";

type OldProject = { id?: string; view: string };

const COOKIE = "bench_guest";
const NAME_KEY = "bench.name";
const PROJECTS_KEY = "bench.projects";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked: the profile lasts as long as the page
  }
}

function cookie(): string {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return "";
  try {
    return cleanName(decodeURIComponent(raw.slice(COOKIE.length + 1)));
  } catch {
    return "";
  }
}

function setCookie(value: string, maxAge: number): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

// The name this browser goes by, or "" if it has never given one.
export function guestName(): string {
  const fromCookie = cookie();
  if (fromCookie) return fromCookie;
  // someone who named themselves before the cookie existed keeps their name
  const old = cleanName(read(NAME_KEY) ?? "");
  if (old) setCookie(old, 31536000);
  return old;
}

export function setGuestName(name: string): void {
  const clean = cleanName(name);
  if (!clean) return;
  setCookie(clean, 31536000);
  write(NAME_KEY, clean);
}

// The links of the designs this browser listed before accounts, edit links
// where it had them.
export function oldProjects(): string[] {
  try {
    const list = JSON.parse(read(PROJECTS_KEY) ?? "[]") as OldProject[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p.view === "string")
      .map((p) => (p.id ? `/d/${p.id}` : `/v/${p.view.split("/").pop()}`));
  } catch {
    return [];
  }
}

export function forgetOldProjects(): void {
  write(PROJECTS_KEY, null);
}

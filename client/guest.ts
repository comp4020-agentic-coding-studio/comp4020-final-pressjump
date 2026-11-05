// The guest profile: who you are on this browser, and the designs you have
// opened here. Not an account. Nothing of it is stored on the server: the
// name is a cookie (so the home page can greet you before any script runs)
// and a copy in localStorage (which the editor has always read); the list of
// projects lives in localStorage only, with each design's links, because a
// cookie is too small for it and the server has no business keeping it.
// Clear the browser's data and it is gone, and the page says so.

import { cleanName } from "../shared/protocol.ts";

export type Project = {
  // the edit id, kept only when this browser was given the edit link
  id?: string;
  // the view-only link's id: every project has one, and it fetches thumbnails
  view: string;
  name: string;
  access: "edit" | "view";
  opened: number;
  features: number;
};

const COOKIE = "bench_guest";
const NAME_KEY = "bench.name";
const PROJECTS_KEY = "bench.projects";
const MAX_PROJECTS = 100;

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

// Forget this browser's name and its list of projects. The designs
// themselves stay on the server for whoever else has their links.
export function forgetGuest(): void {
  setCookie("", 0);
  write(NAME_KEY, null);
  write(PROJECTS_KEY, null);
}

export function projects(): Project[] {
  try {
    const list = JSON.parse(read(PROJECTS_KEY) ?? "[]") as Project[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p.view === "string" && typeof p.name === "string")
      // an id, never a path: a /v/<view> path saved by mistake is mended
      .map((p) => (p.view.includes("/") ? { ...p, view: p.view.split("/").pop() ?? p.view } : p))
      .sort((a, b) => b.opened - a.opened);
  } catch {
    return [];
  }
}

// Put a design at the top of the list, or bring it up to date. An edit link
// once given is kept, even if the design is later opened by its view link.
export function remember(p: Project): void {
  const list = projects();
  const old = list.find((q) => q.view === p.view);
  const next: Project = old?.id && !p.id ? { ...p, id: old.id, access: "edit" } : p;
  const rest = list.filter((q) => q.view !== p.view);
  write(PROJECTS_KEY, JSON.stringify([next, ...rest].slice(0, MAX_PROJECTS)));
}

export function forgetProject(view: string): void {
  write(PROJECTS_KEY, JSON.stringify(projects().filter((p) => p.view !== view)));
}

export function projectLink(p: Project): string {
  return p.id ? `/d/${p.id}` : `/v/${p.view}`;
}

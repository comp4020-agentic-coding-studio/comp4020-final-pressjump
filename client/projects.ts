// /projects: the designs an account has made or opened, from the server, so
// they follow the account to any device. Thumbnails are drawn by showcase.ts
// from each design's view link, as on the home page.

import "./showcase.ts";
import { oldProjects, forgetOldProjects } from "./guest.ts";

type Project = {
  link: string;
  view: string;
  name: string;
  access: "edit" | "view";
  mine: boolean;
  opened: number;
  updated: number;
  features: number;
  online: number;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const list = $<HTMLUListElement>("pj-list");
const empty = $("pj-empty");
const status = $("pj-status");
const error = $("pj-error");
const search = $<HTMLInputElement>("pj-search");
let all: Project[] = [];
let filter: "all" | "mine" | "shared" = "all";

// One card per design, kept between refreshes, so a thumbnail is drawn once.
const cards = new Map<string, HTMLLIElement>();
function card(p: Project): HTMLLIElement {
  let li = cards.get(p.view);
  if (!li) {
    li = el("li");
    const a = el("a", "gcard");
    const pic = el("div", "thumb");
    const img = el("img");
    img.alt = "";
    img.dataset.thumb = p.view;
    img.setAttribute("aria-hidden", "true");
    pic.dataset.initial = p.name.slice(0, 1).toUpperCase();
    pic.append(img, el("span", "badge"), el("span", "live"));
    const meta = el("div", "gmeta");
    meta.append(el("b", "name"), el("span", "sub"));
    a.append(pic, meta);
    const x = el("button", "forget", "×");
    x.type = "button";
    x.addEventListener("click", () => void forget(p));
    li.append(a, x);
    cards.set(p.view, li);
  }
  const a = li.querySelector("a")!;
  a.href = p.link;
  a.setAttribute("aria-label", `${p.name}, ${p.access === "edit" ? "can edit" : "view only"}${p.online ? `, ${p.online} here now` : ""}`);
  li.querySelector(".name")!.textContent = p.name;
  li.querySelector(".sub")!.textContent = `${plural(p.features, "feature")} · ${p.mine ? "yours" : "shared"} · opened ${ago(p.opened)}`;
  const badge = li.querySelector<HTMLElement>(".badge")!;
  badge.className = `badge ${p.access === "edit" ? "badge-edit" : ""}`;
  badge.textContent = p.access === "edit" ? "Can edit" : "View only";
  const live = li.querySelector<HTMLElement>(".live")!;
  live.hidden = p.online === 0;
  live.textContent = `${p.online} here now`;
  const x = li.querySelector<HTMLButtonElement>(".forget")!;
  x.setAttribute("aria-label", `Remove ${p.name} from your projects`);
  x.title = "Remove from your projects (the design itself stays)";
  // a changed design gets a fresh picture
  const img = li.querySelector("img")!;
  if (img.dataset.stamp !== String(p.updated)) {
    img.dataset.stamp = String(p.updated);
    img.removeAttribute("src");
    img.dataset.state = "";
  }
  return li;
}

function render(): void {
  const q = search.value.trim().toLowerCase();
  const shown = all.filter(
    (p) => (filter === "all" || (filter === "mine") === p.mine) && (!q || p.name.toLowerCase().includes(q)),
  );
  list.replaceChildren(...shown.map(card));
  empty.hidden = shown.length > 0;
  empty.textContent = !all.length
    ? "Nothing here yet. Start a design, or open one someone shared with you, and it will be listed here."
    : q
      ? `No project is called anything like "${search.value.trim()}".`
      : filter === "mine"
        ? "You haven't started a design yet."
        : "Nobody has shared a design with you yet.";
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/projects");
    if (res.status === 401) {
      location.href = "/signin?next=/projects";
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    all = (await res.json()) as Project[];
    status.hidden = true;
    // a list being read is not rebuilt under someone's pointer
    if (!list.matches(":hover") || list.children.length === 0) render();
  } catch {
    status.hidden = false;
    status.textContent = "Could not reach the server. Trying again.";
  }
}

async function forget(p: Project): Promise<void> {
  error.textContent = "";
  const res = await fetch(`/api/projects/${encodeURIComponent(p.view)}`, { method: "DELETE" });
  if (!res.ok) {
    error.textContent = `Could not remove ${p.name}. Try again.`;
    return;
  }
  all = all.filter((q) => q.view !== p.view);
  cards.delete(p.view);
  render();
}

search.addEventListener("input", render);
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
  b.addEventListener("click", () => {
    filter = b.dataset.filter as typeof filter;
    for (const o of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) o.setAttribute("aria-pressed", String(o === b));
    render();
  });
}

// ------------------------------------------------------------- new design

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-new-design]")) {
  b.addEventListener("click", async () => {
    b.disabled = true;
    error.textContent = "";
    try {
      const name = document.querySelector(".account-name")?.textContent?.trim();
      const res = await fetch("/api/designs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name ? `${name}'s design` : "New design" }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? "the design could not be made");
      location.href = `/d/${body.id}`;
    } catch (err) {
      error.textContent = `Could not start a design: ${err instanceof Error ? err.message : String(err)}`;
      b.disabled = false;
    }
  });
}

// ------------------------------------------------------------- the menu

const profileButton = $<HTMLButtonElement>("profile-button");
const profileMenu = $("profile-menu");
function setProfile(open: boolean): void {
  profileMenu.hidden = !open;
  profileButton.setAttribute("aria-expanded", String(open));
}
profileButton.addEventListener("click", () => setProfile(profileMenu.hidden === true));
document.addEventListener("pointerdown", (e) => {
  if (!profileMenu.hidden && !(e.target as Element).closest(".profile")) setProfile(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !profileMenu.hidden) {
    setProfile(false);
    profileButton.focus();
  }
});
for (const e of document.querySelectorAll(".pav")) e.textContent = (document.querySelector(".account-name")?.textContent ?? "").trim().slice(0, 1).toUpperCase();

$("pm-signout").addEventListener("click", async () => {
  await fetch("/api/signout", { method: "POST" });
  location.href = "/";
});

// ------------------------------------------------------------- from before accounts

// Designs this browser listed before there were accounts. Offered once; added
// by the links the browser held, so an edit link adds a design to edit and a
// view link only to watch, exactly as opening each would.
const old = oldProjects();
if (old.length) {
  $("pj-import").hidden = false;
  $("pj-import-text").textContent = `This browser kept a list of ${plural(old.length, "design")} from before Bench had accounts. Add them to your projects so you can find them on any device?`;
  $("pj-import-skip").addEventListener("click", () => {
    forgetOldProjects();
    $("pj-import").hidden = true;
  });
  $("pj-import-go").addEventListener("click", async () => {
    const go = $<HTMLButtonElement>("pj-import-go");
    go.disabled = true;
    let failed = 0;
    for (const link of old) {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link }),
      }).catch(() => null);
      if (!res || (!res.ok && res.status !== 404)) failed++;
    }
    if (failed) {
      error.textContent = `${plural(failed, "design")} could not be added. Try again.`;
      go.disabled = false;
      return;
    }
    forgetOldProjects();
    $("pj-import").hidden = true;
    await refresh();
  });
}

refresh();
setInterval(refresh, 5000);

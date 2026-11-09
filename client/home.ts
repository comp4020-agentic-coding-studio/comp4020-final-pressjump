// The home page. For someone new: the pitch, and a way to make an account or
// sign in. For someone signed in (the server puts their name in the page and
// the class "known" on the body): a greeting, their latest projects from
// /projects, and a way back to all of them. Below, what the community is
// building, refreshed every few seconds so a room can see where everyone has
// gone. Thumbnails are drawn by landing3d.ts from each design's own timeline;
// this file only marks where they go.

// The public list gives each design's view link (the example's edit link),
// and the view id its thumbnail is fetched by.
type Row = { link: string; view: string; name: string; updated: number; features: number; online: number; editable: boolean };
type Project = { link: string; view: string; name: string; access: "edit" | "view"; opened: number; features: number };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const known = document.body.classList.contains("known");

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

// A picture of a design, drawn later by landing3d.ts from its timeline.
function thumb(view: string, stamp: string, name: string): HTMLElement {
  const box = el("div", "thumb");
  const img = el("img");
  img.alt = "";
  img.dataset.thumb = view;
  img.dataset.stamp = stamp;
  img.setAttribute("aria-hidden", "true");
  box.dataset.initial = name.slice(0, 1).toUpperCase();
  box.append(img);
  return box;
}

// ------------------------------------------------------------- a new design

// Starting a design takes an account; someone without one is sent to make one.
async function newDesign(name: string): Promise<void> {
  const res = await fetch("/api/designs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) {
    location.href = "/signup?next=/";
    return;
  }
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? "the design could not be made");
  location.href = `/d/${body.id}`;
}

const form = $<HTMLFormElement>("new-design");
const error = $<HTMLParagraphElement>("new-error");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.textContent = "";
  const button = form.querySelector("button") as HTMLButtonElement;
  button.disabled = true;
  try {
    await newDesign(String(new FormData(form).get("name") ?? ""));
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    button.disabled = false;
  }
});

const myName = (): string => (document.querySelector(".guest-name")?.textContent ?? "").trim();

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-new-design]")) {
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const name = myName();
      await newDesign(name ? `${name}'s design` : "New design");
    } catch (err) {
      const where = $("known-error");
      where.textContent = `Could not start a design: ${err instanceof Error ? err.message : String(err)}`;
      b.disabled = false;
    }
  });
}

// ------------------------------------------------------------- who you are

for (const e of document.querySelectorAll(".pav")) e.textContent = myName().slice(0, 1).toUpperCase();

// the menu under your name
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
profileMenu.addEventListener("click", (e) => {
  if ((e.target as Element).closest("button")) setProfile(false);
});

$("pm-signout").addEventListener("click", async () => {
  await fetch("/api/signout", { method: "POST" });
  location.reload();
});

// ------------------------------------------------------------- your latest projects

const recent = $<HTMLUListElement>("recent");

function projectCard(p: Project): HTMLLIElement {
  const li = el("li");
  const a = el("a", "gcard");
  a.href = p.link;
  const pic = thumb(p.view, `${p.features}`, p.name);
  pic.append(el("span", `badge ${p.access === "edit" ? "badge-edit" : ""}`, p.access === "edit" ? "Can edit" : "View only"));
  const meta = el("div", "gmeta");
  meta.append(el("b", "name", p.name), el("span", "", `${plural(p.features, "feature")} · opened ${ago(p.opened)}`));
  a.append(pic, meta);
  li.append(a);
  return li;
}

let lastRecent = "";
async function refreshRecent(): Promise<void> {
  if (!known) return;
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) return;
    const all = ((await res.json()) as Project[]).slice(0, 3);
    const now = JSON.stringify(all);
    if (now === lastRecent) return;
    lastRecent = now;
    recent.replaceChildren(...all.map(projectCard));
    recent.hidden = !all.length;
    $("known-lede").textContent = all.length
      ? "Pick up where you left off, or start something new."
      : "Start your first design, or open one someone shared with you. It'll be waiting on your projects page.";
  } catch {
    // the hero keeps what it had
  }
}

// ------------------------------------------------------------- the community

// Designs with something in them: an empty design or a lone test box says
// nothing about what Bench can make. The example always leads.
const WORTH_SHOWING = 4;
const PAGE = 9;
let limit = PAGE;
const gallery = $<HTMLUListElement>("designs");
const status = $<HTMLParagraphElement>("designs-status");
const more = $<HTMLButtonElement>("designs-more");
more.addEventListener("click", () => {
  limit += PAGE;
  refresh();
});

// One card per design, kept between refreshes and only its words changed, so
// a thumbnail is drawn once and not every four seconds.
const cards = new Map<string, HTMLLIElement>();
function communityCard(r: Row): HTMLLIElement {
  let li = cards.get(r.view);
  if (!li) {
    li = el("li");
    const a = el("a", "gcard");
    const pic = thumb(r.view, String(r.updated), r.name);
    const live = el("span", "live");
    const badge = el("span", "badge");
    pic.append(live, badge);
    const meta = el("div", "gmeta");
    meta.append(el("b", "name"), el("span", "sub"));
    a.append(pic, meta);
    li.append(a);
    cards.set(r.view, li);
  }
  const a = li.querySelector("a")!;
  a.href = r.link;
  a.setAttribute("aria-label", `${r.name}${r.editable ? ", anyone can edit" : ", watch"}${r.online ? `, ${r.online} here now` : ""}`);
  li.querySelector(".name")!.textContent = r.name;
  li.querySelector(".sub")!.textContent = `${plural(r.features, "feature")} · changed ${ago(r.updated)}`;
  const live = li.querySelector<HTMLElement>(".live")!;
  live.hidden = r.online === 0;
  live.textContent = `${r.online} here now`;
  const badge = li.querySelector<HTMLElement>(".badge")!;
  badge.hidden = !r.editable;
  badge.textContent = "Example · anyone can edit";
  // a changed design gets a fresh picture
  const img = li.querySelector("img")!;
  if (img.dataset.stamp !== String(r.updated)) {
    img.dataset.stamp = String(r.updated);
    img.removeAttribute("src");
    img.dataset.state = "";
  }
  return li;
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/designs");
    if (!res.ok) throw new Error(String(res.status));
    const rows = (await res.json()) as Row[];

    const worth = rows.filter((r) => r.editable || r.features >= WORTH_SHOWING);
    // people in it now first, then the newest
    worth.sort((a, b) => Number(b.editable) - Number(a.editable) || b.online - a.online || b.updated - a.updated);
    const shown = worth.slice(0, limit);
    status.hidden = shown.length > 0;
    status.textContent = shown.length ? "" : "Nothing to show yet. Start the first design above.";
    gallery.replaceChildren(...shown.map(communityCard));
    more.hidden = worth.length <= limit;
  } catch {
    status.hidden = false;
    status.textContent = "Could not reach the server. Trying again.";
  }
}

// ------------------------------------------------------------- go

refreshRecent();
refresh();
setInterval(() => {
  refresh();
  refreshRecent();
}, 4000);

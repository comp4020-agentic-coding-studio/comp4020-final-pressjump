// The home page. For someone new: the pitch and a name to launch with. For a
// guest this browser already knows: their name up top, their latest
// projects, and a popup of every project, all kept in this browser (see
// guest.ts); the server only greets them by the name in their cookie.
// Below, what the community is building, refreshed every few seconds so a
// room can see where everyone has gone. Thumbnails are drawn by landing3d.ts
// from each design's own timeline; this file only marks where they go.

import { cleanName } from "../shared/protocol.ts";
import { forgetGuest, forgetProject, guestName, projectLink, projects, remember, setGuestName, type Project } from "./guest.ts";

// The public list gives each design's view link (the example's edit link),
// and the view id its thumbnail is fetched by.
type Row = { link: string; view: string; name: string; updated: number; features: number; online: number; editable: boolean };

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

async function newDesign(name: string): Promise<void> {
  const res = await fetch("/api/designs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
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

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-new-design]")) {
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const name = guestName();
      await newDesign(name ? `${name}'s design` : "New design");
    } catch (err) {
      const where = $("known-error");
      where.textContent = `Could not start a design: ${err instanceof Error ? err.message : String(err)}`;
      b.disabled = false;
    }
  });
}

// ------------------------------------------------------------- who you are

function showGuest(): void {
  const name = guestName();
  document.body.classList.toggle("known", !!name);
  for (const e of document.querySelectorAll(".guest-name")) e.textContent = name;
  for (const e of document.querySelectorAll(".pav")) e.textContent = name.slice(0, 1).toUpperCase();
  renderProjects();
}

// The hero's launch, for someone new: type your name, press Launch, and you
// are in a new design under that name.
const launch = $<HTMLFormElement>("launch");
const launchName = $<HTMLInputElement>("launch-name");
const launchError = $<HTMLParagraphElement>("launch-error");
launch.addEventListener("submit", async (e) => {
  e.preventDefault();
  launchError.textContent = "";
  const name = cleanName(launchName.value);
  if (!name) {
    launchError.textContent = "Type the name people will see on your cursor.";
    return;
  }
  const button = launch.querySelector("button") as HTMLButtonElement;
  button.disabled = true;
  try {
    setGuestName(name);
    await newDesign(`${name}'s design`);
  } catch (err) {
    launchError.textContent = `Could not launch: ${err instanceof Error ? err.message : String(err)}`;
    button.disabled = false;
  }
});

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

const nameDialog = $<HTMLDialogElement>("name-dialog");
const nameInput = $<HTMLInputElement>("name-input");
$("pm-rename").addEventListener("click", () => {
  nameInput.value = guestName();
  nameDialog.showModal();
  nameInput.select();
});
$("name-cancel").addEventListener("click", () => nameDialog.close());
$<HTMLFormElement>("name-form").addEventListener("submit", () => {
  setGuestName(nameInput.value);
  showGuest();
});

$("pm-forget").addEventListener("click", () => {
  const ok = confirm(
    "Forget your name and your list of projects on this browser?\n\nThe designs stay on Bench for everyone who has their links, but this browser will no longer list them. Keep any edit links you need first.",
  );
  if (!ok) return;
  forgetGuest();
  showGuest();
  scrollTo({ top: 0 });
});

// ------------------------------------------------------------- your projects

const pjDialog = $<HTMLDialogElement>("projects");
const pjList = $<HTMLUListElement>("pj-list");
const pjEmpty = $("pj-empty");
const pjSearch = $<HTMLInputElement>("pj-search");
const recent = $<HTMLUListElement>("recent");

function projectCard(p: Project, withForget: boolean): HTMLLIElement {
  const li = el("li");
  const a = el("a", "gcard");
  a.href = projectLink(p);
  const pic = thumb(p.view, `${p.features}`, p.name);
  pic.append(el("span", `badge ${p.access === "edit" ? "badge-edit" : ""}`, p.access === "edit" ? "Can edit" : "View only"));
  const meta = el("div", "gmeta");
  meta.append(el("b", "name", p.name), el("span", "", `${plural(p.features, "feature")} · opened ${ago(p.opened)}`));
  a.append(pic, meta);
  li.append(a);
  if (withForget) {
    const x = el("button", "forget", "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${p.name} from your projects`);
    x.title = "Remove from this list (the design itself stays)";
    x.addEventListener("click", () => {
      forgetProject(p.view);
      renderProjects();
    });
    li.append(x);
  }
  return li;
}

function renderProjects(): void {
  const all = projects();
  const count = $("project-count");
  count.textContent = all.length ? String(all.length) : "";
  count.hidden = !all.length;

  // the hero: the latest three
  recent.replaceChildren(...all.slice(0, 3).map((p) => projectCard(p, false)));
  recent.hidden = !all.length;
  $("known-lede").textContent = all.length
    ? "Pick up where you left off, or start something new. Your projects are kept in this browser."
    : "Start your first design, or open one someone shared with you. It'll be waiting here next time.";
  renderPopup();
}

// the popup: all of them, filtered by the search
function renderPopup(): void {
  const all = projects();
  const q = pjSearch.value.trim().toLowerCase();
  const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
  pjList.replaceChildren(...shown.map((p) => projectCard(p, true)));
  pjEmpty.hidden = shown.length > 0;
  pjEmpty.textContent = all.length
    ? `No project is called anything like "${pjSearch.value.trim()}".`
    : "Nothing here yet. Start a design, or open one someone shared with you, and it will be listed here.";
}

function openProjects(): void {
  renderPopup();
  if (!pjDialog.open) pjDialog.showModal();
}
for (const b of document.querySelectorAll<HTMLElement>("[data-open-projects]")) b.addEventListener("click", openProjects);
$("pj-close").addEventListener("click", () => pjDialog.close());
pjSearch.addEventListener("input", renderPopup);
// a click on the backdrop closes it
pjDialog.addEventListener("click", (e) => {
  if (e.target === pjDialog) pjDialog.close();
});
pjDialog.addEventListener("close", () => {
  if (location.hash === "#projects") history.replaceState(null, "", location.pathname);
});
// the editor's File menu links to /#projects
function fromHash(): void {
  if (location.hash === "#projects") openProjects();
}
addEventListener("hashchange", fromHash);

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

    // your own projects take any new name someone gave them
    const mine = new Map(projects().map((p) => [p.view, p]));
    for (const r of rows) {
      const p = mine.get(r.view);
      if (p && (p.name !== r.name || p.features !== r.features)) remember({ ...p, name: r.name, features: r.features });
    }
    if (mine.size) renderProjectsQuietly();

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

// Names in the popup and the hero follow a rename, but a list being read is
// not rebuilt under someone's pointer.
let lastProjects = JSON.stringify(projects());
function renderProjectsQuietly(): void {
  const now = JSON.stringify(projects());
  if (now === lastProjects) return;
  lastProjects = now;
  if (!pjDialog.open) renderProjects();
}

// ------------------------------------------------------------- go

try {
  launchName.value = guestName();
} catch {
  // the field just starts empty
}
showGuest();
fromHash();
refresh();
setInterval(refresh, 4000);

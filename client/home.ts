// The home page: every design, how many people are in each right now, and a
// form to start one. The list refreshes every few seconds so a room can see
// where everyone has gone.

import { cleanName } from "../shared/protocol.ts";

type Row = { id: string; name: string; updated: number; features: number; online: number };

const list = document.getElementById("designs") as HTMLUListElement;
const status = document.getElementById("designs-status") as HTMLParagraphElement;
const form = document.getElementById("new-design") as HTMLFormElement;
const error = document.getElementById("new-error") as HTMLParagraphElement;

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/designs");
    if (!res.ok) throw new Error(String(res.status));
    const rows = (await res.json()) as Row[];
    status.hidden = rows.length > 0;
    status.textContent = rows.length ? "" : "No designs yet. Start the first one below.";
    list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `/d/${r.id}`;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = r.name;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${r.features} ${r.features === 1 ? "feature" : "features"} · changed ${ago(r.updated)}`;
        a.append(name, meta);
        if (r.online > 0) {
          const live = document.createElement("span");
          live.className = "live";
          live.textContent = `${r.online} here now`;
          a.append(live);
        }
        li.append(a);
        return li;
      }),
    );
  } catch {
    status.hidden = false;
    status.textContent = "Could not reach the server. Trying again.";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.textContent = "";
  const button = form.querySelector("button") as HTMLButtonElement;
  button.disabled = true;
  try {
    const res = await fetch("/api/designs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: new FormData(form).get("name") }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? "the design could not be made");
    location.href = `/d/${body.id}`;
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    button.disabled = false;
  }
});

refresh();
setInterval(refresh, 4000);


// The hero's launch: type your name, press Launch, and you are in a new
// design under that name. The editor reads the name from `bench.name` when it
// says hello to the server, so storing it here is all it takes.
const launch = document.getElementById("launch") as HTMLFormElement;
const launchName = document.getElementById("launch-name") as HTMLInputElement;
const launchError = document.getElementById("launch-error") as HTMLParagraphElement;

try {
  launchName.value = localStorage.getItem("bench.name") ?? "";
} catch {
  // no storage: the field just starts empty
}

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
    try {
      localStorage.setItem("bench.name", name);
    } catch {
      // the editor will ask for a name instead
    }
    const res = await fetch("/api/designs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${name}'s design` }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? "the design could not be made");
    location.href = `/d/${body.id}`;
  } catch (err) {
    launchError.textContent = `Could not launch: ${err instanceof Error ? err.message : String(err)}`;
    button.disabled = false;
  }
});

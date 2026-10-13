// The home page: every sheet, how many people are on each right now, and a
// form to start one. The list refreshes every few seconds so a room can see
// where everyone has gone.

type Row = { id: string; name: string; w: number; h: number; updated: number; shapes: number; online: number };

const list = document.getElementById("sheets") as HTMLUListElement;
const status = document.getElementById("sheets-status") as HTMLParagraphElement;
const form = document.getElementById("new-sheet") as HTMLFormElement;
const error = document.getElementById("new-error") as HTMLParagraphElement;
const size = form.elements.namedItem("size") as HTMLSelectElement;
const custom = form.querySelector(".custom") as HTMLElement;

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/sheets");
    if (!res.ok) throw new Error(String(res.status));
    const rows = (await res.json()) as Row[];
    status.textContent = rows.length ? "" : "No sheets yet. Start the first one below.";
    status.hidden = rows.length > 0;
    list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `/s/${r.id}`;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = r.name;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${r.w} × ${r.h} mm · ${r.shapes} ${r.shapes === 1 ? "shape" : "shapes"} · changed ${ago(r.updated)}`;
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

size.addEventListener("change", () => {
  custom.hidden = size.value !== "custom";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.textContent = "";
  const data = new FormData(form);
  let w: number;
  let h: number;
  if (size.value === "custom") {
    w = Number(data.get("w"));
    h = Number(data.get("h"));
  } else {
    [w, h] = size.value.split("x").map(Number);
  }
  const button = form.querySelector("button") as HTMLButtonElement;
  button.disabled = true;
  try {
    const res = await fetch("/api/sheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.get("name"), w, h }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? "the sheet could not be made");
    location.href = `/s/${body.id}`;
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    button.disabled = false;
  }
});

refresh();
setInterval(refresh, 4000);

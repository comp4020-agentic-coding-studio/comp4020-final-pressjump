// Help for people new to Bench, or to CAD: a guided tour on the first visit,
// and a tip on every command that says in plain words what it does.
//
// The tour is a list of steps. Each points at part of the editor and says
// what it is; some wait for you to do the thing (click Box, place it, drag an
// arrow) and move on by themselves. Any step can be skipped, and so can the
// whole tour. Whether you have seen it is kept in a cookie, `bench_tour`, so
// it shows once per browser and never again unless you ask for it from the
// help menu.

const COOKIE = "bench_tour";

export function seenTour(): boolean {
  return document.cookie.split(";").some((c) => c.trim() === `${COOKIE}=done`);
}

export function markTourSeen(): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=done; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

export type Step = {
  // what to point at; null for a card in the middle of the screen
  target: () => Element | null;
  title: string;
  body: string;
  // when set, the step finishes by itself once this is true
  done?: () => boolean;
  // runs when the step opens
  enter?: () => void;
};

let active: { steps: Step[]; i: number; card: HTMLElement; ring: HTMLElement; timer: number; onEnd: () => void } | null = null;

export function tourRunning(): boolean {
  return active !== null;
}

export function startTour(steps: Step[], onEnd: () => void = () => {}): void {
  endTour(false);
  const ring = document.createElement("div");
  ring.className = "tour-ring";
  ring.setAttribute("aria-hidden", "true");
  const card = document.createElement("section");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  card.setAttribute("aria-label", "Bench tour");
  document.body.append(ring, card);
  active = { steps, i: 0, card, ring, timer: 0, onEnd };
  show(0);
  // follow the target as panels open and the window changes, and notice
  // when a waiting step has been done
  active.timer = window.setInterval(tick, 200);
}

export function endTour(finished: boolean): void {
  if (!active) return;
  const { card, ring, timer, onEnd } = active;
  clearInterval(timer);
  card.remove();
  ring.remove();
  active = null;
  markTourSeen();
  if (finished) onEnd();
}

function show(i: number): void {
  if (!active) return;
  if (i >= active.steps.length) return endTour(true);
  active.i = i;
  const step = active.steps[i];
  step.enter?.();
  const { card } = active;
  const last = i === active.steps.length - 1;
  card.innerHTML = "";
  const count = document.createElement("p");
  count.className = "tour-count";
  count.textContent = `${i + 1} of ${active.steps.length}`;
  const h = document.createElement("h2");
  h.textContent = step.title;
  const p = document.createElement("p");
  p.className = "tour-body";
  p.textContent = step.body;
  const row = document.createElement("div");
  row.className = "tour-row";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "tour-skip";
  skip.textContent = "Skip tour";
  skip.addEventListener("click", () => endTour(false));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "primary";
  next.textContent = last ? "Finish" : step.done ? "Skip this step" : i === 0 ? "Show me" : "Next";
  if (step.done) next.classList.replace("primary", "tour-quiet");
  next.addEventListener("click", () => show(i + 1));
  row.append(skip, next);
  const wait = document.createElement("p");
  wait.className = "tour-wait";
  wait.textContent = step.done ? "Waiting for you to try it…" : "";
  card.append(count, h, p, wait, row);
  place();
  if (!step.done) next.focus({ preventScroll: true });
}

function tick(): void {
  if (!active) return;
  const step = active.steps[active.i];
  if (step.done?.()) {
    show(active.i + 1);
    return;
  }
  place();
}

// The card sits beside what it points at (below if there is room, else
// above), or across the bottom on a phone; the ring outlines the target.
function place(): void {
  if (!active) return;
  const { card, ring, steps, i } = active;
  const el = steps[i].target();
  const r = el?.getBoundingClientRect();
  const phone = innerWidth < 760;
  card.classList.toggle("sheet", phone);
  if (!r || r.width === 0) {
    ring.hidden = true;
    card.classList.add("centre");
    card.style.left = card.style.top = "";
    return;
  }
  card.classList.remove("centre");
  ring.hidden = false;
  const pad = 6;
  ring.style.left = `${r.left - pad}px`;
  ring.style.top = `${r.top - pad}px`;
  ring.style.width = `${r.width + pad * 2}px`;
  ring.style.height = `${r.height + pad * 2}px`;
  if (phone) {
    card.style.left = card.style.top = "";
    return;
  }
  const cw = card.offsetWidth, ch = card.offsetHeight;
  const tall = r.height > innerHeight * 0.5;
  const wide = r.width > innerWidth * 0.5;
  let top: number, left: number;
  if (tall && !wide) {
    // a tall, narrow panel: beside it, on whichever side has room
    top = r.top;
    left = r.left - cw - 16 >= 12 ? r.left - cw - 16 : r.right + 16;
  } else if (tall) {
    // the 3D view, filling the screen: inside its top-left corner
    top = r.top + 16;
    left = r.left + 16;
  } else {
    top = r.bottom + 14;
    if (top + ch > innerHeight - 12) top = Math.max(12, r.top - ch - 14);
    left = r.left + r.width / 2 - cw / 2;
  }
  top = Math.min(Math.max(12, top), innerHeight - ch - 12);
  left = Math.min(Math.max(12, left), innerWidth - cw - 12);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

addEventListener("keydown", (e) => {
  if (active && e.key === "Escape") endTour(false);
});

// ---------- tips ----------
// Hover (or keyboard focus) on a command and, after a moment, a card says
// what it does and its key. Touch screens skip them; the tour covers those.

export function installTips(root: ParentNode = document): void {
  const tip = document.createElement("div");
  tip.className = "tip-card";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  let timer = 0;
  const open = (el: HTMLElement) => {
    const [title, text, key] = (el.dataset.tip ?? "").split("|");
    tip.innerHTML = "";
    const h = document.createElement("strong");
    h.textContent = title;
    if (key) {
      const k = document.createElement("kbd");
      k.textContent = key;
      h.append(k);
    }
    const p = document.createElement("span");
    p.textContent = text;
    tip.append(h, p);
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${r.bottom + 8}px`;
  };
  const close = () => {
    clearTimeout(timer);
    tip.hidden = true;
  };
  for (const el of root.querySelectorAll<HTMLElement>("[data-tip]")) {
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || active) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => open(el), 450);
    });
    el.addEventListener("pointerleave", close);
    el.addEventListener("pointerdown", close);
    el.addEventListener("focus", () => {
      if (el.matches(":focus-visible") && !active) open(el);
    });
    el.addEventListener("blur", close);
  }
}

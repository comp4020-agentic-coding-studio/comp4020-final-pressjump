// The home page hero: a CAD workspace with a real part in it, and pretend
// people working on it.
//
// The part is built from a timeline (shared/bracket.ts) by the same
// shared/evaluate.ts the editor and the STL export use, so what the page shows
// is a part Bench can make. That takes seconds, so `pnpm build` does it once
// per height and the page loads the mesh: the part is up as soon as the page.
// When Ana types a new height, the part is rebuilt to that height and the
// dimension on the model says so; nothing shows a number the model lacks.
//
// Each pretend person runs a little script: move somewhere, click, drag
// something, let go. Everything runs on one clock that stops while the hero
// is off screen, so nobody's script races ahead while you aren't looking.
// Loaded as its own bundle so the rest of the page never waits for three.js.
//
// Kept cheap on purpose. Layout is measured only on resize, never in a frame,
// so moving the cursors never forces the browser to lay the page out again.
// The scene is drawn only when something in it changed, with a light
// material, and at a lower resolution if frames start running long.

import * as THREE from "three";
import { bracketMeshUrl, unpackBracket } from "../shared/bracket.ts";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

const hero = $(".ws");
const host = $("#hero-3d");
const copy = $(".hero-copy");
const side = $(".ws-side");
const dimTag = $("#dim");
const heightField = $("#typed-height");
const heightBox = heightField.closest<HTMLElement>(".field")!;
const holdTag = $("#held");
const toastEl = $("#toast");

// Where things are, measured on resize and never in a frame: reading layout
// right after moving a cursor makes the browser lay the page out again.
const box_ = { heroW: 0, heroH: 0, hostX: 0, hostY: 0, hostW: 1, hostH: 1 };
function measure(): void {
  const hr = hero.getBoundingClientRect(), r = host.getBoundingClientRect();
  box_.heroW = hr.width;
  box_.heroH = hr.height;
  box_.hostX = r.left - hr.left;
  box_.hostY = r.top - hr.top;
  box_.hostW = r.width || 1;
  box_.hostH = r.height || 1;
}
measure();

// ---------------------------------------------------------------- the part

type PartMesh = { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry };
const meshes = new Map<number, Promise<PartMesh>>();
function meshFor(h: number): Promise<PartMesh> {
  let m = meshes.get(h);
  if (!m) {
    m = fetch(bracketMeshUrl(h))
      .then((res) => {
        if (!res.ok) throw new Error(`the bracket at ${h} mm did not load: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        const mesh = unpackBracket(buf);
        const solid = new THREE.BufferGeometry();
        solid.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
        solid.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
        solid.setIndex(new THREE.BufferAttribute(mesh.index, 1));
        const edges = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
        return { solid, edges };
      });
    meshes.set(h, m);
  }
  return m;
}

// ---------------------------------------------------------------- the scene

type Scene3D = {
  project: (local: THREE.Vector3) => { x: number; y: number };
  render: (ms: number) => void;
  warm: () => void;
  setHeight: (h: number) => void;
  orbit: (yaw: number) => void;
  yaw: () => number;
  draft: THREE.Group;
  draftState: (s: "hidden" | "draft" | "placed", opacity?: number) => void;
  spacer: THREE.Group;
  holdSpacer: (held: boolean) => void;
};

const PART = dark ? 0x8c9bb0 : 0x9fb3cf;
const EDGE = dark ? 0x0b1220 : 0x172b4d;
const BG = dark ? 0x22272b : 0xf4f6fa;
const MIA = new THREE.Color("#8e4ec6");
const SAM = new THREE.Color("#0091a8");

let uprightH = 70;

function makeScene(): Scene3D | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    host.classList.add("no-gl");
    return null;
  }
  // the canvas covers the whole hero, so pixels are the cost: 1.5x at most,
  // dropping to 1x if frames run long (see `adapt` below)
  let ratio = Math.min(devicePixelRatio, 1.5);
  renderer.setPixelRatio(ratio);
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "An angle bracket, 140 millimetres wide, being worked on by several people");
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.Fog(BG, 600, 1600);
  scene.fog = fog;
  // plain lights and a Lambert material: flat, like the page, and a fraction
  // of the per-pixel work of a lit metal
  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x3a4250 : 0x9aa3b0, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(120, 260, 160);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-220, 80, -120);
  scene.add(sun, fill);

  const camera = new THREE.PerspectiveCamera(30, 1, 1, 6000);
  const turntable = new THREE.Group();
  scene.add(turntable);

  const solidMat = () =>
    new THREE.MeshLambertMaterial({ color: PART, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

  // empty until its mesh arrives, which is moments after the page
  const part = new THREE.Mesh(new THREE.BufferGeometry(), solidMat());
  const partEdges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: EDGE }));
  turntable.add(part, partEdges);
  function show(h: number): void {
    meshFor(h).then(
      (g) => {
        if (h !== uprightH) return; // retyped again while it loaded
        part.geometry = g.solid;
        partEdges.geometry = g.edges;
        dirty = true;
      },
      (e) => console.warn(e),
    );
  }
  show(uprightH);

  // a workshop floor of 50 mm squares, running out into the fog
  const floor = new THREE.GridHelper(2000, 40, dark ? 0x3a4352 : 0xd3d9e2, dark ? 0x3a4352 : 0xd3d9e2);
  floor.position.y = -0.2;
  turntable.add(floor);

  // the upright's height dimension: a line up its side with end ticks
  const dimLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: EDGE }));
  turntable.add(dimLine);
  function drawDim(h: number): void {
    const x = 82, z = -35, y0 = 10, y1 = 10 + h;
    dimLine.geometry.dispose();
    dimLine.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z),
      new THREE.Vector3(72, y0, z), new THREE.Vector3(x + 5, y0, z),
      new THREE.Vector3(72, y1, z), new THREE.Vector3(x + 5, y1, z),
    ]);
  }
  drawDim(uprightH);

  // Mia's cylinder: a see-through draft while she drags, a body once placed.
  const draftGeo = new THREE.CylinderGeometry(12, 12, 28, 48).translate(0, 14, 0);
  const draftMat = solidMat();
  const draftLines = new THREE.LineBasicMaterial({ color: MIA });
  const draft = new THREE.Group();
  draft.add(new THREE.Mesh(draftGeo, draftMat), new THREE.LineSegments(new THREE.EdgesGeometry(draftGeo, 30), draftLines));
  draft.visible = false;
  turntable.add(draft);

  // Sam's spacer block, standing on the grid beside the bracket.
  const spacerGeo = new THREE.BoxGeometry(30, 30, 30).translate(0, 15, 0);
  const spacerMat = solidMat();
  const spacerLines = new THREE.LineBasicMaterial({ color: EDGE });
  const spacer = new THREE.Group();
  spacer.add(new THREE.Mesh(spacerGeo, spacerMat), new THREE.LineSegments(new THREE.EdgesGeometry(spacerGeo), spacerLines));
  spacer.position.set(118, 0, 45);
  turntable.add(spacer);

  let yaw = 0.3, shownYaw = 0.3, tx = 0, dirty = true;

  // Frame the part in the open floor beside the copy (or below it, on a
  // phone) by shifting the view rather than the model.
  function size(): void {
    measure();
    const w = box_.hostW, h = box_.hostH;
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h, false);
    const hr = host.getBoundingClientRect(), cr = copy.getBoundingClientRect();
    const narrow = w < 720;
    const sideLeft = side.offsetParent ? side.getBoundingClientRect().left - hr.left : w;
    const left = narrow ? 0 : cr.right - hr.left;
    const top = narrow ? cr.bottom - hr.top : 0;
    const fx = narrow ? w / 2 : (left + sideLeft) / 2;
    const fy = narrow ? (top + h) / 2 : h * 0.52;
    const room = narrow ? Math.min(w, h - top) : Math.max(sideLeft - left, 280);
    const dist = THREE.MathUtils.clamp(((narrow ? 600 : 400) * h) / room, 340, 2600);
    camera.aspect = w / h;
    camera.setViewOffset(w, h, w / 2 - fx, h / 2 - fy, w, h);
    camera.position.set(dist * 0.62, dist * 0.5, dist * 0.68);
    camera.lookAt(10, 35, 0);
    camera.updateProjectionMatrix();
    // the floor fades out a little way past the part, so it never reads as
    // a ruled sheet running to the horizon
    fog.near = dist * 0.9;
    fog.far = dist * 1.7;
    dirty = true;
  }
  new ResizeObserver(size).observe(host);
  new ResizeObserver(size).observe(copy);
  size();

  let heroLeft = 0;
  hero.addEventListener("pointerenter", () => { heroLeft = hero.getBoundingClientRect().left; });
  hero.addEventListener("pointermove", (e) => {
    tx = ((e.clientX - heroLeft) / box_.heroW - 0.5) * 0.25;
  }, { passive: true });
  hero.addEventListener("pointerleave", () => { tx = 0; });

  const v = new THREE.Vector3();
  const dimAt = new THREE.Vector3();
  const project = (local: THREE.Vector3) => {
    v.copy(local);
    turntable.localToWorld(v).project(camera);
    return { x: box_.hostX + ((v.x + 1) / 2) * box_.hostW, y: box_.hostY + ((1 - v.y) / 2) * box_.hostH };
  };

  // Only draw when something in the scene moved. `last` is what was drawn.
  const drawn = { yaw: NaN, dx: NaN, dy: NaN, dz: NaN, dv: false, op: NaN, sz: NaN, sc: NaN, h: NaN };
  function changed(): boolean {
    const d = draft.position, c = drawn;
    const now = { yaw: shownYaw, dx: d.x, dy: d.y, dz: d.z, dv: draft.visible, op: draftMat.opacity, sz: spacer.position.z, sc: spacerMat.color.getHex(), h: uprightH };
    const diff = dirty || Math.abs(now.yaw - c.yaw) > 1e-5 || now.dx !== c.dx || now.dy !== c.dy || now.dz !== c.dz ||
      now.dv !== c.dv || now.op !== c.op || now.sz !== c.sz || now.sc !== c.sc || now.h !== c.h;
    if (diff) Object.assign(drawn, now);
    dirty = false;
    return diff;
  }

  // If frames run long, draw fewer pixels. Checked over a second at a time,
  // and only ever downward, so it can't flip back and forth.
  let slow = 0, frames = 0;
  function adapt(ms: number): void {
    frames++;
    if (ms > 22) slow++;
    if (frames < 60) return;
    if (slow > 20 && ratio > 1) {
      ratio = Math.max(1, ratio - 0.25);
      renderer.setPixelRatio(ratio);
      renderer.setSize(box_.hostW, box_.hostH, false);
      dirty = true;
    }
    frames = slow = 0;
  }
  return {
    // a point in the part's own frame, in pixels from the hero's corner
    project,
    render(ms: number) {
      shownYaw += (yaw + tx - shownYaw) * 0.1;
      if (!changed()) return;
      turntable.rotation.y = shownYaw;
      turntable.updateMatrixWorld();
      renderer.render(scene, camera);
      adapt(ms);
      const p = project(dimAt.set(88, 10 + uprightH / 2, -35));
      dimTag.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - 10).toFixed(1)}px)`;
    },
    // load the other height ahead of time, so Ana's edit shows at once
    warm() {
      void meshFor(95);
    },
    setHeight(h) {
      uprightH = h;
      show(h);
      drawDim(h);
      dimTag.textContent = `${h}.000`;
    },
    orbit(y) { yaw = y; },
    yaw: () => yaw,
    draft,
    draftState(s, opacity = 1) {
      draft.visible = s !== "hidden";
      const placed = s === "placed";
      draftMat.color.set(placed ? PART : MIA);
      draftMat.transparent = true;
      draftMat.opacity = (placed ? 1 : 0.5) * opacity;
      draftMat.depthWrite = placed && opacity === 1;
      draftLines.color.set(placed ? EDGE : MIA);
      draftLines.transparent = true;
      draftLines.opacity = opacity;
    },
    spacer,
    holdSpacer(held) {
      spacerLines.color.set(held ? SAM : EDGE);
      spacerMat.color.set(held ? new THREE.Color(PART).lerp(SAM, 0.45) : PART);
    },
  };
}

// ---------------------------------------------------------------- the clock

// Jobs run once a frame on a clock that only moves while the hero is on
// screen; a job returns true when it is done.
let clock = 0;
const jobs = new Set<(t: number) => boolean>();
const job = (fn: (t: number) => boolean) => new Promise<void>((done) => {
  jobs.add((t: number) => (fn(t) ? (done(), true) : false));
});
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
function during(ms: number, fn: (k: number) => void): Promise<void> {
  let t0 = -1;
  return job((t) => {
    if (t0 < 0) t0 = t;
    const k = Math.min(1, (t - t0) / ms);
    fn(k);
    return k >= 1;
  });
}
const wait = (ms: number) => during(ms, () => {});
const lerp = THREE.MathUtils.lerp;

// ---------------------------------------------------------------- the room

let toastTimer = 0;
function notice(colour: string, text: string): void {
  toastEl.style.setProperty("--who", colour);
  toastEl.querySelector("span")!.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- people

const POINTER =
  '<svg viewBox="0 0 16 20" width="18" height="22" aria-hidden="true"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.6 17.8 L7.7 11.5 L13 11.5 Z" fill="currentColor" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';

type Pt = { x: number; y: number };
class Person {
  el: HTMLElement;
  tag: HTMLSpanElement;
  name: string;
  colour: string;
  x: number;
  y: number;
  constructor(name: string, fx: number, fy: number) {
    this.el = hero.querySelector<HTMLElement>(`:scope > [data-cursor][data-name="${name}"]`)!;
    this.name = name;
    this.colour = this.el.dataset.colour ?? "#3e63dd";
    this.el.style.setProperty("--who", this.colour);
    this.el.insertAdjacentHTML("afterbegin", POINTER);
    this.tag = this.el.querySelector("span")!;
    this.tagW = this.tag.offsetWidth;
    this.x = box_.heroW * fx;
    this.y = box_.heroH * fy;
    this.place();
  }
  tagW = 0;
  get shown(): boolean {
    return this.el.offsetParent !== null;
  }
  place(): void {
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0)`;
    // near the right edge the name tag goes on the pointer's left instead
    const flip = this.x + this.tagW + 24 > box_.heroW;
    if (flip !== this.flipped) this.el.classList.toggle("flip", (this.flipped = flip));
  }
  at(p: Pt): void {
    this.x = p.x;
    this.y = p.y;
    this.place();
  }
  flipped = false;
  say(doing = ""): void {
    const text = doing ? `${this.name} · ${doing}` : this.name;
    if (text === this.tag.textContent) return;
    this.tag.textContent = text;
    this.tagW = this.tag.offsetWidth; // once per change of words, not per frame
  }
  moveTo(target: () => Pt, ms = 900): Promise<void> {
    const fx = this.x, fy = this.y;
    return during(ms, (k) => {
      const p = target(), e = ease(k);
      this.at({ x: fx + (p.x - fx) * e, y: fy + (p.y - fy) * e });
    });
  }
  async click(): Promise<void> {
    // restart the ping without a forced reflow: drop it, add it next frame
    this.el.classList.remove("click");
    this.el.classList.add("down");
    await wait(16);
    this.el.classList.add("click");
    await wait(160);
    this.el.classList.remove("down");
  }
  press(on: boolean): void {
    this.el.classList.toggle("down", on);
  }
}

// a point on an element, in the hero's pixels, measured once when first
// asked for (the page doesn't move under a cursor mid-glide)
function on(el: Element, fx = 0.5, fy = 0.5): () => Pt {
  let p: Pt | null = null;
  return () => {
    if (!p) {
      const r = el.getBoundingClientRect(), a = hero.getBoundingClientRect();
      p = { x: r.left - a.left + r.width * fx, y: r.top - a.top + r.height * fy };
    }
    return p;
  };
}
const frac = (fx: number, fy: number) => () => ({ x: box_.heroW * fx, y: box_.heroH * fy });

// ---------------------------------------------------------------- scripts

function run(s: Scene3D | null): void {
  const mia = new Person("Mia", 0.62, 0.3);
  const ana = new Person("Ana", 0.8, 0.7);
  const sam = new Person("Sam", 0.5, 0.8);
  const leo = new Person("Leo", 0.42, 0.2);
  const priya = new Person("Priya", 0.3, 0.86);

  const v = new THREE.Vector3();
  const lift = new THREE.Vector3();
  const up = (y: number) => lift.set(0, y, 0);
  const pt = (x: number, y: number, z: number) => () => s!.project(v.set(x, y, z));
  // resting spots are places on the model, so they stay beside the part on
  // any screen rather than drifting over the copy
  const miaRest = pt(70, 80, 60), samRest = pt(40, 0, 95), anaRest = (h: number) => pt(-30, 10 + h + 8, -40);
  if (s) {
    mia.at(miaRest());
    sam.at(samRest());
    ana.at(anaRest(70)());
  }

  if (still || !s) {
    if (s) {
      s.draft.position.set(30, 10, 20);
      s.draftState("draft");
      mia.say("placing a cylinder");
      requestAnimationFrame(() => {
        mia.at(pt(30, 38, 20)());
        sam.at(pt(118, 30, 45)());
        ana.at(pt(-30, 86, -40)());
      });
    }
    return;
  }

  // Mia pulls a cylinder out of thin air, drags it into place, places it,
  // admires it, then thinks better of it and deletes it.
  (async () => {
    const from = new THREE.Vector3(30, 90, 95), to = new THREE.Vector3(30, 10, 20);
    const top = () => s.project(v.copy(s.draft.position).add(up(28)));
    await wait(400);
    for (;;) {
      mia.say();
      s.draft.position.copy(from);
      await mia.moveTo(top, 1200);
      await mia.click();
      s.draftState("draft");
      mia.say("placing a cylinder");
      await wait(300);
      mia.press(true);
      await during(2600, (k) => {
        s.draft.position.lerpVectors(from, to, ease(k));
        mia.at(top());
      });
      mia.press(false);
      await mia.click();
      s.draftState("placed");
      notice(mia.colour, "Mia added Cylinder");
      mia.say();
      await mia.moveTo(() => ({ x: top().x + 70, y: top().y - 50 }), 900);
      await wait(2200);
      mia.say("deleting Cylinder");
      await mia.moveTo(top, 700);
      await mia.click();
      await during(450, (k) => s.draftState("placed", 1 - k));
      s.draftState("hidden");
      notice(mia.colour, "Mia deleted Cylinder");
      mia.say();
      await mia.moveTo(miaRest, 1300);
      await wait(1600);
    }
  })();

  // Ana types the upright's height; the part is rebuilt to match. Where
  // the properties panel is hidden (narrow screens) she edits on the model.
  (async () => {
    let h = 70;
    await wait(2200);
    for (;;) {
      ana.say();
      const panel = heightBox.offsetParent !== null;
      await ana.moveTo(panel ? on(heightBox, 0.35, 0.6) : pt(-30, 10 + h - 8, -40), 1300);
      await ana.click();
      heightBox.classList.add("focus");
      holdTag.hidden = false;
      dimTag.classList.add("hot");
      ana.say("editing Upright");
      h = h === 70 ? 95 : 70;
      const text = `${h}.000`;
      heightField.textContent = "";
      heightField.classList.add("typing");
      for (let i = 1; i <= text.length; i++) {
        await wait(110);
        heightField.textContent = text.slice(0, i);
      }
      await wait(350);
      heightField.classList.remove("typing");
      s.setHeight(h);
      notice(ana.colour, `Ana set Upright height to ${text} mm`);
      await wait(600);
      heightBox.classList.remove("focus");
      holdTag.hidden = true;
      dimTag.classList.remove("hot");
      ana.say();
      await ana.moveTo(anaRest(h), 1300);
      await wait(3600);
    }
  })();

  // Sam joins, grabs the spacer and slides it along the bracket, then back.
  (async () => {
    let z0 = 45, z1 = 0;
    const top = () => s.project(v.copy(s.spacer.position).add(up(30)));
    await wait(5200);
    notice(sam.colour, "Sam joined the design");
    for (;;) {
      sam.say();
      await sam.moveTo(top, 1200);
      await sam.click();
      s.holdSpacer(true);
      sam.say("moving Spacer");
      sam.press(true);
      await during(2400, (k) => {
        s.spacer.position.z = lerp(z0, z1, ease(k));
        sam.at(top());
      });
      sam.press(false);
      s.holdSpacer(false);
      sam.say();
      [z0, z1] = [z1, z0];
      await sam.moveTo(samRest, 1300);
      await wait(3000);
    }
  })();

  // Leo selects "together", then orbits the view by dragging empty floor.
  (async () => {
    // the headline shown: a returning guest gets their own
    const word = [...document.querySelectorAll<HTMLElement>(".hero h1 em")].find((e) => e.getClientRects().length) ?? $(".hero h1 em");
    let dir = 1;
    await wait(900);
    for (;;) {
      if (!leo.shown) { await wait(1000); continue; }
      leo.say();
      await leo.moveTo(on(word, 0.02, 0.55), 1400);
      leo.press(true);
      word.classList.add("selecting");
      leo.say("selecting");
      const a = on(word, 0.02, 0.55)(), b = on(word, 0.98, 0.55)();
      await during(900, (k) => {
        const e = ease(k);
        word.style.setProperty("--sel", `${Math.round(e * 100)}%`);
        leo.at({ x: lerp(a.x, b.x, e), y: a.y });
      });
      leo.press(false);
      await wait(1800);
      word.classList.remove("selecting");
      word.style.removeProperty("--sel");
      leo.say("orbiting");
      const start = frac(0.5, 0.78)();
      await leo.moveTo(() => start, 1300);
      leo.press(true);
      const y0 = s.yaw();
      await during(2200, (k) => {
        const e = ease(k);
        s.orbit(y0 + dir * 0.7 * e);
        leo.at({ x: start.x + dir * 180 * e, y: start.y - 20 * Math.sin(Math.PI * e) });
      });
      leo.press(false);
      dir = -dir;
      leo.say();
      await leo.moveTo(frac(0.44, 0.16), 1500);
      await wait(2600);
    }
  })();

  // Priya ticks off the checklist, and the last tick exports an STL.
  (async () => {
    const ticks = [...hero.querySelectorAll<HTMLElement>(".ticks li")];
    await wait(3600);
    for (;;) {
      if (!priya.shown) { await wait(1000); continue; }
      priya.say("checking");
      for (const t of ticks) {
        await priya.moveTo(on(t, 0, 0.5), 650);
        await priya.click();
        t.classList.remove("ticked");
        await wait(16);
        t.classList.add("ticked");
        await wait(250);
      }
      notice(priya.colour, "Priya exported Bracket.stl");
      await wait(900);
      ticks.forEach((t) => t.classList.remove("ticked"));
      priya.say();
      await priya.moveTo(frac(0.3, 0.86), 1600);
      await wait(4200);
    }
  })();
}

// ---------------------------------------------------------------- go

const scene = makeScene();
run(scene);
// the second height's mesh, loaded once the page has settled
const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 800));
if (scene) idle(() => scene.warm());
new ResizeObserver(measure).observe(hero);

let visible = true;
new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(hero);
let last = performance.now();
function frame(now: number): void {
  // a frame's timestamp can be older than `last` was when it was read, so
  // never let the clock run backwards
  const dt = Math.max(0, Math.min(50, now - last));
  last = now;
  if (visible && !document.hidden) {
    clock += dt;
    for (const j of [...jobs]) if (j(clock)) jobs.delete(j);
    scene?.render(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// The 3D below the hero: small scenes in the sections (ready-made parts
// turning, two gears meshing, a box rising, bolts dropping into a plate, a
// bracket being printed) and the pictures of designs in the community gallery
// and in your projects.
//
// Everything here is built by thumb-worker.ts from real features, through
// shared/evaluate.ts, so the parts shown are parts Bench makes, at the numbers
// the captions give. One WebGL renderer, off the page, draws every scene and
// every thumbnail and copies the pixels into each one's own canvas or
// picture: browsers allow only a few WebGL contexts, and one is cheapest.
// Scenes are drawn only while on screen, at most 30 times a second, and once,
// still, for anyone who asks for reduced motion.

import * as THREE from "three";
import type { Feature, Stored, Vec3 } from "../shared/model.ts";
import { PARTS, faceFrame, placeSteps } from "../shared/parts.ts";
import { pack } from "../shared/protocol.ts";
import type { Built } from "./thumb-worker.ts";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const EDGE = dark ? 0x0b1220 : 0x172b4d;
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- one renderer

let renderer: THREE.WebGLRenderer | null | undefined;
function gl(): THREE.WebGLRenderer | null {
  if (renderer !== undefined) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.setSize(8, 8, false);
  } catch {
    renderer = null;
  }
  return renderer;
}

// Draw a scene at w×h device pixels into the bottom-left of the shared
// canvas, and hand back that canvas and where the picture is in it.
function draw(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): { src: HTMLCanvasElement; y: number } | null {
  const r = gl();
  if (!r) return null;
  const size = r.getSize(new THREE.Vector2());
  if (size.x < w || size.y < h) r.setSize(Math.max(size.x, w), Math.max(size.y, h), false);
  const H = r.domElement.height;
  r.setViewport(0, 0, w, h);
  r.setScissor(0, 0, w, h);
  r.setScissorTest(true);
  r.clear();
  r.render(scene, camera);
  r.setScissorTest(false);
  return { src: r.domElement, y: H - h };
}

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x3a4250 : 0x8d96a6, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.6, 1, 0.8);
  scene.add(sun);
  const back = new THREE.DirectionalLight(0xffffff, 0.5);
  back.position.set(-0.8, 0.3, -0.6);
  scene.add(back);
}

// ------------------------------------------------------------- building bodies

// A worker that builds bodies, one job at a time. With a time limit, a job
// that runs over is stopped (by ending the worker; a fresh one starts for the
// next job) so one design whose geometry is slow to compute never holds up
// the rest. The scenes and the thumbnails each have their own.
function builder(limitMs = 0): (features: Stored[]) => Promise<Built[]> {
  let worker: Worker | null = null;
  let jobs = 0;
  const waiting = new Map<number, { ok: (s: Built[]) => void; fail: (e: Error) => void; timer: number }>();
  const start = (): Worker => {
    const w = new Worker("/build/thumb-worker.js", { type: "module" });
    w.onmessage = (e: MessageEvent<{ job: number; solids?: Built[]; error?: string }>) => {
      const job = waiting.get(e.data.job);
      waiting.delete(e.data.job);
      if (!job) return;
      clearTimeout(job.timer);
      if (e.data.solids) job.ok(e.data.solids);
      else job.fail(new Error(e.data.error ?? "could not build"));
    };
    return w;
  };
  return (features) => {
    worker ??= start();
    const job = ++jobs;
    return new Promise((ok, fail) => {
      const timer = limitMs
        ? window.setTimeout(() => {
            worker?.terminate();
            worker = null;
            for (const w of waiting.values()) {
              clearTimeout(w.timer);
              w.fail(new Error("too slow to draw"));
            }
            waiting.clear();
          }, limitMs)
        : 0;
      waiting.set(job, { ok, fail, timer });
      worker!.postMessage({ job, features: features.map((f) => pack(f)) });
    });
  };
}
const build = builder();
const buildThumb = builder(20_000);

type Look = { colour?: string; clip?: THREE.Plane[]; edges?: boolean };
function group(solids: Built[], look: Look = {}): THREE.Group {
  const g = new THREE.Group();
  for (const s of solids) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(s.position, 3));
    if (s.normal) geo.setAttribute("normal", new THREE.BufferAttribute(s.normal, 3));
    if (s.index) geo.setIndex(new THREE.BufferAttribute(s.index, 1));
    if (!s.normal) geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: look.colour ?? s.colour,
      metalness: 0.15,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      clippingPlanes: look.clip ?? null,
      side: look.clip ? THREE.DoubleSide : THREE.FrontSide,
    });
    g.add(new THREE.Mesh(geo, mat));
    if (look.edges !== false) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(s.edges, 3));
      g.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55, clippingPlanes: look.clip ?? null })));
    }
  }
  return g;
}

// A ready-made part's features, as the ribbon would place it: on the ground
// at `at`, its combines pointing at the right bodies.
let seq = 0;
function part(id: string, values: Record<string, number> = {}, at: Vec3 = [0, 0, 0], normal = UP): Stored[] {
  const def = PARTS.find((p) => p.id === id)!;
  const v = { ...def.defaults, ...values };
  const ids = new Map<string, string>();
  const out: Stored[] = [];
  for (const { ref, f } of placeSteps(def.build(v), faceFrame(normal, def.into, 0), new THREE.Vector3(...at))) {
    const sid = `s${++seq}`;
    ids.set(ref, sid);
    const real: Feature = f.kind === "combine" ? { ...f, target: ids.get(f.target)!, tools: f.tools.map((t) => ids.get(t)!) } : f;
    out.push({ ...real, id: sid, v: 1, by: "showcase", seq } as Stored);
  }
  return out;
}

const bodyOf = (f: Feature): Stored[] => [{ ...f, id: `s${++seq}`, v: 1, by: "showcase", seq } as Stored];

// Frame what is in `obj` from direction `dir`, filling `fill` of the view.
function frame(camera: THREE.PerspectiveCamera, obj: THREE.Object3D, dir: THREE.Vector3, fill = 0.8): void {
  const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
  const dist = sphere.radius / Math.sin(fit / 2) / fill;
  camera.position.copy(sphere.center).addScaledVector(dir.clone().normalize(), dist);
  camera.near = dist / 50;
  camera.far = dist * 10;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
}

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));

// ------------------------------------------------------------- the scenes

type Live = {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  // move things for time t (seconds); false until there is something to draw
  tick: (t: number) => boolean;
  // set the camera for the canvas's shape
  aim: () => void;
  shown: boolean;
};

const SAM = "#0091a8", ANA = "#e5484d", MIA = "#8e4ec6", PRIYA = "#3e63dd";

function partsScene(live: Live): void {
  const caption = document.getElementById("parts-caption");
  const shows: { features: Stored[]; text: string }[] = [
    { features: part("gear", { n: 24, m: 1.5, b: 6, bore: 8 }), text: "Spur gear · 24 teeth · module 1.5 mm" },
    { features: [...part("bolt", { d: 8, L: 30, s: 13, k: 5.3 }), ...part("nut", { d: 8, s: 13, m: 6.8 }, [0, 8, 0])], text: "Hex bolt M8 × 30 with its nut" },
    { features: part("bracket", { w: 40, a: 40, t: 4, hole: 5.3 }), text: "L-bracket · 40 × 40 × 4 mm" },
    { features: part("pulley", { D: 50, w: 12, g: 3.5, bore: 8 }), text: "Pulley · Ø50 mm · 3.5 mm groove" },
  ];
  const groups: (THREE.Group | null)[] = shows.map(() => null);
  const holder = new THREE.Group();
  live.scene.add(holder);
  shows.forEach((s, i) =>
    build(s.features).then((b) => {
      const g = group(b);
      // stand it in the middle
      const box = new THREE.Box3().setFromObject(g);
      const c = box.getCenter(new THREE.Vector3());
      g.position.set(-c.x, -c.y, -c.z);
      const wrap = new THREE.Group();
      wrap.add(g);
      groups[i] = wrap;
    }),
  );
  let current = -1;
  const SHOW = 4.5;
  live.aim = () => {
    live.camera.position.set(0, 0, 1);
    const g = groups[Math.max(0, current)];
    if (g) frame(live.camera, g, new THREE.Vector3(1, 0.75, 1.3), 1.15);
  };
  live.tick = (t) => {
    const i = Math.floor(t / SHOW) % shows.length;
    if (!groups[i]) return current >= 0;
    if (i !== current) {
      holder.clear();
      holder.add(groups[i]!);
      current = i;
      if (caption) caption.textContent = shows[i].text;
      // framed at full size, not at the size it is growing in from
      holder.scale.setScalar(1);
      holder.rotation.set(0, 0, 0);
      holder.updateMatrixWorld(true);
      live.aim();
    }
    const k = (t % SHOW) / SHOW;
    // grow in, turn, shrink away
    const s = still ? 1 : Math.min(ease(clamp01(k * 6)), ease(clamp01((1 - k) * 8)));
    holder.scale.setScalar(Math.max(0.001, s));
    holder.rotation.y = t * 0.6;
    holder.rotation.x = 0.15;
    return true;
  };
}

function gearsScene(live: Live): void {
  // two gears of module 2, 20 and 12 teeth, 32 mm apart: they mesh
  const N1 = 20, N2 = 12, M = 2, C = (M * (N1 + N2)) / 2;
  const a = new THREE.Group(), b = new THREE.Group();
  a.position.x = -C / 2;
  b.position.x = C / 2;
  live.scene.add(a, b);
  let ready = 0;
  build(part("gear", { n: N1, m: M, b: 8, bore: 6 })).then((s) => { a.add(group(s, { colour: SAM })); ready++; live.aim(); });
  build(part("gear", { n: N2, m: M, b: 8, bore: 6 })).then((s) => { b.add(group(s, { colour: ANA })); ready++; live.aim(); });
  live.aim = () => frame(live.camera, live.scene, new THREE.Vector3(0.2, 1.1, 0.9), 0.85);
  // gear one's tooth points along +X; gear two turns half a tooth so a gap
  // faces it, and runs the other way, faster by the ratio
  const step2 = (Math.PI * 2) / N2;
  live.tick = (t) => {
    const w = 0.5;
    a.rotation.y = w * t;
    b.rotation.y = -w * t * (N1 / N2) + Math.PI - 0.75 * step2;
    return ready === 2;
  };
}

function startScene(live: Live): void {
  // a 60 × 40 box whose height is typed, 0 to 40 mm and back
  const holder = new THREE.Group();
  live.scene.add(holder);
  const grid = new THREE.GridHelper(160, 16, dark ? 0x4a5566 : 0xb6c2d4, dark ? 0x333c4a : 0xdde3ec);
  live.scene.add(grid);
  let ready = false;
  build(bodyOf({ name: "Box", colour: "#85b8ff", pos: [0, 0, 0], rot: [0, 0, 0], kind: "box", w: 60, h: 40, d: 40, fillet: 0, chamfer: 0 })).then((s) => {
    holder.add(group(s));
    ready = true;
  });
  live.aim = () => {
    live.camera.fov = 35;
    live.camera.position.set(110, 90, 130);
    live.camera.lookAt(0, 18, 0);
    live.camera.near = 1;
    live.camera.far = 2000;
    live.camera.updateProjectionMatrix();
  };
  live.tick = (t) => {
    const k = (t % 5) / 5;
    const h = still ? 1 : k < 0.45 ? ease(clamp01(k / 0.45)) : k < 0.85 ? 1 : 1 - ease(clamp01((k - 0.85) / 0.15));
    holder.scale.y = Math.max(0.02, h);
    grid.rotation.y = holder.rotation.y = still ? 0.3 : t * 0.15;
    return ready;
  };
}

function shareScene(live: Live): void {
  // a plate, and four people's bolts dropping into its holes
  const W = 100, D = 70, T = 6, INSET = 12, L = 14;
  const plate = new THREE.Group();
  live.scene.add(plate);
  const who = [SAM, ANA, MIA, PRIYA];
  const at: [number, number][] = [[-W / 2 + INSET, -D / 2 + INSET], [W / 2 - INSET, -D / 2 + INSET], [W / 2 - INSET, D / 2 - INSET], [-W / 2 + INSET, D / 2 - INSET]];
  const bolts = who.map(() => new THREE.Group());
  let ready = 0;
  // aimed again once the plate is there to frame
  build(part("plate", { w: W, d: D, t: T, hole: 6.4, inset: INSET })).then((s) => { plate.add(group(s)); ready++; live.aim(); });
  build(part("bolt", { d: 6, L, s: 10, k: 4 })).then((s) => {
    bolts.forEach((g, i) => {
      g.add(group(s, { colour: who[i] }));
      g.position.set(at[i][0], T - L, at[i][1]);
      live.scene.add(g);
    });
    ready++;
  });
  live.aim = () => frame(live.camera, plate.children.length ? plate : live.scene, new THREE.Vector3(0.9, 1.1, 1.2), 0.95);
  live.tick = (t) => {
    const k = (t % 6) / 6;
    bolts.forEach((g, i) => {
      // each drops in turn, settles, and they all lift off together at the end
      const start = 0.08 + i * 0.16;
      const fall = still ? 1 : ease(clamp01((k - start) / 0.14));
      const lift = still ? 0 : ease(clamp01((k - 0.9) / 0.1));
      g.position.y = T - L + 60 * (1 - fall) + 60 * lift;
      g.visible = still || (k >= start - 0.02 && lift < 0.98);
    });
    plate.rotation.y = 0;
    return ready === 2;
  };
}

function printScene(live: Live): void {
  // a bracket appearing layer by layer, as a printer lays it down
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const holder = new THREE.Group();
  live.scene.add(holder);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(3, 8, 16), new THREE.MeshStandardMaterial({ color: dark ? 0xdee4ea : 0x172b4d, roughness: 0.4 }));
  nozzle.rotation.x = Math.PI;
  live.scene.add(nozzle);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(90, 2, 90), new THREE.MeshStandardMaterial({ color: dark ? 0x38414a : 0xdde3ec, roughness: 0.8 }));
  bed.position.y = -1;
  live.scene.add(bed);
  let top = 1;
  let ready = false;
  build(part("bracket", { w: 50, a: 45, t: 5, hole: 6.4 })).then((s) => {
    const g = group(s, { clip: [plane], colour: "#0c66e4" });
    holder.add(g);
    holder.position.z = 12;
    top = new THREE.Box3().setFromObject(holder).max.y;
    ready = true;
  });
  live.aim = () => frame(live.camera, bed, new THREE.Vector3(1, 0.9, 1.2), 0.9);
  live.tick = (t) => {
    const k = (t % 6) / 6;
    const h = still ? 1 : clamp01(k / 0.8);
    plane.constant = top * h + 0.01;
    nozzle.visible = !still && h < 1;
    nozzle.position.set(Math.sin(t * 9) * 22, top * h + 5, 12 + Math.cos(t * 5.3) * 18);
    return ready;
  };
}

const SCENES: Record<string, (live: Live) => void> = { parts: partsScene, gears: gearsScene, start: startScene, share: shareScene, print: printScene };

const lives: Live[] = [];
const dpr = () => Math.min(devicePixelRatio || 1, 2);

function size(live: Live): void {
  const w = Math.max(1, Math.round(live.host.clientWidth * dpr()));
  const h = Math.max(1, Math.round(live.host.clientHeight * dpr()));
  if (live.canvas.width !== w || live.canvas.height !== h) {
    live.canvas.width = w;
    live.canvas.height = h;
  }
  live.camera.aspect = w / h;
  live.camera.updateProjectionMatrix();
  live.aim();
}

function paint(live: Live, t: number): void {
  if (!live.tick(t)) return;
  const { width: w, height: h } = live.canvas;
  const out = draw(live.scene, live.camera, w, h);
  if (!out) return;
  const ctx = live.canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(out.src, 0, out.y, w, h, 0, 0, w, h);
}

function startScenes(): void {
  if (!gl()) {
    for (const host of document.querySelectorAll<HTMLElement>(".scene3d")) host.classList.add("no-gl");
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const live = lives.find((l) => l.host === e.target);
      if (live) live.shown = e.isIntersecting;
    }
  }, { rootMargin: "100px" });
  const resized = new ResizeObserver((entries) => {
    for (const e of entries) {
      const live = lives.find((l) => l.host === e.target);
      if (live) {
        size(live);
        if (still) stillFrame(live);
      }
    }
  });
  for (const host of document.querySelectorAll<HTMLElement>(".scene3d[data-scene]")) {
    const make = SCENES[host.dataset.scene ?? ""];
    if (!make) continue;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    host.append(canvas);
    const scene = new THREE.Scene();
    lights(scene);
    const live: Live = { host, canvas, scene, camera: new THREE.PerspectiveCamera(30, 1, 1, 4000), tick: () => false, aim: () => {}, shown: false };
    make(live);
    lives.push(live);
    seen.observe(host);
    resized.observe(host);
  }
  if (still) return;
  const t0 = performance.now();
  let last = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (document.hidden || now - last < 33) return;
    last = now;
    const t = (now - t0) / 1000;
    for (const live of lives) if (live.shown) paint(live, t);
  };
  requestAnimationFrame(loop);
}

// with reduced motion: one frame, once the parts have been built
function stillFrame(live: Live, tries = 0): void {
  if (live.tick(2.2)) paint(live, 2.2);
  else if (tries < 40) setTimeout(() => stillFrame(live, tries + 1), 150);
}

// ------------------------------------------------------------- thumbnails

// A picture of each design, fetched by its view link and built from its own
// timeline. Kept in this browser by a fingerprint of the features, so a
// design that has not changed is never built twice, and one that has is.
const THUMB_W = 640, THUMB_H = 400;
const made = new Map<string, { key: string; url: string }>();
// when each design was last checked against the server, this visit
const checked = new Map<string, number>();
const busy = new Set<HTMLImageElement>();
const queue: HTMLImageElement[] = [];
let running = false;

function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${text.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

function cached(view: string): { key: string; url: string } | null {
  try {
    return JSON.parse(localStorage.getItem(`bench.thumb.${view}`) ?? "null");
  } catch {
    return null;
  }
}

function keep(view: string, entry: { key: string; url: string }): void {
  const key = `bench.thumb.${view}`;
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // full: make room by dropping the other pictures, then try once more
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("bench.thumb.") && k !== key) localStorage.removeItem(k);
      localStorage.setItem(key, JSON.stringify(entry));
    } catch {
      // drawn again next visit
    }
  }
}

async function picture(features: Stored[]): Promise<string> {
  const solids = await buildThumb(features);
  const scene = new THREE.Scene();
  lights(scene);
  const g = group(solids);
  scene.add(g);
  const camera = new THREE.PerspectiveCamera(30, THUMB_W / THUMB_H, 1, 10000);
  frame(camera, g, new THREE.Vector3(1, 0.8, 1.25), 0.95);
  const out = draw(scene, camera, THUMB_W, THUMB_H);
  if (!out) throw new Error("no WebGL");
  const c = document.createElement("canvas");
  c.width = THUMB_W;
  c.height = THUMB_H;
  c.getContext("2d")!.drawImage(out.src, 0, out.y, THUMB_W, THUMB_H, 0, 0, THUMB_W, THUMB_H);
  for (const o of g.children) {
    const m = o as THREE.Mesh;
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  const webp = c.toDataURL("image/webp", 0.82);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
}

async function fill(img: HTMLImageElement): Promise<void> {
  const view = img.dataset.thumb!;
  // checked a moment ago (the same design in the hero, the popup and the
  // gallery): what is kept is current
  const known = made.get(view);
  if (known && Date.now() - (checked.get(view) ?? 0) < 20_000) {
    if (!known.url) throw new Error("too slow to draw");
    show(img, known.url);
    return;
  }
  const res = await fetch(`/api/views/${encodeURIComponent(view)}`);
  if (!res.ok) {
    img.dataset.state = "gone";
    return;
  }
  const text = await res.text();
  const key = fingerprint(text);
  let entry = made.get(view);
  if (entry?.key !== key) entry = cached(view) ?? undefined;
  if (entry?.key !== key) {
    const { features } = JSON.parse(text) as { features: Stored[] };
    if (!features.length) {
      img.dataset.state = "empty";
      return;
    }
    let url = "";
    try {
      url = await picture(features);
    } catch (err) {
      // remembered, so this version of the design is not tried again
      keep(view, { key, url: "" });
      made.set(view, { key, url: "" });
      checked.set(view, Date.now());
      throw err;
    }
    entry = { key, url };
    keep(view, entry);
  }
  made.set(view, entry);
  checked.set(view, Date.now());
  if (!entry.url) throw new Error("too slow to draw");
  for (const other of document.querySelectorAll<HTMLImageElement>("img[data-thumb]")) if (other.dataset.thumb === view) show(other, entry.url);
}

function show(img: HTMLImageElement, url: string): void {
  if (img.getAttribute("src") !== url) img.src = url;
  img.dataset.state = "ready";
}

function want(img: HTMLImageElement): void {
  if (busy.has(img) || queue.includes(img)) return;
  // the picture kept from before shows at once; whether it is still current
  // is checked behind it
  const kept = made.get(img.dataset.thumb!) ?? cached(img.dataset.thumb!);
  if (kept?.url && !img.getAttribute("src")) show(img, kept.url);
  queue.push(img);
  pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length) {
    const img = queue.shift()!;
    if (!img.isConnected) continue;
    busy.add(img);
    try {
      await fill(img);
    } catch {
      // too slow or could not be built: say so on the card, not a blank
      for (const other of document.querySelectorAll<HTMLImageElement>("img[data-thumb]")) {
        if (other.dataset.thumb === img.dataset.thumb && other.dataset.state !== "ready") other.dataset.state = "failed";
      }
    }
    busy.delete(img);
    // let the page breathe between pictures
    await new Promise((r) => ("requestIdleCallback" in window ? requestIdleCallback(r, { timeout: 500 }) : setTimeout(r, 60)));
  }
  running = false;
}

function startThumbs(): void {
  if (!gl()) return;
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) want(e.target as HTMLImageElement);
  }, { rootMargin: "300px" });
  const watch = (root: ParentNode) => {
    for (const img of root.querySelectorAll<HTMLImageElement>("img[data-thumb]")) {
      near.unobserve(img);
      near.observe(img);
    }
  };
  watch(document);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof HTMLImageElement) {
        // a design that changed: draw it again when it is next in view
        if (r.target.dataset.state === "") {
          near.unobserve(r.target);
          near.observe(r.target);
        }
        continue;
      }
      for (const n of r.addedNodes) if (n instanceof HTMLElement) watch(n.matches("img[data-thumb]") ? n.parentElement ?? n : n);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-stamp"] });
}

// ------------------------------------------------------------- go

const later = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 400));
later(() => {
  startScenes();
  startThumbs();
});

// The wind preview: air flowing round the part, drawn as long streaks
// coloured by how fast the air is going, with the part itself painted by the
// air pressure on it: red where the air presses (the front, where it meets
// the wind), blue where it is pulled away (over curves, in the wake).
//
// The part is turned into a grid of cells (which cells are solid), the grid
// goes to a worker that simulates the air (wind-worker.ts), and the latest
// velocities it sends back carry a few thousand particles, each drawn with a
// short tail. The grid runs along the wind: its x axis is the wind's
// direction, so changing direction only changes how the grid sits in the
// world.
//
// It is a view, like hiding a body: kept in this browser, never sent, and it
// never changes the design. The note in the view says what it is and what it
// is not: coarse, uncalibrated, for seeing where air goes, never for numbers.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { MeshBVH } from "three-mesh-bvh";

export type WindDir = "+x" | "-x" | "+z" | "-z";

// the inlet speed the worker uses, in cells per step
const U = 0.08;
// points in a streak's tail; one is laid every other frame, so a streak
// shows about a second of the air's path
const TAIL = 36;

// One spectral scale for both, the way flow software draws it: blue for the
// least, through cyan, green and yellow, to red for the most. Its ends stop
// short of near-black, which reads as a smudge rather than a colour.
const SPECTRUM = ["#3b4cc0", "#3f6fe8", "#3d96f5", "#26bde0", "#1ed8b0", "#4ce97a", "#9cee4e", "#d6e33a", "#f6c02f", "#f99227", "#ee5e1d", "#d62c14"].map((c) => new THREE.Color(c));
// both scales run 0 to 1; what 0 and 1 mean is set from the flow itself
const SPEED: [number, THREE.Color][] = SPECTRUM.map((c, i) => [i / (SPECTRUM.length - 1), c]);
// pressure on the part, -1 (pulled hardest) to 1 (pushed hardest)
const PRESSURE: [number, THREE.Color][] = SPECTRUM.map((c, i) => [-1 + (2 * i) / (SPECTRUM.length - 1), c]);

export const SPEED_KEY = SPECTRUM.map((c) => `#${c.getHexString()}`);
export const PRESSURE_KEY = SPEED_KEY;

function ramp(stops: [number, THREE.Color][], t: number, out: THREE.Color): THREE.Color {
  if (t <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) return out.copy(stops[i - 1][1]).lerp(stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return out.copy(stops[stops.length - 1][1]);
}

type Grid = { nx: number; ny: number; nz: number; h: number; solid: Uint8Array; toWorld: THREE.Matrix4; part: { y1: number; z0: number; z1: number } };

export class Wind {
  private worker: Worker | null = null;
  private group = new THREE.Group();
  private lines: LineSegments2;
  private lineMaterial: LineMaterial;
  private positions: Float32Array;
  private colours: Float32Array;
  private count: number;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private age: Float32Array;
  private trail: Float32Array; // count x TAIL x 3, newest first
  private grid: Grid | null = null;
  private field: { ux: Float32Array; uy: Float32Array; uz: Float32Array; rho: Float32Array } | null = null;
  private skins: THREE.Mesh[] = [];
  private toLattice = new THREE.Matrix4();
  private lastSkin = 0;
  private frameNo = 0;
  // the speeds the colour scale runs between, from the latest flow
  private slowest = 0;
  private fastest = U * 1.4;
  private on = false;
  private dir: WindDir = "+x";
  private geometries: THREE.BufferGeometry[] = [];
  private pending = 0;
  private last = 0;
  private raf = 0;
  onGrid: (cellMm: number | null) => void = () => {};

  private schedule: () => void;
  private background: THREE.Color;
  private phone: boolean;

  constructor(scene: THREE.Scene, schedule: () => void, background: THREE.Color, phone: boolean) {
    this.schedule = schedule;
    this.background = background;
    this.phone = phone;
    this.count = phone ? 300 : 650;
    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.age = new Float32Array(this.count);
    this.trail = new Float32Array(this.count * TAIL * 3);
    const segs = this.count * (TAIL - 1);
    this.positions = new Float32Array(segs * 6);
    this.colours = new Float32Array(segs * 6);
    // thick lines, drawn as screen-space ribbons: plain WebGL lines are one
    // pixel wide whatever is asked for
    const g = new LineSegmentsGeometry();
    g.setPositions(this.positions);
    g.setColors(this.colours);
    this.lineMaterial = new LineMaterial({ vertexColors: true, linewidth: phone ? 1.2 : 1.5, worldUnits: false, transparent: true, opacity: 0.92 });
    this.lines = new LineSegments2(g, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.lines.matrixAutoUpdate = false;
    this.group.add(this.lines);
    this.group.visible = false;
    scene.add(this.group);
    document.addEventListener("visibilitychange", () => this.worker?.postMessage({ t: "run", on: this.on && !document.hidden }));
  }

  setOn(on: boolean): void {
    this.on = on;
    this.group.visible = on && !!this.grid;
    if (on) {
      if (!this.worker) {
        this.worker = new Worker("/build/wind-worker.js", { type: "module" });
        this.worker.onmessage = (e) => {
          if (e.data.t !== "field") return;
          this.field = e.data;
          this.fitColours();
        };
      }
      this.rebuildSoon(0);
      this.worker.postMessage({ t: "run", on: !document.hidden });
      this.last = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.worker?.postMessage({ t: "run", on: false });
      cancelAnimationFrame(this.raf);
      this.schedule();
    }
  }

  setDirection(dir: WindDir): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.rebuildSoon(0);
  }

  // The solids to blow round. Building the grid takes a moment, so it waits
  // until the part has stopped changing (a drag sends a new part every frame).
  setSolids(geometries: THREE.BufferGeometry[]): void {
    const same = geometries.length === this.geometries.length && geometries.every((g, i) => g === this.geometries[i]);
    if (same) return;
    this.geometries = geometries;
    this.rebuildSoon(500);
  }

  private rebuildSoon(ms: number): void {
    clearTimeout(this.pending);
    if (!this.on) return;
    this.pending = window.setTimeout(() => this.rebuild(), ms);
  }

  private rebuild(): void {
    this.grid = this.geometries.length ? voxelise(this.geometries, this.dir, this.phone) : null;
    this.field = null;
    this.group.visible = this.on && !!this.grid;
    this.onGrid(this.grid ? this.grid.h : null);
    if (!this.grid) return this.schedule();
    const { nx, ny, nz, solid, toWorld } = this.grid;
    this.lines.matrix.copy(toWorld);
    this.lines.matrixWorldNeedsUpdate = true;
    this.toLattice.copy(toWorld).invert();
    this.makeSkins();
    this.worker?.postMessage({ t: "setup", nx, ny, nz, solid });
    for (let p = 0; p < this.count; p++) this.respawn(p, true);
  }

  // The part's surface, drawn over itself and coloured by the pressure of
  // the air just outside each point.
  private makeSkins(): void {
    for (const m of this.skins) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.skins = this.geometries.map((src) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", src.attributes.position);
      if (src.index) g.setIndex(src.index);
      if (src.attributes.normal) g.setAttribute("normal", src.attributes.normal);
      else g.computeVertexNormals();
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 3).fill(0.96), 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      // hidden until there is a pressure to show, so the part keeps its own
      // colours meanwhile
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    });
  }

  private paintSkins(): void {
    const g = this.grid;
    if (!g || !this.field) return;
    const p = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color();
    const out = g.h * 0.9;
    // pressure just outside each point, as a fraction of the oncoming air's
    // dynamic pressure
    const cps = this.skins.map((mesh) => {
      const pos = mesh.geometry.attributes.position, nor = mesh.geometry.attributes.normal;
      const values = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        n.fromBufferAttribute(nor, i);
        p.addScaledVector(n, out).applyMatrix4(this.toLattice);
        values[i] = (this.density(p.x, p.y, p.z) - 1) / (1.5 * U * U);
      }
      return values;
    });
    // the colours are relative: scaled so the strongest push and pull on this
    // part (ignoring the odd extreme point) are full red and full blue
    const all = Float32Array.from(cps.flatMap((v) => [...v].map(Math.abs))).sort();
    const scale = Math.max(0.05, all[Math.floor(all.length * 0.95)] ?? 0.05);
    this.skins.forEach((mesh, k) => {
      const col = mesh.geometry.attributes.color;
      cps[k].forEach((cp, i) => {
        ramp(PRESSURE, Math.max(-1, Math.min(1, cp / scale)), c);
        col.setXYZ(i, c.r, c.g, c.b);
      });
      col.needsUpdate = true;
      mesh.visible = true;
    });
  }

  private density(x: number, y: number, z: number): number {
    const g = this.grid!;
    const cx = Math.min(Math.max(x - 0.5, 0), g.nx - 1.001);
    const cy = Math.min(Math.max(y - 0.5, 0), g.ny - 1.001);
    const cz = Math.min(Math.max(z - 0.5, 0), g.nz - 1.001);
    const x0 = Math.floor(cx), y0 = Math.floor(cy), z0 = Math.floor(cz);
    const tx = cx - x0, ty = cy - y0, tz = cz - z0;
    let sum = 0, weight = 0;
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
      const c = x0 + dx + g.nx * (y0 + dy + g.ny * (z0 + dz));
      if (g.solid[c]) continue; // only the air counts
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz) + 1e-6;
      sum += w * this.field!.rho[c];
      weight += w;
    }
    return weight ? sum / weight : 1;
  }

  // Spread the colours over the speeds actually in the flow, between its
  // 2nd and 98th percentiles, so slow air is blue and the fastest red
  // whatever the part: a fixed scale put the oncoming air itself at the hot
  // end, and everything looked fast.
  private fitColours(): void {
    const f = this.field, g = this.grid;
    if (!f || !g) return;
    const speeds: number[] = [];
    for (let c = 0; c < f.ux.length; c += 7) {
      if (g.solid[c]) continue;
      speeds.push(Math.hypot(f.ux[c], f.uy[c], f.uz[c]));
    }
    if (speeds.length < 20) return;
    speeds.sort((a, b) => a - b);
    this.slowest = speeds[Math.floor(speeds.length * 0.02)];
    this.fastest = Math.max(this.slowest + U * 0.2, speeds[Math.floor(speeds.length * 0.98)]);
  }

  private solidAt(x: number, y: number, z: number): boolean {
    const g = this.grid!;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) return false;
    return g.solid[ix + g.nx * (iy + g.ny * iz)] === 1;
  }

  // New air comes in at the inlet, mostly in the band the part sits in, so
  // the streaks are where there is something to see.
  private respawn(p: number, anywhere = false): void {
    const g = this.grid!;
    const { y1, z0, z1 } = g.part;
    for (let tries = 0; tries < 8; tries++) {
      const x = anywhere ? Math.random() * (g.nx - 1) : Math.random() * 1.5;
      const y = 0.3 + Math.random() * Math.min(g.ny - 1.3, y1 * 1.25 + 1);
      const span = z1 - z0;
      // most streaks in a thin slice through the middle of the part, the way
      // a wind tunnel shows a section, so the part sits in front of them and
      // the air can be seen bending round it; the rest spread wider
      const mid = (z0 + z1) / 2;
      const z = Math.min(g.nz - 1, Math.max(0, p % 10 < 7 ? mid + (Math.random() - 0.5) * span * 0.2 : z0 - span * 0.15 + Math.random() * span * 1.3));
      if (this.solidAt(x, y, z)) continue;
      this.px[p] = x;
      this.py[p] = y;
      this.pz[p] = z;
      break;
    }
    this.age[p] = anywhere ? Math.random() * 4 : 0;
    for (let k = 0; k < TAIL; k++) {
      const o = (p * TAIL + k) * 3;
      this.trail[o] = this.px[p];
      this.trail[o + 1] = this.py[p];
      this.trail[o + 2] = this.pz[p];
    }
  }

  // velocity at a point, in cells per step, trilinear between cell centres
  private velocity(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const g = this.grid!;
    const f = this.field;
    if (!f) return out.set(U, 0, 0);
    const cx = Math.min(Math.max(x - 0.5, 0), g.nx - 1.001);
    const cy = Math.min(Math.max(y - 0.5, 0), g.ny - 1.001);
    const cz = Math.min(Math.max(z - 0.5, 0), g.nz - 1.001);
    const x0 = Math.floor(cx), y0 = Math.floor(cy), z0 = Math.floor(cz);
    const tx = cx - x0, ty = cy - y0, tz = cz - z0;
    out.set(0, 0, 0);
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      const c = x0 + dx + g.nx * (y0 + dy + g.ny * (z0 + dz));
      out.x += w * f.ux[c];
      out.y += w * f.uy[c];
      out.z += w * f.uz[c];
    }
    return out;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.on || !this.grid || document.hidden) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const g = this.grid;
    // the inflow crosses the grid in about four seconds
    const k = g.nx / (4 * U);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    const lay = this.frameNo++ % 2 === 0;
    if (this.field && now - this.lastSkin > 400) {
      this.lastSkin = now;
      this.paintSkins();
    }
    const tail = new THREE.Color();
    let s = 0;
    for (let p = 0; p < this.count; p++) {
      // two half steps, so a streak bends round the part rather than cutting it
      for (let h = 0; h < 2; h++) {
        this.velocity(this.px[p], this.py[p], this.pz[p], v);
        this.px[p] += v.x * k * dt * 0.5;
        this.py[p] += v.y * k * dt * 0.5;
        this.pz[p] += v.z * k * dt * 0.5;
      }
      this.age[p] += dt;
      const out = this.px[p] >= g.nx - 1 || this.px[p] < 0 || this.py[p] < 0 || this.py[p] >= g.ny || this.pz[p] < 0 || this.pz[p] >= g.nz;
      if (out || this.age[p] > 14 || this.solidAt(this.px[p], this.py[p], this.pz[p])) this.respawn(p);
      // every other frame the tail moves along; the head is always the particle
      const base = p * TAIL * 3;
      if (lay) this.trail.copyWithin(base + 3, base, base + (TAIL - 1) * 3);
      this.trail[base] = this.px[p];
      this.trail[base + 1] = this.py[p];
      this.trail[base + 2] = this.pz[p];
      // coloured by speed against the wind's own; the tail fades into the background
      ramp(SPEED, (v.length() - this.slowest) / (this.fastest - this.slowest), c);
      for (let t = 0; t < TAIL - 1; t++) {
        const a = base + t * 3, b = base + (t + 1) * 3;
        this.positions.set(this.trail.subarray(a, a + 3), s);
        this.positions.set(this.trail.subarray(b, b + 3), s + 3);
        const fade = (k: number) => Math.max(0, (k / (TAIL - 1) - 0.8) / 0.2) * 0.6;
        tail.copy(c).lerp(this.background, fade(t));
        this.colours[s] = tail.r;
        this.colours[s + 1] = tail.g;
        this.colours[s + 2] = tail.b;
        tail.copy(c).lerp(this.background, fade(t + 1));
        this.colours[s + 3] = tail.r;
        this.colours[s + 4] = tail.g;
        this.colours[s + 5] = tail.b;
        s += 6;
      }
    }
    const geo = this.lines.geometry;
    (geo.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    (geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    const canvas = document.querySelector("#viewport canvas") as HTMLCanvasElement | null;
    if (canvas) this.lineMaterial.resolution.set(canvas.clientWidth, canvas.clientHeight);
    this.schedule();
  };
}

// The grid: a box of cells round the part, longer downstream than upstream
// so the wake has room, standing on the ground. Each column of cells along
// the wind gets one ray through every solid; between an odd and the next even
// crossing is inside.
function voxelise(geometries: THREE.BufferGeometry[], dir: WindDir, phone: boolean): Grid | null {
  const angle = { "+x": 0, "-x": Math.PI, "+z": -Math.PI / 2, "-z": Math.PI / 2 }[dir];
  const toWind = new THREE.Matrix4().makeRotationY(-angle);
  const box = new THREE.Box3();
  for (const g of geometries) {
    g.computeBoundingBox();
    box.union(g.boundingBox!.clone().applyMatrix4(toWind));
  }
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const L = Math.max(size.x, size.z, 20);
  // room upstream for the air to arrive, more behind for the wake, and
  // enough round the sides and over the top that the flow can get past
  const x0 = box.min.x - L * 0.5, x1 = box.max.x + L * 1.3;
  const side = Math.max(size.z, L * 0.4) * 0.6;
  const z0 = box.min.z - side, z1 = box.max.z + side;
  const y0 = Math.min(0, box.min.y), y1 = box.max.y + Math.max(size.y, L * 0.3) * 0.8;
  const budget = phone ? 45_000 : 110_000;
  let h = Math.cbrt(((x1 - x0) * (y1 - y0) * (z1 - z0)) / budget);
  h = Math.max(h, (x1 - x0) / 110);
  const nx = Math.max(8, Math.ceil((x1 - x0) / h));
  const ny = Math.max(6, Math.ceil((y1 - y0) / h));
  const nz = Math.max(6, Math.ceil((z1 - z0) / h));
  // cell (i, j, k) -> world: scale by h, shift to the grid's corner, turn into the wind's direction
  const toWorld = new THREE.Matrix4()
    .makeRotationY(angle)
    .multiply(new THREE.Matrix4().makeTranslation(x0, y0, z0))
    .multiply(new THREE.Matrix4().makeScale(h, h, h));
  const solid = new Uint8Array(nx * ny * nz);
  const along = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(angle));
  const ray = new THREE.Ray();
  let top = 0, zmin = nz, zmax = 0;
  for (const g of geometries) {
    const plain = new THREE.BufferGeometry();
    plain.setAttribute("position", g.attributes.position);
    if (g.index) plain.setIndex(g.index);
    const bvh = new MeshBVH(plain);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        ray.origin.set(-1, j + 0.5, k + 0.5).applyMatrix4(toWorld);
        ray.direction.copy(along);
        const hits = bvh.raycast(ray, THREE.DoubleSide).map((i) => i.distance / h).sort((a, b) => a - b);
        for (let m = 0; m + 1 < hits.length; m += 2) {
          // cell i's centre is i + 1.5 cells from the ray's start
          const from = Math.max(0, Math.ceil(hits[m] - 1.5)), to = Math.min(nx - 1, Math.floor(hits[m + 1] - 1.5));
          for (let i = from; i <= to; i++) solid[i + nx * (j + ny * k)] = 1;
          if (to >= from) {
            top = Math.max(top, j + 1);
            zmin = Math.min(zmin, k);
            zmax = Math.max(zmax, k + 1);
          }
        }
      }
    }
    plain.dispose();
  }
  if (zmin > zmax) return null;
  return { nx, ny, nz, h, solid, toWorld, part: { y1: top, z0: zmin, z1: zmax } };
}

// The wind preview's air: a lattice Boltzmann simulation (D3Q19, BGK
// collision) on a coarse grid of cells round the part, run in a worker so the
// editor never waits for it. Air comes in at the low-x face at a steady
// speed, leaves at the high-x face, slides along the sides and top, sticks to
// the ground and to the part (bounce-back). It is a real, if coarse, fluid
// calculation, which is why the wake and the flow over the top look right;
// it is too coarse, and uncalibrated, to give forces or numbers, and the
// editor never shows any.
//
// In:  { t: "setup", nx, ny, nz, solid: Uint8Array }  a new grid and part
//      { t: "run", on: boolean }                       pause and resume
// Out: { t: "field", ux, uy, uz, rho: Float32Array }    a few times a second
//      (rho is density, which is pressure here, averaged over the last
//      second or so, so the colours on the part settle rather than flicker)

const EX = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const EY = [0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1];
const EZ = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1];
const OPP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17];
const W = [1 / 3, ...Array(6).fill(1 / 18), ...Array(12).fill(1 / 36)];
const Q = 19;

// inlet speed, in cells per step; well under the lattice's sound speed
const U = 0.08;
// relaxation time: viscosity (tau - 0.5) / 3, so the flow is lively but stable
const TAU = 0.56;
const OMEGA = 1 / TAU;

let nx = 0, ny = 0, nz = 0, n = 0;
let solid: Uint8Array = new Uint8Array(0);
let f = new Float32Array(0);
let g = new Float32Array(0);
let ux = new Float32Array(0), uy = new Float32Array(0), uz = new Float32Array(0);
let rho = new Float32Array(0), rhoAvg = new Float32Array(0);
const inlet = new Float32Array(Q);
let running = false;
let timer = 0;
let steps = 0;

function equilibrium(out: Float32Array | number[], rho: number, vx: number, vy: number, vz: number, at = 0, stride = 1): void {
  const uu = vx * vx + vy * vy + vz * vz;
  for (let i = 0; i < Q; i++) {
    const eu = EX[i] * vx + EY[i] * vy + EZ[i] * vz;
    out[at + i * stride] = W[i] * rho * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * uu);
  }
}

function setup(m: { nx: number; ny: number; nz: number; solid: Uint8Array<ArrayBufferLike> }): void {
  ({ nx, ny, nz } = m);
  n = nx * ny * nz;
  solid = m.solid;
  f = new Float32Array(n * Q);
  g = new Float32Array(n * Q);
  ux = new Float32Array(n);
  uy = new Float32Array(n);
  uz = new Float32Array(n);
  rho = new Float32Array(n).fill(1);
  rhoAvg = new Float32Array(n).fill(1);
  equilibrium(inlet, 1, U, 0, 0);
  for (let c = 0; c < n; c++) {
    if (solid[c]) continue;
    for (let i = 0; i < Q; i++) f[i * n + c] = inlet[i];
    ux[c] = U;
  }
  steps = 0;
}

function step(): void {
  // collide: relax each cell toward equilibrium at its own density and velocity
  for (let c = 0; c < n; c++) {
    if (solid[c]) {
      ux[c] = uy[c] = uz[c] = 0;
      continue;
    }
    let d = 0, mx = 0, my = 0, mz = 0;
    for (let i = 0; i < Q; i++) {
      const v = f[i * n + c];
      d += v;
      mx += v * EX[i];
      my += v * EY[i];
      mz += v * EZ[i];
    }
    if (!(d > 0.2 && d < 5)) {
      // a cell gone unstable is put back to the inflow, not left to spread
      for (let i = 0; i < Q; i++) f[i * n + c] = inlet[i];
      ux[c] = U;
      uy[c] = uz[c] = 0;
      rho[c] = 1;
      continue;
    }
    rho[c] = d;
    const vx = mx / d, vy = my / d, vz = mz / d;
    ux[c] = vx;
    uy[c] = vy;
    uz[c] = vz;
    const uu = vx * vx + vy * vy + vz * vz;
    for (let i = 0; i < Q; i++) {
      const eu = EX[i] * vx + EY[i] * vy + EZ[i] * vz;
      const eq = W[i] * d * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * uu);
      const k = i * n + c;
      f[k] += OMEGA * (eq - f[k]);
    }
  }
  // stream: each cell pulls from its neighbours; off the inlet comes steady
  // air, off the outlet the cell's own, off the ground and the part it
  // bounces back, and the sides and top let air slide along them
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = x + nx * (y + ny * z);
        if (solid[c]) continue;
        for (let i = 0; i < Q; i++) {
          const sx = x - EX[i];
          let sy = y - EY[i];
          let sz = z - EZ[i];
          let v: number;
          if (sx < 0) v = inlet[i];
          else if (sx >= nx) v = f[i * n + c];
          else if (sy < 0) v = f[OPP[i] * n + c];
          else {
            // top and sides: mirror the neighbour back in (free slip)
            if (sy >= ny) sy = ny - 1;
            if (sz < 0) sz = 0;
            else if (sz >= nz) sz = nz - 1;
            const s = sx + nx * (sy + ny * sz);
            v = solid[s] ? f[OPP[i] * n + c] : f[i * n + s];
          }
          g[i * n + c] = v;
        }
      }
    }
  }
  const t = f;
  f = g;
  g = t;
  steps++;
}

function loop(): void {
  if (!running || n === 0) return;
  const start = performance.now();
  // steps for about 30 ms, then a 15 ms rest: the air keeps moving, and the
  // worker never pins a core (this is on whenever the editor is open)
  do step();
  while (performance.now() - start < 30);
  for (let c = 0; c < n; c++) rhoAvg[c] += 0.12 * (rho[c] - rhoAvg[c]);
  postMessage({ t: "field", ux: ux.slice(), uy: uy.slice(), uz: uz.slice(), rho: rhoAvg.slice(), steps });
  timer = setTimeout(loop, 15) as unknown as number;
}

onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.t === "setup") {
    setup(m);
    if (running) {
      clearTimeout(timer);
      loop();
    }
  } else if (m.t === "run") {
    const was = running;
    running = !!m.on;
    if (running && !was) loop();
    if (!running) clearTimeout(timer);
  }
};

// Promise 3: you can see the other people. A pointer that stutters, or that
// leaps up and down while its owner draws a straight line, shows them badly.
// client/glide.ts plays another person's pointer back; these drive it the way
// the network does (about ten points a second, unevenly once the server has
// batched them) and look at what would be drawn, frame by frame.

import { describe, expect, it } from "vitest";
import { Glide } from "../client/glide.ts";
import type { Vec3 } from "../shared/model.ts";

const EYE: Vec3 = [0, 200, 400];
const FRAME = 1000 / 60;

// Points along a straight sweep, seen from EYE, arriving at `times`; each
// sits `depth(i)` along its ray from the eye.
function sweep(times: number[], depth: (i: number) => number): { at: Vec3; t: number }[] {
  return times.map((t, i) => {
    const x = -100 + (200 * i) / (times.length - 1);
    const dir = [x, -200, -400];
    const l = Math.hypot(...dir);
    const d = depth(i);
    return { t, at: [EYE[0] + (dir[0] / l) * d, EYE[1] + (dir[1] / l) * d, EYE[2] + (dir[2] / l) * d] as Vec3 };
  });
}

// What is drawn each frame from the first point to `until`.
function play(points: { at: Vec3; t: number }[], until: number): Vec3[] {
  const g = new Glide();
  const shown: Vec3[] = [];
  let next = 0;
  for (let now = points[0].t; now <= until; now += FRAME) {
    while (next < points.length && points[next].t <= now) g.push(points[next].at, EYE, points[next++].t);
    const p = g.at(now);
    if (p) shown.push(p);
  }
  return shown;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("another person's pointer", () => {
  it("moves at a steady pace when its points arrive unevenly", () => {
    // ten a second on average, but batched: 50 ms, then 150 ms, and so on
    const times = Array.from({ length: 21 }, (_, i) => i * 100 + (i % 2 ? -50 : 0));
    const shown = play(sweep(times, () => 450), 2600);
    const steps = shown.slice(1).map((p, i) => dist(p, shown[i])).filter((s) => s > 0.01);
    // the middle of the sweep, away from starting and stopping
    const mid = steps.slice(Math.floor(steps.length * 0.2), Math.floor(steps.length * 0.8));
    const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
    const spread = Math.sqrt(mid.reduce((a, b) => a + (b - mean) ** 2, 0) / mid.length) / mean;
    expect(spread).toBeLessThan(0.25);
  });

  // how far a drawn point is from the floor's line, the sweep at 450 mm
  const floor = sweep(Array.from({ length: 801 }, (_, i) => i), () => 450).map((q) => q.at);
  const offFloor = (p: Vec3) => Math.min(...floor.map((q) => dist(p, q)));

  it("does not spike when a straight sweep clips something thin", () => {
    // a thin post halfway along: one point lands on it, 150 mm nearer the eye
    const times = Array.from({ length: 21 }, (_, i) => i * 100);
    const shown = play(sweep(times, (i) => (i === 10 ? 300 : 450)), 2600);
    // drawn as it came, the pointer would leap about 150 mm off the line
    // and back; it stays on the line
    expect(Math.max(...shown.map(offFloor))).toBeLessThan(2);
  });

  it("rises onto a part it moves onto, in one even step, and stays there", () => {
    // halfway along, the sweep moves onto a block 150 mm nearer the eye
    const times = Array.from({ length: 21 }, (_, i) => i * 100);
    const points = sweep(times, (i) => (i < 10 ? 450 : 300));
    const shown = play(points, 2600);
    const steps = shown.slice(1).map((p, i) => dist(p, shown[i]));
    // the 150 mm step up is spread over a whole point's worth of frames
    // (six at 60 a second), never leapt in one or two
    expect(Math.max(...steps)).toBeLessThan(150 / 4);
    // and it ends on the block, exactly where the sender stopped
    expect(dist(shown.at(-1)!, points.at(-1)!.at)).toBeLessThan(0.02);
    expect(offFloor(shown.at(-1)!)).toBeGreaterThan(100);
  });

  it("comes to rest exactly where its owner stopped", () => {
    const times = Array.from({ length: 6 }, (_, i) => i * 100);
    const points = sweep(times, (i) => (i < 5 ? 450 : 300));
    const g = new Glide();
    for (const p of points) {
      g.push(p.at, EYE, p.t);
      g.at(p.t);
    }
    let now = 500;
    while (g.moving && now < 5000) g.at((now += FRAME));
    expect(g.moving).toBe(false);
    expect(dist(g.at(now)!, points.at(-1)!.at)).toBeLessThan(0.02);
    expect(now).toBeLessThan(1500);
  });

  it("appears where its owner is after being away, rather than gliding in", () => {
    const g = new Glide();
    g.push([0, 0, 0], EYE, 0);
    g.at(0);
    g.clear();
    expect(g.at(100)).toBeNull();
    g.push([80, 0, 0], EYE, 200);
    expect(g.at(200)).toEqual([80, 0, 0]);
  });
});

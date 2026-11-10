// Another person's pointer, played back smoothly.
//
// A pointer arrives as the point on the model under their mouse, about ten
// times a second, a little unevenly once the server has batched it. Drawn as
// it comes, it stutters; eased towards frame by frame, its speed depends on
// the watcher's screen and it stops and lurches whenever a point is late. And
// because the point sits on whatever is under the mouse, a straight sweep
// across a part jumps between the floor and the part: seen from anywhere but
// the sender's own eye, a straight line becomes a run of spikes.
//
// So each point is kept as the sender's eye, the direction from it and how far
// along, and given a time to be played at: evenly spaced, at the pace points
// have been arriving, drifting slowly towards when they really came. The
// pointer is drawn two gaps behind, between the points either side of then,
// so a late point is waited for, not lurched to. Between them it turns the
// direction, so the path is the path the sender's hand made. How far along
// is the middle of a point's own and its neighbours': a sweep that clips one
// thin thing for one point stays on the floor, and one that moves onto a part
// rises onto it over a single step. The last point is always its own, so a
// person who stops is drawn exactly on what they are over.

import type { Vec3 } from "../shared/model.ts";

// `dist` as measured; `prev` the one before it, kept once that is played
type Point = { eye: Vec3; dir: Vec3; dist: number; time: number; prev: number };

const median = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
function unit(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export class Glide {
  private points: Point[] = [];
  private gap = 100; // how far apart points arrive, smoothed, in ms
  private lastArrival = -Infinity;
  // how far behind the pointer is drawn: two gaps, followed slowly, because
  // a sudden change in it is a sudden change in where the pointer is
  private delay = 200;
  private lastDrawn = -Infinity;
  private lastNow = -Infinity;

  // A new point under the sender's mouse, seen from `eye` (their camera).
  push(at: Vec3, eye: Vec3 | undefined, now: number): void {
    // with no camera known yet, play from just above the point: straight down
    const from = eye ?? [at[0], at[1] + 1, at[2]];
    const d = sub(at, from);
    const point: Point = { eye: from, dir: unit(d), dist: len(d), time: now, prev: len(d) };
    const since = now - this.lastArrival;
    this.lastArrival = now;
    const last = this.points.at(-1);
    if (!last) {
      // first sight, or back after being away: appear where they are
      this.points = [point];
      return;
    }
    if (since > 400) {
      // moving again after a rest: glide from where they were, over one gap
      this.points = [{ ...last, time: now - this.gap, prev: last.dist }];
    } else {
      this.gap += (Math.min(250, Math.max(30, since)) - this.gap) * 0.1;
      // evenly after the last, pulled a little towards when it really came
      const due = last.time + this.gap;
      point.time = Math.max(last.time + 10, due + (now - due) * 0.05);
    }
    point.prev = last.dist;
    this.points.push(point);
  }

  // They went away (off the model, or out of the view): forget the path.
  clear(): void {
    this.points = [];
  }

  // Where to draw them at `now`, or null if nowhere.
  at(now: number): Vec3 | null {
    if (!this.points.length) return null;
    const dt = Math.min(1000, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    this.delay += (this.gap * 2 - this.delay) * (1 - Math.exp(-dt / 1000));
    const t = (this.lastDrawn = Math.max(this.lastDrawn, now - this.delay));
    while (this.points.length > 1 && this.points[1].time <= t) this.points.shift();
    const a = this.points[0];
    const b = this.points[1] ?? a;
    const k = b === a ? 1 : Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time)));
    const eye = mix(a.eye, b.eye, k);
    const dir = unit(mix(a.dir, b.dir, k));
    const da = this.settled(0), db = this.settled(b === a ? 0 : 1);
    const dist = da + (db - da) * k;
    return [eye[0] + dir[0] * dist, eye[1] + dir[1] * dist, eye[2] + dir[2] * dist];
  }

  // How far along point i is drawn: the middle of it and its neighbours,
  // or its own if it is the last.
  private settled(i: number): number {
    const p = this.points[i];
    const next = this.points[i + 1];
    return next ? median(p.prev, p.dist, next.dist) : p.dist;
  }

  // Still on its way somewhere, so worth drawing again next frame.
  get moving(): boolean {
    return this.points.length > 1;
  }
}

// The example design: a small wind turbine, made only with the editor's own
// tools, so it shows what Bench can make. It is built by the same recipes
// the ribbon uses (shared/parts.ts) plus primitives, arranged the way the
// Circular and Grid patterns arrange things, and every piece is an ordinary
// feature anyone in the example can select, retype or undo. The server makes
// it at /d/example whenever that design is empty, and it is the one design
// the wind preview starts on in: the turbine faces into the wind, which
// blows along +X.

import * as THREE from "three";
import type { Body, Feature, Vec3 } from "./model.ts";
import { PARTS, faceFrame, placeSteps, type Step } from "./parts.ts";

export const EXAMPLE_ID = "example";
export const EXAMPLE_NAME = "Example: wind turbine";

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = "#eceae4", BLUE = "#2f6db5", BLACK = "#2b2d31";

export function exampleFeatures(): { id: string; f: Feature }[] {
  const out: { id: string; f: Feature }[] = [];
  const add = (f: Feature): string => {
    const id = `ex-${String(out.length + 1).padStart(3, "0")}`;
    out.push({ id, f });
    return id;
  };
  // a list of steps, placed by q at `at`, with "@face" naming the body cut into;
  // returns the first body's id, which the recipe's combines change
  const place = (steps: Step[], q: THREE.Quaternion, at: Vec3, face?: string): string => {
    const ids = new Map<string, string>();
    if (face) ids.set("@face", face);
    let first = "";
    for (const { ref, f } of placeSteps(steps, q, new THREE.Vector3(...at))) {
      const real = f.kind === "combine" ? { ...f, target: ids.get(f.target)!, tools: f.tools.map((t) => ids.get(t)!) } : f;
      const id = add(real);
      ids.set(ref, id);
      if (!first && f.kind !== "combine") first = id;
    }
    return first;
  };
  // a ready-made part, on a face with the given outward normal
  const part = (id: string, values: Record<string, number>, at: Vec3, normal = UP, face?: string, turn = 0): string => {
    const def = PARTS.find((p) => p.id === id)!;
    const v = { ...def.defaults, ...values };
    const problem = def.check?.(v);
    if (problem) throw new Error(`example ${def.name}: ${problem}`);
    return place(def.build(v), faceFrame(normal, def.into, turn), at, face);
  };
  const along = (axis: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(UP, axis);
  const body = (b: Body): Step[] => [{ ref: "b", f: b }];

  // ---- the base: a plate on four hex standoffs, bolted through with washers
  const corners: [number, number][] = [[-62, -42], [62, -42], [-62, 42], [62, 42]];
  for (const [x, z] of corners) part("standoff", { d: 6.4, s: 10, L: 10 }, [x, 0, z]);
  const plate = part("plate", { w: 160, d: 120, t: 6, hole: 6.4, inset: 18 }, [0, 10, 0]);
  for (const [x, z] of corners) part("washer", { d1: 6.4, d2: 12, h: 1.6 }, [x, 16, z]);
  for (const [x, z] of corners) part("bolt", { d: 6, L: 17.6, s: 10, k: 4 }, [x, 0, z]);
  // a cable slot through the plate, beside the mast
  part("slot", { L: 30, w: 8, depth: 7 }, [45, 16, 0], UP, plate, 90);

  // ---- the mast: a flange with countersunk screw holes, a tube, four gussets
  const flange = part("washer", { d1: 24, d2: 64, h: 6 }, [0, 16, 0]);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    part("countersink", { d: 4.5, D: 9, depth: 8 }, [Math.cos(a) * 24, 22, Math.sin(a) * 24], UP, flange);
  }
  part("tube", { od: 24, id: 18, L: 200 }, [0, 22, 0]);
  const gusset = PARTS.find((p) => p.id === "gusset")!;
  for (let k = 0; k < 4; k++) {
    // the four arranged round the mast, as Circular pattern does
    const q = new THREE.Quaternion().setFromAxisAngle(UP, (k * Math.PI) / 2);
    const at = new THREE.Vector3(0, 0, 12).applyQuaternion(q).add(new THREE.Vector3(0, 22, 0));
    place(gusset.build({ a: 40, t: 4 }), q, [at.x, at.y, at.z]);
  }

  // ---- the nacelle: a chamfered housing, screwed down into counterbores, vented
  const hubY = 239;
  const nacelle = add({ name: "Nacelle", colour: WHITE, pos: [10, 222, 0], rot: [0, 0, 0], kind: "box", w: 80, h: 34, d: 36, fillet: 0, chamfer: 4 });
  for (const x of [-5, 30]) {
    part("counterbore", { d: 4.5, D: 8, cb: 5, depth: 12 }, [x, 256, 0], UP, nacelle);
    part("screw", { d: 4, L: 12, dk: 7, k: 4, sk: 3 }, [x, 239, 0]);
  }
  // three vents along the side, as a Grid pattern would space them
  for (const x of [-10, 10, 30]) part("slot", { L: 14, w: 4, depth: 3 }, [x, hubY, 18], new THREE.Vector3(0, 0, 1), nacelle);

  // ---- the rotor: a keyed shaft out of the front, a hub, a spinner, three blades
  part("shaft", { d: 10, L: 55, b: 3, t: 1.5 }, [-25, hubY, 0], new THREE.Vector3(-1, 0, 0));
  place(body({ name: "Hub", colour: BLUE, pos: [0, 0, 0], rot: [0, 0, 0], kind: "cylinder", r: 16, h: 16, chamfer: 2 }), along(new THREE.Vector3(-1, 0, 0)), [-66, hubY, 0]);
  place(body({ name: "Spinner", colour: BLUE, pos: [0, 0, 0], rot: [0, 0, 0], kind: "cone", r1: 16, r2: 2, h: 22 }), along(new THREE.Vector3(-1, 0, 0)), [-82, hubY, 0]);
  for (let k = 0; k < 3; k++) {
    // round the shaft every 120°, each pitched 15° to the wind
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (k * 2 * Math.PI) / 3);
    place(body({ name: "Blade", colour: WHITE, pos: [0, 14, 0], rot: [0, 15, 0], kind: "box", w: 4, h: 95, d: 18, fillet: 0, chamfer: 1 }), q, [-74, hubY, 0]);
  }

  // ---- the back: a short shaft carrying a gear, held on by a nut
  part("shaft", { d: 10, L: 22, b: 3, t: 1.5 }, [45, hubY, 0], new THREE.Vector3(1, 0, 0));
  part("gear", { n: 24, m: 1.5, b: 6, bore: 10 }, [52, hubY, 0], new THREE.Vector3(1, 0, 0));
  part("nut", { d: 10, s: 16, m: 8.4 }, [59, hubY, 0], new THREE.Vector3(1, 0, 0));

  // ---- the tail: a fin on an L-bracket, to keep it facing the wind
  part("bracket", { w: 20, a: 24, t: 3, hole: 4.3 }, [44, 256, 0], UP, undefined, 90);
  add({ name: "Tail fin", colour: BLACK, pos: [92, 258, 0], rot: [0, 0, 0], kind: "box", w: 70, h: 46, d: 3, fillet: 0, chamfer: 1 });
  return out;
}

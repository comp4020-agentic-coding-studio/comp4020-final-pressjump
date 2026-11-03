// Imported models: opened in the browser and kept in the browser.
//
// A model file never goes to the server. That is on purpose: the server is a
// small free machine, a model can be a gigabyte, and the server would have to
// hold it for everyone forever. So an import is like hiding a body, a thing
// of this browser only: nobody else in the design sees it, the STL export
// leaves it out, and the editor says both.
//
// What it opens: STEP (ISO 10303, the format CAD programs use to share parts
// with each other), and the open mesh formats OBJ, PLY and 3MF. Each becomes
// plain triangles in millimetres with Y up, the model's own units. STL is not
// offered for import; Bench only writes it (the export).

import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import type { Vec3 } from "../shared/model.ts";

export const ACCEPT = ".step,.stp,.obj,.ply,.3mf";
// beyond these a browser tab struggles, and the wind grid would be useless
export const MAX_BYTES = 150 * 1024 * 1024;
export const MAX_TRIANGLES = 2_000_000;

export type Unit = "mm" | "cm" | "m" | "in";
export const UNIT_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

// One imported model: its triangles as read (in the file's own units and
// axes), and how it sits in the design. Everything here stays in this browser.
export type Imported = {
  id: string;
  design: string;
  name: string;
  positions: Float32Array; // non-indexed triangles, as read
  unit: Unit;
  zUp: boolean; // the file's up axis is Z (most CAD and printing formats)
  pos: Vec3; // mm
  rot: Vec3; // degrees
  keep: boolean; // kept in this browser between visits
};

// Reads a file into triangles. STEP and 3MF are Z up by convention;
// OBJ and PLY usually Y up. The panel lets you change both guesses.
export async function readModel(file: File): Promise<{ positions: Float32Array; unit: Unit; zUp: boolean }> {
  if (file.size > MAX_BYTES) throw new Error(`it is ${Math.round(file.size / 1048576)} MB; a browser tab can open up to ${MAX_BYTES / 1048576} MB`);
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const buffer = await file.arrayBuffer();
  let positions: Float32Array;
  let zUp = true;
  if (ext === "obj") {
    positions = flattenObject(new OBJLoader().parse(new TextDecoder().decode(buffer)));
    zUp = false;
  } else if (ext === "ply") {
    positions = flatten(new PLYLoader().parse(buffer));
    zUp = false;
  } else if (ext === "3mf") positions = flattenObject(new ThreeMFLoader().parse(buffer));
  else if (ext === "step" || ext === "stp") positions = await readStep(buffer);
  else throw new Error(`Bench opens ${ACCEPT.replaceAll(",", " ")} files`);
  const triangles = positions.length / 9;
  if (!triangles) throw new Error("there are no triangles in it");
  if (triangles > MAX_TRIANGLES) throw new Error(`it has ${triangles.toLocaleString()} triangles; up to ${MAX_TRIANGLES.toLocaleString()} can be opened`);
  return { positions, unit: "mm", zUp };
}


function readStep(buffer: ArrayBuffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/build/step-worker.js");
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.positions);
      else reject(new Error(e.data.message));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("the STEP reader could not start"));
    };
    worker.postMessage(buffer, [buffer]);
  });
}

function flatten(g: THREE.BufferGeometry): Float32Array {
  const plain = g.index ? g.toNonIndexed() : g;
  return new Float32Array(plain.attributes.position.array);
}

function flattenObject(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const parts: Float32Array[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
    parts.push(new Float32Array(g.attributes.position.array));
  });
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The model's triangles in the design: scaled to millimetres, turned so its
// up is Y, then placed. Z up becomes Y up by a rotation, never a mirror.
export function placedGeometry(m: Imported): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions.slice(), 3));
  const s = UNIT_MM[m.unit];
  const fix = new THREE.Matrix4().makeScale(s, s, s);
  if (m.zUp) fix.premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  g.applyMatrix4(fix);
  const deg = Math.PI / 180;
  const place = new THREE.Matrix4().compose(
    new THREE.Vector3(...m.pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(m.rot[0] * deg, m.rot[1] * deg, m.rot[2] * deg, "XYZ")),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(place);
  g.computeVertexNormals();
  return g;
}

// Where a freshly opened model goes: centred over the origin, standing on the floor.
export function standOnFloor(m: Imported): Vec3 {
  const g = placedGeometry({ ...m, pos: [0, 0, 0] });
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.dispose();
  const r = (n: number) => Math.round(n * 1000) / 1000 + 0;
  return [r(-(b.min.x + b.max.x) / 2), r(-b.min.y), r(-(b.min.z + b.max.z) / 2)];
}

// ---------- kept in this browser: IndexedDB ----------

const DB = "bench-imports";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("models", { keyPath: "id" }).createIndex("design", "design");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadImports(design: string): Promise<Imported[]> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction("models").objectStore("models").index("design").getAll(design);
      req.onsuccess = () => resolve((req.result as Imported[]).map((m) => ({ ...m, keep: true })));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveImport(m: Imported): Promise<void> {
  if (!m.keep) return;
  try {
    const db = await open();
    db.transaction("models", "readwrite").objectStore("models").put(m);
  } catch {
    // private windows can refuse storage; the model just won't outlive the tab
  }
}

export async function forgetImport(id: string): Promise<void> {
  try {
    const db = await open();
    db.transaction("models", "readwrite").objectStore("models").delete(id);
  } catch {
    // nothing kept, nothing to forget
  }
}

// The 3D view: scene, camera, orbiting, the move gizmo, the view cube, picking
// and the HTML labels that float over it. It knows nothing about the network;
// design.ts tells it what to show and it reports what the pointer did.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { creases, type Solid } from "../shared/evaluate.ts";
import type { Vec3 } from "../shared/model.ts";
import type { Camera } from "../shared/protocol.ts";

export type Hit = { id: string | null; point: THREE.Vector3; normal: THREE.Vector3 };
export type Display = "shaded" | "edges" | "wire";
export type BodyStyle = { selected: boolean; holder: string | null; hidden: boolean };

const ACCENT = new THREE.Color("#0696d7");

export class Viewport {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gizmo: TransformControls;
  proxy = new THREE.Object3D();
  labels: HTMLElement;

  bodies = new THREE.Group();
  ghosts = new THREE.Group();
  overlay = new THREE.Group();
  remote = new THREE.Group();
  grid = new THREE.Group();

  display: Display = "edges";
  meshes = new Map<string, THREE.Mesh>();
  edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  raycaster = new THREE.Raycaster();
  dirty = true;
  onFrame: () => void = () => {};
  tween: { from: Camera; to: Camera; start: number; ms: number } | null = null;

  cube: ViewCube;

  constructor(host: HTMLElement, cubeHost: HTMLElement, labels: HTMLElement) {
    this.host = host;
    this.labels = labels;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute("role", "img");
    host.prepend(this.canvas);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 200_000);
    this.camera.position.set(260, 200, 300);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(300, 600, 400);
    this.scene.add(sun);

    this.buildGrid(10);
    this.scene.add(this.grid, this.bodies, this.ghosts, this.overlay, this.remote);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => this.schedule());

    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
    });
    this.gizmo.addEventListener("change", () => this.schedule());
    this.scene.add(this.proxy, this.gizmo.getHelper());

    this.cube = new ViewCube(cubeHost, (dir) => this.lookFrom(dir));

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.loop();
  }

  buildGrid(step: number): void {
    this.grid.clear();
    const minor = new THREE.GridHelper(1000, 1000 / step, 0xc9ced6, 0xdde1e7);
    (minor.material as THREE.Material).transparent = true;
    (minor.material as THREE.Material).opacity = 0.7;
    const major = new THREE.GridHelper(1000, 10, 0xaab1bc, 0xaab1bc);
    major.position.y = 0.01;
    const axis = (to: THREE.Vector3, colour: number): THREE.Line =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([to.clone().multiplyScalar(-500), to.clone().multiplyScalar(500)]),
        new THREE.LineBasicMaterial({ color: colour }),
      );
    const x = axis(new THREE.Vector3(1, 0, 0), 0xd9534f);
    const z = axis(new THREE.Vector3(0, 0, 1), 0x3a7bd5);
    x.position.y = z.position.y = 0.02;
    this.grid.add(minor, major, x, z);
    this.schedule();
  }

  resize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.schedule();
  }

  schedule(): void {
    this.dirty = true;
  }

  loop = (): void => {
    requestAnimationFrame(this.loop);
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.start) / this.tween.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const lerp = (a: Vec3, b: Vec3): THREE.Vector3 => new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), e);
      this.camera.position.copy(lerp(this.tween.from.p, this.tween.to.p));
      this.controls.target.copy(lerp(this.tween.from.t, this.tween.to.t));
      this.camera.lookAt(this.controls.target);
      if (k >= 1) this.tween = null;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.cube.render(this.camera);
    this.onFrame();
  };

  // ---------- what is shown ----------

  setSolids(solids: Solid[], style: (id: string) => BodyStyle, colourOf: (person: string) => string): void {
    const seen = new Set<string>();
    for (const s of solids) {
      const st = style(s.id);
      seen.add(s.id);
      let mesh = this.meshes.get(s.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          s.geometry,
          new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        );
        mesh.userData.id = s.id;
        this.meshes.set(s.id, mesh);
        this.bodies.add(mesh);
      }
      if (mesh.geometry !== s.geometry) {
        mesh.geometry = s.geometry;
        mesh.clear();
      }
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(s.feature.colour);
      mat.wireframe = this.display === "wire";
      mat.emissive.set(st.selected ? ACCENT : st.holder ? colourOf(st.holder) : 0x000000);
      mat.emissiveIntensity = st.selected ? 0.45 : st.holder ? 0.35 : 0;
      mesh.visible = !st.hidden;
      // edges, as Fusion's "shaded with visible edges"
      let edges = mesh.children[0] as THREE.LineSegments | undefined;
      if (this.display === "edges") {
        if (!edges) {
          let eg = this.edgeCache.get(s.geometry);
          if (!eg) {
            eg = creases(s.geometry);
            this.edgeCache.set(s.geometry, eg);
          }
          edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x23262b }));
          mesh.add(edges);
        }
        (edges.material as THREE.LineBasicMaterial).color.set(st.selected ? ACCENT : st.holder ? colourOf(st.holder) : 0x23262b);
        edges.visible = true;
      } else if (edges) {
        edges.visible = false;
      }
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        this.bodies.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        this.meshes.delete(id);
      }
    }
    this.schedule();
  }

  // translucent stand-ins: bodies used up by a combine, other people's drags,
  // the preview of what you are about to make
  setGhosts(items: { geometry: THREE.BufferGeometry; colour: string; opacity?: number }[]): void {
    for (const child of this.ghosts.children) ((child as THREE.Mesh).material as THREE.Material).dispose();
    this.ghosts.clear();
    for (const g of items) {
      const mat = new THREE.MeshBasicMaterial({ color: g.colour, transparent: true, opacity: g.opacity ?? 0.25, depthWrite: false });
      const mesh = new THREE.Mesh(g.geometry, mat);
      const wire = new THREE.LineSegments(
        this.edgesOf(g.geometry),
        new THREE.LineBasicMaterial({ color: g.colour, transparent: true, opacity: 0.9 }),
      );
      mesh.add(wire);
      this.ghosts.add(mesh);
    }
    this.schedule();
  }

  edgesOf(g: THREE.BufferGeometry): THREE.BufferGeometry {
    let eg = this.edgeCache.get(g);
    if (!eg) {
      eg = creases(g);
      this.edgeCache.set(g, eg);
    }
    return eg;
  }

  setDisplay(d: Display): void {
    this.display = d;
  }

  // ---------- picking ----------

  ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  // The body under the pointer, or failing that the ground (y = 0).
  pick(e: { clientX: number; clientY: number }, groundOnly = false): Hit | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    if (!groundOnly) {
      const visible = this.bodies.children.filter((m) => m.visible);
      const [hit] = this.raycaster.intersectObjects(visible, false);
      if (hit && hit.face) {
        const normal = hit.face.normal.clone();
        if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
        return { id: hit.object.userData.id as string, point: hit.point, normal };
      }
    }
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = this.raycaster.ray.intersectPlane(ground, new THREE.Vector3());
    return p ? { id: null, point: p, normal: new THREE.Vector3(0, 1, 0) } : null;
  }

  pickPlane(e: { clientX: number; clientY: number }, plane: THREE.Plane): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  // ---------- camera ----------

  view(): Camera {
    const r = (v: THREE.Vector3): Vec3 => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
    return { p: r(this.camera.position), t: r(this.controls.target) };
  }

  flyTo(to: Camera, ms = 350): void {
    this.tween = { from: this.view(), to, start: performance.now(), ms };
    this.schedule();
  }

  lookFrom(dir: THREE.Vector3): void {
    const t = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(t);
    const d = dir.clone().normalize();
    // straight down needs a nudge or the orbit controls lose their up vector
    if (Math.abs(d.y) > 0.999) d.z += 0.001;
    const p = t.clone().add(d.normalize().multiplyScalar(dist));
    this.flyTo({ p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] });
  }

  fit(): void {
    const box = new THREE.Box3();
    for (const m of this.bodies.children) if (m.visible) box.expandByObject(m);
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 60, 60));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (sphere.radius * 1.3) / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const p = sphere.center.clone().add(dir.multiplyScalar(dist));
    this.flyTo({ p: [p.x, p.y, p.z], t: [sphere.center.x, sphere.center.y, sphere.center.z] });
  }

  home(): void {
    this.lookFrom(new THREE.Vector3(1, 0.8, 1.15));
    setTimeout(() => this.fit(), 360);
  }

  // Screen position of a world point, or null if it is behind the camera.
  project(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }

  // A world size that looks `px` pixels big at point p.
  pixels(p: THREE.Vector3, px: number): number {
    const dist = this.camera.position.distanceTo(p);
    const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return (px * h) / this.canvas.getBoundingClientRect().height;
  }
}

// The cube in the corner: shows which way you are looking and takes you to a
// standard view when a face is clicked.
class ViewCube {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  cube: THREE.Mesh;
  raycaster = new THREE.Raycaster();

  constructor(host: HTMLElement, go: (dir: THREE.Vector3) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(96, 96);
    host.append(this.renderer.domElement);
    // order: +X, -X, +Y, -Y, +Z, -Z
    const names = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"];
    const mats = names.map((n) => new THREE.MeshBasicMaterial({ map: faceTexture(n) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x8b929c }));
    this.scene.add(this.cube, edges);
    const dirs = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
    ];
    const el = this.renderer.domElement;
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("click", (e) => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const [hit] = this.raycaster.intersectObject(this.cube);
      if (hit?.face) go(dirs[hit.face.materialIndex]);
    });
  }

  render(main: THREE.Camera): void {
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(main.quaternion);
    this.camera.position.copy(dir.multiplyScalar(6));
    this.camera.quaternion.copy(main.quaternion);
    this.renderer.render(this.scene, this.camera);
  }
}

function faceTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f3f4f6";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#3d434b";
  g.font = "600 24px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

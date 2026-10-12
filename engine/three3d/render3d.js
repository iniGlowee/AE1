/**
 * AE1 - the shared 3D renderer.
 *
 * ONE renderer for the editor viewport AND the shipped game (Principle 2). It
 * builds a three.js scene from AE1 elements + their glTF files, and keeps it in
 * sync — transform, animation clip, per-part visibility, light params — reading
 * only the element `model`/`light` components, never touching the editor or the
 * game specifically. The editor wraps it with an orbit camera and selection; the
 * game wraps it with a fixed camera and the game loop.
 *
 * It lives in `engine/three3d/` (not the concatenated 2D bundle) because it
 * imports three.js, which is loaded as an ES module via an import map — the same
 * reason `vendor/` is exempt from the bundler (DESIGN.md §18.2, §18.8).
 *
 * three.js is resolved through the import map: `three` and `three/addons/`.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
// §18.53 phase 3b: BVH-accelerated raycasts (three-mesh-bvh, vendored).
// three has NO ray acceleration — a ground probe against the City Ruins'
// megameshes was 3 ms PER CALL (per-triangle tests), and every character
// fires several per tick: three chasing enemies alone ate the frame budget.
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three/addons/utils/three-mesh-bvh.module.js';
// §18.66: the Kawaii-style secondary-bone pass (ponytails, sashes, the
// Commander's sword) — runs after the mixers, before the render.
import { createBonePhys } from './bonephys.js';

// Opt-in per geometry: acceleratedRaycast uses the BVH only where a
// boundsTree was computed (the static-freeze pass below); every other mesh
// raycasts exactly as stock three. Semantics (all hits, sorted) unchanged.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { decodeHDR } from './hdr.js';
import { createPostFX } from './postfx.js';

const DEG = Math.PI / 180;

/** Apply AE1's material rescue + culling fix to a freshly loaded glTF scene. */
export function conditionGltf(root, maxAniso = 8) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    // §18.87 revision of the §18.5 rule: only SKINNED meshes skip frustum
    // culling (their bounds are bind-pose; the animated body leaves them).
    // Static meshes cull normally — the old blanket `false` submitted every
    // triangle of every glb every frame regardless of the camera ("cost is
    // nil at this scale" stopped being true around the third character).
    o.frustumCulled = !o.isSkinnedMesh;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      // §18.87: anisotropic filtering — grazing-angle surfaces (floors!)
      // were mip-mush at anisotropy 1. Applied at load, before first upload.
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap,
                       m.aoMap, m.emissiveMap]) {
        if (t && t.anisotropy < maxAniso) t.anisotropy = maxAniso;
      }
      // §18.97 HAIR = ALPHA BLEND WITH DEPTH. The long history: §18.84 hashed
      // hair (soft, but "staticy" dither); §18.86 switched authored-MASK hair
      // to a hard cutout (crisp, but this the reference action game head's soft feathered alpha
      // punches HOLES through the strands at any threshold — Austin: "spotty,
      // holes", and it survives even uncompressed PNG). Blending is the
      // answer neither earlier pass used: `transparent` renders the soft
      // edges smoothly (no holes, no static), while `depthWrite` + a low
      // `alphaTest` keep the solid core sorting correctly against the body
      // and itself (the sort trouble that first drove §18.84 to hashing was
      // pure blend with depthWrite OFF).
      if (/hair|lash|feather/i.test(m.name || '')) {
        m.transparent = true;
        m.depthWrite = true;
        m.alphaTest = 0.05;
        if ('alphaHash' in m) m.alphaHash = false;
        m.needsUpdate = true;
        continue;
      }
      if (m.transparent && !(m.alphaTest > 0)) {
        m.transparent = false;
        m.alphaTest = 0.2;
        m.depthWrite = true;
        m.needsUpdate = true;
      }
    }
  });
  return root;
}

/**
 * Build and drive a 3D view of a set of AE1 elements.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {() => Array} opts.elements   live accessor for the scene's elements
 * @param {(glbName: string) => Promise<object>} opts.loadGlb   name -> parsed gltf
 * @param {boolean} [opts.fill]  a modest hemisphere fill (editor chrome); off for a shipped game
 */
export function createRenderer3D(canvas, { elements, loadGlb, mediaUrl = null, fill = true, onClipEnd = null } = {}) {
  // §18.53 phase 2: ask for the discrete GPU on dual-GPU laptops, and cap
  // the pixel ratio — a 2x display renders FOUR TIMES the fragments for a
  // sharpness the film layer mostly hides; 1.5 is the sweet spot.
  // §18.87: `antialias: false` — the canvas only ever receives the postfx
  // composite triangle, so canvas MSAA was pure bandwidth for zero edges;
  // the REAL antialiasing is the 4x-sampled scene target in postfx.js.
  // `stencil: false` — nothing in the engine uses one; saves 8 bits/px.
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, stencil: false, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping; // matches Blender 4.x — DESIGN §18.5
  renderer.toneMappingExposure = 1.0;
  const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
  // §18.87: the synchronous getShaderParameter readback per program compile
  // is a debug aid — priceless while authoring (fill=true is the editor),
  // a stall in a shipped game.
  renderer.debug.checkShaderErrors = !!fill;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1c20);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnv;
  const baseBackground = scene.background;
  if (fill) scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.4));

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(3, 2.4, 4.5);

  /** glbName -> { gltf, mixer, actions:Map, clips:[], current } */
  const glbs = new Map();
  const loading = new Map();
  /** element.id -> the three.js object it drives. */
  const bindings = new Map();
  const clock = new THREE.Clock();
  /** >0 while build() resolves — geometry queries answer null then (§18.13). */
  let buildsInFlight = 0;
  /** §18.66 — the secondary-bone (Kawaii) physics pass. */
  const bonePhys = createBonePhys(THREE);

  async function ensureGlb(name) {
    if (glbs.has(name)) return glbs.get(name);
    if (loading.has(name)) return loading.get(name);
    const p = (async () => {
      const gltf = await loadGlb(name);
      if (!gltf) {
        // A FAILED load must not be cached forever — a re-uploaded file (new
        // hash, same name) deserves a retry on the next sync. One stale
        // rejection made a re-exported bazooka permanently invisible.
        loading.delete(name);
        return null;
      }
      conditionGltf(gltf.scene, MAX_ANISO);
      applyFadeMaterials(gltf.scene);
      staticCastDirty = true; // §18.87 — new geometry: raycast cache stale
      const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : null;
      const actions = new Map();
      if (mixer) for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
      // The REST pose, node by node, exactly as the file shipped it. This is
      // what '__bind__' restores. NOT Skeleton.pose() — that recomputes bone
      // locals through matrixWorld and detonates under an element-scaled
      // armature (a 0.01-scale character vanished). Top-level nodes are
      // excluded: elements own their transforms (applyTransform).
      const rest = [];
      gltf.scene.traverse((o) => {
        if (o === gltf.scene || o.parent === gltf.scene) return;
        rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
      });
      // Name → object, captured AT LOAD. Binding must resolve through THIS,
      // never getObjectByName on the scene: a mounted item is reparented into
      // its host's skeleton, live lookup fails there, and the cross-glb
      // fallback then grabs the first same-named node — with every glb
      // shipping a top-level "Armature", that welded a picked-up lance into
      // the hand forever and drove a character with the lance's transform.
      const nodeMap = new Map();
      gltf.scene.traverse((o) => {
        if (o.name && !nodeMap.has(o.name)) nodeMap.set(o.name, o);
      });
      // The ORIGINAL top-level nodes, captured before any mount reparents
      // them — build() hides the ones no element claims (a deleted element's
      // node must not haunt the scene).
      const topNodes = [...gltf.scene.children];
      const entry = { gltf, mixer, actions, clips: gltf.animations.map((a) => a.name), current: null, rest, atRest: false, lastEl: null, playEl: null, nodeMap, topNodes };
      if (mixer) {
        mixer.addEventListener('finished', () => {
          if (onClipEnd) { const t = finishTarget(entry); if (t) onClipEnd(t); }
        });
      }
      glbs.set(name, entry);
      scene.add(gltf.scene);
      return entry;
    })();
    loading.set(name, p);
    return p;
  }

  /* -- near-plane fading (§18.33) ------------------------------------------ */
  //
  // The the reference action game trick, by its right name: a mesh CLOSE TO THE CAMERA dithers out
  // smoothly instead of slicing across the near plane — back the camera into
  // a wall and the wall screen-doors away, keeping the character in view.
  // Per-FRAGMENT (only the near part of a long wall fades), via a Bayer
  // discard so the pipeline stays opaque (no transparency sorting, and the
  // dither reads right at home next to the PSX crunch). Distance is
  // `length(vViewPosition)` — free in every lit material, per-camera by
  // construction, so the same mesh fades for the play camera and the editor
  // orbit alike. Skinned meshes are exempt (characters are the thing the
  // fade exists to keep visible). Default ON for every static mesh; an
  // element opts out with `(nearFade false)` (applyNearFade, in update).

  // Tuned to the third-person BOOM (~3.4 m): a wall between camera and
  // character sits 2–3 m from the lens, so the band must reach almost to the
  // character herself — and stop just short, so she, her weapon, and props
  // she stands beside never dither.
  const FADE_GONE = 1.2; // fully dithered away this close, metres
  const FADE_FULL = 3.2; // fully opaque beyond this

  function injectNearFade(shader) {
    // The fade reads `vViewPosition`, a varying only LIT materials declare. The
    // diet exporter's mo1 pass folds flat/opaque surfaces to an unlit
    // MeshBasicMaterial (KHR_materials_unlit), which has no such varying — the
    // string even shows up in #ifdef-guarded chunks, so a text test is unsafe.
    // `onBeforeCompile` runs as a material method, so `this` IS the material:
    // only inject where the lit varying genuinely exists.
    const lit = this && (this.isMeshStandardMaterial || this.isMeshPhysicalMaterial ||
      this.isMeshPhongMaterial || this.isMeshToonMaterial || this.isMeshLambertMaterial);
    if (!lit) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      {
        float aeFade = smoothstep(${FADE_GONE.toFixed(2)}, ${FADE_FULL.toFixed(2)}, length(vViewPosition));
        if (aeFade < 0.999) {
          const mat4 AE_BAYER = mat4(
             0.0, 12.0,  3.0, 15.0,
             8.0,  4.0, 11.0,  7.0,
             2.0, 14.0,  1.0, 13.0,
            10.0,  6.0,  9.0,  5.0) / 16.0;
          ivec2 aeQ = ivec2(mod(gl_FragCoord.xy, 4.0));
          if (aeFade <= AE_BAYER[aeQ.x][aeQ.y]) discard;
        }
      }`,
    );
  }

  // base material -> fading twin, and the reverse — GLOBAL, so twins are
  // shared across glbs and re-registered onto clones. Stored as DIRECT
  // properties on meshes (ae1FadeMat/ae1BaseMat), never userData: Object3D
  // .clone() JSON-round-trips userData, which would mangle a material into
  // junk and crash the first toggled clone.
  const fadeTwins = new Map();
  const fadeBases = new Map();

  /** Give every static mesh a fading twin of its material (shared per source
   *  material, so one glb still compiles one program) and start ON —
   *  nearFade is the default. `applyNearFade` swaps per element. Safe to
   *  call on clones: a mesh already wearing a twin just re-registers. */
  function applyFadeMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || Array.isArray(o.material)) return;
      // §18.33 addendum — GROUND AUTO-EXEMPT (default look only). A floor/terrain
      // slab spans BOTH horizontal axes, so the third-person camera (forever
      // skimming the ground at the character's feet) keeps its near part inside
      // the 1.2-3.2 m fade band, and the screen-fixed Bayer holes crawl as the
      // ground slides under them — Austin's "scan lines strobbing on every
      // texture." So a big-footprint mesh starts with its BASE material (never
      // dithers by default). But it STILL gets a twin, so an element that opts in
      // (`nearFade true`) can fade a big spread-out OCCLUDER — the the reference MMO town's
      // per-material meshes each span the whole map yet are walls, not floor, and
      // must dither out when the camera backs into them. Geometry bounds are the
      // glb's authored metres (terrain ships 1:1), before element scale.
      const geo = o.geometry;
      let big = false;
      if (geo) {
        if (!geo.boundingBox) geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (bb) {
          const FLOOR_MIN = 24; // metres in BOTH horizontal axes ⇒ floor-scale
          big = (bb.max.x - bb.min.x) > FLOOR_MIN && (bb.max.z - bb.min.z) > FLOOR_MIN;
        }
      }
      if (fadeBases.has(o.material)) {
        o.ae1FadeMat = o.material; // a clone arrives already wearing the twin
        o.ae1BaseMat = fadeBases.get(o.material);
        return;
      }
      let fm = fadeTwins.get(o.material);
      if (!fm) {
        fm = o.material.clone();
        fm.onBeforeCompile = injectNearFade;
        fadeTwins.set(o.material, fm);
        fadeBases.set(fm, o.material);
      }
      o.ae1BaseMat = o.material;
      o.ae1FadeMat = fm;
      o.ae1BigFoot = big;          // remembered for the per-element default
      if (!big) o.material = fm;    // small meshes fade by default; big keep base
    });
  }

  function applyNearFade(el, obj) {
    // A WIELDED item never fades: it is part of the character the fade
    // exists to keep visible, and it lives closer to the camera than any
    // wall — the band would shave it.
    const mounted = !!el.components?.model?.mount?.host;
    // Tri-state: an EXPLICIT nearFade wins (a spread-out occluder like the the reference MMO
    // town sets it true to dither near the camera; a floor sets it false). With
    // nothing set, the DEFAULT is per-mesh — small meshes fade, big-footprint
    // (floor-scale) meshes don't — so existing projects are unchanged and grounds
    // never strobe. `mode` is 'on' | 'off' | 'default'.
    let mode = 'default';
    if (el.nearFade === true || el.nearFade === 'true') mode = 'on';
    else if (el.nearFade === false || el.nearFade === 'false') mode = 'off';
    if (mounted) mode = 'off';
    if (obj.ae1FadeMode === mode) return;
    obj.ae1FadeMode = mode;
    obj.traverse((o) => {
      if (!o.ae1FadeMat) return;
      const fade = mode === 'on' ? true : mode === 'off' ? false : !o.ae1BigFoot;
      o.material = fade ? o.ae1FadeMat : o.ae1BaseMat;
    });
  }

  /**
   * Should this element's object render at all? One rule beyond the checkbox:
   * a PROJECTILE TEMPLATE (an element with `launch()` that was never spawned)
   * is a MOLD, not a prop — ammunition exists only from the muzzle to the hit
   * (§18.15/§18.21). Duck-typed so the renderer stays class-free; it hides in
   * the EDITOR viewport and the shipped game alike.
   */
  function wantsVisible(el) {
    if (el.visible === false) return false;
    if (typeof el.launch === 'function' && !el._spawned) return false;
    return true;
  }

  function applyTransform(obj, el) {
    // §18.87 DIRTY GUARD: writing position/rotation/scale marks the whole
    // subtree's world matrices dirty even when the values are identical —
    // and the §18.53 static freeze only skips the LOCAL updateMatrix, not
    // the world multiply under a dirtied root. Most elements never move;
    // comparing ten numbers spares their entire subtree traversal. A
    // mount/unmount invalidates the tuple (applyMount owns the transform
    // while mounted and hands it back dirty).
    const x = el.x ?? 0, y = el.y ?? 0, z = el.z ?? 0;
    const rx = el.rotationX ?? 0, ry = el.rotationY ?? 0, rz = el.rotation ?? 0;
    const sx = el.scaleX ?? 1, sy = el.scaleY ?? 1, sz = el.scaleZ ?? 1;
    const ro = el.rotationOrder === 'YXZ' ? 1 : 0;
    let t = obj.ae1Xf; // direct prop, never userData (§18.36 — clone safety)
    if (!t) t = obj.ae1Xf = new Float64Array(10).fill(NaN);
    if (t[0] !== x || t[1] !== y || t[2] !== z || t[3] !== rx || t[4] !== ry
      || t[5] !== rz || t[6] !== sx || t[7] !== sy || t[8] !== sz || t[9] !== ro) {
      obj.position.set(x, y, z);
      // 'YXZ' opt-in (§18.52): yaw about world-up FIRST, then pitch about the
      // yawed local X, then roll — what an aircraft's heading/pitch/bank mean.
      // The default 'XYZ' pitches about the un-yawed axis, so pitching an
      // east-facing craft rolled it (Austin's "subtle banking on W/S").
      obj.rotation.set(rx * DEG, ry * DEG, rz * DEG, ro ? 'YXZ' : 'XYZ');
      obj.scale.set(sx, sy, sz);
      t[0] = x; t[1] = y; t[2] = z; t[3] = rx; t[4] = ry;
      t[5] = rz; t[6] = sx; t[7] = sy; t[8] = sz; t[9] = ro;
    }
    // ae1CullHidden is the 1 Hz distance-cull verdict (sweepCullDistance).
    // It must be honored HERE: this assignment runs every frame, and a
    // plain `wantsVisible` overwrote the sweep a frame after it fired —
    // §18.53's cullDistance was silently inert until this guard.
    const vis = wantsVisible(el) && !obj.userData.ae1CullHidden;
    if (obj.visible !== vis) {
      obj.visible = vis;
      staticCastDirty = true; // §18.87 — shown/hidden geometry changes the cast set
    }
  }

  const _ws = new THREE.Vector3();

  /**
   * The SOCKET mount (§18.11): a `mount` component on the model bag parents
   * this element's object to a BONE of another element (a wielded item in a
   * hand). `{host: <element name>, bone: <node name or '' to auto-detect a
   * right hand>, px,py,pz (WORLD units), rx,ry,rz (deg), scale (world)}`.
   * Offsets author in world units; bone space is usually element-scaled
   * (a cm-authored armature is 0.01), so everything is divided by the bone's
   * world scale. Clearing the mount reparents the object home and hands the
   * transform back to applyTransform. Returns true while mounted.
   */
  function applyMount(el) {
    const obj = bindings.get(el.id);
    if (!obj) return false;
    const m = el.components?.model?.mount;

    if (!m || !m.host) {
      // Unmount: back to the original parent, element transform resumes.
      if (obj.ae1Parent && obj.parent !== obj.ae1Parent) {
        obj.ae1Parent.add(obj);
        obj.ae1Xf = null;        // §18.87 — force applyTransform to rewrite
        staticCastDirty = true;  // no longer bone-mounted: ground again
      }
      return false;
    }

    const hostEl = elements().find((e) => e.name === m.host);
    const hostObj = hostEl && bindings.get(hostEl.id);
    if (!hostObj) return false;

    let bone = m.bone ? hostObj.getObjectByName(m.bone) : null;
    if (!bone) {
      // No named bone → find a right hand the Mixamo way. Cache on the host.
      if (!hostObj.ae1RightHand) {
        hostObj.traverse((o) => {
          if (!hostObj.ae1RightHand && o.isBone && /right[\W_]*hand$|hand[\W_]*r$/i.test(o.name)) {
            hostObj.ae1RightHand = o;
          }
        });
      }
      bone = hostObj.ae1RightHand;
    }
    if (!bone) return false;

    if (obj.parent !== bone) {
      // DIRECT property, never userData (§18.36): Object3D.clone() JSON-
      // round-trips userData, and an Object3D stored there is CIRCULAR — one
      // mounted-then-cloned node crashed the whole claim pass, unbinding
      // every element after it ("my weapon is invisible"). Same law as the
      // fade-material twins. Direct props also stay off clones, which is
      // right: a clone derives its own caches.
      obj.ae1Parent ??= obj.parent;
      bone.add(obj);
      obj.ae1Xf = null;        // §18.87 — transform ownership changed hands
      staticCastDirty = true;  // bone-mounted: out of the ground-cast set
    }
    // THE HAND HOLDS ONE THING (§18.32): evict any OTHER mounted mesh still
    // hanging on this bone. glbs are CACHED across scene changes, so a mesh
    // parented into the hand can outlive its scene — without this, a stale
    // key welds itself alongside the freshly equipped lance.
    for (const c of [...bone.children]) {
      if (c !== obj && c.ae1Parent) c.ae1Parent.add(c);
    }
    bone.getWorldScale(_ws);
    const inv = 1 / (_ws.x || 1);
    // LIVE dat first (a Hitbox element carries mountX/mountOffsetX… accessors —
    // tuning them in Properties during play moves the grip immediately); the
    // equip-time snapshot in the component covers anything else.
    const px = Number(el.mountX ?? m.px) || 0;
    const py = Number(el.mountY ?? m.py) || 0;
    const pz = Number(el.mountZ ?? m.pz) || 0;
    const rx = Number(el.mountOffsetX ?? m.rx) || 0;
    const ry = Number(el.mountOffsetY ?? m.ry) || 0;
    const rz = Number(el.mountOffsetZ ?? m.rz) || 0;
    // Natural world size = the element's authored scale; ×mountScale on top;
    // ÷bone world scale so the bone's own scaling cancels out.
    const s = (Number(m.scale) || 1) * (el.scaleX ?? 1) * inv;
    obj.scale.setScalar(s);

    // ITEM-AUTHORED GRIP (§18.14): a child node (a Blender Empty parented to
    // the mesh — e.g. "SocketRightHand") whose frame should land exactly ON
    // the hand bone. Place the item so the socket coincides with the bone;
    // the mountOffset numbers become fine-tune ON TOP, not the whole grip.
    let grip = null;
    if (obj.ae1Grip === undefined) {
      const wantName = m.grip || '';
      obj.traverse((o) => {
        if (obj.ae1Grip) return;
        if (wantName ? o.name === wantName : /socket[\W_]*right[\W_]*hand/i.test(o.name)) {
          if (o !== obj) obj.ae1Grip = o;
        }
      });
      obj.ae1Grip ??= null; // remembered either way
    }
    grip = obj.ae1Grip;

    if (grip && grip.parent === obj) {
      const offQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG, 'XYZ'));
      const iq = grip.quaternion.clone().invert();
      obj.quaternion.copy(offQ).multiply(iq);
      const p = grip.position
        .clone()
        .applyQuaternion(iq)
        .multiplyScalar(-s)
        .applyQuaternion(offQ);
      obj.position.set(p.x + px * inv, p.y + py * inv, p.z + pz * inv);
      applyAimAssist(el, obj, bone, grip);
    } else {
      obj.position.set(px * inv, py * inv, pz * inv);
      obj.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'XYZ');
    }
    obj.visible = wantsVisible(el);
    return true;
  }

  /**
   * AIM ASSIST (§18.16): pivot a wielded weapon ABOUT ITS GRIP so the muzzle
   * axis tracks the focal point the character wrote into `model.aimAt`.
   * Priority order, per Austin: the right-hand GRIP anchors position (the
   * rotation is about that point — the weapon never leaves the hand), the
   * MUZZLE steers orientation (grip→muzzle is the barrel line), the left
   * hand is cosmetic and ignored. `(aimWeight 0.75)` keeps it partial —
   * subtle beats robotic — and `(aimMaxDeg 30)` caps how far the barrel may
   * swing off its animated pose, so a focal point behind her cannot fold the
   * bazooka through her shoulder. All three live-read from dat.
   */
  function applyAimAssist(el, obj, bone, grip) {
    const aimAt = el.components?.model?.aimAt;
    if (!Array.isArray(aimAt) || aimAt.length < 3) return;
    if (el.aimAssist === false || el.aimAssist === 'false') return;
    if (obj.ae1Muzzle === undefined) {
      const want = String(el.muzzleNode || '');
      obj.traverse((o) => {
        if (obj.ae1Muzzle) return;
        if (want ? o.name === want : /muzz/i.test(o.name)) { if (o !== obj) obj.ae1Muzzle = o; }
      });
      obj.ae1Muzzle ??= null;
    }
    const muzzle = obj.ae1Muzzle;
    if (!muzzle) return;

    // Barrel line now vs wanted, in world space. (getWorldPosition refreshes
    // the parent chain, so the grip transform just written above is honoured;
    // the bone pose is last frame's — a partial, clamped nudge hides that.)
    const gW = grip.getWorldPosition(new THREE.Vector3());
    const mW = muzzle.getWorldPosition(new THREE.Vector3());
    const d1 = mW.sub(gW).normalize();
    const d2 = new THREE.Vector3(aimAt[0], aimAt[1], aimAt[2]).sub(gW).normalize();
    if (d1.lengthSq() < 0.5 || d2.lengthSq() < 0.5) return;

    let qd = new THREE.Quaternion().setFromUnitVectors(d1, d2);
    const maxRad = Math.max(0, Number(el.aimMaxDeg ?? 30)) * DEG;
    const weight = Math.max(0, Math.min(1, Number(el.aimWeight ?? 0.75)));
    const ang = 2 * Math.acos(Math.min(1, Math.abs(qd.w)));
    let t = weight;
    if (ang > 1e-4 && ang * weight > maxRad) t = maxRad / ang;
    if (t <= 0) return;
    qd = new THREE.Quaternion().slerp(qd, t);

    // LOW-PASS the correction (§18.37): the assist reads LAST frame's bone
    // pose, so the walk bob feeds straight into it and the muzzle whipped
    // around mid-stride. Smoothing the delta (direct prop, per the userData
    // law) keeps the barrel on the focal without riding every hip sway.
    obj.ae1AimQ = obj.ae1AimQ ? obj.ae1AimQ.slerp(qd, 0.12) : qd.clone();

    // Apply the world-space delta in bone space, rotating about the GRIP
    // POINT so the hold stays exactly in the hand.
    const bq = bone.getWorldQuaternion(new THREE.Quaternion());
    const localQ = bq.clone().invert().multiply(obj.ae1AimQ).multiply(bq);
    const gL = bone.worldToLocal(gW.clone());
    obj.position.sub(gL).applyQuaternion(localQ).add(gL);
    obj.quaternion.premultiply(localQ);
  }

  /* -- the sky (§18.13) --------------------------------------------------- */

  let skyState = null; // { name, owner, tex } — the applied .hdr
  const skyCache = new Map(); // media name -> THREE.DataTexture (decoded once)

  async function loadSkyTexture(name) {
    if (skyCache.has(name)) return skyCache.get(name);
    const url = mediaUrl?.(name);
    if (!url) return null;
    try {
      const { width, height, data } = decodeHDR(await (await fetch(url)).arrayBuffer());
      // §18.87: HALF float — an equirect that feeds PMREM and a soft backdrop
      // gains nothing from full float32, and halving it saves ~22 MB of VRAM
      // (+ the float mip chain) per sky.
      const half = new Uint16Array(data.length);
      const toHalf = THREE.DataUtils.toHalfFloat;
      for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
      const tex = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.LinearSRGBColorSpace; // .hdr is linear radiance
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      skyCache.set(name, tex);
      return tex;
    } catch (err) {
      console.warn(`[sky] Could not decode '${name}': ${err?.message ?? err}`);
      skyCache.set(name, null); // don't retry a bad file every frame
      return null;
    }
  }

  function resetSky() {
    skyState?.env?.dispose(); // the PMREM lighting copy is per-sky (§18.67)
    skyState = null;
    scene.background = baseBackground;
    scene.backgroundIntensity = 1;
    scene.backgroundRotation?.set(0, 0, 0);
    scene.environment = roomEnv;
    scene.environmentRotation?.set(0, 0, 0);
  }

  /**
   * A `sky` component (AE1Skybox) puts an equirect .hdr around the scene —
   * the background, and (light !== false) the image-based lighting too, so a
   * night sky makes the world night. Opacity dims via backgroundIntensity;
   * rotation turns background and environment together. Live dat wins over
   * the component snapshot (the mount pattern) — Properties tweaks apply
   * mid-play.
   */
  function applySky(el) {
    const sky = el.components?.sky;
    const name = sky?.media || (typeof el.sky === 'string' ? el.sky : '');
    if (!name) {
      if (skyState?.owner === el.id) resetSky();
      return;
    }
    if (skyState?.name !== name) {
      skyState = { name, owner: el.id, tex: null };
      loadSkyTexture(name).then((tex) => {
        if (skyState?.name !== name) return; // swapped again while decoding
        if (!tex) return resetSky();
        skyState.tex = tex;
        scene.background = tex;
        const light = !(el.lightScene === false || el.lightScene === 'false');
        // §18.67: the LIGHTING copy is PMREM-prefiltered. The raw equirect
        // has no roughness mips, so metals sampled the sharp texel grid and
        // glittered angle-dependently in motion (the flight unit's strobing
        // panels). PMREM builds the blurred mip chain PBR expects —
        // reflections go smooth and uniform; the BACKDROP keeps the raw
        // sharp texture (that crispness is wanted there).
        if (light) {
          const env = pmrem.fromEquirectangular(tex).texture;
          if (skyState?.name !== name) { env.dispose(); return; }
          skyState.env = env;
          scene.environment = env;
        } else {
          scene.environment = roomEnv;
        }
      });
    }
    scene.backgroundIntensity = Math.max(0, Number(el.skyOpacity ?? sky.opacity ?? 1));
    // §18.57: how strongly the sky HDRI LIGHTS PBR materials (reflections
    // included) — separate from how bright it draws as the backdrop. The
    // Factory's metallic floors at intensity 1 rendered as sky-blue mirrors
    // (Austin's "the floor is reflecting the HDRI"); ~0.3 reads as painted
    // metal under a night sky. Default 1 = the old behavior everywhere.
    const envI = Number(el.envIntensity ?? sky.envIntensity ?? 1);
    if (scene.environmentIntensity !== envI) scene.environmentIntensity = Math.max(0, envI);
    const rot = (Number(el.skyRotation ?? sky.rotation) || 0) * DEG;
    scene.backgroundRotation?.set(0, rot, 0);
    scene.environmentRotation?.set(0, rot, 0);
  }

  /** element.id -> cloned object for spawned duplicates (fired rounds). */
  const spawnClones = new Map();

  /**
   * Clone a node WITH ITS SKELETON (§18.36). `Object3D.clone(true)` copies a
   * SkinnedMesh but leaves it bound to the ORIGINAL's bones — the carried
   * lance's clone rendered wherever the rack lance's armature stood, which
   * read as "my weapon is invisible". This is SkeletonUtils.clone, hand-
   * rolled (SkeletonUtils is not vendored): map source→clone node pairs,
   * then rebind every cloned SkinnedMesh to the CLONED bones.
   */
  function cloneWithSkeleton(source) {
    const toSource = new Map();
    const toClone = new Map();
    const result = source.clone(true);
    (function pair(a, b) {
      toSource.set(b, a);
      toClone.set(a, b);
      for (let i = 0; i < a.children.length; i++) pair(a.children[i], b.children[i]);
    })(source, result);
    result.traverse((node) => {
      if (!node.isSkinnedMesh) return;
      const src = toSource.get(node);
      if (!src?.skeleton) return;
      const skeleton = src.skeleton.clone();
      // A bone outside the cloned subtree keeps the original (best effort).
      skeleton.bones = src.skeleton.bones.map((b) => toClone.get(b) ?? b);
      node.bindMatrix.copy(src.bindMatrix);
      node.bind(skeleton, node.bindMatrix);
    });
    return result;
  }

  /** How far into its CURRENT clip an element's glb is: {t, d} seconds, or
   *  null. The character's attack asks this to time a projectile spawn to a
   *  fraction of the firing animation (§18.15). */
  function clipTime(el) {
    const entry = glbs.get(el.components?.model?.media);
    const a = entry?.current;
    if (!a) return null;
    return { t: a.time, d: a.getClip().duration };
  }

  /** SLAVE an element's playing clip to an external clock (§18.52): the
   *  aircraft phase-locks its hull cycle to the pilot's action age every
   *  tick, so the synced pair can never drift — not across tab suspends,
   *  not across clock clamps. Loops take the time modulo their duration;
   *  one-shots clamp just short of the end (the finished edge still fires
   *  from the mixer's own advance). No-op while nothing plays. */
  function setClipTime(el, t) {
    const entry = glbs.get(el.components?.model?.media);
    const a = entry?.current;
    if (!a || !Number.isFinite(t)) return false;
    const d = a.getClip().duration;
    if (!(d > 0)) return false;
    a.time = a.loop === THREE.LoopRepeat ? t % d : Math.min(t, d - 1e-3);
    return true;
  }

  /** element.id -> THREE.Line for its debug path. */
  const pathLines = new Map();

  /**
   * A visible route (§18.12): an element with a `debug.path` component — a
   * flat [x,y,z, x,y,z…] polyline — gets a line drawn through it. An NPC
   * writes its planned waypoints here while `(drawPaths true)`; clearing the
   * component removes the line.
   */
  function applyPath(el) {
    const pts = el.components?.debug?.path;
    const line = pathLines.get(el.id);
    if (!Array.isArray(pts) || pts.length < 6) {
      if (line) {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        pathLines.delete(el.id);
      }
      return;
    }
    const v = [];
    for (let i = 0; i + 2 < pts.length; i += 3) v.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
    if (!line) {
      const l = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(v),
        new THREE.LineBasicMaterial({ color: 0x33ddff }),
      );
      scene.add(l);
      pathLines.set(el.id, l);
    } else if (v.length > (line.geometry.getAttribute('position')?.count ?? 0)) {
      // A GROWING path (a projectile trail) outruns its first buffer —
      // setFromPoints on a too-small buffer clamps and warns. Reallocate.
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(v);
    } else {
      line.geometry.setFromPoints(v);
      line.geometry.setDrawRange(0, v.length); // a SHRUNK path draws fewer
    }
  }

  /* -- scatter (§18.23): one archetype, many render copies ----------------- */

  const scatterSets = new Map(); // element.id -> {key, clones?, insts?}
  const _scUp = new THREE.Vector3(0, 1, 0);
  const _scQ = new THREE.Quaternion();
  const _scQ2 = new THREE.Quaternion();
  const _scBox = new THREE.Box3();
  // §18.93 instancing scratch — reused per row, no per-frame alloc
  const _scRoot = new THREE.Matrix4();
  const _scM = new THREE.Matrix4();
  const _scPos = new THREE.Vector3();
  const _scScl = new THREE.Vector3();
  const _scZero = new THREE.Matrix4().makeScale(0, 0, 0); // a hidden instance

  /**
   * `(spawns …)` on a Scatter element: place CLONES of its bound object at
   * each row — geometry and materials SHARED, so a forest of one tree costs
   * one mesh. Rebuilt only when the list changes; positions, the archetype's
   * live rotation/scale, and visibility sync every call, so tuning numbers in
   * Properties moves copies immediately — in the editor viewport too. With
   * `(spawnSnap true)` each copy drops to the ground under its x,z (the
   * ground ray only sees glb scenes, so clones never snap onto each other —
   * and, deliberately, copies are DRESSING: no collision, no hitbox).
   */
  function scatterCleanup(s) {
    if (!s) return;
    if (s.clones) for (const c of s.clones) scene.remove(c);
    if (s.insts) for (const im of s.insts) { scene.remove(im); im.dispose(); }
  }

  function applyScatter(el) {
    const list = typeof el.spawnList === 'function' ? el.spawnList() : null;
    const obj = bindings.get(el.id);
    let s = scatterSets.get(el.id);
    if (!obj || !list?.length || el.visible === false) {
      if (s) { scatterCleanup(s); scatterSets.delete(el.id); }
      return;
    }
    const snap = el.spawnSnap === true || el.spawnSnap === 'true';
    // §18.93: a scattered ARCHETYPE is static dressing (no collision, no
    // hitbox), so its non-skinned meshes become ONE InstancedMesh each —
    // a thousand trees is a handful of draw calls instead of a thousand
    // clones. A skinned archetype (rare — a crowd of animated things) keeps
    // the clone path: InstancedMesh has no per-instance skeleton.
    let skinned = false;
    obj.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
    const key = JSON.stringify([list, snap, skinned]);

    if (!s || s.key !== key) {
      scatterCleanup(s);
      if (skinned) {
        s = { key, clones: list.map(() => {
          const c = obj.clone(true);
          c.userData.ae1Scatter = el.id;
          scene.add(c);
          return c;
        }) };
      } else {
        // One InstancedMesh per archetype mesh; cache each mesh's transform
        // RELATIVE to the archetype root so a multi-part model (trunk +
        // fronds) instances correctly.
        obj.updateWorldMatrix(true, true);
        _scM.copy(obj.matrixWorld).invert(); // root^-1 (reused immediately)
        const rootInv = _scM.clone();
        const insts = [];
        obj.traverse((m) => {
          if (!m.isMesh || m.isSkinnedMesh) return;
          const im = new THREE.InstancedMesh(m.geometry, m.material, list.length);
          im.userData.ae1Scatter = el.id;
          im.userData.ae1Local = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld);
          im.frustumCulled = false; // rows sprawl; whole-set cull is wrong here
          im.castShadow = m.castShadow;
          scene.add(im);
          insts.push(im);
        });
        s = { key, insts };
      }
      scatterSets.set(el.id, s);
    }

    // Snap plants the mesh's FOOT, not its origin (§18.23): the below-origin
    // extent from the live world box, added back per copy at the copy's scale.
    let foot = 0;
    if (snap) {
      _scBox.setFromObject(obj);
      if (!_scBox.isEmpty()) foot = (Number(el.y) || 0) - _scBox.min.y;
    }

    // -- clone path (skinned archetype) -------------------------------------- //
    if (s.clones) {
      for (let i = 0; i < list.length; i++) {
        const [x, y, z, yaw, k] = list[i];
        const c = s.clones[i];
        const gy = snap ? groundAt(el, x, z, Math.abs(y) + 50) : null;
        if (snap && gy == null) { if (!c.userData.ae1Placed) c.visible = false; continue; }
        c.position.set(x, gy != null ? gy + foot * k + y : y, z);
        c.quaternion.copy(obj.quaternion);
        if (yaw) c.quaternion.premultiply(_scQ.setFromAxisAngle(_scUp, yaw * DEG));
        c.scale.copy(obj.scale).multiplyScalar(k);
        c.visible = obj.visible;
        c.userData.ae1Placed = true;
      }
      return;
    }

    // -- instanced path ------------------------------------------------------ //
    for (const im of s.insts) im.visible = obj.visible;
    for (let i = 0; i < list.length; i++) {
      const [x, y, z, yaw, k] = list[i];
      const gy = snap ? groundAt(el, x, z, Math.abs(y) + 50) : null;
      if (snap && gy == null) {
        // ground not ready this frame (§18.31): park the instance invisibly
        // (zero scale) until it answers — never hang it at the raw offset.
        for (const im of s.insts) if (!im.userData.ae1Placed) im.setMatrixAt(i, _scZero);
        continue;
      }
      _scPos.set(x, gy != null ? gy + foot * k + y : y, z);
      _scQ.copy(obj.quaternion);
      if (yaw) _scQ.premultiply(_scQ2.setFromAxisAngle(_scUp, yaw * DEG));
      _scScl.copy(obj.scale).multiplyScalar(k);
      _scRoot.compose(_scPos, _scQ, _scScl);
      for (const im of s.insts) {
        _scM.multiplyMatrices(_scRoot, im.userData.ae1Local);
        im.setMatrixAt(i, _scM);
      }
    }
    for (const im of s.insts) {
      im.instanceMatrix.needsUpdate = true;
      im.userData.ae1Placed = true;
    }
  }

  /** element.id -> THREE.Line for its AIM lines (camera → focal → muzzle). */
  const aimLines = new Map();

  /** The aim triangulation (§18.16): a `debug.aim` polyline, drawn in warm
   *  ink so it never reads as an NPC route. Same lifecycle as applyPath. */
  function applyAim(el) {
    const pts = el.components?.debug?.aim;
    const line = aimLines.get(el.id);
    if (!Array.isArray(pts) || pts.length < 6) {
      if (line) {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        aimLines.delete(el.id);
      }
      return;
    }
    const v = [];
    for (let i = 0; i + 2 < pts.length; i += 3) v.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
    if (!line) {
      const l = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(v),
        new THREE.LineBasicMaterial({ color: 0xffaa33 }),
      );
      scene.add(l);
      aimLines.set(el.id, l);
    } else if (v.length > (line.geometry.getAttribute('position')?.count ?? 0)) {
      // The muzzle leg appears when a weapon is picked up mid-play: the line
      // GROWS from 2 points to 3, and a too-small buffer clamps silently.
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(v);
    } else {
      line.geometry.setFromPoints(v);
      line.geometry.setDrawRange(0, v.length);
    }
  }

  /** World position of a NAMED node inside an element's bound object — the
   *  muzzle of a mounted weapon (§18.16). Exact name first, else the first
   *  node matching /muzzle-ish/ (Blender Empties survive as plain nodes).
   *  Null before binding. */
  function nodePos(el, name) {
    const obj = bindings.get(el.id);
    if (!obj) return null;
    let node = name ? obj.getObjectByName(name) : null;
    if (!node) {
      const want = String(name || 'muzzle').toLowerCase();
      obj.traverse((o) => {
        if (node) return;
        const n = o.name?.toLowerCase() ?? '';
        if (n === want || /muzz/.test(n)) node = o;
      });
    }
    if (!node) return null;
    const p = node.getWorldPosition(new THREE.Vector3());
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Drop every debug line at once — the editor calls this on play EXIT, so
   *  routes, trails, and aim tracers never linger into edit mode. Live
   *  particles die with the session too: effects are PLAY things. */
  function clearDebug() {
    for (const m of [pathLines, aimLines]) {
      for (const line of m.values()) {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
      }
      m.clear();
    }
    for (const em of fxEmitters.values()) {
      em.age.set(em.life); // everything instantly at end-of-life
      em.points.visible = false;
    }
  }

  /* -- particles (§18.22) -------------------------------------------------- */
  //
  // Four presets, zero assets: the sprite textures are drawn on a CANVAS at
  // first use — soft radial gradients (feathered edges are the whole look;
  // hard edges read as artificial) — so nothing must be fetched, authored, or
  // inlined, and file:// exports carry them for free. 64px: hundreds may be
  // on screen. The sim is CPU + one THREE.Points per emitter with a tiny
  // point shader (per-particle size and alpha — PointsMaterial has neither).

  const fxTextures = new Map();
  function fxTexture(kind) {
    if (fxTextures.has(kind)) return fxTextures.get(kind);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const blob = (x, y, r, stops) => {
      const gr = g.createRadialGradient(x, y, 1, x, y, r);
      for (const [t, col] of stops) gr.addColorStop(t, col);
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
    };
    if (kind === 'flame') {
      // Bright core fading through orange — drawn tall-ish by a second blob.
      blob(32, 36, 26, [[0, 'rgba(255,255,224,1)'], [0.35, 'rgba(255,190,90,0.9)'], [0.7, 'rgba(255,100,20,0.4)'], [1, 'rgba(255,60,0,0)']]);
      blob(32, 22, 16, [[0, 'rgba(255,240,180,0.8)'], [1, 'rgba(255,150,40,0)']]);
    } else if (kind === 'splash') {
      blob(32, 32, 24, [[0, 'rgba(230,244,255,0.95)'], [0.5, 'rgba(170,210,255,0.5)'], [1, 'rgba(150,190,255,0)']]);
    } else if (kind === 'explosion') {
      // A main fireball plus offset blobs — the jagged, noisy read.
      blob(32, 32, 30, [[0, 'rgba(255,255,230,1)'], [0.3, 'rgba(255,200,90,0.85)'], [0.7, 'rgba(255,90,30,0.35)'], [1, 'rgba(200,40,0,0)']]);
      blob(18, 24, 12, [[0, 'rgba(255,220,140,0.6)'], [1, 'rgba(255,120,30,0)']]);
      blob(46, 40, 12, [[0, 'rgba(255,220,140,0.6)'], [1, 'rgba(255,120,30,0)']]);
      blob(40, 16, 9, [[0, 'rgba(255,230,170,0.5)'], [1, 'rgba(255,140,40,0)']]);
    } else {
      // smoke: an amorphous soft grey — three overlapping blobs.
      blob(32, 32, 28, [[0, 'rgba(210,210,210,0.75)'], [0.6, 'rgba(160,160,160,0.35)'], [1, 'rgba(130,130,130,0)']]);
      blob(20, 26, 14, [[0, 'rgba(200,200,200,0.4)'], [1, 'rgba(150,150,150,0)']]);
      blob(44, 38, 14, [[0, 'rgba(200,200,200,0.4)'], [1, 'rgba(150,150,150,0)']]);
    }
    const tex = new THREE.CanvasTexture(c);
    fxTextures.set(kind, tex);
    return tex;
  }

  // REAL sprite sheets for particles (§18.52): an fx component may name a
  // MEDIA image (`texture`) — the reference game's own extracted effect sprites ride the
  // same emitters as the canvas blobs. TextureLoader returns synchronously
  // and fills in when the fetch lands, so no placeholder dance.
  const fxMediaTex = new Map();
  function fxMediaTexture(name) {
    if (fxMediaTex.has(name)) return fxMediaTex.get(name);
    const url = mediaUrl?.(name);
    if (!url) return null;
    const tex = new THREE.TextureLoader().load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    fxMediaTex.set(name, tex);
    return tex;
  }

  // What each effect IS: pool size, per-particle life/size ranges, launch
  // speed, cone spread (1 = full sphere → radial burst), buoyant lift vs
  // gravity, tint, and blending (additive glows; smoke occludes).
  const FX_PRESETS = {
    flame: { count: 60, life: [0.35, 0.8], size: [0.2, 0.4], grow: 1.4, speed: [0.4, 1.0], spread: 0.18, lift: 1.4, gravity: 0, color: 0xffc077, blend: 'add', maxAlpha: 1 },
    smoke: { count: 36, life: [1.0, 2.2], size: [0.25, 0.5], grow: 2.4, speed: [0.25, 0.6], spread: 0.35, lift: 0.8, gravity: 0, color: 0xaaaaaa, blend: 'normal', maxAlpha: 0.45 },
    splash: { count: 64, life: [0.35, 0.7], size: [0.06, 0.14], grow: 0.5, speed: [1.6, 3.2], spread: 0.8, lift: 0, gravity: -9, color: 0xbcd8ff, blend: 'normal', maxAlpha: 0.9 },
    explosion: { count: 90, life: [0.25, 0.7], size: [0.25, 0.55], grow: 3.2, speed: [1.5, 4.5], spread: 1, lift: 0, gravity: 0, color: 0xffcc77, blend: 'add', maxAlpha: 1 },
  };

  const fxEmitters = new Map(); // element.id -> emitter
  const _q1 = new THREE.Quaternion();
  const _fxOff = new THREE.Vector3();

  function fxDispose(id) {
    const em = fxEmitters.get(id);
    if (!em) return;
    scene.remove(em.points);
    em.points.geometry.dispose();
    em.points.material.dispose();
    fxEmitters.delete(id);
  }

  function fxEnsure(el, kind, texName = '', colorHex = '') {
    const key = `${kind}|${texName}|${colorHex}`;
    let em = fxEmitters.get(el.id);
    if (em && em.key === key) return em;
    if (em) fxDispose(el.id);
    const p = FX_PRESETS[kind] ?? FX_PRESETS.smoke;
    const n = p.count;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    const mediaTex = texName ? fxMediaTexture(texName) : null;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: mediaTex ?? fxTexture(kind) },
        color: { value: new THREE.Color(colorHex || p.color) },
      },
      vertexShader:
        'attribute float size; attribute float alpha; varying float vA;\n' +
        'void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
        'gl_PointSize = size * (240.0 / -mv.z); gl_Position = projectionMatrix * mv; }',
      fragmentShader:
        'uniform sampler2D map; uniform vec3 color; varying float vA;\n' +
        'void main(){ vec4 t = texture2D(map, gl_PointCoord);\n' +
        'gl_FragColor = vec4(color * t.rgb, t.a * vA); if (gl_FragColor.a < 0.012) discard; }',
      transparent: true,
      depthWrite: false,
      blending: p.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false; // positions churn; a stale sphere blinks them out
    points.visible = false;
    scene.add(points);
    em = {
      kind, key, preset: p, points, n,
      vel: new Float32Array(n * 3),
      age: new Float32Array(n).fill(1e9),
      life: new Float32Array(n).fill(1),
      size0: new Float32Array(n),
      anchor: new THREE.Vector3(),
      lastBurst: 0,
      cfg: null,
    };
    fxEmitters.set(el.id, em);
    return em;
  }

  /** The element's fx component -> a live emitter (or none). Called from
   *  update(el) like every other component apply. */
  function applyFx(el) {
    const bag = el.components?.fx;
    if (!bag || el.visible === false) {
      const em = fxEmitters.get(el.id);
      if (em) em.cfg = null; // pool idles; existing particles fade out
      return;
    }
    const em = fxEnsure(el, String(bag.kind || 'smoke'), String(bag.texture || ''), String(bag.color || ''));
    em.cfg = bag;
    em.el = el;
  }

  function fxAnchor(em) {
    const bag = em.cfg;
    _fxOff.set(Number(bag.ox) || 0, Number(bag.oy) || 0, Number(bag.oz) || 0);
    let node = null;
    if (bag.host) {
      const hostEl = elements().find((e) => e.name === bag.host);
      const hostObj = hostEl && bindings.get(hostEl.id);
      if (hostObj && hostObj.visible !== false) {
        node = (bag.node && hostObj.getObjectByName(bag.node)) || hostObj;
      }
      if (!node) return false; // host named but not available: no emission
    }
    if (node) {
      node.getWorldPosition(em.anchor);
      node.getWorldQuaternion(_q1);
      em.anchor.add(_fxOff.applyQuaternion(_q1)); // offset in the NODE's frame
    } else {
      const el = em.el;
      em.anchor.set(el.x ?? 0, el.y ?? 0, el.z ?? 0).add(_fxOff);
    }
    return true;
  }

  function fxSpawn(em, i, stagger = 0) {
    const p = em.preset;
    const pos = em.points.geometry.getAttribute('position').array;
    em.age[i] = -stagger; // negative age = queued, invisible until it starts
    em.life[i] = p.life[0] + Math.random() * (p.life[1] - p.life[0]);
    em.size0[i] = p.size[0] + Math.random() * (p.size[1] - p.size[0]);
    pos[i * 3] = em.anchor.x + (Math.random() - 0.5) * 0.06;
    pos[i * 3 + 1] = em.anchor.y + (Math.random() - 0.5) * 0.06;
    pos[i * 3 + 2] = em.anchor.z + (Math.random() - 0.5) * 0.06;
    // Launch: spread 1 = a full sphere (radial burst); less = a cone about UP.
    const s = p.speed[0] + Math.random() * (p.speed[1] - p.speed[0]);
    let dx = (Math.random() * 2 - 1) * p.spread;
    let dy = p.spread >= 1 ? Math.random() * 2 - 1 : 1;
    let dz = (Math.random() * 2 - 1) * p.spread;
    const len = Math.hypot(dx, dy, dz) || 1;
    em.vel[i * 3] = (dx / len) * s;
    em.vel[i * 3 + 1] = (dy / len) * s;
    em.vel[i * 3 + 2] = (dz / len) * s;
  }

  /** One frame of every emitter: integrate, fade, respawn. renderFrame calls
   *  this with the same dt the mixers get. */
  function stepFx(dt) {
    for (const em of fxEmitters.values()) {
      const bag = em.cfg;
      const geo = em.points.geometry;
      const pos = geo.getAttribute('position');
      const size = geo.getAttribute('size');
      const alpha = geo.getAttribute('alpha');
      const p = em.preset;
      const anchored = bag ? fxAnchor(em) : false;
      const loop = !!bag && bag.loop !== false && anchored;
      const burstN = Number(bag?.burst) || 0;
      const doBurst = anchored && burstN !== em.lastBurst;
      em.lastBurst = burstN;
      const scale = Number(bag?.scale) || 1;
      let alive = 0;
      for (let i = 0; i < em.n; i++) {
        if (em.age[i] < em.life[i]) {
          em.age[i] += dt;
          if (em.age[i] < 0) { alpha.array[i] = 0; alive++; continue; } // queued
          em.vel[i * 3 + 1] += (p.lift + p.gravity) * dt;
          pos.array[i * 3] += em.vel[i * 3] * dt;
          pos.array[i * 3 + 1] += em.vel[i * 3 + 1] * dt;
          pos.array[i * 3 + 2] += em.vel[i * 3 + 2] * dt;
          const t = Math.max(0, em.age[i] / em.life[i]);
          alpha.array[i] = p.maxAlpha * (1 - t) * Math.min(1, t * 8); // snap in, fade out
          size.array[i] = em.size0[i] * (1 + p.grow * t) * scale;
          alive++;
        } else if (doBurst) {
          fxSpawn(em, i);
          alive++;
        } else if (loop) {
          fxSpawn(em, i, Math.random() * 0.2); // trickle, not a clump
          alive++;
        } else {
          alpha.array[i] = 0;
        }
      }
      pos.needsUpdate = true;
      size.needsUpdate = true;
      alpha.needsUpdate = true;
      em.points.visible = alive > 0;
    }
  }

  // §18.87 THE STATIC RAYCAST CACHE. Every geometry query (ground probes,
  // foot IK, wall sweeps — ~12-25 rays a frame with two matched characters)
  // used to re-walk every loaded glb's full subtree to collect candidates,
  // per ray. The candidate set only actually changes when geometry arrives,
  // build() reshapes the scene, or a visibility sweep flips something — so
  // it is cached flat and those sites set `staticCastDirty`. Per-ray
  // correctness (exclusions, hidden subtrees, bone-mounted items) moved to
  // per-HIT ancestor checks: hits are few, candidates were thousands.
  let staticCastDirty = true;
  let visEpoch = 0; // bumped when a 1 Hz sweep changes verdicts — re-arms applyParts
  const staticCastList = [];
  function staticCandidates() {
    if (staticCastDirty) {
      staticCastList.length = 0;
      const walk = (o) => {
        if (o.visible === false) return; // hidden libraries prune at their root
        if (o.isMesh && !o.isSkinnedMesh && !(o.parent && o.parent.isBone)) {
          staticCastList.push(o);
        }
        for (const c of o.children) walk(c);
      };
      for (const e of glbs.values()) walk(e.gltf.scene);
      staticCastDirty = false;
    }
    return staticCastList;
  }
  /** Post-hit guard: is this hit inside an excluded or since-hidden subtree,
   *  or mounted under a bone? (The cache is rebuilt lazily; the chain check
   *  keeps single-frame staleness harmless.) */
  function castHitSkipped(obj, exclude) {
    for (let o = obj; o; o = o.parent) {
      if (o === exclude) return true;
      if (o.visible === false) return true;
      if (o.parent && o.parent.isBone) return true; // carried things are never ground
    }
    return false;
  }

  const _aimRay = new THREE.Raycaster();

  /**
   * Where the CAMERA is looking (§18.16): a ray through the exact center of
   * the view, against the scene's static meshes. Returns the camera origin
   * and the FOCAL point — the first hit, or `maxDist` out along the view
   * axis. The shooter's own subtree is excluded (the camera sits behind the
   * character — her back is not a target), so are flying rounds and skinned
   * meshes (their raycast geometry is the bind pose, not the animated one —
   * an NPC still gets hit because the round crosses its VOLUME en route).
   */
  function aimPoint(el, maxDist = 60) {
    const excl = new Set([bindings.get(el?.id)].filter(Boolean));
    for (const e of elements()) if (e._spawned) { const o = bindings.get(e.id); if (o) excl.add(o); }
    // Candidates are pruned BEFORE the raycast, never filtered after: since
    // three r151 raycasting a SkinnedMesh skins EVERY VERTEX on the CPU, and
    // the view center usually sits square on the character's dense mesh —
    // testing her every tick tanked the frame rate. Static visible meshes
    // only; excluded and hidden subtrees are never even walked.
    const candidates = [];
    const collect = (o) => {
      if (o.visible === false || excl.has(o) || o.userData.noAim) return;
      if (o.isMesh && !o.isSkinnedMesh) candidates.push(o);
      for (const c of o.children) collect(c);
    };
    collect(scene);
    _aimRay.setFromCamera({ x: 0, y: 0 }, camera);
    _aimRay.far = maxDist;
    const hit = _aimRay.intersectObjects(candidates, false)[0] ?? null;
    const o = camera.getWorldPosition(new THREE.Vector3());
    const p = hit ? hit.point : _aimRay.ray.at(maxDist, new THREE.Vector3());
    const out = { ox: o.x, oy: o.y, oz: o.z, x: p.x, y: p.y, z: p.z, hit: !!hit };
    // The SURFACE too (§18.30): a portal gun needs to know which way the
    // wall faces, not just where it is.
    if (hit?.face) {
      _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      out.nx = _n.x;
      out.ny = _n.y;
      out.nz = _n.z;
    }
    return out;
  }

  const _sOrigin = new THREE.Vector3();
  const _sDir = new THREE.Vector3();

  /**
   * Is the straight walk from (x1,z1) to (x2,z2), at height y, BLOCKED by a
   * mesh? A horizontal ray along the segment: any visible, non-skinned hit
   * within its length is an obstacle (walls, furniture — characters are
   * skinned and move, so they don't count; hidden things don't exist). The
   * NPC's path planner asks this through `env3d.blocked` (§18.12).
   */
  function sweepBlocked(el, x1, z1, x2, z2, y) {
    const exclude = el ? bindings.get(el.id) : null;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (!len) return false;
    _ray.set(_sOrigin.set(x1, y, z1), _sDir.set(dx / len, 0, dz / len));
    _ray.far = len;
    // §18.87: PRUNED before the cast, like every other query — the old
    // recursive intersect walked into every SkinnedMesh and CPU-skinned all
    // of them per sweep (this file's own documented sin, committed by this
    // very function). The shared static cache never contains one.
    for (const hit of _ray.intersectObjects(staticCandidates(), false)) {
      if (castHitSkipped(hit.object, exclude)) continue;
      return true;
    }
    return false;
  }

  /** The world AABB of an element's bound object — the Hitbox volume. */
  function boundsOf(el) {
    const obj = bindings.get(el.id);
    if (!obj) return null;
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return null;
    return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  }

  /** §18.79 LIVE MATERIALS: the three.js materials on an element's bound
   *  object whose NAME matches `pattern` (regex string). The AGS hook for
   *  animated surfaces — flip a baked map material emissive, scroll its
   *  texture, pulse its glow — no rebake. Returns [] until the glb builds
   *  (callers re-grab until non-empty). These are the SHARED originals:
   *  every element on the glb sees the change — right for a map's screen
   *  bank, mind it for props. */
  function materialsOf(el, pattern) {
    const obj = bindings.get(el.id);
    if (!obj) return [];
    let re;
    try { re = new RegExp(pattern); } catch { return []; }
    const out = [];
    const seen = new Set();
    obj.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m && !seen.has(m) && re.test(m.name || '')) { seen.add(m); out.push(m); }
      }
    });
    return out;
  }

  function applyParts(obj, el) {
    // §18.87 identity guard: this used to full-traverse every element's
    // subtree and allocate a Set EVERY FRAME (~750 node visits/frame in the
    // dev room). The hidden list only changes via setComponent (new array
    // identity), and the 1 Hz LOD sweep bumps `visEpoch` when its verdicts
    // change — so between those, the whole walk is skippable.
    const hiddenArr = Array.isArray(el.components?.model?.hidden) ? el.components.model.hidden : null;
    if (obj.ae1PartsRef === hiddenArr && obj.ae1PartsEpoch === visEpoch) {
      applyTint(obj, el); // its own cheap guard
      return;
    }
    obj.ae1PartsRef = hiddenArr;
    obj.ae1PartsEpoch = visEpoch;
    staticCastDirty = true; // part visibility feeds the ground-cast set
    const hidden = new Set(hiddenArr || []);
    // NEVER the bound root itself: traverse visits obj FIRST, and when the
    // top-level node IS a mesh (furniture glbs, no armature wrapper), setting
    // it here stomped the element visibility applied a line earlier — hidden
    // elements kept rendering. Parts are DESCENDANTS; the root belongs to
    // the element.
    // ae1LodHidden is the 1 Hz per-mesh LOD verdict (sweepCullDistance) —
    // folded in here for the same reason applyTransform folds ae1CullHidden:
    // this line re-asserts every mesh each frame and silently undid the sweep.
    obj.traverse((o) => {
      if (o !== obj && o.isMesh) o.visible = !hidden.has(o.name) && !o.userData.ae1LodHidden;
      // §18.84 invariant: alpha-hashed hair must NOT also hard-clip — the
      // glTF cutoff kept reappearing after load (clone paths), and
      // hash+test together still chews the soft strands into holes.
      if (o.isMesh || o.isSkinnedMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m && m.alphaHash && m.alphaTest !== 0) m.alphaTest = 0;
        }
      }
    });
    applyTint(obj, el); // §18.46 — rides the same two call sites as parts
  }

  /** PER-INSTANCE TINT (§18.46): `model.tint` (a CSS hex like "#40ff90")
   *  multiplies this element's textures with a color — the cheap filter.
   *  Clones SHARE materials, so the first tint on an object clones its
   *  materials once (cached on the mesh) and colors the private copies;
   *  clearing the tint restores the shared originals. Cheap guard makes
   *  the per-frame call free when nothing changed. */
  function applyTint(obj, el) {
    const want = String(el.components?.model?.tint ?? '');
    if (obj.ae1Tint === want) return;
    obj.ae1Tint = want;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      if (want) {
        if (!o.ae1TintOrig) {
          o.ae1TintOrig = o.material;
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.color?.set(want);
      } else if (o.ae1TintOrig) {
        o.material = o.ae1TintOrig;
        delete o.ae1TintOrig;
      }
    });
  }

  // -- LIGHT ELEMENTS (§18.48) --------------------------------------------- //
  // The Light builtin carries no mesh; the renderer owns its THREE objects
  // here — created on sight, retyped on lightType change, swept when the
  // element goes. This seam (element state -> managed render objects) is
  // where shadows/probes/future-GPU work will plug in.
  const lightSets = new Map(); // el.id -> {light, fill, type}

  function applyLightObject(el) {
    if (typeof el._lightTick !== 'function') return;
    let s = lightSets.get(el.id);
    const type = String(el.lightType || 'sun');
    if (s && s.type !== type) {
      scene.remove(s.light);
      if (s.light.target) scene.remove(s.light.target);
      if (s.fill) scene.remove(s.fill);
      lightSets.delete(el.id);
      s = null;
    }
    if (!s) {
      let light;
      if (type === 'point') light = new THREE.PointLight(0xffffff, 1, 0, 2);
      else if (type === 'spot') light = new THREE.SpotLight(0xffffff, 1);
      else light = new THREE.DirectionalLight(0xffffff, 1);
      scene.add(light);
      if (light.target) scene.add(light.target);
      s = { light, fill: null, type };
      lightSets.set(el.id, s);
    }
    const L = s.light;
    const on = el.visible !== false;
    L.visible = on;
    L.position.set(el.x ?? 0, el.y ?? 0, el.z ?? 0);
    if (L.target) {
      // a slightly tilted aim below — dead-vertical light reads flat
      L.target.position.set((el.x ?? 0) - 3, 0, (el.z ?? 0) - 4);
    }
    if (el.color) L.color.set(String(el.color));
    L.intensity = Number(el.intensity) || 1;
    if (L.isPointLight || L.isSpotLight) L.distance = Math.max(0, Number(el.distance) || 0);
    if (L.isSpotLight) {
      L.angle = Math.max(1, Math.min(89, Number(el.angle) || 40)) * DEG;
      L.penumbra = Math.max(0, Math.min(1, Number(el.penumbra) || 0));
    }
    const fillI = Number(el.fill) || 0;
    if (fillI > 0 && !s.fill) {
      s.fill = new THREE.HemisphereLight(0xbfd4ff, 0x3a3228, fillI);
      scene.add(s.fill);
    }
    if (s.fill) {
      s.fill.intensity = fillI;
      s.fill.visible = on && fillI > 0;
    }
  }

  function applyLight(obj, el) {
    const L = el.components?.light;
    if (!L || !obj.isLight) return;
    if (L.color) obj.color.set(L.color);
    if (L.intensity != null && L.intensity !== '') obj.intensity = Number(L.intensity);
    if (obj.isSpotLight) {
      if (L.angle != null) obj.angle = Math.max(0, Math.min(90, Number(L.angle))) * DEG;
      if (L.penumbra != null) obj.penumbra = Number(L.penumbra);
      if (L.distance != null) obj.distance = Number(L.distance);
    } else if (obj.isPointLight && L.distance != null) {
      obj.distance = Number(L.distance);
    }
  }

  /** A model's animation LIBRARIES: glbs contributing clips only (§18.10).
   *  Normalised — the AGS reader collapses a single-item list to its string. */
  function libsOf(model) {
    const v = model?.libs;
    if (typeof v === 'string') return v ? [v] : [];
    return Array.isArray(v) ? v : [];
  }

  /**
   * Lock the ground-plane drift out of a library clip, once, in place.
   *
   * Motion clips ship ROOT MOTION — the hips translate across the ground
   * inside the animation. AE1's element position is the single source of truth
   * for WHERE a character is (the physics moves it), so a clip that also moves
   * the root fights it: mesh drifting away from the element, then snapping.
   * This armature is Z-up-authored (rotationX 90 baked), so its ground plane
   * is bone-local X/Y — those components are pinned to their first keyframe;
   * Z (the vertical bob) stays animated (§18.10).
   */
  function lockRootDrift(clip) {
    if (clip.userData.ae1DriftLocked) return clip;
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position')) continue;
      const v = track.values;
      for (let i = 3; i < v.length; i += 3) {
        v[i] = v[0];
        v[i + 1] = v[1];
      }
    }
    clip.userData.ae1DriftLocked = true;
    return clip;
  }

  /** The clip object a model asks for: its own glb's first, then each
   *  library's. Empty name = the first clip anywhere (the resting default).
   *  Library clips get their root drift locked — a library exists to animate
   *  a body the PHYSICS moves. A model's own clips are left untouched. */
  /**
   * WHO HEARS `onFinished` (§18.10). A glb's mixer is shared by every element
   * that wears it, so the finish event must go to the element that STARTED
   * the current playback — not merely the last one to touch the entry.
   * Scene 1 ships two door1.glb elements (the quest door and the range door);
   * the second one auto-played the swing, claimed `lastEl`, and swallowed the
   * quest door's `opened()` — the key stopped opening the way to Scene 2.
   * `lastEl` remains the fallback for clips nobody explicitly started.
   */
  function finishTarget(entry) {
    return entry.playEl ?? entry.lastEl;
  }

  function resolveClip(entry, model) {
    const pools = [entry.gltf.animations];
    for (const lib of libsOf(model)) {
      const l = glbs.get(lib);
      if (l) pools.push(l.gltf.animations);
    }
    const name = model.clip || '';
    if (!name) {
      for (let i = 0; i < pools.length; i++) {
        if (pools[i].length) return i === 0 ? pools[i][0] : lockRootDrift(pools[i][0]);
      }
      return null;
    }
    // "file.glb" or "file.glb#Clip" pins a specific FILE — mandatory when
    // every Mixamo export ships a clip with the same name
    // ("Armature|mixamo.com|Layer0" seven times over). Bare file = first clip.
    if (/\.(glb|gltf)(#|$)/.test(name)) {
      const [file, clipName] = name.split('#');
      const lib = file === model.media ? entry : glbs.get(file);
      const pool = lib?.gltf.animations ?? [];
      const c = clipName ? pool.find((a) => a.name === clipName) : pool[0];
      return c ? (lib === entry ? c : lockRootDrift(c)) : null;
    }
    for (let i = 0; i < pools.length; i++) {
      const c = pools[i].find((a) => a.name === name);
      if (c) return i === 0 ? c : lockRootDrift(c);
    }
    return null;
  }

  // §18.46 PER-INSTANCE ANIMATION — the instancing round's renderer half.
  // A clone-bound element may drive clips of its OWN: a mixer rooted at ITS
  // clone binds the SHARED glb's clips by node name (cloneWithSkeleton
  // preserves names), so twenty stubbies play twenty timelines over ONE
  // loaded glb — one download, shared geometry and materials, per-instance
  // state. OPT-IN by an explicitly set clip: an unset clip on a clone stays
  // the static snapshot it always was (projectile rounds, carried-item
  // twins, the second door1) — auto-play-first-clip is the ORIGINAL's
  // convention alone.
  const instAnims = new Map(); // el.id -> per-clone animation state

  function disposeInstAnim(id) {
    const inst = instAnims.get(id);
    if (!inst) return;
    inst.mixer?.stopAllAction();
    if (inst.mixer && inst.root) inst.mixer.uncacheRoot(inst.root);
    instAnims.delete(id);
  }

  function applyInstanceAnimation(el, obj, entry) {
    const model = el.components?.model;
    const clipName = model?.clip ?? '';
    if (!clipName && !instAnims.has(el.id)) return; // never driven: stay a statue
    let inst = instAnims.get(el.id);
    if (inst && inst.root !== obj) {
      disposeInstAnim(el.id); // rebound to a different clone: fresh state
      inst = null;
    }
    if (!inst) {
      inst = { el, root: obj, mixer: null, current: null, lastKey: '', trim: null, trimFiredKey: '', rest: null, atRest: false };
      instAnims.set(el.id, inst);
    }
    inst.el = el;
    const snapshotRest = () => {
      if (inst.rest) return;
      inst.rest = [];
      obj.traverse((o) => inst.rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
    };
    if (clipName === '__none__') {
      inst.lastKey = '__none__';
      if (inst.current) { inst.current.stop(); inst.current = null; }
      inst.mixer?.stopAllAction();
      inst.trim = null;
      return;
    }
    if (clipName === '__bind__' || !clipName) {
      inst.lastKey = '__bind__';
      if (inst.current) { inst.current.stop(); inst.current = null; }
      if (!inst.atRest) {
        inst.mixer?.stopAllAction();
        snapshotRest();
        for (const r of inst.rest) { r.o.position.copy(r.p); r.o.quaternion.copy(r.q); r.o.scale.copy(r.s); }
        inst.atRest = true;
      }
      inst.trim = null;
      return;
    }
    const clip = resolveClip(entry, model);
    if (!clip) return;
    snapshotRest(); // the T-pose captured before the first play ever moves a bone
    if (!inst.mixer) {
      inst.mixer = new THREE.AnimationMixer(obj);
      // Per-instance mixer, per-instance finish: no finishTarget ambiguity —
      // the element that owns the clone owns every finish it makes.
      inst.mixer.addEventListener('finished', () => { if (onClipEnd && inst.el) onClipEnd(inst.el); });
    }
    const action = inst.mixer.clipAction(clip);
    const loop = model.loop !== false;
    const speed = Number(model.speed) || 1;
    const start = Math.max(0, Number(model.start) || 0);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = speed;
    const key = `${clip.uuid}|${speed}|${start}`;
    if (inst.current !== action || inst.lastKey !== key) {
      const fade = Number.isFinite(+model.fade) ? Math.max(0, +model.fade) : 0.3;
      action.reset();
      if (speed < 0) action.time = start > 0 ? Math.min(start, clip.duration) : clip.duration;
      else if (start > 0) action.time = Math.min(start, clip.duration);
      if (fade > 0) action.fadeIn(fade);
      action.play();
      if (inst.current && inst.current !== action) {
        if (fade > 0) inst.current.fadeOut(fade);
        else inst.current.stop();
      }
      inst.current = action;
      inst.lastKey = key;
      inst.atRest = false;
    }
    inst.trim = Number(model.end) > 0
      ? { start, end: Math.min(Number(model.end), clip.duration), loop }
      : null;
  }

  function applyAnimation(el) {
    const model = el.components?.model;
    const entry = model && glbs.get(model.media);
    if (!entry) return;

    // ONE GLB, ONE TIMELINE — so only the element bound to the ORIGINAL may
    // drive it. A second element wearing the same glb renders a CLONE
    // (build()), and a clone is never posed by the mixer: it is a snapshot,
    // moved by applyTransform alone. Letting it reach the state machine below
    // meant two elements fighting over one animation every frame — Scene 1's
    // range door cancelled the quest door's opening swing with its own
    // '__bind__' (and, before that pin, auto-played the swing and swallowed
    // the finish), so the key stopped opening the way to Scene 2. Projectile
    // rounds take this path too and lose nothing: their motion is transform,
    // never clip.
    {
      // A clone-bound element takes the PER-INSTANCE path (§18.46) — its own
      // mixer over the shared clips — instead of the old hard stop.
      const cl = spawnClones.get(el.id);
      if (cl && cl === bindings.get(el.id)) return applyInstanceAnimation(el, cl, entry);
    }

    // '__none__': RELEASE the skeleton — stop any playing action but restore
    // NOTHING. For characters whose bones are driven outside the mixer (the
    // motion-matching driver poses them every tick): when its one-shot action
    // clip ends, '__bind__' would flash the rest pose for a frame before the
    // driver's next write; releasing leaves the bones to whoever owns them.
    if (model.clip === '__none__') {
      entry.lastKey = '__none__';
      entry.animMemo = null; // §18.87 — a re-play of the same clip must restart
      if (entry.current) {
        entry.current.stop();
        entry.current = null;
      }
      entry.mixer?.stopAllAction();
      entry.trim = null;
      return;
    }

    // '__bind__' (AE1Model.bindPose()): stop AND restore the file's rest pose.
    // A stopped mixer leaves every bone wherever the last frame put it, and
    // the mixer must be told to FORGET the pose it cached (uncacheRoot), or
    // the next play resumes from stale bindings. Restoring the snapshotted
    // node locals IS the T-pose for a clip-less character.
    if (model.clip === '__bind__') {
      entry.lastKey = '__bind__'; // the next real play is always a fresh start
      entry.animMemo = null; // §18.87
      if (entry.current) {
        entry.current.stop();
        entry.current = null;
      }
      if (!entry.atRest) {
        entry.mixer?.stopAllAction();
        for (const r of entry.rest) {
          r.o.position.copy(r.p);
          r.o.quaternion.copy(r.q);
          r.o.scale.copy(r.s);
        }
        entry.atRest = true;
      }
      return;
    }

    // §18.87 MEMO: everything below derives from these primitives. Per frame
    // per animated element this used to re-resolve the clip (regex + split +
    // linear name scans over the whole pool) and rebuild a template-literal
    // key just to conclude nothing changed — the common case, every frame.
    const am = entry.animMemo;
    if (am && am.el === el && am.clip === model.clip && am.libs === model.libs
      && am.loop === model.loop && am.speed === model.speed
      && am.start === model.start && am.end === model.end) {
      return;
    }
    const clip = resolveClip(entry, model);
    if (!clip) return; // (no memo — a still-loading library retries next frame)
    // A library clip drives THIS model's skeleton: the mixer is rooted here
    // and binds tracks by node name, so a same-skeleton export just works.
    // Created lazily — a mesh-only glb has no mixer until a clip needs one.
    if (!entry.mixer) {
      entry.mixer = new THREE.AnimationMixer(entry.gltf.scene);
      // One-shot clips (a turn-around) tell the ELEMENT they finished, the
      // same contract as Sprite and Video: onFinished (§18.10).
      entry.mixer.addEventListener('finished', () => {
        if (onClipEnd) { const t = finishTarget(entry); if (t) onClipEnd(t); }
      });
    }
    entry.lastEl = el;
    const action = entry.mixer.clipAction(clip); // cached per clip+root inside three
    const loop = model.loop !== false;
    const speed = Number(model.speed) || 1;
    const start = Math.max(0, Number(model.start) || 0);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = speed;
    // Restart on a NEW play request — a different action, or the same action
    // asked for differently (a turn re-triggered reversed, a new start time).
    // The key, not isRunning(): a FINISHED one-shot whose request hasn't
    // changed must hold its last frame, not restart every frame forever.
    const key = `${clip.uuid}|${speed}|${start}`;
    if (entry.current !== action || entry.lastKey !== key) {
      const fade = Number.isFinite(+model.fade) ? Math.max(0, +model.fade) : 0.3;
      action.reset();
      // Playback begins at `start` seconds (the custom frame); a reversed
      // one-shot with no explicit start begins at the END and runs down.
      if (speed < 0) action.time = start > 0 ? Math.min(start, clip.duration) : clip.duration;
      else if (start > 0) action.time = Math.min(start, clip.duration);
      // fade 0 is a HARD CUT: a turn clip's root rotation hands off to the
      // element heading in the same frame — any fade would sweep the yaw.
      if (fade > 0) action.fadeIn(fade);
      action.play();
      if (entry.current && entry.current !== action) {
        if (fade > 0) entry.current.fadeOut(fade);
        else entry.current.stop();
      }
      entry.current = action;
      entry.lastKey = key;
      entry.playEl = el; // this element owns the playback — and its finish
      entry.atRest = false; // playing again — the rest snapshot no longer holds
    }
    // TRIMMED TAIL (§18.35): `end` seconds caps the playable window. Enforced
    // per-frame in renderFrame — a looping clip wraps back to `start`, a
    // one-shot counts as finished (same event as running off the real end).
    entry.trim = Number(model.end) > 0
      ? { start, end: Math.min(Number(model.end), clip.duration), loop }
      : null;
    entry.animMemo = { el, clip: model.clip, libs: model.libs, loop: model.loop,
      speed: model.speed, start: model.start, end: model.end }; // §18.87
  }

  /** Enforce a clip's trimmed end. Runs each frame after the mixers. */
  function stepTrims() {
    for (const entry of glbs.values()) {
      const t = entry.trim;
      const a = entry.current;
      if (!t || !a) continue;
      if (a.timeScale >= 0 ? a.time >= t.end : a.time <= t.start) {
        if (t.loop) {
          a.time = a.timeScale >= 0 ? t.start : t.end;
        } else if (entry.trimFiredKey !== entry.lastKey) {
          entry.trimFiredKey = entry.lastKey; // one finish per playback
          a.paused = true;
          if (onClipEnd) { const t = finishTarget(entry); if (t) onClipEnd(t); }
        }
      }
    }
    // ...and the per-instance timelines (§18.46), same rules per clone.
    for (const inst of instAnims.values()) {
      const t = inst.trim;
      const a = inst.current;
      if (!t || !a) continue;
      if (a.timeScale >= 0 ? a.time >= t.end : a.time <= t.start) {
        if (t.loop) {
          a.time = a.timeScale >= 0 ? t.start : t.end;
        } else if (inst.trimFiredKey !== inst.lastKey) {
          inst.trimFiredKey = inst.lastKey;
          a.paused = true;
          if (onClipEnd && inst.el) onClipEnd(inst.el);
        }
      }
    }
  }

  /** Load every glb the elements reference, bind, and place.
   *
   * Does NOT move the camera — the editor frames only on first content or a
   * merge (an orbiting user must not be yanked), the game frames once at boot.
   * Callers call frameCamera() when framing is wanted.
   */
  async function build() {
    buildsInFlight++;
    try {
      return await _build();
    } finally {
      buildsInFlight--;
    }
  }

  async function _build() {
    const els = elements();
    const wanted = new Set();
    const mediaSet = new Set();
    for (const e of els) {
      const m = e.components?.model;
      if (m?.media) {
        wanted.add(m.media);
        mediaSet.add(m.media);
      }
      for (const lib of libsOf(m)) wanted.add(lib); // clip libraries load too
    }
    await Promise.all([...wanted].map(ensureGlb));

    // A glb renders ONLY while some element uses it as its model. Everything
    // else that happens to be loaded — animation libraries, anim-only assets,
    // a glb whose elements were all deleted — contributes clips at most, never
    // scenery. One rule, no special cases (§18.10).
    for (const [name, l] of glbs) l.gltf.scene.visible = mediaSet.has(name);

    // STALE MOUNTS (§18.32): a mesh parented into a hand bone survives scene
    // changes (glbs are cached), so a mount whose element no longer exists —
    // or is no longer rendered — would haunt the new scene's character. Send
    // every unclaimed mounted mesh home to its original glb parent.
    {
      const bound = new Set(bindings.values());
      const stale = [];
      scene.traverse((o) => {
        if (o.ae1Parent && !bound.has(o) && o.parent !== o.ae1Parent) stale.push(o);
      });
      for (const o of stale) o.ae1Parent.add(o);
    }

    // Clones for SPAWNED elements (fired projectiles): rounds whose element
    // is gone are removed from the scene first.
    for (const [id, c] of spawnClones) {
      if (!els.some((e) => e.id === id)) {
        scene.remove(c);
        spawnClones.delete(id);
        disposeInstAnim(id); // its timeline dies with it (§18.46)
      }
    }
    // Scatter copies of a DELETED archetype die with it (§18.23/§18.93).
    for (const [id, s] of scatterSets) {
      if (!els.some((e) => e.id === id)) {
        scatterCleanup(s);
        scatterSets.delete(id);
      }
    }
    // Portals of a gone gun close (§18.30) — scene changes included.
    for (const [id, set] of portalSets) {
      if (!els.some((e) => e.id === id)) {
        for (const k of ['a', 'b']) scene.remove(set[k].group);
        portalSets.delete(id);
      }
    }
    // Eyes of gone PerspectiveCameras close too — targets are GPU memory.
    for (const [id, s] of captureSets) {
      if (!els.some((e) => e.id === id)) {
        s.target.dispose();
        captureSets.delete(id);
      }
    }
    // Audio volume boxes of gone elements (§18.34).
    for (const [id, b] of volumeBoxes) {
      if (!els.some((e) => e.id === id)) {
        scene.remove(b);
        volumeBoxes.delete(id);
      }
    }
    // Lights of gone elements go dark (§18.48).
    for (const [id, s] of lightSets) {
      if (!els.some((e) => e.id === id)) {
        scene.remove(s.light);
        if (s.light.target) scene.remove(s.light.target);
        if (s.fill) scene.remove(s.fill);
        lightSets.delete(id);
      }
    }

    bindings.clear();
    const claimedThisPass = new Set();
    for (const el of els) {
      applySky(el); // the sky element carries no model — apply before binding
      applyVolumeBox(el); // ditto — and the on-demand editor may not update again
      applyLightObject(el); // ditto — a Light element is renderer-owned (§18.48)
      const glbName = el.components?.model?.media;
      const nodeName = el.components?.model?.node ?? el.name;
      // Load-time nodeMap, NOT live getObjectByName — see ensureGlb.
      let obj = glbName ? glbs.get(glbName)?.nodeMap.get(nodeName) : null;
      if (!obj) for (const e of glbs.values()) { obj = e.nodeMap.get(nodeName); if (obj) break; }
      if (!obj) continue;
      // TWO elements, one node = a template and its spawned round — or a
      // CARRIED item meeting a scene's own copy (§18.32). The second claimant
      // gets a CLONE, and an element that ever received one KEEPS it: binding
      // is stable across scene changes, so the mesh in your hand stays the
      // same object even in a scene with no competing claimant. (Re-resolving
      // to the original here once orphaned a mount-scaled clone into the
      // world — the giant-bazooka haunting.)
      const prior = spawnClones.get(el.id);
      if (prior) {
        obj = prior;
      } else if (claimedThisPass.has(obj)) {
        const c = cloneWithSkeleton(obj); // skinned meshes rebind to CLONED bones
        applyFadeMaterials(c); // re-register the twins clone() cannot carry
        scene.add(c);
        spawnClones.set(el.id, c);
        obj = c;
      }
      claimedThisPass.add(obj);
      bindings.set(el.id, obj);
      if (!applyMount(el)) applyTransform(obj, el);
      applyParts(obj, el);
      applyScatter(el); // the first paint must place the copies too
      applyLight(obj, el);
      applyAnimation(el);
    }
    // Orphaned clones die NOW: a clone whose element no longer binds it (or
    // no longer exists) is unowned — no update will ever move, scale, or hide
    // it again. Removing it is the only honest cleanup.
    for (const [id, c] of spawnClones) {
      if (bindings.get(id) !== c) {
        scene.remove(c);
        spawnClones.delete(id);
        disposeInstAnim(id); // §18.46
      }
    }

    // STATIC MATRIX FREEZE (§18.53): a city tile's hundreds of child meshes
    // never move locally, yet three.js recomputed every local matrix every
    // frame. Children of bindings whose glb ships NO animations get frozen
    // (the bound ROOT stays live — applyTransform still moves the element);
    // any subtree with skinned meshes or bones is exempt. Re-running build
    // re-freezes fresh instances; a frozen child that must move again just
    // sets matrixAutoUpdate back.
    const elById = new Map(); // §18.87 — was elements().find() per binding: O(n²)
    for (const e of els) elById.set(e.id, e);
    for (const [fid, fobj] of bindings) {
      const fel = elById.get(fid);
      const fentry = fel && glbs.get(fel.components?.model?.media);
      if (!fentry || fentry.gltf.animations?.length) continue;
      let fskinned = false;
      fobj.traverse((o) => { if (o.isSkinnedMesh || o.isBone) fskinned = true; });
      if (fskinned) continue;
      fobj.traverse((o) => {
        if (o === fobj || !o.matrixAutoUpdate) return;
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      });
      // §18.53 phase 3b: the same static meshes get a BVH — ground probes,
      // melee sweeps, and aim rays against the city drop from ~3 ms to
      // microseconds (acceleratedRaycast only engages where a tree exists;
      // skinned/animated meshes keep the stock path). Built once per
      // geometry, survives rebinds; lazyGeneration is not worth it — the
      // one-time cost rides the load screen.
      fobj.traverse((o) => {
        if (o.isMesh && o.geometry && !o.geometry.boundsTree) {
          try { o.geometry.computeBoundsTree(); } catch { /* index-less or degenerate — stock raycast */ }
        }
      });
    }

    // TOP-LEVEL NODE VISIBILITY — LAST, against THIS pass's bindings. An
    // ORIGINAL top-level node renders only while an element binds it (or
    // something bound lives inside it): deleting ONE element of a multi-node
    // glb used to leave its mesh haunting the scene. Both directions, so the
    // hide is never sticky.
    //
    // ORDER IS THE WHOLE LESSON. This ran BEFORE `bindings.clear()` and the
    // rebinding loop below it, so `claimed` described the PREVIOUS scene:
    // entering the MM Range fresh, none of the course's 29 blocks were
    // claimed yet, every one was hidden, and nothing revisited them — an
    // empty test range (and, since hidden meshes are pruned from ground rays,
    // an unraycastable one). It only looked fixed while bouncing between
    // scenes, where the previous visit's bindings happened to be right.
    const claimed = new Set();
    for (const obj of bindings.values()) {
      for (let o = obj; o; o = o.parent) claimed.add(o);
    }
    for (const l of glbs.values()) {
      if (!l.gltf.scene.visible) continue;
      for (const top of l.topNodes ?? []) top.visible = claimed.has(top);
    }
    staticCastDirty = true; // §18.87 — build reshaped visibility and bindings
  }

  /** Point the camera at the loaded content. Returns {center, radius} so an
   *  orbit-controls wrapper can aim its target too, or null if nothing loaded. */
  function frameCamera() {
    const box = new THREE.Box3();
    for (const e of glbs.values()) if (e.gltf.scene.visible) box.expandByObject(e.gltf.scene);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Cap the framing radius: a large ground plane would otherwise push the
    // camera far back and shrink a 1.6 m character to a dot.
    const radius = Math.min(Math.max(size.x, size.y, size.z) * 0.5, 1.6) || 1;
    camera.lookAt(center);
    const dist = radius / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist * 1.8));
    // §18.87: floor the near plane. radius caps at 1.6, so radius/100 gave
    // near≈0.016 against far≈1600 — a 100,000:1 range on a 24-bit depth
    // buffer: z-fighting territory, and the DOF linearizes exactly this
    // depth. 0.08 m still clears the third-person boom by an order of
    // magnitude (near-fade dithers walls long before they slice).
    camera.near = Math.max(0.08, radius / 100);
    camera.far = radius * 1000;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    return { center, radius };
  }

  /**
   * Drive the VIEW from a camera element (play mode). The element's x/y/z and
   * rotationX/rotationY are applied as a YXZ euler — yaw about the world's up
   * FIRST, then pitch about the camera's own X — which is what a mouse-look
   * camera means. (Bound objects use XYZ; a view is not a bound object.)
   */
  function setView(el) {
    camera.position.set(el.x ?? 0, el.y ?? 0, el.z ?? 0);
    // roll (el.rotation) joins the view for the handheld sway (§18.47) —
    // zero for every camera that never writes it, exactly as before.
    camera.rotation.set(
      (el.rotationX ?? 0) * DEG, (el.rotationY ?? 0) * DEG, (el.rotation ?? 0) * DEG, 'YXZ');
    // an element-declared FOV wins (the sprint kick eases this live)
    const fov = Number(el.fov) || 0;
    if (fov > 0 && Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // §the reference MMO render — element-declared CLIP RANGE. frameCamera's radius-scaled
    // near/far (0.08 / 1600 on a 1.6 m character = ~20,000:1) leaves almost no
    // depth precision, so dense coplanar tile geometry (RS walls/decor stacked
    // on the ground) z-fights and flickers. A tight far plane restores it.
    const nearP = Number(el.nearPlane) || 0, farP = Number(el.farPlane) || 0;
    if (nearP > 0 && farP > nearP && (camera.near !== nearP || camera.far !== farP)) {
      camera.near = nearP; camera.far = farP; camera.updateProjectionMatrix();
    }
    // §the reference MMO render — DISTANCE FOG. 2004 the reference MMO faded the world to the sky
    // near its draw distance; three's per-vertex fog is that exact effect, free
    // (no post pass). Fading to the SKY colour (and painting the background the
    // same) means no hard horizon line — the world dissolves into the sky, and
    // far pop-in is hidden. Opt-in: only cameras that set (fog true).
    if (el.fog === true || el.fog === 'true') {
      const ffar = farP > 0 ? farP : camera.far;
      const fstart = Math.max(0, Math.min(0.98, Number(el.fogStart ?? 0.5)));
      if (!_ae1Fog) { _ae1Fog = new THREE.Fog(0x000000, 1, 2); }
      _ae1Fog.color.set(el.fogColor || '#aeb9c2');
      _ae1Fog.near = ffar * fstart; _ae1Fog.far = ffar;
      scene.fog = _ae1Fog;
      if (el.fogSky !== false && el.fogSky !== 'false') scene.background = _ae1Fog.color;
    } else if (scene.fog === _ae1Fog && _ae1Fog) {
      scene.fog = null; scene.background = baseBackground;
    }
  }
  let _ae1Fog = null;

  const _ray = new THREE.Raycaster();
  const _down = new THREE.Vector3(0, -1, 0);
  const _n = new THREE.Vector3();
  const _gOrigin = new THREE.Vector3(); // §18.87 — reused ground-ray origin

  /**
   * The ground height under (x, z), casting DOWN from fromY — or null over the
   * void. Excludes `el`'s own bound object: a character standing on its own
   * head is a physics singularity. This is the geometry query the pure-engine
   * character controller has injected as `world.env3d.groundAt` (§18.9).
   */
  function _groundHit(el, x, z, fromY) {
    // MID-BUILD the scene graph is a lie — nodes sit at raw glb origins while
    // ensureGlb resolves. The hosts already refuse to RENDER a half-built
    // scene (§18.13); the GEOMETRY CHANNEL must go quiet too, or a ticking
    // NPC snaps to a surface that never existed (the goober spent a play
    // session one metre under Scene 2). Null means "no answer right now" —
    // every caller already treats it as "hold still".
    if (buildsInFlight > 0) return null;
    const exclude = el ? bindings.get(el.id) : null;
    _ray.set(_gOrigin.set(x, fromY, z), _down);
    _ray.far = 1000;
    // Candidates are PRUNED before the cast, never filtered after — the
    // aimPoint lesson: raycasting a SkinnedMesh skins every vertex on the
    // CPU, and a ground ray cast from knee/foot height starts INSIDE the
    // character's own dense mesh. §18.87 moved the pruning into the shared
    // static cache (this exact walk used to run per ray, ~12-25×/frame);
    // per-ray concerns — the excluded element, since-hidden subtrees, and
    // CARRIED THINGS (a bone-mounted 3.5 m lance was once a raycast floor:
    // the foot-IK planted her foot ON HER OWN SPEAR — "she thinks her foot
    // is on a tall rock") — are per-hit ancestor checks now.
    for (const hit of _ray.intersectObjects(staticCandidates(), false)) {
      if (castHitSkipped(hit.object, exclude)) continue;
      // A floor FACES UP. Without this, a character inside an (un-collided)
      // box "stands" on its bottom face, and a steep wall reads as ground.
      // DoubleSide exports report every face, so the normal is the only tell.
      if (hit.face) {
        _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (_n.y < 0.5) continue; // steeper than ~60° is a wall, not a floor
      }
      return hit; // intersections arrive sorted near→far; first valid is the floor
    }
    return null;
  }

  function groundAt(el, x, z, fromY) {
    return _groundHit(el, x, z, fromY)?.point.y ?? null;
  }

  /**
   * The ground under (x, z) WITH ITS IDENTITY (§18.20): `{y, el}` where `el`
   * is the AE1 element whose bound object the ray struck — walk the hit's
   * ancestors until one is a binding. Surface-aware systems (footsteps by
   * ground type) read the element's dat from there; the renderer never
   * interprets it. Null over the void; `el` null on unclaimed geometry.
   */
  function groundInfo(el, x, z, fromY) {
    const hit = _groundHit(el, x, z, fromY);
    if (!hit) return null;
    let owner = null;
    outer: for (let o = hit.object; o; o = o.parent) {
      for (const [id, obj] of bindings) {
        if (obj === o) {
          owner = elements().find((e) => e.id === id) ?? null;
          break outer;
        }
      }
    }
    // §18.80: the WORLD-space surface normal rides along — the ring
    // stabilizer levels the bunker by the floor normal under the player.
    let n = null;
    if (hit.face?.normal) {
      const nm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (nm.y < 0) nm.negate(); // standable tops point up
      n = { x: nm.x, y: nm.y, z: nm.z };
    }
    return { y: hit.point.y, el: owner, n };
  }

  const _ptrNdc = new THREE.Vector2();
  /**
   * The ground point under a SCREEN cursor (§click-to-move): cast a ray from the
   * camera through normalized device coords (nx,ny ∈ [-1,1], y up) and return the
   * first floor hit `{x,y,z}` — or null over the void. Same up-facing-only floor
   * test as `groundAt` (a wall/ceiling is not a place you can click to walk to).
   * The cursor-picking primitive a tile-mover turns a click into a destination
   * tile with; general, not genre-specific.
   */
  function pointerGround(nx, ny) {
    if (buildsInFlight > 0) return null;
    _aimRay.setFromCamera(_ptrNdc.set(nx, ny), camera);
    _aimRay.far = 2000;
    for (const hit of _aimRay.intersectObjects(staticCandidates(), false)) {
      if (castHitSkipped(hit.object, null)) continue;
      if (hit.face) {
        _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (_n.y < 0.5) continue; // steeper than ~60° is a wall, not a floor
      }
      return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    }
    return null;
  }

  /**
   * The NODE under a screen cursor (§element-graph): cast a ray through NDC
   * (nx,ny ∈ [-1,1], y up) against the scene's static meshes and return the
   * first hit — but UNLIKE pointerGround this keeps walls/doors/props (no
   * floor-normal filter), and reports the nearest NAMED node plus the bound
   * scene element that owns it. That is exactly what a right-click needs: what
   * did I click, and which glb sub-node is it, so the ElementGraph can look up
   * its interaction options. Returns { name, node, el, point:{x,y,z} } or null.
   */
  function pointerPick(nx, ny) {
    if (buildsInFlight > 0) return null;
    _aimRay.setFromCamera(_ptrNdc.set(nx, ny), camera);
    _aimRay.far = 2000;
    for (const hit of _aimRay.intersectObjects(staticCandidates(), false)) {
      if (castHitSkipped(hit.object, null)) continue;
      // nearest named node up the chain (the glb sub-node, e.g. "door_3"),
      // and the bound scene element whose subtree this hit lives in.
      let named = null, owner = null;
      for (let o = hit.object; o; o = o.parent) {
        if (!named && o.name) named = o;
        for (const [id, obj] of bindings) {
          if (obj === o) { owner = elements().find((e) => e.id === id) ?? null; break; }
        }
        if (owner) break;
      }
      const node = named ?? hit.object;
      return {
        name: node.name || null,
        node,
        el: owner,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      };
    }
    return null;
  }

  const _upOrigin = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  /**
   * Is something DIRECTLY OVERHEAD? (§element-graph roof-removal.) Cast a ray
   * straight up from a world point and return the nearest NAMED node it hits, or
   * null for open sky. The ElementGraph asks this at the player's feet each tick:
   * a "roof" node overhead → hide the roofs (classic RS steps-inside behaviour).
   */
  function rayUp(x, y, z, maxDist = 40, exclude = null) {
    if (buildsInFlight > 0) return null;
    _ray.set(_upOrigin.set(x, y + 0.5, z), _up);
    _ray.far = maxDist;
    for (const hit of _ray.intersectObjects(staticCandidates(), false)) {
      // Skip the caller's OWN body: an overhead ray from the player's feet hits
      // the player mesh (a static, non-skinned composite) before any roof.
      if (castHitSkipped(hit.object, exclude)) continue;
      let named = null;
      for (let o = hit.object; o; o = o.parent) { if (o.name) { named = o; break; } }
      return { name: named?.name ?? null, node: named ?? hit.object, dist: hit.distance };
    }
    return null;
  }

  const _ccO = new THREE.Vector3();
  const _ccD = new THREE.Vector3();
  /**
   * Camera obstruction test (§third-person collision). Cast from the LOOK point
   * (at the character) toward the ideal camera position; return the free
   * distance to the first static hit, or null when the path is clear. The
   * third-person camera pulls its boom in to this distance so it never clips
   * through a wall/roof — the the reference MMO "camera zooms in when blocked" feel.
   * `exclude` is the character's own object (the ray starts inside it).
   */
  function cameraClip(lx, ly, lz, cx, cy, cz, exclude = null) {
    if (buildsInFlight > 0) return null;
    _ccD.set(cx - lx, cy - ly, cz - lz);
    const dist = _ccD.length();
    if (dist < 1e-4) return null;
    _ccD.multiplyScalar(1 / dist);
    _ray.set(_ccO.set(lx, ly, lz), _ccD);
    _ray.far = dist;
    for (const hit of _ray.intersectObjects(staticCandidates(), false)) {
      if (castHitSkipped(hit.object, exclude)) continue;
      return hit.distance;
    }
    return null;
  }

  const _w2s = new THREE.Vector3();
  /**
   * Project a WORLD point to canvas pixels (§element-graph click marker). Returns
   * { x, y, behind } where x/y are CSS pixels within the canvas and `behind` is
   * true when the point is behind the camera (caller should hide the overlay).
   * Lets a DOM marker stay pinned to the spot on the ground the player clicked
   * even as the camera orbits.
   */
  function worldToScreen(x, y, z) {
    _w2s.set(x, y, z).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    // VIEWPORT (client) pixels, not canvas-relative: consumers place a
    // position:fixed overlay, and the canvas is offset from the viewport origin
    // in the editor (it sits inside a panel). Add the canvas's top-left.
    return {
      x: rect.left + (_w2s.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-_w2s.y * 0.5 + 0.5) * rect.height,
      behind: _w2s.z > 1,
    };
  }

  /** Re-sync one element (mount/transform/parts/light/animation) after a
   *  change. A mounted element's transform belongs to its socket. */
  function update(el) {
    applySky(el); // unbound-friendly: the sky element carries no model
    applyLightObject(el); // ditto: Light elements are renderer-owned (§18.48)
    applyFx(el); // ditto: a Particles element carries no mesh of its own
    applyPortal(el); // ditto: portal OVALS belong to the pass, not a glb
    applyCapture(el); // ditto: an EYE is a render target, not a mesh
    applyVolumeBox(el); // ditto: an audio REGION draws authoring ink only
    const obj = bindings.get(el.id);
    if (!obj) return;
    applyNearFade(el, obj); // §18.33 — dat-toggled, cached, cheap
    if (!applyMount(el)) applyTransform(obj, el);
    applyParts(obj, el);
    applyScatter(el); // after parts: clones copy the archetype's current look
    applyLight(obj, el);
    applyAnimation(el);
    applyPath(el);
    applyAim(el);
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  /* -- audio volume boxes (§18.34) ------------------------------------------ */
  //
  // An element carrying a `volume` component (the audio volume built-ins
  // write one) draws as a lightly translucent box — teal for music, magenta
  // for FX — so the developer can see and shape the region with the normal
  // transform tools. Authoring ink only: hiding the element hides the box,
  // the audio logic never looks at it. `noAim` keeps the box out of aim and
  // ground rays — it is a region, not geometry.

  const volumeBoxes = new Map(); // element.id -> Mesh
  const VOLUME_COLORS = { music: 0x2fd4b0, fx: 0xd44fd4 };

  function applyVolumeBox(el) {
    // DUCK-TYPED, not component-driven (§18.36): the `volume` component is
    // written by onLoad, which only runs in PLAY — the boxes vanished from
    // the restored edit scene after Stop. Class methods survive rehydration
    // everywhere, like wantsVisible's launch() test.
    const kind =
      typeof el._bgmTick === 'function' ? 'music'
      : typeof el._fxvTick === 'function' ? 'fx'
      : el.components?.volume?.kind;
    let box = volumeBoxes.get(el.id);
    if (!kind) {
      if (box) {
        scene.remove(box);
        volumeBoxes.delete(el.id);
      }
      return;
    }
    if (!box) {
      box = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({
          color: VOLUME_COLORS[kind] ?? 0xffffff,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      );
      box.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(box.geometry),
        new THREE.LineBasicMaterial({ color: VOLUME_COLORS[kind] ?? 0xffffff, transparent: true, opacity: 0.4 }),
      ));
      box.userData.noAim = true;
      scene.add(box);
      volumeBoxes.set(el.id, box);
    }
    box.visible = el.visible !== false;
    box.position.set(el.x ?? 0, el.y ?? 0, el.z ?? 0);
    box.rotation.set(0, (el.rotationY ?? 0) * DEG, 0);
    box.scale.set(el.scaleX ?? 1, el.scaleY ?? 1, el.scaleZ ?? 1);
  }

  /* -- captures & portals (§18.30) ------------------------------------------ */
  //
  // CAPTURES: an element with a `camera` component (the PerspectiveCamera
  // built-in writes one) is an invisible EYE — every frame the scene renders
  // from the element's position along its aim normal into a private target,
  // and any surface may sample that texture. PORTALS are the first tenant:
  // the gun writes a `portal` component ({a: [x,y,z,nx,ny,nz], b: [...],
  // aCam: "PortalEyeA", bCam: "PortalEyeB"}), this pass draws the ovals, and
  // each face displays the OTHER portal's eye — the view perpendicular to
  // that portal's plane, which is exactly what you will see after stepping
  // through. One portal alone (or an eye missing) shows a ring of nothing.

  const captureSets = new Map(); // element.id -> {cam, target, size}
  const portalSets = new Map(); // element.id -> {a: slot, b: slot}
  const PORTAL_COLORS = { a: 0xff8822, b: 0x2299ff };
  const _prtZ = new THREE.Vector3(0, 0, 1);
  const _capBack = new THREE.Vector3(0, 0, -1); // a THREE camera looks down -Z
  const _capN = new THREE.Vector3();
  // Continuity math (§18.32): entry frame → 180° turn → exit frame.
  const _prtM1 = new THREE.Matrix4();
  const _prtM2 = new THREE.Matrix4();
  const _prtR180 = new THREE.Matrix4().makeRotationY(Math.PI);
  const _prtOne = new THREE.Vector3(1, 1, 1);
  const _prtPlane = new THREE.Plane();
  const _prtN = new THREE.Vector3();
  const _bufSize = new THREE.Vector2();

  function applyCapture(el) {
    const c = el.components?.camera;
    let s = captureSets.get(el.id);
    if (!c) {
      if (s) {
        s.target.dispose();
        captureSets.delete(el.id);
      }
      return;
    }
    const size = Math.max(16, Number(c.size) || 512);
    if (!s || s.size !== size) {
      s?.target.dispose();
      s = { cam: new THREE.PerspectiveCamera(), target: new THREE.WebGLRenderTarget(size, size), size };
      captureSets.set(el.id, s);
    }
    s.cam.fov = Number(c.fov) || 60;
    s.cam.near = Number(c.near) || 0.05;
    s.cam.far = Number(c.far) || 200;
    s.cam.aspect = Number(c.aspect) || 1;
    s.cam.updateProjectionMatrix();
    s.cam.position.set(el.x ?? 0, el.y ?? 0, el.z ?? 0);
    _capN.set(Number(c.nx) || 0, Number(c.ny) || 0, Number(c.nz) || 0);
    if (_capN.lengthSq() < 1e-6) _capN.set(0, 0, 1);
    _capN.normalize();
    s.cam.quaternion.setFromUnitVectors(_capBack, _capN);
    s.cam.updateMatrixWorld(true); // Camera's override derives the inverse too
  }

  /** Fill every capture target. Runs before the main render so surfaces carry
   *  THIS frame's world. Portal faces hide during captures — a face sampling
   *  the very target being written is a GL feedback loop, not a mirror. */
  function renderCaptures() {
    // Portal-claimed eyes get the CONTINUITY pose (§18.32): the play camera
    // re-expressed through the portal pair — world → entry-portal-local, turn
    // 180° (in becomes out), → exit-portal-world — with the play camera's OWN
    // projection, so the oval's screen-space sample puts behind every pixel
    // of the ring exactly what your eye would see were the wall a doorway.
    // Unclaimed eyes keep their element-authored pose (monitors, mirrors).
    const claims = new Map(); // eye element id -> {exit slot, entry slot}
    for (const set of portalSets.values()) {
      if (!(set.a.group.visible && set.b.group.visible) || !set.camNames) continue;
      for (const [mine, other] of [['a', 'b'], ['b', 'a']]) {
        const name = set.camNames[mine];
        const eyeEl = name ? elements().find((e) => e.name === name) : null;
        if (eyeEl && captureSets.has(eyeEl.id)) {
          claims.set(eyeEl.id, { exit: set[mine], entry: set[other] });
        }
      }
      renderer.getDrawingBufferSize(_bufSize);
      set.a.face.material.uniforms.res.value.copy(_bufSize);
      set.b.face.material.uniforms.res.value.copy(_bufSize);
    }
    const faces = [];
    for (const set of portalSets.values()) {
      for (const k of ['a', 'b']) {
        if (set[k].face.visible) {
          faces.push(set[k].face);
          set[k].face.visible = false;
        }
      }
    }
    for (const [elId, s] of captureSets) {
      const claim = claims.get(elId);
      if (claim) {
        _prtM1.compose(claim.entry.pos, claim.entry.quat, _prtOne).invert();
        _prtM2
          .compose(claim.exit.pos, claim.exit.quat, _prtOne)
          .multiply(_prtR180)
          .multiply(_prtM1)
          .multiply(camera.matrixWorld);
        s.cam.position.setFromMatrixPosition(_prtM2);
        s.cam.quaternion.setFromRotationMatrix(_prtM2);
        s.cam.updateMatrixWorld(true);
        s.cam.projectionMatrix.copy(camera.projectionMatrix);
        s.cam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
        // The eye legitimately stands BEHIND its own wall (as far behind the
        // exit as you stand before the entry) — clip everything behind the
        // exit portal's plane so only the room shows through.
        _prtN.copy(_prtZ).applyQuaternion(claim.exit.quat);
        _prtPlane.setFromNormalAndCoplanarPoint(_prtN, claim.exit.pos);
        renderer.clippingPlanes = [_prtPlane];
      }
      renderer.setRenderTarget(s.target);
      renderer.render(scene, s.cam);
      renderer.clippingPlanes = [];
    }
    renderer.setRenderTarget(null);
    for (const f of faces) f.visible = true;
  }

  function makePortalSlot(color) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.0, 40),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.86, 40),
      new THREE.ShaderMaterial({
        uniforms: { map: { value: null }, res: { value: new THREE.Vector2(1, 1) } },
        vertexShader:
          'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform sampler2D map; uniform vec2 res;\n' +
          // SCREEN-SPACE sampling: the eye renders with the play camera's own
          // projection (posed through the portal frames), so the pixel behind
          // each fragment of the oval is exactly the pixel the through-view
          // puts there — the continuity illusion (§18.32). And a render into
          // a TARGET skips tone mapping + the sRGB output pass — the texels
          // are raw linear; convert or the view reads as a cave.
          'void main(){\n' +
          '  vec3 c = texture2D(map, gl_FragCoord.xy / res).rgb;\n' +
          '  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);\n' +
          '}',
        side: THREE.DoubleSide,
      }),
    );
    face.visible = false;
    group.add(ring);
    group.add(face);
    group.scale.set(0.72, 1.15, 1); // the oval read
    group.visible = false;
    group.userData.noAim = true; // a shot at a portal must land on the WALL
    scene.add(group);
    return { group, ring, face, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  }

  function applyPortal(el) {
    const bag = el.components?.portal;
    let set = portalSets.get(el.id);
    if (!bag) {
      if (set) {
        for (const k of ['a', 'b']) scene.remove(set[k].group);
        portalSets.delete(el.id);
      }
      return;
    }
    if (!set) {
      set = { a: makePortalSlot(PORTAL_COLORS.a), b: makePortalSlot(PORTAL_COLORS.b) };
      portalSets.set(el.id, set);
    }
    for (const k of ['a', 'b']) {
      const d = bag[k];
      const s = set[k];
      if (Array.isArray(d) && d.length >= 6) {
        const n = new THREE.Vector3(d[3], d[4], d[5]).normalize();
        s.pos.set(d[0] + n.x * 0.04, d[1] + n.y * 0.04, d[2] + n.z * 0.04);
        s.quat.setFromUnitVectors(_prtZ, n);
        s.group.position.copy(s.pos);
        s.group.quaternion.copy(s.quat);
        s.group.visible = true;
      } else {
        s.group.visible = false;
      }
    }
    // Faces open only when BOTH portals stand AND the cross-wired eye exists:
    // face A shows eye B's capture (the view out of the far side) and vice
    // versa. Eyes are named elements — the gun writes aCam/bCam.
    set.camNames = { a: bag.aCam ?? null, b: bag.bCam ?? null };
    const both = set.a.group.visible && set.b.group.visible;
    for (const [k, otherCamKey] of [['a', 'bCam'], ['b', 'aCam']]) {
      const camEl = both && bag[otherCamKey]
        ? elements().find((e) => e.name === bag[otherCamKey])
        : null;
      const cap = camEl ? captureSets.get(camEl.id) : null;
      set[k].face.visible = !!cap;
      set[k].face.material.uniforms.map.value = cap ? cap.target.texture : null;
    }
  }

  /* -- the procedural layer (§18.24) --------------------------------------- */
  //
  // Runs AFTER the mixers each frame: a weighted BIAS over whatever pose the
  // clips just wrote, never a replacement — and ONLY while a clip is driving
  // the bones (the mixer rewrites them every frame, so our nudge never
  // accumulates; without a running clip, one nudge per frame would corkscrew
  // the skeleton). Not IK: elbows and knees do not re-solve. A reach is a
  // directional pull, a foot-plant is a settle + tilt — the honest cheap 90%.

  const _prV1 = new THREE.Vector3();
  const _prV2 = new THREE.Vector3();
  const _prV3 = new THREE.Vector3();
  const _prV4 = new THREE.Vector3();
  const _prQ1 = new THREE.Quaternion();
  const _prQ2 = new THREE.Quaternion();
  const _prQ3 = new THREE.Quaternion();
  const _prQ4 = new THREE.Quaternion();
  const _prUp = new THREE.Vector3(0, 1, 0);

  function procBones(obj) {
    if (obj.ae1Proc) return obj.ae1Proc;
    const f = { arm: null, fore: null, footL: null, footR: null, hips: null, neck: null, head: null };
    obj.traverse((o) => {
      if (!o.isBone) return;
      const n = o.name.toLowerCase();
      if (!f.arm && /right[\W_]*arm$/.test(n) && !/forearm$/.test(n)) f.arm = o;
      else if (!f.fore && /right[\W_]*forearm$/.test(n)) f.fore = o;
      else if (!f.footL && /left[\W_]*foot$/.test(n)) f.footL = o;
      else if (!f.footR && /right[\W_]*foot$/.test(n)) f.footR = o;
      else if (!f.hips && /hips$/.test(n)) f.hips = o;
      else if (!f.neck && /neck$/.test(n)) f.neck = o;
      else if (!f.head && /head$/.test(n)) f.head = o;
    });
    obj.ae1Proc = f;
    return f;
  }

  /** Rotate `bone` by the WORLD-space delta `qd` (partial), in bone-local
   *  terms — the aim-assist composition, reused. */
  function boneNudge(bone, qd) {
    const pq = bone.parent.getWorldQuaternion(_prQ3);
    bone.quaternion.premultiply(_prQ4.copy(pq).invert().multiply(qd).multiply(pq));
  }

  function applyProcedural(el, dt) {
    // Only elements that OPTED IN (the character's dat) — and only while a
    // clip is animating their skeleton (see the accumulation note above).
    if (el.footPlant === undefined && el.reachWeight === undefined) return;
    const obj = bindings.get(el.id);
    if (!obj) return;
    const entry = glbs.get(el.components?.model?.media);
    if (!entry?.mixer || !entry.current) return;
    const bones = procBones(obj);
    const ud = obj.userData;
    const k = Math.min(1, dt * 8); // ramp everything; nothing snaps

    // -- HEAD LOOK (§18.35): eyes lead the body ----------------------------- //
    // `model.headLook = [yawDeg, pitchDeg]` (the character publishes the
    // camera's bearing relative to her facing, pre-clamped). Split across
    // neck and head so the crane reads organic; both angles and the weight
    // ramp — a snapped gaze is worse than none.
    const hl = el.components?.model?.headLook;
    const wantH = Array.isArray(hl) ? 1 : 0;
    // A CLEARED gaze drops HARD (×4): it is cleared when the body snaps to a
    // new heading (the trigger pull) — a slow ramp-out there reads as the
    // head spinning against the fire clip. A held gaze still eases normally.
    const kOut = Array.isArray(hl) ? k : Math.min(1, k * 4);
    ud.ae1HeadW = (ud.ae1HeadW ?? 0) + (wantH - (ud.ae1HeadW ?? 0)) * kOut;
    if (Array.isArray(hl)) ud.ae1HeadAt = hl;
    else if (ud.ae1HeadYaw) {
      // and the remembered ANGLES decay toward zero too — a frozen 60° yaw
      // under a fading weight still twists the neck for half a second.
      ud.ae1HeadYaw *= 1 - kOut;
      ud.ae1HeadPitch = (ud.ae1HeadPitch ?? 0) * (1 - kOut);
    }
    if (ud.ae1HeadW > 0.02 && ud.ae1HeadAt && (bones.head || bones.neck)) {
      ud.ae1HeadYaw = (ud.ae1HeadYaw ?? 0) + ((Number(ud.ae1HeadAt[0]) || 0) - (ud.ae1HeadYaw ?? 0)) * k;
      ud.ae1HeadPitch = (ud.ae1HeadPitch ?? 0) + ((Number(ud.ae1HeadAt[1]) || 0) - (ud.ae1HeadPitch ?? 0)) * k;
      for (const [bone, frac] of [[bones.neck, 0.35], [bones.head, 0.65]]) {
        if (!bone) continue;
        bone.updateWorldMatrix(true, false);
        _prV1.set(0, 1, 0); // yaw about world-up
        _prQ1.setFromAxisAngle(_prV1, ud.ae1HeadYaw * DEG * frac * ud.ae1HeadW);
        // pitch about the bone's own right axis (world X column)
        _prV2.setFromMatrixColumn(bone.matrixWorld, 0).normalize();
        _prQ2.setFromAxisAngle(_prV2, ud.ae1HeadPitch * DEG * frac * ud.ae1HeadW);
        boneNudge(bone, _prQ1.multiply(_prQ2));
      }
    }

    // -- REACH: the right arm bends toward `model.reach` -------------------- //
    const reach = el.components?.model?.reach;
    const wantW = Array.isArray(reach)
      ? Math.max(0, Math.min(1, Number(el.reachWeight ?? 0.5)))
      : 0;
    ud.ae1ReachW = (ud.ae1ReachW ?? 0) + (wantW - (ud.ae1ReachW ?? 0)) * k;
    if (Array.isArray(reach)) ud.ae1ReachAt = reach; // the ramp-OUT keeps aiming here
    if (ud.ae1ReachW > 0.02 && ud.ae1ReachAt && bones.arm) {
      const at = ud.ae1ReachAt;
      _prV3.set(at[0], at[1], at[2]);
      for (const [bone, frac] of [[bones.arm, 0.65], [bones.fore, 0.45]]) {
        if (!bone) continue;
        const child = bone.children.find((c) => c.isBone);
        if (!child) continue;
        bone.updateWorldMatrix(true, false);
        const bp = bone.getWorldPosition(_prV1);
        const cur = child.getWorldPosition(_prV2).sub(bp).normalize();
        const want = _prV4.copy(_prV3).sub(bp).normalize();
        const qd = _prQ2.identity().slerp(_prQ1.setFromUnitVectors(cur, want), ud.ae1ReachW * frac);
        boneNudge(bone, qd);
      }
    }

    // -- FOOT PLANT: settle into uneven ground, tilt feet to the slope ----- //
    // ONLY for standing and locomotion (Austin's scoping): during attack and
    // interact the one-shot clip owns the whole body — foot rays under a
    // firing stance oscillated the settle every frame and read as recoil.
    if (el.footPlant === false || el.footPlant === 'false') return;
    const st = el._state;
    const planting =
      el._grounded !== false &&
      (st === undefined || st === 'idle' || st === 'move' || st === 'turn' ||
        st === 'strafeLeft' || st === 'strafeRight' || st === 'backLeft' || st === 'backRight');
    let drop = ud.ae1PlantL ?? 0;
    const feet = [bones.footL, bones.footR];
    if (planting && bones.hips && feet[0] && feet[1]) {
      // One ray per FRAME, alternating feet — the smoothing hides the phase,
      // and the ray budget halves.
      ud.ae1FootPhase = 1 - (ud.ae1FootPhase ?? 0);
      const f = feet[ud.ae1FootPhase];
      f.updateWorldMatrix(true, false);
      const fp = f.getWorldPosition(_prV1);
      const hit = _groundHit(el, fp.x, fp.z, fp.y + 1);
      const d = hit ? Math.min(0, hit.point.y - (Number(el.y) || 0)) : 0;
      if (ud.ae1FootPhase === 0) ud.ae1FootL = d;
      else ud.ae1FootR = d;
      drop = Math.max(Math.min(ud.ae1FootL ?? 0, ud.ae1FootR ?? 0), -0.35);
      // …and the sampled foot tilts partway to the slope under it.
      if (hit?.face) {
        _prV2.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (_prV2.y > 0.5 && _prV2.angleTo(_prUp) > 0.03) {
          const qd = _prQ2.identity().slerp(_prQ1.setFromUnitVectors(_prUp, _prV2), 0.5);
          boneNudge(f, qd);
        }
      }
    } else {
      drop = 0; // one-shots and the air ramp the settle away
    }
    ud.ae1PlantL = drop;
    ud.ae1PlantY = (ud.ae1PlantY ?? 0) + (drop - (ud.ae1PlantY ?? 0)) * k;
    if (Math.abs(ud.ae1PlantY) > 0.004 && bones.hips) {
      // The offset is WORLD-down, expressed in the hips-parent's local frame.
      // `position.y +=` was the recoil bug: this armature bakes rotationX 90,
      // so the parent's local Y points along WORLD Z — the "settle" shoved
      // her forward and back instead of down.
      const pq = bones.hips.parent.getWorldQuaternion(_prQ1).invert();
      _prV1.set(0, ud.ae1PlantY, 0).applyQuaternion(pq);
      bones.hips.parent.getWorldScale(_prV2);
      _prV1.x /= _prV2.x || 1;
      _prV1.y /= _prV2.y || 1;
      _prV1.z /= _prV2.z || 1;
      bones.hips.position.add(_prV1);
    }
  }

  // -- the shader layer (§18.47) -------------------------------------------- //
  // Lazy on both axes: the module loads on first sight of a live PostFX
  // element, and targets allocate on first composite. No element = the plain
  // render below, byte-for-byte the old path.
  let postfx = null;
  let postfxEl = null;
  let postfxScan = 0;
  // §18.56 FX_OFF: the debug wall's shader kill switch — with no postfxEl
  // the frame takes the plain render path below (no DOF, grain, vignette,
  // CA, bloom, renderScale). Rescan is forced so the flag lands next frame.
  let postfxOff = false;
  function setPostFxOff(on) {
    postfxOff = !!on;
    postfxScan = 0;
  }

  function findPostFX(dt) {
    postfxScan -= dt;
    if (postfxScan > 0) return;
    postfxScan = 1; // a 1 Hz scan — adding/removing the element mid-play works
    postfxEl = postfxOff ? null : elements().find((e) => typeof e._pfxTick === 'function'
      && !(e.enabled === false || e.enabled === 'false')) ?? null;
    sweepCullDistance(); // §18.53 phase 2 — same 1 Hz cadence
  }

  // DISTANCE CULLING (§18.53 phase 2): any element with `(cullDistance N)`
  // in its dat hides its bound object when the CAMERA is farther than N
  // from the element — the nine-tile City Ruins only ever shows a few
  // tiles' worth of geometry. 1 Hz is plenty at flight speeds; hidden
  // means pruned from ground rays too, so pick N well past gameplay range.
  // PHASE 3 LOD PAIRS: `cullDistanceMin M` hides the object when the camera
  // is CLOSER than M. A full tile with (cullDistance D) + a decimated twin
  // with (cullDistanceMin D) are exact complements — both stay resident, so
  // the swap is a visibility flip (free) instead of a media rebuild (hitch).
  function sweepCullDistance() {
    for (const el of elements()) {
      const cd = Number(el.cullDistance);
      const cdMin = Number(el.cullDistanceMin);
      if (!(cd > 0) && !(cdMin > 0)) continue;
      const obj = bindings.get(el.id);
      if (!obj) continue;
      // measure to the RENDERED bounds center — tile elements all sit at
      // the origin (the offset lives inside the glb), cached once (static)
      let c = obj.userData.ae1CullCenter;
      if (!c) {
        c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
        obj.userData.ae1CullCenter = c;
      }
      const dx = c.x - camera.position.x;
      const dy = c.y - camera.position.y;
      const dz = c.z - camera.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      let culled = false;
      if (cd > 0 && d2 > cd * cd) culled = true;
      if (cdMin > 0 && d2 <= cdMin * cdMin) culled = true;
      // the verdict lives on userData — applyTransform re-asserts visibility
      // every frame and folds this flag in (a direct write here lasted ONE
      // frame; that overwrite made phase 2's cullDistance a silent no-op)
      obj.userData.ae1CullHidden = culled;
      obj.visible = wantsVisible(el) && !culled;
    }
    sweepLodPairs();
  }

  // PER-MESH LOD (§18.53 phase 3). The City Ruins chunks are NOT a spatial
  // grid — all nine overlap one ~±150 m area, so element-level distance
  // swapping can never separate near from far. Instead a full-detail element
  // names its decimated twin in the model bag (`lodPair` + `lodDistance D`),
  // and each MESH swaps against its own bounds: a far building renders from
  // the twin, a near one full-res, whichever chunk owns it. Twins are baked
  // unjoined from the same blends, so meshes pair by name + occurrence.
  // Verdicts land on mesh.userData.ae1LodHidden — applyParts re-asserts
  // every mesh's visibility each frame and folds that flag in.
  // FLIGHT LOD (setLodFar): measured on the City Ruins, the whole ~9 ms
  // tile bill lives in the giant meshes the camera is always inside of —
  // honest distance LOD can't touch them, but decimating EVERYTHING cut
  // 22 ms to 13 ms. The aircraft flips this on for flight mode, where
  // speed and altitude hide the decimation and frame rate matters most.
  let lodFarAll = false;
  function setLodFar(on) {
    if (lodFarAll === !!on) return;
    lodFarAll = !!on;
    sweepLodPairs(); // flip NOW — mode changes shouldn't wait out the 1 Hz tick
  }
  function sweepLodPairs() {
    let lodChanged = false; // §18.87 — applyParts is guarded; bump its epoch on flips
    for (const el of elements()) {
      const bag = el.components?.model;
      const D = Number(bag?.lodDistance);
      if (!(D > 0) || !bag?.lodPair) continue;
      const obj = bindings.get(el.id);
      if (!obj) continue;
      const pairEl = elements().find((e) => e.name === bag.lodPair);
      const pobj = pairEl ? bindings.get(pairEl.id) : null;
      if (!pobj) continue;
      let kit = obj.userData.ae1LodKit;
      if (!kit || kit.pobj !== pobj) {
        const collect = (root) => {
          const out = [];
          root.traverse((o) => { if (o.isMesh) out.push(o); });
          return out;
        };
        const full = collect(obj);
        const byName = new Map();
        for (const m of collect(pobj)) {
          (byName.get(m.name) ?? byName.set(m.name, []).get(m.name)).push(m);
        }
        const seen = new Map();
        const pairs = [];
        const paired = new Set();
        for (const m of full) {
          const idx = seen.get(m.name) ?? 0;
          seen.set(m.name, idx + 1);
          const twin = (byName.get(m.name) ?? [])[idx] ?? null;
          if (twin) paired.add(twin);
          m.updateWorldMatrix(true, false);
          // world AABB, cached — a bounding SPHERE is uselessly loose here
          // (a fallen overpass's sphere swallows half the map and never
          // LODs); the box is tight along each axis for static geometry
          const box = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position)
            .applyMatrix4(m.matrixWorld);
          pairs.push({ full: m, lod: twin, box });
        }
        // a twin mesh nothing claimed must never render (it would z-fight)
        for (const list of byName.values()) {
          for (const m of list) {
            if (!paired.has(m)) { m.userData.ae1LodHidden = true; m.visible = false; }
          }
        }
        kit = obj.userData.ae1LodKit = { pairs, pobj };
      }
      const cp = camera.position;
      for (const p of kit.pairs) {
        // distance from the camera to the mesh's world AABB — zero while
        // any part of it is overhead or underfoot, honest for far props.
        // Center-distance decimated a near overpass whose center sat 100 m
        // out; sphere-surface distance never decimated anything (ruins
        // meshes sprawl, their spheres swallow the map).
        const b = p.box;
        const dx = Math.max(b.min.x - cp.x, 0, cp.x - b.max.x);
        const dy = Math.max(b.min.y - cp.y, 0, cp.y - b.max.y);
        const dz = Math.max(b.min.z - cp.z, 0, cp.z - b.max.z);
        // a mesh with no twin keeps its only copy on screen at any range
        const near = (!lodFarAll && dx * dx + dy * dy + dz * dz <= D * D) || !p.lod;
        if (p.full.userData.ae1LodHidden !== !near) lodChanged = true;
        p.full.userData.ae1LodHidden = !near;
        if (!near) p.full.visible = false; // un-hides via applyParts next frame
        if (p.lod) {
          if (p.lod.userData.ae1LodHidden !== near) lodChanged = true;
          p.lod.userData.ae1LodHidden = near;
          if (near) p.lod.visible = false;
        }
      }
    }
    if (lodChanged) {
      visEpoch += 1;          // §18.87 — wake every guarded applyParts once
      staticCastDirty = true; // LOD flips change the ground-cast set
    }
  }

  // HARD PAUSE (§18.56): the loop stops dispatching ticks; this stops the
  // renderer's OWN clocks — mixers, per-instance timelines, procedural
  // motion, particles — while the frozen frame keeps presenting. The clock
  // delta is still consumed each frame so resume never sees a dt spike.
  let rendPaused = false;
  function setPaused(on) { rendPaused = !!on; }

  function renderFrame() {
    const dt = clock.getDelta();
    if (!rendPaused) {
      for (const e of glbs.values()) if (e.mixer && e.current) e.mixer.update(dt);
      // per-instance timelines advance beside the originals (§18.46)
      for (const inst of instAnims.values()) if (inst.current) inst.mixer.update(dt);
      stepTrims(); // §18.35 — trimmed clip windows wrap/finish here
      for (const el of elements()) applyProcedural(el, Math.min(dt, 0.1));
      // §18.66 bone physics: after every animation source has posed the
      // skeletons, before the render reads them — the anim post-FX layer.
      for (const el of elements()) {
        const bp = el.components?.model?.bonePhys;
        if (!bp) continue;
        const obj = bindings.get(el.id);
        if (obj) bonePhys.step(el, obj, bp, Math.min(dt, 0.05));
      }
      if (fxEmitters.size) stepFx(Math.min(dt, 0.1)); // a tab-return dt spike must not teleport particles
    }
    if (captureSets.size) renderCaptures(); // eyes fill their targets first
    findPostFX(dt);
    if (postfxEl) {
      if (!postfx) postfx = createPostFX(THREE, renderer);
      postfx.render(scene, camera, {
        focusDist: postfxEl._focusDist,
        dofEnabled: postfxEl.dofEnabled,
        dofAperture: postfxEl.dofAperture,
        dofMaxBlur: postfxEl.dofMaxBlur,
        dofSharpRange: postfxEl.dofSharpRange, // §18.60 — the crisp mid-field

        grainAmount: postfxEl.grainAmount,
        vignette: postfxEl.vignette,
        caAmount: postfxEl.caAmount,
        renderScale: postfxEl.renderScale, // §18.53
        bloomStrength: postfxEl.bloomStrength,
        bloomThreshold: postfxEl.bloomThreshold,
      }, dt);
    } else {
      renderer.render(scene, camera);
    }
  }

  function dispose() {
    for (const e of glbs.values()) e.mixer?.stopAllAction();
    scene.environment?.dispose?.();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  /** §18.87 — compile all shaders + upload textures ahead of the first frame. */
  function precompile() {
    return renderer.compileAsync
      ? renderer.compileAsync(scene, camera)
      : Promise.resolve(renderer.compile(scene, camera));
  }

  return { renderer, scene, camera, glbs, bindings, ensureGlb, build, update, resize, renderFrame, frameCamera, setView, groundAt, groundInfo, pointerGround, pointerPick, rayUp, worldToScreen, cameraClip, boundsOf, sweepBlocked, clipTime, setClipTime, nodePos, aimPoint, setLodFar, setPaused, setPostFxOff, clearDebug, dispose, materialsOf, precompile };
}

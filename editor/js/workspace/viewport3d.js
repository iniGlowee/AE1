/**
 * AE1 - the 3D viewport (editor).
 *
 * The RENDERING is engine/three3d/render3d.js — the same module a shipped 3D
 * game uses, so the viewport and the build cannot drift apart (Principle 2).
 * What lives HERE is editor-only:
 *
 *   - decomposition & merge: a glb no element represents yet is unpacked into
 *     AE1 elements (one per top-level node), added to the current scene
 *   - backfill: sub-mesh names (Parts toggles) and clip names (Animation
 *     dropdown) written onto the model component for the Properties panel
 *   - an orbit camera, the overlay messages, and store event wiring
 *
 * three.js is VENDORED (engine/vendor/three), resolved through the import map
 * in index.html — never a CDN (Principle 5).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRenderer3D } from '/engine/three3d/render3d.js';
import { AE1Input } from '/engine/input.js';
import { AE1ThirdPersonCamera } from '/engine/thirdperson.js';
import { store } from '../scene-store.js';
import { api } from '../api.js';
import { h, clear } from '../ui.js';

const DEG = Math.PI / 180;
const mediaBase = (slug) => `/projects/${slug}/media`;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/** A model-kind media entry by friendly name, or null. */
function modelEntry(name) {
  for (const [hash, e] of Object.entries(store.media ?? {})) {
    if (e.name === name && e.kind === 'model') return { hash, ext: e.ext, name };
  }
  return null;
}

/** Every model-kind glb in the collection, by name. */
function allModels() {
  const out = [];
  for (const [hash, e] of Object.entries(store.media ?? {})) {
    if (e.kind === 'model' && (e.ext === 'glb' || e.ext === 'gltf')) {
      out.push({ hash, ext: e.ext, name: e.name, animOnly: !!e.animOnly, merged: !!e.merged });
    }
  }
  return out;
}

/** A three.js light → an AE1 `light` component. */
function lightToComponent(light) {
  const c = { kind: 'point', color: `#${light.color.getHexString()}`, intensity: r4(light.intensity) };
  if (light.isSpotLight) { c.kind = 'spot'; c.angle = r4(light.angle / DEG); c.penumbra = r4(light.penumbra); c.distance = r4(light.distance); }
  else if (light.isPointLight) { c.kind = 'point'; c.distance = r4(light.distance); }
  else if (light.isDirectionalLight) c.kind = 'directional';
  else if (light.isAmbientLight) c.kind = 'ambient';
  else if (light.isHemisphereLight) c.kind = 'hemisphere';
  return c;
}

/** A top-level glTF node → the data for one AE1 element. */
function nodeToElement(node, glbName) {
  const e = new THREE.Euler().setFromQuaternion(node.quaternion, 'XYZ');
  const data = {
    name: node.name || 'Node',
    type: 'object',
    x: r4(node.position.x), y: r4(node.position.y), z: r4(node.position.z),
    rotation: r4(e.z / DEG), rotationX: r4(e.x / DEG), rotationY: r4(e.y / DEG),
    scaleX: r4(node.scale.x), scaleY: r4(node.scale.y), scaleZ: r4(node.scale.z),
    // EVERY element records the glb + node it came from — that is how a glb is
    // known to be "already unpacked" (so it is not merged twice) and how each
    // element re-binds to its object on reload.
    components: { model: { media: glbName, node: node.name } },
  };
  const light = node.isLight ? node : node.getObjectByProperty('isLight', true);
  if (light) data.components.light = lightToComponent(light);

  // Record the sub-meshes, so the Properties panel can offer per-part show/hide.
  // Ripped models ship alternate expressions and duplicate parts overlapping in
  // one node; there is no "priority" flag in glTF, so the author picks which to
  // keep. Only meaningful when a node holds more than one mesh (a character).
  const meshNames = [];
  node.traverse((o) => { if (o.isMesh) meshNames.push(o.name); });
  if (meshNames.length > 1) {
    data.components.model.parts = meshNames;
    data.components.model.hidden = [];
  }
  return data;
}

export function mountViewport3D(el, context) {
  const slug = context?.project?.slug;

  const canvas = h('canvas', { class: 'viewport-canvas' });
  const overlay = h('div', { class: 'v3d-overlay' });
  el.append(canvas, overlay);

  // The editor loads glbs from the project's media route; a failure is worth an
  // overlay message here (a shipped game inlines its glbs and cannot miss them).
  const loader = new GLTFLoader();
  const loadGlb = (name) =>
    new Promise((resolve) => {
      const m = modelEntry(name);
      if (!m) return resolve(null);
      loader.load(
        `${mediaBase(slug)}/${m.hash}.${m.ext}`,
        resolve,
        undefined,
        () => { overlay.append(h('div', { class: 'v3d-msg v3d-msg--err' }, `Failed to load ${name}`)); resolve(null); },
      );
    });

  let r3d;
  try {
    r3d = createRenderer3D(canvas, {
      // During play, carried inventory (§18.32) renders alongside the scene —
      // the wielded item must ride the hand across scene changes. Travelling
      // projectile templates (§18.38) ride along too.
      elements: () => {
        const base = store.scene?.all() ?? [];
        if (!store.playing) return base;
        const carried = store.world?.carried ?? [];
        const aux = store.world?.carriedAux ?? [];
        return carried.length || aux.length ? [...base, ...carried, ...aux] : base;
      },
      loadGlb,
      // Any media by friendly name (the Skybox fetches its .hdr through this).
      mediaUrl: (name) => {
        for (const [hash, e] of Object.entries(store.media ?? {})) {
          if (e.name === name) return `${mediaBase(slug)}/${hash}.${e.ext}`;
        }
        return null;
      },
      fill: true, // editor chrome: a gentle fill so nothing is pure black
      // A one-shot clip ran out (the 180 turn) — tell the element, the same
      // onFinished contract as Sprite/Video. Play mode only; edit mode loops.
      onClipEnd: (el) => { if (store.playing) store.loop?.dispatchTo(el, 'onFinished'); },
    });
  } catch (err) {
    overlay.append(h('div', { class: 'v3d-msg v3d-msg--err' }, `WebGL unavailable: ${err.message}`));
    return () => {};
  }

  // Console access for driving/debugging the live renderer (the same doctrine
  // as importing scene-store in devtools — respawn.md "How to work here"):
  //   document.querySelector('.viewport-canvas').__r3d
  canvas.__r3d = r3d;

  const controls = new OrbitControls(r3d.camera, canvas);
  controls.enableDamping = true;
  controls.addEventListener('change', requestRender);

  let framed = false;

  /** frameCamera + aim the orbit target at the same center. */
  function frameAll() {
    const framing = r3d.frameCamera();
    if (framing) { controls.target.copy(framing.center); controls.update(); }
  }

  /** Normalise a libs value (the reader collapses single-item lists). */
  const libList = (v) => (typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map(String) : []);

  /** Every glb some element uses as an animation LIBRARY — declared in script
   *  dat (`animLibs`, readable in edit mode through the dat accessor) or on
   *  the model component. Libraries contribute clips, never scene elements. */
  function libraryGlbs() {
    const libs = new Set();
    for (const el of store.scene?.all() ?? []) {
      for (const n of libList(el.animLibs)) libs.add(n);
      for (const n of libList(el.components?.model?.libs)) libs.add(n);
    }
    return libs;
  }

  /** Backfill lists the panel needs but a bare decomposed element lacks: the
   *  sub-mesh names (Parts toggles) and the clip names (the Animation
   *  dropdown — so nobody types "Armature|mixamo.com|Layer0"). Clips include
   *  the model's animation libraries' (§18.10). */
  function backfill() {
    for (const element of store.scene?.all() ?? []) {
      const obj = r3d.bindings.get(element.id);
      const model = element.components?.model;
      if (!obj || !model) continue;
      if (!model.parts) {
        const names = [];
        obj.traverse((o) => { if (o.isMesh) names.push(o.name); });
        if (names.length > 1) element.setComponent('model', 'parts', names);
      }
      const clips = [...(r3d.glbs.get(model.media)?.clips ?? [])];
      for (const lib of libList(model.libs)) {
        for (const c of r3d.glbs.get(lib)?.clips ?? []) if (!clips.includes(c)) clips.push(c);
      }
      if (clips.length && JSON.stringify(model.clips ?? []) !== JSON.stringify(clips)) {
        element.setComponent('model', 'clips', clips);
      }
    }
  }

  // sync() is async and creates elements; a second call arriving mid-flight (a
  // drop during a load) could decompose the same glb twice. Serialize: one runs,
  // the next is coalesced into a single re-run when it finishes.
  let syncing = false;
  let pending = false;
  async function sync() {
    if (syncing) { pending = true; return; }
    syncing = true;
    try { await doSync(); } finally { syncing = false; if (pending) { pending = false; sync(); } }
  }

  async function doSync() {
    const models = allModels();
    if (!models.length) {
      overlay.append(h('div', { class: 'v3d-msg' }, 'Drop a .glb into the Media Collection to see it here.'));
      return;
    }

    // Which glbs are already unpacked into elements — and which are animation
    // LIBRARIES (clips only, no scenery; merging one would stand a duplicate
    // mesh in the scene, §18.10).
    const unpacked = new Set(store.scene.all().map((e) => e.components?.model?.media).filter(Boolean));
    const libs = libraryGlbs();
    let mergedAny = false;

    for (const m of models) {
      // Direct ensureGlb, not build(): build() only loads glbs some element
      // already references, and a freshly-dropped glb has no elements yet.
      const entry = await r3d.ensureGlb(m.name);
      if (!entry) continue;
      // A glb no element represents is NEW → merge it ONCE: decompose its
      // top-level nodes into elements added to the CURRENT scene (nothing
      // existing removed). The `merged` flag on the media entry makes that
      // once PERMANENT — deleting the elements used to resurrect them on the
      // next sync, which made removing an asset impossible (delete the
      // elements → they respawn; delete the media → refused, in use).
      // Flagged anim-only assets and declared libraries never merge at all.
      const markMerged = async () => {
        try {
          await api.patchMedia(slug, m.hash, { merged: true });
          if (store.media[m.hash]) store.media[m.hash].merged = true;
        } catch (err) {
          console.warn('[viewport3d] could not mark merged:', err);
        }
      };
      if (!m.merged && !libs.has(m.name) && !m.animOnly) {
        if (!unpacked.has(m.name)) {
          for (const node of [...entry.gltf.scene.children]) {
            store.addElement(nodeToElement(node, m.name), 'scene');
          }
          unpacked.add(m.name);
          mergedAny = true;
        }
        // Either way it is now represented (or already was) — remember that.
        await markMerged();
      }
    }

    await r3d.build();
    backfill();

    // Frame on first content, and whenever something new merges in, so a dropped
    // character actually comes into view.
    if (!framed || mergedAny) { frameAll(); framed = true; }
    clear(overlay);
    overlay.append(h('div', { class: 'v3d-msg v3d-msg--info' }, `${r3d.glbs.size} file${r3d.glbs.size === 1 ? '' : 's'}, ${r3d.bindings.size} element${r3d.bindings.size === 1 ? '' : 's'}`));
    requestRender();
  }

  /* -- play mode ----------------------------------------------------------- */
  //
  // While the store plays, the viewport IS the game (DESIGN.md §18.9): input is
  // captured on this canvas, the world gets the ground query, and — if the
  // scene has a ThirdPersonCamera — the VIEW is that camera, not the orbit.
  // Stop restores the editor camera exactly where it was.

  const input = new AE1Input();
  let savedPose = null;

  // Esc, pressed while the mouse is FREE, stops play — the way out of the
  // game and back to the editor. (Under pointer lock the browser reserves the
  // first Esc for releasing the lock and suppresses the event; so it reads as:
  // first Esc frees the mouse, second Esc stops play.)
  function onPlayKey(e) {
    if (e.code === 'Escape' && !document.pointerLockElement && store.playing) store.stop();
  }

  function enterPlay() {
    input.attach(canvas);
    if (store.world) {
      store.world.input3d = input;
      store.world.env3d = {
        groundAt: (pel, x, z, fromY) => r3d.groundAt(pel, x, z, fromY),
        groundInfo: (pel, x, z, fromY) => r3d.groundInfo(pel, x, z, fromY),
        boundsOf: (pel) => r3d.boundsOf(pel),
        blocked: (pel, x1, z1, x2, z2, y) => r3d.sweepBlocked(pel, x1, z1, x2, z2, y),
        clipTime: (pel) => r3d.clipTime(pel),
        nodePos: (pel, name) => r3d.nodePos(pel, name),
        aimPoint: (pel, maxDist) => r3d.aimPoint(pel, maxDist),
        // §click-to-move + §element-graph — the editor Play surface must offer
        // the same cursor queries the shipped game3d.js host does, or a TileMover
        // can't route and an ElementGraph can't pick/roof-probe under Play.
        pointerGround: (nx, ny) => r3d.pointerGround(nx, ny),
        pointerPick: (nx, ny) => r3d.pointerPick(nx, ny),
        rayUp: (x, y, z, exclude) => r3d.rayUp(x, y, z, 40, exclude),
        worldToScreen: (x, y, z) => r3d.worldToScreen(x, y, z),
        cameraClip: (lx, ly, lz, cx, cy, cz, exclude) => r3d.cameraClip(lx, ly, lz, cx, cy, cz, exclude),
        // the bound THREE object — the motion-matching character drives its
        // skeleton directly (engine/the motion-matching driver (not in the public build)). Same hook as
        // game3d.js — both hosts or the two surfaces disagree (Principle 2).
        objectFor: (pel) => r3d.bindings.get(pel.id) ?? null,
      };
    }
    // Edges (jump, actions) must close on the GAME LOOP's frame, after its
    // dispatch — NOT in this pane's render tick. The two are separate rAF
    // callbacks and this pane's runs FIRST, so an endFrame here would clear
    // every pressed() before any script saw it. One eaten jump = this comment.
    if (store.loop && !store.loop.onFrame) store.loop.onFrame = () => input.endFrame();
    savedPose = {
      pos: r3d.camera.position.clone(),
      rot: r3d.camera.rotation.clone(),
      target: controls.target.clone(),
    };
    controls.enabled = false;
    canvas.style.cursor = 'none'; // play mode owns the pointer, seen or not
    window.addEventListener('keydown', onPlayKey);
    overlay.append(h('div', { class: 'v3d-msg v3d-msg--info' }, 'Mouse looks around — click to capture it, Esc stops play.'));
  }

  function exitPlay() {
    input.detach();
    if (store.loop?.onFrame) store.loop.onFrame = null;
    canvas.style.cursor = '';
    r3d.clearDebug(); // routes, trails, aim tracers are PLAY things
    // A motion-matching character's skeleton is wherever the last matched frame
    // left it — the driver poses bones directly, and its element is torn down
    // with play, so nobody would ever un-pose them: the edit viewport froze
    // mid-stride. The class stashes the graph's true bind on the persistent
    // binding (the motion-matching driver (not in the public build), userData.__mmBind); restore it here
    // so edit mode shows the rest pose again.
    for (const obj of r3d.bindings.values()) {
      const snap = obj?.userData?.__mmBind;
      if (!snap) continue;
      for (const [node, t] of snap) {
        node.position.fromArray(t.p);
        node.quaternion.fromArray(t.q);
        node.scale.fromArray(t.s);
      }
      obj.updateMatrixWorld(true);
    }
    lastCount = -1; // every play entry starts from a FRESH build (held, not drawn)
    window.removeEventListener('keydown', onPlayKey);
    controls.enabled = true;
    if (savedPose) {
      r3d.camera.position.copy(savedPose.pos);
      r3d.camera.rotation.copy(savedPose.rot);
      controls.target.copy(savedPose.target);
      controls.update();
      savedPose = null;
    }
    requestRender();
  }

  /* -- render loop -------------------------------------------------------- */

  let raf = null;
  let needsRender = true;
  let lastCount = -1; // play-mode element count, for spawn rebuilds
  let rebuilding = null; // in-flight play build: HOLD the frame until it lands
  function requestRender() { needsRender = true; }

  function tick() {
    raf = requestAnimationFrame(tick);

    if (store.playing) {
      // The game loop already ticked the scripts; push every element's state to
      // the renderer, aim the view, and draw — every frame, it's a game now.
      // SPAWNS (fired projectiles) change the element count: rebuild bindings
      // so the new round gets its mesh clone (§18.15).
      const n = store.scene?.size ?? 0;
      if (n !== lastCount) {
        lastCount = n;
        rebuilding = r3d.build().finally(() => { rebuilding = null; });
      }
      // NEVER draw a half-built scene: mid-build, nodes sit at their raw glb
      // spots (everything piled at the origin — the play-start artifact).
      // Hold the last good frame; the first frame drawn after the build is a
      // full script-applied update pass below, so it lands CORRECT.
      if (rebuilding) return;
      let viewCam = null;
      // Scene elements ONLY — deliberately NOT the carried list. game3d's
      // frame loop iterates scene+carried (the giant-key fix), but here
      // touching store.world?.carried per frame FROZE the character (start
      // clips churning, position pinned — measured, then bisected back to
      // exactly this line). The editor is covered anyway: its element change
      // events re-sync carried items the moment a mount/visible flag moves.
      for (const element of store.scene?.all() ?? []) {
        r3d.update(element);
        if (!viewCam && element instanceof AE1ThirdPersonCamera) viewCam = element;
      }
      if (viewCam) r3d.setView(viewCam);
      r3d.renderFrame();
      return;
    }

    const easing = controls.update();
    // renderFrame advances the mixers AND draws; while a clip is playing, every
    // frame needs it. Otherwise render only on demand (edits, orbiting).
    let animating = false;
    for (const e of r3d.glbs.values()) if (e.mixer && e.current) { animating = true; break; }
    if (needsRender || easing || animating) {
      needsRender = false;
      r3d.renderFrame();
    }
  }

  function resize() {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    r3d.resize(rect.width, rect.height);
    requestRender();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  resize();
  sync();
  tick();

  const offs = [
    store.on('element', ({ element }) => {
      if (element) {
        r3d.update(element); // unbound elements matter too (the Skybox)
        requestRender();
      }
    }),
    store.on('scene', sync),
    store.on('media', sync), // a dropped .glb merges in
    store.on('play', (on) => (on ? enterPlay() : exitPlay())),
  ];

  // Mounted mid-play (pane opened after F5)? Catch up.
  if (store.playing) enterPlay();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    offs.forEach((off) => off());
    input.detach();
    window.removeEventListener('keydown', onPlayKey);
    controls.dispose();
    r3d.dispose();
  };
}

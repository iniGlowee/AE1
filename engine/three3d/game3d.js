/**
 * AE1 - the shipped 3D game boot.
 *
 * The 3D counterpart of game.js. Same idea — all data is inlined, the game runs
 * from a double-clicked file:// page — but 3D forces two differences:
 *
 *   1. It is an ES MODULE, because three.js is. The 2D game is a concatenated
 *      classic script; a 3D game loads three.js and this file via an import map.
 *   2. glTF can't be fetched on file:// (no fetch), so each .glb is inlined as
 *      base64 and turned into a Blob URL here — GLTFLoader loads a blob: URL fine
 *      on file://, where a relative path would be blocked (DESIGN.md §18.8).
 *
 * The rendering is `render3d.js`, the SAME module the editor viewport uses, so a
 * 3D game looks in the shipped build exactly as it did while authoring
 * (Principle 2). This file only wires it to the world and the game loop.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createRenderer3D } from './render3d.js';
import { AE1World } from '../world.js';
import { compileAll } from '../ags/runtime.js';
import { GameLoop } from '../loop.js';
import { AE1Input } from '../input.js';
import { AE1ThirdPersonCamera } from '../thirdperson.js';

export function bootGame3D(data, mount = document.body) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ae1-canvas';
  mount.append(canvas);

  // Inlined glb (base64) -> Blob URL, decoded LAZILY and NATIVELY. Blob URLs
  // load on file:// where a relative path would hit a blocked fetch — but the
  // decode is its own trap: `Uint8Array.from(atob(b64), cb)` invokes the
  // callback PER CHARACTER, and a 175 MB model froze the page for minutes.
  // fetch of a data: URL hands the decode to the browser's native path.
  const glbUrls = new Map();
  async function glbUrl(name) {
    if (glbUrls.has(name)) return glbUrls.get(name);
    const b64 = (data.glbs || {})[name];
    if (!b64) return null;
    let buf;
    if (typeof b64 !== 'string') {
      buf = b64; // §18.88 aepack path — already raw bytes, zero decode
    } else {
      try {
        buf = await (await fetch(`data:application/octet-stream;base64,${b64}`)).arrayBuffer();
      } catch {
        const bin = atob(b64); // fallback: a tight loop, never a per-char callback
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        buf = bytes.buffer;
      }
    }
    const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
    glbUrls.set(name, url);
    // §18.87 RELEASE THE PAYLOAD: the base64 source string (1.33× the asset)
    // was retained for the whole session — for the dev room that pinned
    // ~660 MB of strings that were consumed exactly once. render3d caches
    // the PARSED gltf per name forever, so the string never serves again.
    if (data.glbs) delete data.glbs[name];
    return url;
  }

  const loader = new GLTFLoader();
  // §18.92 meshopt geometry (EXT_meshopt_compression + KHR_mesh_quantization):
  // the decoder's wasm is base64-inlined in the module, so it runs on file://
  // with no fetch. A glb without the extension loads unchanged.
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loadGlb = (name) =>
    glbUrl(name).then(
      (url) =>
        url &&
        new Promise((res) => {
          loader.load(url, (gltf) => {
            // §18.87: the Blob served its one load — unpin it (the decoded
            // ArrayBuffer inside was ANOTHER full copy held for the session).
            URL.revokeObjectURL(url);
            glbUrls.delete(name);
            res(gltf);
          }, undefined, () => res(null));
        }),
    );

  // Any inlined media by name (the Skybox's .hdr, audio tracks). §18.87:
  // a data: URL instead of the old synchronous atob loop — the browser
  // decodes NATIVELY on use: <audio> streams it (no main-thread decode of a
  // 4-minute track before playback), fetch() of the HDR decodes off-thread.
  const mediaUrlCache = new Map();
  function mediaUrlSync(name) {
    if (mediaUrlCache.has(name)) return mediaUrlCache.get(name);
    const b64 = (data.glbs || {})[name];
    if (!b64) return null;
    const url = typeof b64 === 'string'
      ? `data:application/octet-stream;base64,${b64}`
      : URL.createObjectURL(new Blob([b64])); // §18.88 aepack — raw bytes
    mediaUrlCache.set(name, url);
    return url;
  }

  const { classes, diagnostics } = compileAll(data.scripts || {});
  for (const d of diagnostics) {
    const where = `${d.file}${d.line ? `:${d.line}` : ''}`;
    console[d.severity === 'error' ? 'error' : 'warn'](`[ags] ${where} — ${d.message}`);
  }

  const world = new AE1World({
    scenes: data.scenes,
    hud: data.hud,
    classes,
    media: data.media || {},
    mediaBase: 'media',
    game: { id: data.gameId, title: data.title, version: data.version, engine: 'Angel’s Egg' },
  });

  // DATA FILES on file:// — the motion-matching database packs (§AE1-SYNC): the
  // export inlines kind-"other" media as base64 (data.bins, by name), and
  // this hook hands them out as data: URLs. The character's loader fetch()es
  // whatever URL it gets, and fetch decodes a data: URL natively — no eager
  // decode of a 90 MB pose stream, no Blob juggling. Absent in the editor
  // host (media served over http there), so the character falls back to
  // `${mediaBase}/${hash}.${ext}` — the same file the server serves.
  const binUrlCache = new Map();
  world.mediaUrlFor = (name) => {
    const b64 = (data.bins || {})[name];
    if (!b64) return null;
    if (typeof b64 === 'string') return `data:application/octet-stream;base64,${b64}`;
    let url = binUrlCache.get(name); // §18.88 aepack — raw bytes as a Blob URL
    if (!url) { url = URL.createObjectURL(new Blob([b64])); binUrlCache.set(name, url); }
    return url;
  };

  // AUDIO on file:// (§18.18): sound files are INLINED like the glbs — there
  // is no media folder to point an <audio> at. The audio engine asks for a
  // URL by hash; resolve the hash back to its media NAME and hand over the
  // same Blob URL path everything else inlined rides.
  const AUDIO_MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4' };
  const audioUrl = world.audio.url.bind(world.audio);
  world.audio.url = (hash, ext) => {
    const meta = (data.media || {})[hash];
    const name = meta?.name;
    if (!name) return audioUrl(hash, ext);
    const b = (data.glbs || {})[name];
    if (b == null) return mediaUrlSync(name) || audioUrl(hash, ext);
    // §18.91: a correctly-typed URL — the exporter may have transcoded to
    // mp3 (meta.ext updated), and a bare octet-stream data URL leaves
    // <audio> to sniff. base64 (file://) → typed data: URL; aepack raw
    // bytes → typed Blob URL.
    const mime = AUDIO_MIME[meta.ext] || 'audio/mpeg';
    if (typeof b === 'string') return `data:${mime};base64,${b}`;
    let url = binUrlCache.get('__audio__' + name);
    if (!url) { url = URL.createObjectURL(new Blob([b], { type: mime })); binUrlCache.set('__audio__' + name, url); }
    return url;
  };

  let loopRef = null; // the loop is built below; the renderer needs it early
  const r3d = createRenderer3D(canvas, {
    // Carried inventory (§18.32) renders too — the wielded item's mesh must
    // ride the hand in every scene, not just the one it was picked up in.
    // Travelling projectile templates (§18.38) come along the same way.
    elements: () =>
      world.scene
        ? [...world.scene.all(), ...(world.carried ?? []), ...(world.carriedAux ?? [])]
        : [],
    loadGlb,
    // An inlined asset by name (glb, hdr) — or, for media the export ships as a
    // FILE (images: an Image Plane's picture, a particle sheet), the shipped file
    // by its manifest entry, which a relative <img> load reads on http and on
    // file:// alike. Inlined-only left every image plane white in a build while
    // the editor drew it (MANAGER-PROJECT-01 W2; Principle 2).
    mediaUrl: (name) => {
      const inlined = mediaUrlSync(name);
      if (inlined) return inlined;
      const r = world.resolveMedia(name);
      return r ? `media/${r.hash}.${r.ext}` : null;
    },
    fill: false, // a shipped game is lit by its own lights, not editor fill
    // A one-shot clip ran out (the 180 turn) — tell the element, the same
    // onFinished contract as Sprite/Video.
    onClipEnd: (el) => loopRef?.dispatchTo(el, 'onFinished'),
  });

  // §18.89 KTX2: GPU-compressed textures (KHR_texture_basisu). The exporter
  // embeds the basis transcoder in the payload bag under reserved names, so
  // a shipped game decodes on file:// AND on any web host — no external
  // path, no CDN. detectSupport picks the GPU's native block format (BC7 on
  // desktop); textures stay compressed in VRAM (~4x less than RGBA8).
  {
    const tjs = mediaUrlSync('__basis_transcoder.js');
    const twasm = mediaUrlSync('__basis_transcoder.wasm');
    if (tjs && twasm) {
      const ktx2 = new KTX2Loader()
        .setTranscoderPath({ js: tjs, wasm: twasm }) // AE1-patched loader
        .detectSupport(r3d.renderer);
      loader.setKTX2Loader(ktx2);
    }
  }

  // Third-person wiring (§18.9): the input the Controller's mappings are read
  // against, and the geometry query the character's pure-math physics injects.
  const input = new AE1Input();
  input.attach(canvas);
  world.input3d = input;
  world.env3d = {
    groundAt: (el, x, z, fromY) => r3d.groundAt(el, x, z, fromY),
    groundInfo: (el, x, z, fromY) => r3d.groundInfo(el, x, z, fromY),
    pointerGround: (nx, ny) => r3d.pointerGround(nx, ny), // cursor→ground (click-to-move)
    pointerPick: (nx, ny) => r3d.pointerPick(nx, ny), // cursor→named glb node (§element-graph)
    rayUp: (x, y, z, exclude) => r3d.rayUp(x, y, z, 40, exclude), // is a roof overhead? (§element-graph)
    worldToScreen: (x, y, z) => r3d.worldToScreen(x, y, z), // world→canvas px (§click marker)
    cameraClip: (lx, ly, lz, cx, cy, cz, exclude) => r3d.cameraClip(lx, ly, lz, cx, cy, cz, exclude), // §cam collision
    boundsOf: (el) => r3d.boundsOf(el),
    blocked: (el, x1, z1, x2, z2, y) => r3d.sweepBlocked(el, x1, z1, x2, z2, y),
    clipTime: (el) => r3d.clipTime(el),
    setClipTime: (el, t) => r3d.setClipTime(el, t), // §18.52 phase lock
    setLodFar: (on) => r3d.setLodFar(on), // §18.53 phase 3 — flight-mode LOD
    setPaused: (on) => r3d.setPaused(on), // §18.56 — the debug menu's frame freeze
    setPostFxOff: (on) => r3d.setPostFxOff(on), // §18.56 — the FX_OFF debug flag
    nodePos: (el, name) => r3d.nodePos(el, name),
    aimPoint: (el, maxDist) => r3d.aimPoint(el, maxDist),
    // the bound THREE object — the motion-matching character drives its skeleton
    // directly (engine/the motion-matching driver (not in the public build))
    objectFor: (el) => r3d.bindings.get(el.id) ?? null,
    // §18.79 — live material access for animated surfaces (screens)
    materialsOf: (el, pattern) => r3d.materialsOf(el, pattern),
  };

  function resize() {
    r3d.resize(window.innerWidth, window.innerHeight);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }
  window.addEventListener('resize', resize);
  resize();

  // The loop runs the scripts (onLoad → idle, onTick, …); each frame we push
  // element state onto the renderer and draw. Reconciling per element per frame
  // keeps a script's this.play("walk") live without any event wiring.
  let lastCount = -1; // spawns (fired projectiles) need fresh bindings
  let rebuilding = null; // in-flight rebuild: hold the frame until it lands
  const loop = new GameLoop(world, {
    onFrame: () => {
      const n = world.scene?.size ?? 0;
      if (n !== lastCount) {
        lastCount = n;
        rebuilding = r3d.build().finally(() => { rebuilding = null; });
      }
      // A half-built scene draws every node at its raw glb spot (the piled-up
      // first-frame artifact) — hold the last good frame instead; the first
      // frame after the build lands fully script-applied.
      if (rebuilding) return;
      let viewCam = null;
      // The SAME list the renderer builds from — scene PLUS carried inventory
      // and travelling templates (§18.32/§18.38). Iterating world.scene.all()
      // alone starved carried items of per-frame reconcile: an unequipped
      // item evicted from the hand bone kept its MOUNT-ERA scale and
      // visibility forever (Austin's giant key floating in the map), and an
      // equip that landed between rebuilds never applied its mount at all
      // (the invisible wielded weapon after a level switch).
      const live = world.scene
        ? [...world.scene.all(), ...(world.carried ?? []), ...(world.carriedAux ?? [])]
        : [];
      for (const el of live) {
        r3d.update(el);
        if (!viewCam && el instanceof AE1ThirdPersonCamera) viewCam = el;
      }
      // A third-person camera in the scene IS the play perspective.
      if (viewCam) r3d.setView(viewCam);
      r3d.renderFrame();
      input.endFrame(); // edges (jump, actions) are one frame wide
    },
    onError: (err, el, method, mode) =>
      console.error(`[ags] ${el?.name}.${method}() threw during ${mode}:`, err),
  });
  world.loop = loop;
  loopRef = loop;

  // Scene first (fires onLoad — AE1Model sets its idle clip), then build the
  // three.js scene (loads glbs, binds, plays the clips), frame it, start ticking.
  world.start(data.entryScene);
  r3d.build().then(async () => {
    lastCount = world.scene?.size ?? 0; // the boot build already covered these
    r3d.frameCamera();
    // §18.87 SHADER WARM-UP: compile every material (including the near-fade
    // twins) and upload textures BEFORE the first playable frame — the cost
    // rides the load screen instead of hitching mid-play when a character
    // first walks into view.
    try { await r3d.precompile(); } catch { /* best-effort */ }
    loop.start();
  });

  const game = { world, loop, render: r3d, canvas };
  window.AE1 = game;
  return game;
}

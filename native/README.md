# AE1 native runtime

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

The Windows build target from Build & Ship. The editor, Curator, and motion-matching
lab stay in the browser forever (docs/engine/20); this is the C++ *player* that
consumes a frozen AE1 Game Package (AGP, docs/engine/21) and will grow into the
Phase-A shell (SDL3 + a render backend + miniaudio + QuickJS running the engine
JS unmodified).

## Status — Phase A: package reader + native shell

Built so far, with **zero third-party dependencies** (MSVC + Windows SDK only):

**Step 0 — the package reader**
- `src/json.hpp` — header-only recursive-descent JSON reader for AE1's own JSON.
- `src/agp.hpp` / `src/agp.cpp` — the AGP reader: memory-maps `game.aepack`,
  validates the `AEPK` header, parses the TOC, and hands out **zero-copy** views
  into the mapping. SHA-256 via the Windows CNG (BCrypt) provider. Parses
  `manifest.json`. This is the native mirror of the browser loader's fetch path.
- `src/main.cpp` — `ae1pack`, an inspector that reports a package's identity,
  scenes/scripts/media, and every asset, and (`--verify`) re-hashes data.json,
  the whole pack, and every asset against the recorded digests.

**Step 1 — the native shell + renderer seam** (`ae1player`)
- `src/platform.hpp` / `src/platform_win32.cpp` — the platform seam (window,
  input, timing) on Win32. Owns the window and exposes its HWND; rendering lives
  behind the Gfx seam. An SDL3 implementation later drops in behind it unchanged.
- `src/gfx.hpp` / `src/gfx_d3d11.cpp` — the **renderer seam** and its first
  backend. Decision (2026-09-04): implement on **D3D11** now (Windows SDK only,
  zero new deps); **bgfx** stays the documented future backend that replaces
  `gfx_d3d11.cpp` behind `gfx.hpp` unchanged. Owns device, swapchain, depth,
  a shader compiled from inline HLSL, vertex/index buffers, a camera + per-object
  transform, and simple lighting. `src/mat.hpp` — small matrix/vec math.
- `src/player.cpp` — `ae1player`, the shell: opens a package (same reader as
  `ae1pack`), stands up the window + renderer, runs a **fixed-timestep loop**
  with an orbit camera, and renders a spinning lit cube through the gfx seam
  (the game's own meshes replace it once glTF loading from the pack lands). Titles
  the window from the game; `--seconds N` self-exits (for verify/CI).

**Step 2 — JavaScript runs natively** (`ae1js`) — *needs one vendored library*
- `third_party/quickjs-0.16.2/` — vendored quickjs-ng (see `third_party/VENDORING.md`).
- `src/qjs_main.cpp` — `ae1js`, which embeds QuickJS, installs an ES-module
  loader that resolves the engine's own imports from disk, loads the **real**
  engine AGS compiler (`engine/ags/compiler.js` → `reader.js`) into it, and runs
  it on the **real** game scripts pulled from the loaded AGP. Compiles all 30
  devroom scripts with the engine's own compiler and proves an emitted script
  class actually builds — the "same game, unmodified code" thesis in native.

**Step 3 — the engine's element/dispatch model ticks** (`ae1run`)
- `src/qjs_host.hpp` / `src/qjs_host.cpp` — a reusable QuickJS host: runtime +
  context lifecycle, a `console`, platform-global polyfills (`structuredClone`),
  native-function registration, and an ES-module loader with a **stub table** so
  a rendering module can be replaced by a stand-in while its dependents run for
  real. The seed of the eventual runtime's script host.
- `src/qjs_run.cpp` — `ae1run`, which loads the **real** engine scheduler
  (`ags/runtime.js`: `compileAll`/`rehydrate`/`buildSchedule`/`dispatch`) and
  scene (`scene.js`), builds the entry scene from the AGP, compiles the game's
  scripts to classes, rehydrates the scene onto them, builds the scheduler
  tables, and dispatches run modes including repeated `onTick` frames. The ~30
  rendering element types are stubbed (empty classes extending the real
  `AE1Element`) pending the renderer; the scheduler itself is authentic. On
  devroom: 31 elements, 30 classes, 29 rehydrated, and 4/5 `onTick` handlers run
  natively per frame with no renderer bound.

This proves, in native code, that the package contract, the platform loop, the
engine's JavaScript, AND the engine's own element/dispatch model all hold before
the renderer exists — the foundation every later system plugs into.

## Build

Needs the **"Desktop development with C++"** workload of Visual Studio 2019
Build Tools (MSVC 14.29 + Windows SDK 10.0.19041 confirmed working). No CMake —
`build.bat` drives `cl.exe` through `vcvars64.bat`.

```
native\build.bat
```

Output: `native\build\ae1pack.exe`.

## Run

Inspect / verify a package:

```
build\ae1pack.exe ..\exports\devroom-agp --verify
```

Run the native shell (opens a window; Esc quits, `--seconds N` self-exits):

```
build\ae1player.exe ..\exports\devroom-agp
```

Run the engine's JavaScript natively — compile every game script with the real
engine compiler inside QuickJS:

```
build\ae1js.exe ..\exports\devroom-agp ..\engine
```

Tick the engine's element/dispatch model natively — build the scene, compile,
rehydrate, schedule, and dispatch onTick frames:

```
build\ae1run.exe ..\exports\devroom-agp ..\engine
```

Tick AND draw — the whole game in one native loop (engine + renderer):

```
build\ae1game.exe ..\exports\devroom-agp ..\engine
```

## Roadmap (docs/engine/20)

- **Step 0 (done):** AGP reader + inspector, integrity verified.
- **Step 1 (done):** native shell — window, D3D11 present loop, input, fixed
  timestep, titled from the package. Ships a running exe with zero downloads.
- **Step 2 (done):** QuickJS embedded; the real engine AGS compiler runs inside
  it and compiles every game script. Scripts run unmodified — thesis proven.
- **Step 3 (done):** the real engine scheduler ticks the real scene natively —
  compile → rehydrate → schedule → dispatch onTick, with rendering element types
  stubbed pending the renderer.
- **Step 4 (done):** the `gfx` renderer seam + a D3D11 backend — device,
  swapchain, depth, HLSL shader, meshes, camera, lighting; a spinning lit cube
  renders through it. Backend call made: D3D11 now, bgfx deferred behind the seam.
- **Step 5 (done):** glTF/GLB loading from the mapped pack — plain meshes, plus
  `EXT_meshopt_compression` (via vendored meshoptimizer), `KHR_mesh_quantization`,
  and **CPU skinning at bind pose** (joint matrices = worldTransform(joint) ·
  inverseBindMatrix; the skinned mesh's node transform is ignored per spec).
  Props and the full character cast render — the runt machine, the player character, the companion character, the
  Officer all stand correctly.
- **Step 6 (done):** the scene join — `ae1player` with no glb argument reads the
  entry scene from data.json and draws every visible element that has a model,
  each glb loaded from the pack and placed at its element world transform
  (position / euler XYZ|YXZ / scale, composing parents — matching render3d's
  applyTransform). The dev room assembles natively. (the player character's cm-rig double-scales
  under her 0.01 element scale — the engine's model-mount handles that specially;
  a per-asset follow-up.)
- **Step 7 (done):** materials — base-color textures. KTX2 (`KHR_texture_basisu`)
  images are transcoded to RGBA8 via the vendored Basis Universal transcoder
  (`tex.hpp/.cpp`), UVs (+ `KHR_texture_transform`) are read into the vertex, and
  a textured D3D11 shader samples them. The player character and the cast render with their real
  materials. (PNG-encoded images — the §18.96 hair cutouts — are skipped for now.)
- **Step 8 (done) — the tick+draw join** (`ae1game`): ONE native loop that hosts
  the real engine scheduler in QuickJS (as `ae1run`) AND renders the scene (as
  `ae1player`). Each frame it dispatches `onTick`, then reads every drawn
  element's live transform back from the JS scene and draws its meshes there.
  Meshes load in glb-local space; the element's right-handed transform is
  converted to the renderer's left-handed model matrix per frame. This is the
  Phase-A capstone: the engine's own model, ticking, drawing itself.
- **Step 9 (done) — animation.** A glTF animation player (in `gltf.cpp`, opaque
  `GlbRig`): loads a glb as a posable rig, and `poseRig(anim, t)` samples the
  TRS channels, re-poses the skeleton, and re-skins on the CPU. `gfx` gained
  dynamic meshes (`updateMesh`) to refresh the verts each frame. `ae1player
  <glb> --anim <clip>` plays any clip; `ae1game` plays each animated character's
  Idle in-scene while the engine ticks. (the player character's clips live in a separate
  `hero_actions.glb` with no skin — retargeting those is later.)
- **Step 10 (done) — native bindings; real element modules run.** `ae1game`
  builds a native `world`: `input3d` backed by the platform keyboard (KeyboardEvent.code
  / Mouse<N> strings mapped to live key state), `env3d` as the query surface with
  sane defaults, and a deep no-op Proxy for fields not yet implemented so nothing
  crashes. Only the 4 three/DOM modules (light, the motion-matching driver †, debugmenu,
  video) stay stubbed; every other element type (model3d, thirdperson, npc,
  hitbox, projectile, …) loads FOR REAL and drives the render through the real
  interface. Verified: 18/18 onTick handlers run, 0 threw.
- **Step 11 (done) — the finishers.** (a) PNG/JPEG decode via vendored stb_image
  + alpha test (glTF MASK/BLEND cutoff) in the shader — the player character's hair cuts out as
  strands. (b) The the player character scale rule — a tiny element scale on an already-human-sized
  mesh (her cm-rig 0.01) is treated as a rig artifact, so she stands at full size.
  (c) miniaudio — the audio seam plays the pack's MP3s from memory;
  `world.playSound/playMusic/voiceLine` route to it. Verified: device opens, a
  pack MP3 decodes and plays.
- **Step A.5 (done) — motion-matching runs natively.** A three.js-math shim
  (`Vector2/3`, `Quaternion`, `Matrix4`, `Object3D`/`Bone` — pure JS, no WebGL)
  un-stubs the last element types. The `objectFor` skeleton bridge: `objectFor(el)`
  hands the matcher a JS `Bone` graph built from the glb node hierarchy
  (`__rigNodes`); the matcher poses it each tick; the native renderer reads the
  posed world-matrices back (`__rigWorldsArr` → `poseRigFromWorlds`) and skins the
  mesh. The matcher builds from the pack's pose DBs (a `fetch` shim serves them),
  and the player character + the companion character render in real motion-matching poses, textured, with a follow-cam.
  **Caveat:** the matcher's search over the 65 MB pose DB in *interpreted* QuickJS
  runs ~0.5 fps — the hot path Phase B moves to native C++. Capability proven
  end to end; performance is Phase B.
- **Phase B (next per docs/engine/20):** move the hot paths — the motion-matching
  search, and CPU skinning — into native C++ behind the same interfaces, so the
  matcher and skinning run at frame rate. Then the player character walks in real time.

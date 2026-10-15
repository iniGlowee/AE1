# 20 — Breaking out of the browser: the native build architecture

*Drafted 2026-09-03, the start of the optimization/portability phase. This is
the plan of record for shipping Windows 11 executables from Build & Ship while
the editor, Curator, and motion-matching lab stay in the browser forever.*

## The core insight: the game package is already portable

Build & Ship already collects everything that makes a game *that game*:

- `scenes/*.json` — elements, components, transforms, dat overrides
- `scripts/*.ags.txt` — the AngelScript (dat header + JS body)
- `hud.json`, save-schema, settings
- `media/` — content-addressed assets (glb, textures, audio, mm packs, fonts)

Nothing in that set is browser-specific. **We name this the AE1 Game Package
(AGP)** and freeze it as a versioned spec (`agpVersion: 1`). A build target is
then just a *runtime* that consumes an AGP:

```
                    ┌─ target: browser ──► single index.html (today, forever)
project ──► AGP ────┤
                    └─ target: windows ──► game.exe + pack.agp (native player)
```

The same AGP in, essentially the same game out — tailored to the environment.

## The native runtime: mirror, don't rewrite

The Windows player is a C++ host that mirrors AE1's runtime contract. The
critical decision that makes "same game" TRUE rather than aspirational:

**Game scripts run unmodified.** AngelScript bodies are JavaScript; the native
player embeds a small JS engine (QuickJS — tiny, embeddable, no browser) and
runs the SAME element/dispatch model. We do not transpile game code to C++ —
we host it. What gets ported to C++ is the ENGINE: the platform layer first,
hot paths second.

Phased honestly:

- **Phase A — native shell, JS engine-core.** SDL3 window + input, a C++
  render backend, miniaudio, QuickJS running the existing engine JS (element
  system, loop, scripts) against native bindings that implement the same
  interfaces the browser build uses. This ships a working exe early and keeps
  every line of doctrine.
- **Phase B — hot paths go native.** The motion-matching search, skinning
  feeds, particle updates, ground probing move behind the same interfaces as
  C++ modules. Scripts and elements never notice.
- **Phase C — engine-core native.** If/when profiling says so. Not a goal in
  itself.

**Graphics library:** a thin RHI rather than a specific vendor stack —
**bgfx** (first choice: mature, D3D11/12 + Vulkan + GL backends, shader
cross-compilation) or sokol_gfx (smaller). No vendor-specific (NVIDIA etc.)
libraries — the abstraction IS the versatility. three.js's behavior is the
reference: the native renderer must match its lighting/tonemapping/material
semantics closely enough that a tuned scene reads the same.

## The seams (work that starts NOW, serves the browser too)

The browser engine already has most of the right boundaries. This phase
formalizes them so nothing new leaks browser APIs into game-visible paths:

| Seam | Today | Rule going forward |
|---|---|---|
| **Renderer** | `world.env3d.*` (objectFor, materialsOf, groundAt, aimPoint, setLodFar, setPaused, boundsOf…) | env3d IS the renderer interface. Scripts/engine systems talk ONLY through it; its surface is documented and versioned. New renderer features land as env3d methods, never as three.js leaks. |
| **Audio** | voiceLine/playSound/playMusic/music bus | Already a facade. Keep it total — no raw Audio/AudioContext outside the audio module. |
| **Input** | `world.input3d` (down/pressed/stick, key-name alternatives) | Already centralized. The pad/key name table is the contract. |
| **UI overlays** | DOM modules: DialogueUI, DebugWall, console, PauseMenu | These are PLATFORM UI MODULES — each is a self-contained DOM component with a small API (open/close/state). The native player implements the same four with an immediate-mode UI. New overlays follow the same shape: one module, small API, no DOM outside it. |
| **Storage** | SaveHandler, settingsStore | Already abstracted (filesystem-is-truth doctrine). Native maps to real files trivially. |
| **Media** | media.js + manifest, hash-addressed | The manifest is the loader contract. The AGP pack format (below) is the same data, containerized. |
| **Timers/loop** | loop.js owns time | No script-visible setTimeout/rAF; wall-clock only via loop APIs (dynamicRes already learned this). |

**The lint rule for this era:** engine PRs that touch game-visible behavior
may not introduce `document.`, `window.`, `fetch`, `localStorage`, or
`AudioContext` outside the designated platform modules (render3d, media,
audio, input, the UI modules, savehandler). That list is the portability
boundary.

## The AGP container (shared by both targets)

The 667 MB base64 single-file is a browser-target artifact, not the package.
The AGP is a directory (or single `.agp` zip):

```
pack.agp/
  manifest.json      (agpVersion, entry scene, media index w/ hashes+offsets)
  scenes/…  scripts/…  hud.json
  media.bin          (concatenated assets, offset-indexed — ONE mmap-able file)
```

- The **windows target** ships `player.exe + pack.agp` — the exe mmaps
  media.bin; no decode-the-universe load step.
- The **browser target** keeps single-file index.html for file:// play, but
  gains an http variant that fetches media.bin ranges instead of inlining
  base64 (faster loads in the editor and for hosted builds).
- Content addressing is preserved — the native player and the web loader
  share one integrity story.

## What stays in the browser, permanently

The editor, viewport, Curator, motion-matching lab, and all tooling. The native
runtime is a Build & Ship TARGET only. Authoring truth remains the project
folder; the filesystem-is-truth principle carries over unchanged (the exe
reads the AGP; saves are real files beside it).

## Sequencing

1. **Now (this phase):** browser-runtime optimization pass (chapter 21 /
   DESIGN §18.87+); formalize the seams above; freeze env3d + platform-module
   surfaces in docs.
2. **Next:** exporter grows `target` ("browser" default, "windows" scaffold)
   and the AGP writer; browser-http builds switch to media.bin ranges.
3. **Then:** the Phase-A native shell (SDL3 + bgfx + QuickJS + miniaudio)
   against a frozen AGP + interface spec.

---

## As-built status — 2026-09-09 (Phase A shipped, then hardened)

The plan above is the intent; this section is the **reality** of the shipped
native target. The full symptom→layer map lives in
[`native-translation-layer.html`](native-translation-layer.html) — read that to
localize a bug. This is the prose summary.

### What actually got built (differs from the plan)

- **Platform + renderer: Win32 + D3D11**, not SDL3/bgfx. Chosen because it
  needs only the Windows SDK — zero vendoring — so the shell stood up and was
  verifiable first. The `gfx.hpp` / `platform.hpp` seams are exactly as the plan
  wanted, so an SDL3/bgfx (or Metal/Vulkan) backend still drops in behind them.
  Linux/macOS remain **TBD** (no backend yet).
- **JS host: QuickJS-ng 0.16.2** running the real engine. `three` is replaced by
  `kThreeShim` (pure-JS Vector/Quaternion/Matrix4/Object3D/Bone — audited
  complete for the natively-reachable modules). `world.js`/`game.js`/`loop.js`
  are **not** loaded — the native harness (`kGame` in `native/src/game.cpp`)
  builds its own `world` (`base`) + loop; `render3d`/`postfx`/`hdr`/`game3d` are
  replaced by C++ + the `env3d` shim; only `debugmenu.js`/`video.js` are stubbed.
- **The whole render-fidelity stack landed:** HDR offscreen → AgX tonemap → FXAA,
  equirect .hdr skybox, sun shadow map + PCF, image-based ambient, DOF, grain,
  alpha-blend transparency, CPU skinning (motion-matching + glTF clips), and native
  bone physics (the browser's `bonephys.js`, driven through a JS bone graph).
- **Native UI overlays** (immediate-mode, C++): control hint, the JRPG-style
  dialogue box, and a **save/load menu** (F6 / F5 / F9). These are the plan's
  "platform UI modules" — the DOM versions no-op natively; the state lives in JS
  and the pixels are drawn by the overlay pass.

### The portability boundary, learned the hard way

The plan's lint rule ("no `document.`/`window.`/`localStorage` in game-visible
paths") is exactly right, and the port proved *why*: the native `world` is a
lenient `Proxy` whose unknown reads return a **truthy** deep no-op. Any engine
code that branches on `world.X` for an X the native world didn't provide took
the **wrong branch, silently**. This class of bug bit repeatedly and each fix is
just "give `base` a real, falsy-or-correct field":

- `debugFlags`, `_camCurveActive`, `loop` — early locomotion/camera bugs.
- **`world.find`** — the big one: `element.find()` tries `world.find` *first*, so
  its absence made **every** `find()` return the proxy → NPC interaction was dead.
- `debugFlag()` (pause menu), `voices` (must be a `Set`), `inventory`, `hud`.

Two silent-failure mechanisms enabled these: the tick swallowed `console.error`
(now it dedupes + dumps at exit — the errscan harness), and C++ `JS_Call` sites
ignore JS exceptions. Note the corrected model: natively `window` = `globalThis`
(real; `window.X` is undefined, safe) and `document` is **undefined** (unguarded
`document.X` *throws* rather than mis-branches).

### Storage (as-built)

`save.js` + `settings.js` run natively (same envelope/format as the browser).
The `platform` seam gained a durable-storage API (`storeWriteAtomic`/`Read`/
`List`/`Delete`) — **atomic** temp→flush→rename with a `.bak`, so a crash never
truncates a save. `localStorage` is a file-backed KV (`.localstore.json`) for the
"continue" slot + settings. Slot files land in `<agp>/saves/*.ae1save.json`.
Measured: load-from-disk ≈0.2 ms, survives process restarts.

### Runtime spawns (as-built)

`world.loop.rescan()` rebuilds the tick schedule (mirrors `loop.js`) AND signals
the renderer to reconcile its draw list against the live model elements — so
elements created at runtime (projectiles, enemy AoE, pod rounds, spawned props)
now **tick and draw**. Identical static media share one GPU upload.

### Known gaps (what a full game still needs natively)

| Gap | State | Note |
|---|---|---|
| ~~Multi-scene / `goToScene` / doors~~ | **ported** | unload/build/rehydrate/onLoad + `applySceneVisuals`; GPU meshes + rigs freed on teardown (`destroyMesh` + slot recycling, memory bounded); inventory-carry across scenes + `pendingSceneState` restore pending |
| ~~Particle FX / `*Fx` elements~~ | **ported** | native renderer owns the sim + a billboard pass (`gfx.drawParticles`); host-node anchoring + `fxTexture` media sprites pending |
| ~~Scatter~~ | **ported** | copies draw as TRUE GPU instances (one DrawIndexedInstanced per archetype mesh, shadow + main); opaque only |
| **3D positional audio / sound opts** | reduced | music/sfx buses + volume work; no spatialization, fades, or per-sound opts |
| **Dynamic lighting / animated sky** | logic-only | Light/Skybox dats are read once at boot; per-tick changes aren't re-read |
| **PerspectiveCamera / LockMarker / near-fade / 2D HUD** | logic-only / N-A | a 3D ship needs no 2D HUD; alternate cameras + the near-plane dither are unported |
| **Linux / macOS targets** | TBD | need an SDL3/Vulkan + Metal backend behind the `gfx` seam |

The through-line: runtime-spawned logic (rescan), a native particle pass, and
the multi-scene loader (`goToScene`) were the three things between "walks,
talks, saves, flies" and a full 3D game — all now done. What remains is minor polish:
per-scene inventory carry, `fxTexture` media sprites, metallic-roughness/normal
MAPS (factors ship today), and the **Linux/macOS** backends (deliberately
deferred).

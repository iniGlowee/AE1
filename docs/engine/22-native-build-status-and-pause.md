# 22 — Native build: status & pause (2026-09-09)

*We are pausing the Windows-native target here to enrich the single browser 3D
project (devroom) with a real map from the reference action game, so features get tested against real
content. This is the state of the native build at the pause, how to drive it,
what's deliberately reduced, and the ordered list to pick up when we return.*

**Read alongside:** [`20-native-build-architecture.md`](20-native-build-architecture.md)
(as-built architecture + gap table) and
[`native-translation-layer.html`](native-translation-layer.html) (the symptom→layer
map, per feature, browser vs native). This doc is the *pause snapshot* — those two
are the living reference.

## Where it stands: the native target is feature-complete for a 3D game

Over this session the native player (Win32 + D3D11 + QuickJS + miniaudio, built by
`native/build.bat`, no CMake) went from "walks" to a full 3D game runtime. Shipped,
each verified with a headless screenshot:

- **Bone physics** ("kawaii") — the browser's `bonephys.js`, driven natively; the
  Officer's sash/veil/dress hang under gravity (`f3b3539`).
- **NPC interaction + dialogue** — restored after a deep-proxy audit; the critical
  bug was `world.find` resolving to the truthy proxy, which killed *every*
  `element.find()`. Talk to the companion character → JRPG-style box, arrow/WASD/pad nav (`eef47a6`).
- **Industry-standard saves** — the real `save.js`/`settings.js` run natively;
  atomic durable slot files (temp→flush→rename + `.bak`) + a file-backed
  `localStorage`; load-from-disk ~0.2 ms, survives restarts (`7107d4a`).
- **In-game save/load menu** (F6) + quicksave/quickload (F5/F9); **audio music/sfx
  buses** driven by the settings volume (`7926ac2`).
- **Runtime spawns** — `world.loop.rescan` was a no-op; now spawned elements
  (projectiles, enemy AoE, pod fire, props) both tick AND draw (`4836e5d`).
- **Multi-scene loader** — `goToScene` swaps the scene (elements, tick schedule,
  render instances, per-scene lighting/skybox/ground/camera); cross-scene
  save/load works too (`9704284`).
- **GPU mesh freeing on teardown** — `destroyMesh` + slot recycling; memory bounded
  across level changes (verified: slots capped across 6 scene toggles) (`4c432c0`).
- **Particle FX** — the native renderer owns the sim + a billboard pass
  (`gfx.drawParticles`); flame/smoke/splash/explosion, loop+burst, `fxColor`,
  depth-tested (`510296e`); `fxNode` rides a host **bone/socket** — muzzle flashes,
  thrusters (`f69ce7b`).
- **PBR materials** — Cook-Torrance (GGX + Smith-Schlick + Fresnel) from glTF
  metallic/roughness factors + an ambient IBL approximation; real form + metal
  response (`a731d63`).
- **Scatter with true GPU instancing** — one `DrawIndexedInstanced` per archetype
  mesh for all copies, shadow + main passes (`c70913d`).

(Earlier in the arc: HDR→AgX→FXAA, skybox, shadows+PCF, DOF, grain, transparency,
CPU skinning for motion-matching + glTF clips, third-person + gamepad + mouse-look,
variable timestep, native dialogue/HUD text via stb_truetype, MM gait warm-cache,
the AGP pack reader.)

## How to build, run, and drive it

```
native/build.bat                      # cl.exe, produces native/build/ae1game.exe (+ ae1pack/player/js/run)
```

**IMPORTANT before every rebuild:** kill any running exe first, or the linker
silently fails and you test a stale binary:

```
Get-Process ae1game -ErrorAction SilentlyContinue | Stop-Process -Force
```

Run (positional args: the AGP export dir, then the live engine JS dir):

```
native/build/ae1game.exe exports/devroom-agp engine
```

**Debug/headless flags** (all added this session; they make features testable
without a human at the keyboard):

| Flag | Purpose |
|---|---|
| `--shot <png> --shot-at <s> --seconds <s>` | grab one screenshot at time `s`, then exit at `seconds` |
| `--freecam "ex,ey,ez,tx,ty,tz"` | park the camera at eye→target (engine coords) |
| `--warmcache` | build the motion-matching gait cache and exit (first-launch speedup) |
| `--walk` / `--follow` | force forward input / follow-cam |
| `--talk <ElementName>` | fire `onInteract` from the player to that NPC (opens dialogue) |
| `--menu` | open the save/load menu on the first frame |
| `--savetest <write\|read\|full>` | exercise the save system (cross-process durability), then exit |
| `--spawntest <ElementName>` | clone a model element at runtime (proves rescan tick+draw) |
| `--fxtest <kind>` | spawn a looping particle emitter (flame/smoke/explosion) |
| `--fxbonetest` | anchor a looping flame to the Officer's head bone |
| `--gotoscene` | synthesize a 2nd scene at runtime and switch (then toggles, to stress teardown) |
| `--scattertest` | make the Officer a scatter archetype (a ring of instanced copies) |
| `--testaudio` | play a looping sound (verify the audio device) |

The C++ harness silences per-tick `console.error` but now **dedupes + dumps unique
errors at exit** ("=== tick errors ===") — the errscan that surfaces a
silently-throwing feature. `world`-object reads are the native trap class: an
unknown `world.X` returns a truthy deep proxy, so any code branching on it takes
the wrong path. Every native fix of that class was "give `base` a real
falsy/correct field" (see the translation-layer DOM row).

## Deliberately reduced / not yet ported (the resume list, ordered)

None of these block a shippable 3D game; they're polish + reach.

1. **`fxTexture` media sprites** — particles use a procedural soft radial sprite;
   the authored the reference action game effect sheets (`an effect sheet`, etc.) aren't loaded per-emitter.
2. **Metallic-roughness + normal MAPS** — PBR uses the glTF *factors* only (the
   devroom models are factor-based, so exact today); MR/normal textures need a
   second texture bind + tangents.
3. **Per-scene inventory carry + `pendingSceneState`** — `goToScene` doesn't carry
   the player's picked-up items across scenes, nor restore parked per-element state.
4. **Specular IBL is approximate** — a Fresnel-grazing term, not a prefiltered
   (PMREM) environment reflection.
5. **Dynamic lighting / animated sky** — `Light`/`Skybox` dats are read once at
   scene load; per-tick changes (day/night) aren't re-read (a scene change does
   re-read them).
6. **PerspectiveCamera element / LockMarker / near-plane fade** — the native camera
   reads only `AE1ThirdPersonCamera`; alternate cameras + the reticle + the near
   dither aren't ported (mostly N/A for a 3D ship).
7. **3D positional audio / fades** — music/sfx buses + volume work; spatialization
   and per-sound `opts` are dropped.
8. **Transparent scatter** — instanced scatter is opaque-only.
9. **Linux / macOS backends** — **deliberately deferred.** Need SDL3/Vulkan + Metal
   behind the `gfx` seam (the seam is ready; nothing above it changes).

## When we come back

- The seams (`gfx`, `platform`, `input3d`, `env3d`) are stable and documented; new
  render features land as `gfx` methods, not three.js leaks.
- The debug flags above are the fastest way to re-verify any feature after a change.
- The most valuable next native items are (1) `fxTexture` sprites and (2) MR/normal
  maps — both make the existing systems look markedly better. Then the SDL3/bgfx
  port for other OSes when that becomes a priority.

## Why we're pausing here

The native runtime now exercises every engine subsystem, but it's been proven
against the **devroom test scene** (a white void with a handful of characters). The
next leverage is *content*: enrich the single browser 3D project with a real,
stripped-down the reference action game map (a city-tile ground tile + a few props) so the whole
feature set — locomotion, camera, dialogue, FX, scatter, saves, PBR — is tested
against a real environment. That work happens in the **browser build** (rebuilt to
browser each iteration); the native target inherits it for free through the shared
AGP whenever we resume.

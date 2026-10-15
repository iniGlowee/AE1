# 13. The Chase Camera & the Shader Layer

*(DESIGN.md §18.47 — the stealth-game-feel round. Research base: the reference stealth game's
camera is parameterized as a REAL LENS — its extracted camera scripts show 16–35 mm
focal lengths at f/1.875 — with raw input rotation over damped position
chase, and a 3-octave handheld sway gated by the game's own Camera Shake
toggle. Post stack per Courrèges' frame study of the reference stealth game; DOF triggers per
NVIDIA's guide. The environment pipeline rides along: real ground from the reference action game under
all of it.)*

## The chase camera (`AE1ThirdPersonCamera`, §18.47)

Three principles from the research, kept exactly:

1. **Never smooth the stick.** `_yaw`/`_pitch` stay raw input — the reference stealth game's
   low-latency feel — and every consumer (mouse-steer, lock-on, aim math,
   billboards) keeps reading them clean.
2. **Smooth the POSITION.** The camera chases its ideal spherical spot
   through per-axis damping (Y heavier — it floats over terrain, never
   bounces with footsteps), and the lag loosens with speed: composed at
   idle (`chaseLag 0.08`), the chase-cameraman drag at sprint
   (`chaseLagSprint 0.15` — steady-state lead ≈ speed × lag, tuned for the player character's
   12 m/s). Teleports snap.
3. **Sway is OUTPUT-only.** A 3-octave incommensurate-sine wobble (slow
   wander ~0.3 Hz, mid tremor ~1.5 Hz, tiny shiver ~9 Hz, plus a gait
   octave only sprint wakes) rides the final rotation fields — pitch, yaw,
   and the new camera ROLL — scaled from `swayIdle 0.15°` (barely-alive
   breathing) to `swaySprint 1.6°` (the documentary chase). `(handheld 0)`
   is the reference stealth game's own Camera Shake toggle: the old rigid camera, exactly.

The lens: `fovBase 48` (the 28 mm feel), `fovSprintAdd 4` — speed reads
from lag + sway, NOT a fisheye kick. Framing: `shoulder 0.25` slides the
pivot along the camera's right so the character sits a third off-center;
at speed the pivot rides lower (`runLower`) and the camera hangs back
(`distSprintAdd`). All blended by one smoothed speed "energy", no discrete
state pops. Everything is a dat.

Queued from the same research (ROADMAP): the discrete ADS lens (32°,
0.55 m shoulder, 0.15 s snap), the trauma impact layer, CQC finisher dolly.

## The shader layer (§18.47)

`engine/three3d/postfx.js` + the `PostFX` builtin element
(`engine/postfx.js`). Architecture: renderFrame's final render routes into
a color+depth target when a PostFX element is live, then ONE fullscreen
uber-pass composites to screen. No element → the plain path, byte-for-byte;
targets allocate lazily; a 1 Hz scan notices the element appearing or
leaving mid-play.

The pass, modeled on Austin's own ReShade stack for the reference action game (CinematicDOF + film
grain + Prism CA + grade):

- **Cinematic DOF**: per-pixel circle-of-confusion from |viewZ − focus|,
  12-tap poisson blur, taps weighted by their own CoC (sharp foregrounds
  don't smear over blurred backs), near-side blurs slightly harder.
  **Autofocus follows the character**: the element eases `_focusDist`
  toward the camera→chest distance at `dofFocusLag 0.2` — the ReShade
  AutoFocusTransitionSpeed glide. `(dofFocusDist N)` pins manual focus.
- **Film grain**: animated hash noise, luma-weighted (gentler in
  highlights).
- **Vignette** + **radial chromatic aberration** (quadratic falloff).

Dats on the element (see `postfx.ags.txt` — a two-line `(extends PostFX)`
script, the Skybox pattern): `dofEnabled/dofAperture/dofMaxBlur/
dofFocusLag/dofFocusDist/grainAmount/vignette/caAmount`. Phase 2 queue
(ROADMAP): bloom, the reference stealth game's soft-shoulder tone curve, LUT slot, motion blur,
lens dirt.

## The environment pipeline (§18.47)

Documented fully in `<local path> reference game\tools\ENVIRONMENTS.md`:
CPK → museum .blend (`bulk_import_models.py`, which already handled
wd/ba/bg formats) → **`export_static_glb.py`** (LOD/shadow/collision strip,
single named root, dds→png, `--upload` straight into a project). First
asset shipped: the **flooded-city colosseum** (`g5a900`, 949 meshes,
237 MB) — the camtest project's ground.

Traps paid for:

- **Map tiles carry world offsets** — the colosseum spanned 1×1.8 km with
  its arena floor at (441, −48, 871). Probe `groundAt` on a grid, bucket by
  height for the biggest flat, offset the ELEMENT to put that floor at the
  origin.
- **Parent from `bpy.data.objects`, not `scene.collection.objects`** — the
  importer files meshes into sub-collections, and the collection-scoped
  loop left 1372 loose roots (an empty named node that bound nothing; the
  scene rendered blank).
- **Engine-typed elements need a script** — a bare `extends` in scene JSON
  builds a plain Element; `(extends PostFX)` in a two-line .ags.txt is the
  route (the Skybox convention).

## The Light element (§18.48)

The first-class light — until it existed, light came only from
glb-embedded light nodes or the environment map, and a dark the reference action game map had
no cure. `(extends Light)` (builtin `Light`, `engine/light.js`):

```
(lightType "sun")   ; directional key — or "point" (lamp) / "spot" (cone)
(color "#fff4e0") (intensity 2.6)
(fill 0.4)          ; hemisphere sky/ground bounce riding the same element
(follow true) (lightHeight 14)   ; glued above the player — always lit
(distance/angle/penumbra ...)    ; point/spot shaping
```

The renderer manages the THREE objects as its own set (`lightSets` in
render3d — created on sight, retyped live on `lightType` change, swept with
the element): the element owns position + dat state, the renderer owns GPU
objects. **That seam is the generalization hook** — shadows, light probes,
and whatever a future Windows GPU build wants (the someday-ray-tracing
conversation) plug in behind it without touching elements. Camtest's
`sun.ags.txt` is the reference; a lamp prop is the same script with
`(lightType "point")(distance 12)` parented near a mesh.

Trap paid for (again): the follow height dat was born `height` — a BASE
SCHEMA field (invariant 17) — and the sun hovered at 0.5 m. It is
`lightHeight`.

## The camtest project

`projects/camtest` — the camera/shader testbed: the player character + the chase camera +
ScenePostFX on the colosseum arena, bracers ahead of spawn, one runt.
Verified: idle micro-sway alive at ±0.05° roll, sprint energy 0→1 with the
48→52 FOV ease and the trailing chase, clean settle, DOF focus gliding
3.6 m → 7.2 m with the sprint pull-back, and the full combat loop (aggro,
hits, kill) on real ground from the reference action game.

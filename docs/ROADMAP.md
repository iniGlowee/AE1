# AE1 Roadmap — reassessed 2026-08-25

The living checklist, rebuilt from DESIGN's open questions, every docs page's
"future material" queue, and the sessions so far. Ordered by leverage.

## Landed this cycle (for context)

Weapon families · enemy base class + archetyped attacks (melee/ranged/AOE) ·
combat feel (hit stop, kill slow-mo, rumble, hurt reactions) · lock-on ·
player death + restart · instancing + tint · playtest1 · standalone tools
(mot-extractor, enemy-glb-baker) · **§18.47: the chase camera (stealth-game feel),
the PostFX shader layer (focal DOF/grain/vignette/CA), the reference action game environment
extraction pipeline + the camtest testbed.**

## Landed 2026-08-26 (this cycle)

- **The polish batch (§18.57–18.61)**: Skybox `envIntensity` (the
  blue-mirror-floor fix) + fixture-derived arena lights (no runtime light
  data exists in the reference action game maps — the glow-material fixtures ARE the lamps);
  spawn hold (gravity waits for the world — the big-map load race);
  dynamic resolution (auto renderScale to hold target fps, verified
  converging both directions); DOF `dofSharpRange` (crisp mid-field, blur
  only beyond); camera feel (beat-based slow sway ≤0.61 Hz at rest +
  `lookSmooth` orbit momentum).

- **The .lay layout layer (`factory1`)**: the reference game's prop-placement system
  imported for the first time — the abandoned Factory (wd5 g52001) with
  all 182 authored placements from its Layout.lay (12 unique ba/bg/bh
  models from <pack>) stamped into the map blend and baked as one glb.
  Pipeline: pure-python lay parser → prop extraction/import (root
  `cpkfp`) → placement stamp in Blender (the plugin's +90°X convention:
  lay is Y-up, museum blends are Z-up raw) → the standard static bake.
  Survey fact: the CITY tiles have no .lay (their bareness is authored);
  the Factory, cave (g50200, 258 instanced rocks), and Tower carry them.

- **The Tower (`tower1`)**: wd5 g50001 identified and shipped — the Route-C
  spire: Library (spawn), Church, Under-Church, Red Girls' room, the faction
  arena, elevator hall, all over the 7 km Earth cloud dome. The player character + the pod
  pod + the flight craft on the Library floor, 75 fps. The chunk's mesh groups
  are NAMED (unlike city tiles) — per-room work is addressable. Destroyed
  "_D" duplicate set + BEFORE/AFTER variants dropped at bake. The wd5
  survey also identified the Copied City (g50010) and the Factory
  (g52001), both import-ready. THE BUNKER is not in wd5 — best lead is
  <pack> st5/r5xx (different file family, needs its own import path).

- **The Follower Pod (§18.55)**: `FollowerPod` base element + `PodBolt` —
  the companion pod (<asset>, DLC cpk) on the real <asset> pod skeleton with
  real pod motions; shoulder follow, own fire/special buttons (KeyQ/RB,
  KeyC/LT), lock-target aiming, friendly-wave special, vanishes while
  piloting the flight craft. Demo project `pod1`. Follow-ups queued below.

## Landed 2026-08-27 (this cycle)

- **The GREEN Forest (`forest1`, §18.62–18.63)**: the outdoor lighting
  playground, twice — first from wd3 (the wrong world: post-Big-Bang
  scorch, Austin's "this doesn't look like a forest"), then rebuilt from
  the living wd1 twins (g11417/18/19 + g11319, 3,869 lay props, tiered
  bake, 554 MB). World identity table settled via the community docs (wd1 living /
  wd2 its LODs / wd3 scorched / wd4 its LODs / wd5 standalone). Found
  the `wda/ga0001` global texture atlas (living-ground splat albedos live
  there, NOT in tile dtts — materials.json diff → slice from the wtp →
  patch blends → rebake). Generated Nishita day-sky HDRI; sandy river-
  bank spawn in the gorge (walkable strip probed by groundAt grid).

- **The pause menu + the reference series dial (§18.64)**: first active menu — pure
  AGS on the pause surfaces, MENU_PROTO-gated (debug wall), ESC/START.
  faction CSS ported (parchment grid, ink tabs); the spinning flower-node
  disc over the panel corner (original SVG art, CSS-transition dial,
  A/D + d-pad with hold-repeat, illuminated anchor node = active tab).
  Verified in-editor and in the export. Editor caveat: ESC = stop-play
  there, use pad START; export ESC is the real path.

## Landed 2026-08-30 (this cycle)

- **The Bunker (`bunker-level`, §18.65)**: the orbital station found by
  archive string-scan (<asset>, <pack> — r550 is audio-only, wd5 was a
  dead end). Hangars, control room, the androids' quarters, corridor
  rings, own 16km starfield sphere. Skinning-strip bake pass (ba props
  are armature-bound → SkinnedMesh → no ground rays), element-side
  orientation (ba axes ≠ wd tiles by 90°), the bound-vs-unbound model
  path doctrine written down. Cloned from flight1 → flight craft +
  boarding ready; **<asset> (the companion character's armed flight craft) identified as the
  enemy model for space battles — pulled, not yet baked.** Spawn on the
  corridor ring, collision verified by 111-point probe grid. Export
  shipped (663 MB). Eyes-on pass pending (browser pane closed mid-verify).

## Now / next (high leverage, unblocked)

- **Pod polish**: muzzle-flash timing pass, bolt tracers, Fire_Start/End
  clip stitching, per-pod-program specials (laser/hammer — the reference game
  program roster as dats), a second pod skin (<asset>/3001 already
  extracted), pod voice barks via Ambience.

- **Shader layer, phase 2**: bloom (¼-res Kawase), soft-shoulder tone curve
  (linear→0.6, the reference stealth game's own), LUT color-grade slot, lens dirt — the rest of the
  the reference stealth game's post stack (Courrèges frame study is the map). Motion blur
  (camera-rotation velocity first — cheapest "filmed" win).
- **ADS / aim camera state**: the discrete aim lens of the reference stealth game (32° vFOV, 0.55 m
  shoulder, 0.15 s snap) + DOF-on-aim trigger; shoulder-swap that remembers.
- **Camera trauma layer**: impact shake (trauma², Perlin, 8°/8°/5° max) fed
  by the §18.41 combat-feel seams; CQC-style finisher dolly on kills.
- **Main-game map tiles**: pull wd1 city-tile tiles (g10716 first) via the
  documented CriPakGUI recipe (tools/ENVIRONMENTS.md); then the <pack>
  prop sweep (<asset> tree-skyscraper, bg cars/trees) for set dressing.
- **Enemy roster growth**: <asset> small biped family (<asset> pack), the
  spin-attack chain (0600-0602 as a multi-phase archetype), directional hit
  reactions (attacker-bearing pick from the 011x grid).

- **Performance, phase 3 — LANDED** (§18.53): per-mesh LOD pairs
  (`model.lodPair`/`lodDistance`, decimated twin glbs from
  `--decimate/--texsize`) + flight LOD (`env3d.setLodFar` — the aircraft
  drops the whole map to its decimated twins in flight mode): 45 → 75 fps
  flying, on-foot quality untouched. Fixed on the way: `cullDistance` was
  silently inert (schema + per-frame visibility clobber). Two new measured
  negatives: texture downscale alone saves nothing (vertex-bound), and
  honest AABB distance saves nothing on foot (the always-near giant meshes
  are the bill). Phase 3b: three-mesh-bvh vendored — ground probes vs the
  city megameshes were 3 ms PER RAY (no acceleration in stock three);
  static meshes now carry a boundsTree, combat with three aggroed enemies
  went 23 → 14 ms and the periodic GC spikes vanished. Still open for
  phase 4: spatial-cell material join, InstancedMesh for repeated props,
  <asset> sprite dig, skinned mesh count on the unit.

## Queued (valuable, not urgent)

- Dodge-cancels the player's stagger (the reference game's rule; dash trigger →
  stopAction).
- Enemy group behaviors: pack aggro (one provoked provokes neighbors via
  instancesOf), spacing/flanking.
- Per-instance animation at scale: GPU-skinned batches for 100+ crowds
  (today ~20 clones is the comfort zone).
- Editor affordances for instancing: "link to prototype" + spawn-count
  authoring.
- HUD layer: health bars, lock-on reticle upgrade (the alchemy rings),
  damage numbers — deferred by Austin until the feel is done.
- Sound design pass: combat SFX, footsteps per enemy, the deferred
  particle/audio halves of combat feel.
- Player death polish: corpse camera orbit, fade-through-black restart.
- Standalone releases: the queued sanitize_character distiller; the
  reference-game→UE5 retargeter as flagship v2 when the pipeline settles.

## Open engine questions (from DESIGN §11, still true)

- Snapshot retention policy; element ID display names; undo/redo via the
  journal; `void` naming.
- The editor-tab-clobbers-file-edits hazard (§18.46 trap): consider a
  server-side merge or a file-watch reload in the editor.

# 14. Fishing & Camera Courses

*(DESIGN.md §18.49 — the fishing1 project round. The reference game's fishing system,
rough-cut: real extracted animations, a real extracted fish, and the new
camera-cinematics elements that present the catch.)*

## CharacterCameraCurve & CharacterCameraCourse (§18.49)

The camera-cinematics kit (`engine/cameracurve.js`, both builtins):

**A CURVE is a character-relative camera track.**
`(curvePoints ((t px py pz lx ly lz) ...))` — position AND look-at offsets
in the character's frame (+z ahead, +x their right, y above their feet),
anchored to their position and heading AT `play()` TIME, so one authored
sweep works wherever they stand. Playback eases per segment (smoothstep);
`(playRate)`, `(holdAtEnd)` (freeze on the last frame for a course to
advance past), `(anchorYawOffset)`. Script hooks: **`onStart`** as the
claim lands, **`onEnd`** as it releases — two new RUN_INFO modes.

**THE RULE, engine-enforced**: two curves can never be active at once —
`play()` refuses (false + warning) while another holds the camera. One
camera, one author.

**The handover** lives in `AE1ThirdPersonCamera._camTick`: while a curve is
live its sample IS the view (position + look-at → YXZ fields); `_yaw`/
`_pitch` stay untouched, so the orbit — Fox layers and all — resumes
exactly where the player left it, the frame the curve ends.

**A COURSE conducts curves**: `(courseCurves ("SweepIn" "PushClose"))` —
names resolved via the global element lookup, so ANY script anywhere runs
`this.find("PresentCourse").playCourse()`. Advances as each curve ends (or
holds), `setCurves([...])` re-orders on the fly, `skip()`, `stopCourse()`,
`running` to poll, its own onStart/onEnd. The course never touches the
camera itself — the one-active rule holds by construction.

## The fishing system (fishing1, "Lakeside")

**The animations are the player character's own** — the contiguous `e0cb–<asset>` block from
pl000f (community-labeled): Stand-to-Fishing, the Release cycle, the 7.4 s
Fishing cycle, Fishing-to-Stand — curated into a NEW pack `fishingPack`
(set `Fishing`, action-only in `tagOf`: she must never cast uninvited).
The pack rides `mmPacks` alongside the other four; 1.3 MB.

**The state machine** is pure AngelScript (`fishing-spot.ags.txt`, a
Hitbox): E at the pier's end →

```
enter → cast → wait (castMin..castMax s, Idle cycle relinking)
  → roll catchChance:
      miss  → recast → cast (the loop)
      CATCH → land (Fishing_Exit) → present:
              the koi surfaces at her focus point (1.5 m ahead, chest
              height, slowly spinning) and PresentCourse plays —
              SweepIn (over-shoulder → face-on, holds) then PushClose
              (drift in, releases) → fish hides, control returns
```

Actions chain through `mm.playAction` + `inAction` polling — the same
contract as combat and ladders. No inventory, no UI: the rough system.

**The fish is a real one**: `koi_carp.glb`, exported from the museum's
`etf005` blend. The whole `etf` roster is extracted and ready — 21 fish,
15 machine variants, the junk items (tire! machine head!), even the
fishing chair (`etf100`). One `export_static_glb.py` call each.

**The lake**: the flooded city (a canonical the reference action game fishing area) as the far
shore — the colosseum map's proven placement pushed 420 m north — with a
meshforged translucent water plane and a plank pier. A real lake TILE
(city-ruins crater lake) is queued: LibCPK.dll is driveable from PowerShell
(TOC verified against Steam's <pack>/014), recipe in tools/ENVIRONMENTS.md.

Verified end-to-end headless: pack loads, every phase in order on loaded
dice, the miss→recast loop, the koi at the focus point, the sweep claiming
the camera, a second `play()` REFUSED mid-sweep, and a clean release.

## TriggerBox, bloom, and the reference action game glow secret (§18.50)

**`TriggerBox`** (builtin, `engine/triggerbox.js`) generalizes the audio
regions: a `(sizeX/Y/Z)` volume that dispatches **`onStart`** to its own
script when the character enters and **`onEnd`** when they leave (the same
modes camera curves use — learn once), `(triggerOnce)` + `reset()`,
`occupied` for polling. Fishing became a `FishingTrigger extends TriggerBox`:
walk to the pier's end and it simply begins — **the chair materializes at
HER position and heading** (a half-step back so the seated animation lands
in it), and walking out cleans everything up.

**Bloom joined the shader layer**: bright-pass (½ res) → two gaussian
bounces (¼ res) → additive composite, `(bloomStrength)(bloomThreshold)` on
the PostFX element.

**The the reference action game glow secret** (researched from the add-on source): the reference game has
**no emissive texture slot**. Glow is SHADER CHOICE + SCALARS — `CNS*`
(constant/unlit) and decal shaders render `albedo × g_AlbedoColor ×
g_Intensity`, and intensity > 1 IS the engine's bloom marker. The fishing
chair ships `CNS00 @ 3.0`, warm gold — marked to glow in the game's own
data. That survives import only as inert custom props;
`export_static_glb.py` now wires them into Principled Emission
automatically, the glTF exporter emits `emissiveFactor` +
`KHR_materials_emissive_strength`, three.js renders it hot, and the
bright-pass does the rest. Data-driven — every future CNS-shaded prop
glows correctly with zero hand-tagging.

## Traps paid for

- Curves/courses are engine-typed: scene use needs the two-line
  `(extends ...)` script (the Skybox convention, third time).
- The fishing clips have no labeled "catch success" mot — the presentation
  is Exit + fish + camera, which reads right; the unlabeled neighbors of
  `<asset>` may hide a bite reaction for a later pass.
- Interact targets need a VISIBLE element with render bounds — a mesh-less
  Hitbox is untargetable by the real E-press (`containsPoint` reads
  `boundsOf`). Headless tests must ALSO drive the real input path, never
  only `dispatchTo`.
- A long-lived editor tab predates newly-added engine modules — a script
  extending a builtin registered after the page loaded compiles against
  nothing, silently. Reload after adding builtins.

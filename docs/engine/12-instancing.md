# 12. Instancing & Instance-Overriding

*(DESIGN.md §18.46. The Stubby Horde behind the green door is the living
demo: twenty machines, one glb download, one animation package, twenty
independent timelines, tints, health pools, and punch values.)*

## The insight: AE1 already had half of this

The round's first discovery was architectural, not code: **AE1 scripts are
prototypes and elements are instances, and always were.** A script's dat
block declares defaults; a scene element persists ONLY the dats that differ
from those defaults (see `serialize()` in element.js — "persist only
differences"). That is precisely Unity's prefab-override model:

| industry term | AE1 term |
| --- | --- |
| Unity prefab / UE Blueprint class (CDO) | the `.ags.txt` script (dat block = defaults) |
| prefab instance with property overrides | a scene element (persists only changed dats) |
| `Instantiate(prefab)` / `SpawnActor` | **`spawnInstance(proto, overrides)`** — new |
| GPU instancing / HISM (shared mesh memory) | shared glb + clones (geometry/materials shared by three.js clone) — animation was the missing half |
| per-instance material property block | **`model.tint`** — new |

Platinum-style crowds (the machine mobs of the reference action game) are this same recipe: one
rig, one clip set, N lightweight animation states.

## What was actually missing, and what was built

**1. Per-instance ANIMATION (render3d.js).** The one-glb-one-timeline rule
made every second wearer of a glb a static statue. Now a clone-bound
element gets its OWN `AnimationMixer` rooted at its clone; the SHARED glb's
clips bind to it by node name (clones preserve names). Full clip semantics
per instance — `__bind__`/`__none__`, loop/speed/start/fade, trims, and
`onFinished` delivered to exactly the owning element (per-instance mixers
have no finish-target ambiguity). Geometry and materials stay shared;
memory cost per instance is a bone hierarchy and a mixer.

**OPT-IN, deliberately**: an element that never sets `model.clip` keeps the
old static-clone behavior — projectile rounds, carried-item twins, and the
second door1 are untouched. Auto-play-first-clip remains the ORIGINAL
wearer's convention alone.

**2. Per-instance TINT.** `model.tint` (CSS hex) multiplies an instance's
textures with a color — `this.setTint("#50ff70")`, or the Enemy `(tint)`
dat. First tint lazily clones that instance's materials (cached, restored
when cleared); no shader work, no texture copies.

**3. The programmatic API (§ the instance-overriding ask).**

```js
const inst = this.spawnInstance("StubbyProto", {
  x: 4, z: -2,          // its own transform
  health: 80,           // any dat override
  aiType: "melee",      // even ones the prototype set differently
});
inst.setTint("#ff5050");
inst.setAttackDamage("Attack_1", 7);   // per-instance combat tuning (§18.44)

this.instancesOf("StubbyProto")        // every live member of the group
```

`world.spawnInstance` serializes the prototype, deep-copies its components
(a shared model bag would make every instance's clip write fight every
other's), stamps `_protoName`, gives it a fresh id and a `Proto#N` name,
adds it live (`game3d` sees the element count change and builds the clone),
and dispatches its `onLoad`. Behavior differences are DAT differences — the
AE1 way; methods stay on the shared class, and dats like `aiType`,
`attackSpecs`, and `tint` select behavior per instance.

## The prototype convention

Park a hidden pacifist in the scene: `visible false`, `(aiType "friendly")
(wander false)`. It claims the glb's primary timeline invisibly; every
spawn overrides itself alive (`aiType: "melee", wander: true`). See
`StubbyProto` + `horde-spawner.ags.txt` — the whole horde is ~20 lines of
AngelScript.

## Traps found and paid for

- **An open editor tab clobbers file-side scene edits** — it journals its
  in-memory scene constantly AND fires a `sendBeacon` save on page unload,
  so editing scene JSON on disk while a tab sits in the project loses the
  edit on the next save/navigate. Add elements THROUGH the live editor
  (`store.scene.add(...)`) or with every tab on the Projects page. (The
  pack-refresh doctrine, now proven for scenes too.)
- A hidden Browser pane stops rAF — the loop stalls; drive verification by
  manual tick pumping.

## Known limits (v1)

- Per-instance animation rides the clone path — ~20 skinned instances is
  comfortable; hundreds would want true GPU skinning batches (a renderer
  project, not an element one).
- `spawnInstance` copies the prototype at CALL time — later edits to the
  prototype don't retro-apply to live instances (same as Unity runtime
  instantiation).
- Editor-authored instances are simply elements sharing a script + media —
  they gain per-instance animation automatically now, but there is no
  editor "link to prototype" affordance yet.

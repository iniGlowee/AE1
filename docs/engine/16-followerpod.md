# 16 — The Follower Pod (§18.55)

The floating companion: the reference action game's pod, here wearing the Grimoire
Weiss DLC book skin, hovering at the character's shoulder. Stellar Blade's
drone is the same creature. One new base element carries the whole system.

## The element: `FollowerPod`

`engine/followerpod.js`, builtin `FollowerPod` — extend it in a project
script exactly like `Aircraft`:

```
<?def
(extends FollowerPod)
(name "GrimoirePod")
ags?>
```

Design rules, in the engine's usual shape:

- **The host stays the root of truth.** The pod reads the host's position
  and the camera's yaw every tick and chases a camera-relative shoulder
  offset on a spring. It never pushes back. `(host "the player character")` names the
  element; empty auto-finds the player.
- **The pod is its own element** with its own model and clips — the DLC
  pod skins share the wp3000 pod SKELETON, so the companion pod plays real
  pod motions with no retargeting (`Idle` = the 0000 hover, `Fire` = the
  0010 fire cycle, `Special` = the e050 flourish).
- **Flight-unit rule** (Austin's spec): the pod vanishes while its host
  pilots an Aircraft and reappears on dismount. The engine reads
  `host._pilotCraft` — the truth the aircraft already maintains — so no
  aircraft wiring exists at all. `(hideWhenPiloted false)` opts out.
- **One button, two gestures** — `(podFire "KeyQ PadRB")`, the same
  keyboard+pad token grammar as every Controller mapping, identical on
  both devices. TAP-AND-HOLD = a rate-limited stream of `PodBolt`s; a
  DOUBLE-TAP inside `doubleTapTime` (0.3 s) = the special. Bolts fly at
  the host's LOCK TARGET when one is held (the §18.43 kit), else at the
  camera's aim point.
- **The special** is a charged shot on a cooldown: a heavy slow bolt
  that detonates into a FRIENDLY AoeWave (§18.44, `_friendly` mode — the
  flight unit AOE's sibling), so a sidestepping target still eats the
  splash. Kills credit the host — combat-feel hooks (slow-mo, rumble)
  fire there. `podSpecial` remains as an OPTIONAL dedicated extra button
  (empty by default).
- **The idle clip owns the hover.** wp3000_0000 breathes on its own; the
  procedural `bobAmp/bobFreq` is only a slow drift on top (default 0.02 /
  0.35 Hz). Stacking a fast sine over the authored hover read as frantic
  bobbing — set `bobAmp 0` when the clip carries the motion.

## `PodBolt`

`AE1EnemyRound`'s mirror image: travels straight, damages the first
ENEMY-family element it overlaps (`takeDamage` + `_npcAnimate`, never the
player, never the host), then pops. Damage/speed/range ride the bolt from
the pod's dats at spawn. Spawned live — the LockMarker precedent; no
authoring. The bolt's media is named in the pod script's dat text
(`boltMedia "pod_bolt.glb"`) so the export sweep keeps the glb — the
§18.52 runtime-spawned-media rule.

## Dats that matter

| group | dats |
| --- | --- |
| seat | `offsetSide` (−0.9 = camera-left, the reference game's side), `offsetHeight`, `offsetForward`, `followLag`, `bobAmp`, `bobFreq`, `faceOffset` |
| clips | `clipIdle`, `clipFire`, `clipSpecial` |
| buttons | `podFire` (hold = stream, double-tap = special), `doubleTapTime`, `podSpecial` (optional extra) |
| stream | `boltMedia/Node`, `fireRate`, `boltSpeed/Damage/Range/Spread`, `muzzleForward/Down`, `aimDist` |
| special | `specialDamage/Radius/WaveSpeed/BoltScale/Speed/Cooldown` |
| fx | `muzzleFx`, `hitFx`, `specialFx` — NAMED Particles elements; `hitFx` is moved to the impact point before each burst |

Script events: `onFire` (each bolt), `onSpecial`, `onPodHit (victim,
damage)`.

## The asset pipeline (what was new)

- The the companion pod pod is **wp3011 in Steam `data101.cpk`** (the DLC
  pod skins live one per DLC archive: 3012 cardboard in 105, 3014 in 107,
  3017 in 108; the Emil head is wp3020 in data016). Pulled by LibCPK into
  `CPK/dlc_wp/unpacked/wp/` — `bulk_import_models.py` gained the
  `cpkdlc` root for exactly this layout.
- Pod ANIMATIONS live in `data006 wp/wp300f.dat` — 45 `wp3000_*.mot`
  files, unpacked with the plugin's `dat_unpacker` (drive it inside
  Blender; note its extract-path quirk joins with a leading backslash and
  lands at the DRIVE ROOT — move the files after).
- `bake_enemy_glb.py` bakes the book + curated clips (no retarget — the
  skins share the pod skeleton). New flag: `--emissive-lift 0.4` feeds
  each material's own base-color texture into its emission — companion
  props rendered as silhouettes under the night City Ruins without it.
- `pod_bolt.glb` is FORGED (a Blender-generated emissive dart, the
  clipforge doctrine) — pale gold, spun on Y in flight by the element.

## Verified (pod1, real inputs)

Follow + idle bob at the shoulder; a held Q burst took a 60 hp stubby to
0; the C special one-shot another (heavy bolt + wave); E into the flight
unit hid the pod, E out brought it back; every bolt cleaned up after
itself.

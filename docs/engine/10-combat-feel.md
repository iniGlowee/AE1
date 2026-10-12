# 10. Combat Feel — time effects, rumble, hurt reactions

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

*(DESIGN.md §18.41. The research behind the numbers: hit-stop frame data from
the publisher beat-'em-ups and Smash, UE global-time-dilation conventions, the
Vlambeer "art of screenshake" school. This page is the impact layer ON TOP of
the combat systems in [Enemy System](09-enemy-system.md) and
[Weapon Archetypes](07-weapon-archetypes.md). Particles, sound, and HUD are
deliberately out of scope — deferred by Austin.)*

## The time-effects core (`engine/loop.js`)

One chokepoint: every dt the loop hands out — element ticks, the motion
matcher, the renderer's mixers — passes through `_timeFxScale()` before
dispatch. Bending time there bends the WHOLE simulation uniformly (the UE
`SetGlobalTimeDilation` model). Rules:

- **Effect clocks advance in real time** — an effect must outlive the freeze
  it causes.
- **Concurrent effects combine by MINIMUM** — the strongest freeze wins;
  nothing multiplies or stacks. A mash-guard caps the queue at 8.
- **Scale never reaches 0** (0.05 floor on the presets) — dt-zero breaks
  velocity math; UE clamps for the same reason.
- Envelope: **instant drop → hold → ease back**. An eased ramp-IN kills the
  punch; the eased ramp-OUT prevents the resume jolt.

```js
loop.hitStop(hold = 0.09, scale = 0.05)        // the impact freeze
loop.slowMo(hold = 0.75, scale = 0.15, ease = 0.4)  // the finisher
```

Scripts get both as element delegates: `this.hitStop()`, `this.slowMo()` —
no-ops outside play.

**v1 simplification, on purpose:** classic hit stop freezes ONLY the
attacker/victim pair while the world runs. Ours is global — with one player
and two enemies the difference is imperceptible (Vlambeer's famous advice is
literally "sleep the whole game 50 ms"), and it cost one chokepoint instead
of per-entity clocks. If arenas ever hold six enemies, revisit per-entity
`CustomTimeDilation`-style scaling; until then the global bend also slows
the camera, which at these durations nobody can see.

## What fires when (the tuned values)

| event | seam | time effect | rumble (strong/weak/ms) |
| --- | --- | --- | --- |
| light hit landed (damage < 20) | `thirdperson.js::_attackSweep` | hitStop 0.08 s @ 0.05 | 0.45 / 0.3 / 90 |
| heavy hit landed (≥ 20) | same | hitStop 0.13 s @ 0.05 | 0.7 / 0.3 / 140 |
| **fatal blow** | same (+ `projectile.js` for a killing round) | **slowMo 0.7 s @ 0.12, ease 0.45** | 1.0 / 0.6 / 320 |
| player takes a hit | `the motion-matching driver †::takeDamage` | none (never punish the player's eyes) | light 0.55/0.5/140 · big 0.9/0.5/260 |

These sit inside the research ranges (light stops 50–83 ms, heavy 130–230 ms,
kill dilation 0.1–0.25 held ≤ 1 s). Projectile kills get the slow-mo but
ordinary projectile hits get NO hit stop — freezing the world per bazooka
splash read as spam.

## Rumble (`engine/input.js::rumble`)

Dual-rumble through the Gamepad API: `strong` = low-frequency motor (the
thud), `weak` = high-frequency (the buzz). Feature-detected, promise
swallowed, gated behind `gamepadEnabled` — a missing pad or Safari is a
silent no-op. **A new pulse replaces the playing one** (Chrome semantics),
which is the right priority rule for combat: the kill thud overrides the tap
it landed on. Keyboard players simply never feel it; nothing else branches.

## the player character's hurt reactions (the `Reaction` set)

The pack gained an action-only set: `Hit_S` (<asset>, trimmed 0:55) and
`Hit_B` (<asset>) — the player character's own damage mots from the `10xx` range, curated
through the normal lab `/convert` flow. `tagOf` routes `set === 'Reaction'`
to `'action'` (the Ladder precedent): named-only, never searchable —
searchable flinches match ordinary standing frames and she winces uninvited.

`AE1the motion-matching character †.takeDamage` plays them under the reference game's rules:

- **A light hit never steals an in-flight strike** — the combo survives; you
  still get the rumble.
- `(bigHitAt 15)`+ damage plays `Hit_B` and interrupts anything grounded.
- **Reaction-proof states**: ladder, traversal, airborne — those protocols
  own the body; a flinch mid-vault strands the state machine.
- `_mmStrike` clears on reaction — an interrupted swing stops dealing damage.
- A 0.8 s sim-time lockout prevents stun-lock from two machines.

Enemy-side reactions (`hit`/`hitBig`/stagger) predate this page — see
[Enemy System](09-enemy-system.md).

## Lock-on (§18.43)

**Toggle**: right-stick CLICK (`PadRS`) or `Z` — the Controller's `(lockOn)`
mapping. Opt-in by nature: never pressing it never changes anything.

**Acquisition** (Austin's spec): the enemy closest to the camera → focal ray
— the same ray the bazooka shoots down. `_lockAcquire` (thirdperson.js)
scores every living NPC-family element by perpendicular distance to the view
ray plus a light range tax; nearest wins, `(lockRange 40)` caps it.
Auto-release on death, invisibility, or breaking 1.25× the range; the toggle
releases manually. The lock kit lives on the BASE character class — both
character systems call `_lockTick` — and `_aimFocal()` wraps every aim seam
(bazooka spawn direction, aim-assist barrel, aim lines, fire-facing), so a
locked bazooka shoots the target's bounds-center instead of the terrain
focal.

**Camera**: while locked the camera owns its yaw — eased onto the
player→target bearing at `(lockYawSpeed 240)` deg/s, pitch settling to
`(lockPitch 16)`° — the Souls frame. Sticks resume the moment the lock
drops.

**The indicator**: `LockMarker` (engine/lockmarker.js, builtin) — a white
disc (`lock_ring.glb`, meshforged) billboarded at the target's bounds
center, pulled `(ringToward 0.55)` m toward the camera so it floats in
front of the enemy. SPAWNED on lock, REMOVED on release — game3d notices
the element-count change and loads the glb itself; `(lockMarkerMedia)` on
the character is a dat so the exporter's name scan inlines the disc into
shipped builds. It is a deliberate BASE CLASS: `ringSize`/`ringSpin`/
`ringToward` are dats, the billboard roll already spins, and the planned
alchemy-circle rings (recoloring, layered, particle-accented) will extend
it — `(extends LockMarker)` with fancier media is the whole upgrade path.

## the player character's death (§18.45)

Zero health ends the run. The fatal blow triggers the game's deepest
emphasis (slow-mo 1 s @ 0.18, full-strength 500 ms rumble) and one of the player character's
own death animations from the reference action game, curated into the pack's `Reaction` set:

- **`Death`** — `<asset>`, the Self-Destruct collapse (the canonical
  one), for ordinary killing blows;
- **`Death_B`** — `<asset>`, blown flat on her back, when the fatal hit
  was `(bigHitAt)`+.

Both are weaponless collapses, so ONE pair serves every weapon
classification — bracers, spear, unarmed, and anything future. While the
clip plays the driver steps with neutral input (root motion lays her down);
when it ends, updates stop entirely and the skeleton freezes on her final
frame. The dead take no further damage, lock-on releases, and after
`(deathRestartAfter 5)` seconds the world calls **`world.restart()`** — the
full-reset contract: pockets emptied (hers and the world's stash), aux
templates dropped, `sceneFile` cleared so the reload happens even when she
died IN the target scene, and everything rehydrates fresh from
`(restartScene "Scene 1")` — health, enemies, items on racks, as if the run
never happened.

Dats on the character: `deathClip`, `deathClipBig`, `deathRestartAfter`,
`restartScene` — a checkpoint system later is a different `restartScene`
value and nothing else.

## Future material (researched, deferred)

- **Dodge-cancels the stagger**: the reference action game lets an attentive player cancel the
  hurt animation into a dodge almost immediately (stagger as a removable
  layer — the Resilience chip removes it entirely). Our dash trigger could
  `stopAction()` a playing reaction.
- **Directional reactions**: the 10xx range has back/left/right variants;
  pick by attacker bearing (the enemy grid has them too: `0111`, `0113/4`).
- **Trauma-based camera kick** (Eiserloh GDC 2016): a `trauma` scalar,
  shake = trauma², Perlin-driven, ~25 Hz, decay 1.5/s — melee wants a
  directional kick + a whisper of noise, a fraction of explosion values.
- **Rumble decay chains**: 2–3 chained pulses approximate a decay curve the
  web API can't express (1.0/80 ms → 0.5/80 → 0.2/120).
- Hit-stop *variation* inside combo strings (shorten stops on hits 2..n−1)
  if long strings ever feel gluey.

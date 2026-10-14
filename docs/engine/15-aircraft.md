# 15 — Aircraft: pilotable vehicles (§18.52)

The `Aircraft` builtin (`engine/aircraft.js`, `(extends Aircraft)`) turns a
skinned glb element into a two-mode pilotable vehicle. The the reference action game flight craft
(project `flight1`, script `flight-craft.ags.txt`) is the first tenant —
planes, helicopters, and anything else ridden later reuse the same base and
override dats.

## The root-of-truth contract

The **third-person character stays the root**: input, world position, and
hitbox all live on her. Boarding:

1. puts her driver in **ladder mode** (ground/walls/search suspended,
   vertical root motion honored),
2. plays the synced Board pair (her retargeted mot + the unit's own clip —
   the reference action game authored them under the same animation id),
3. from then on the aircraft's physics **drives her root** each tick
   (`mm.teleport` + `mm.setYaw`), and the aircraft element **mirrors her**
   at `(pilot − seat offsets)`, wearing pitch on `rotationX` and roll on
   `rotation`.

Character-side there is exactly one block (in `_mmTick`, after the dead
block): while `el._pilotCraft` is set she advances her held riding pose and
mirrors the driver out — no interact, no combat, no locomotion. Weapons
sheathe automatically (ladder mode's existing sheathe edge). This is the
fishing-state doctrine — a character state swaps the entire control scheme.

## Modes

**TRAVEL ("Strider", upright hover)** — mech-game hands:

- camera-relative inertial strafe; the mech faces the camera's aim
  (`turnRate`),
- boost **held** (`travelBoost`), quick-boost on a **tap** under 0.24 s
  (`qbImpulse` + the spin-evade clips `QB_L/R`),
- terrain-following hover: rises with the ground (`hoverRise`), **descends
  slowly** (`hoverFall`) — input never climbs it,
- attacks: melee lunge (frontal-arc `takeDamage` sweep + hitStop + rumble)
  and a shot clip. The pilot hides during attack clips (the hull swings
  through the seat).
- The normal chase orbit camera is untouched — she *is* the craft.

**FLIGHT ("Falcon", jet)** — flight-game hands:

- Shift/Ctrl throttle between `flightMin`/`flightMax`; W/S pitch; A/D
  roll-to-turn (`bankTurnRate` × bank fraction); dives gain speed, climbs
  bleed it,
- ground-skim clamp, and a `voidFloor` for space past the map's edge
  (the ground ray answers null there),
- chase camera: the aircraft publishes `pilot._flightCam`
  `{yaw,pitch,roll,dist,height,lag,fov}`; `AE1ThirdPersonCamera` flies
  formation — banked horizon, FOV opening with airspeed — and returns the
  orbit **behind the craft** the frame the field clears,
- the pilot hides (`hidePilotInFlight`), or rides her prone pose if not,
- **flight LOD** (§18.53 phase 3): entering flight calls
  `env3d.setLodFar(true)` — every map mesh with a decimated twin
  (`model.lodPair` + `lodDistance` on the tile elements) swaps to it for
  the whole flight, the transform curve and seam flash hiding the flip.
  The unfold to travel (and any unboard) restores full detail. Measured
  on the city tiles: 45 → 75 fps while flying, on-foot detail untouched.

**Rules**: `F` toggles modes. Flight→travel **refuses** above
`travelEnterHeight` (or over the void — unknown altitude is infinite).
`E` boards and dismounts, **travel mode only**. The interactive TriggerBox
is a thin doorman that calls `craft.board(actor)` and **follows the parked
unit**, so E re-boards wherever a flight ended.

## Camera curves at the seams

Transitions conduct `CharacterCameraCurve`/`Course` elements **by name**
(`boardCourse`, `exitCourse`, `toFlightCurve` dats). The board shot is the
low bottom-left art angle — its *release* is the hard jump to the orbit.
The transform shot slides dead astern: curves anchor to the character's
heading at play time, and her heading is the craft's nose, so "behind" is
correct at any bearing and the flight chase picks up from the shot's final
pose.

## Clips are dats, both sides

Unit-side clip names live in the element's own glb (baked by
`bake_enemy_glb.py`); pilot-side actions live in an mm pack (set `Flight`,
action-only). **The scene element's model `clips` whitelist must list
every baked clip** or the renderer won't load them. Two-frame pose holds
(the prone ride) are force-looped by the engine like the combat-air holds.

Dispatches: `onBoard`, `onUnboard`, `onModeChange (mode)` — compiler
category `aircraft`.

## The cut seams (boarding without an honest climb)

An EMPTY `pilotBoard`/`pilotExit` dat makes that door a **cut**: she hides
for `boardCutTime`, is placed (seat, or beside the hull at `exitDropHeight`
above the local ground so the hop-off drop always happens), and reveals.
An empty `clipBoard`/`clipUnboard` means the unit has no receiving
animation and keeps its idle. Why these exist: **the mot ID pairing is not
a law** — `pl0000_aXXX ↔ pl0010_aXXX` are a synced duet only where the
game authored one (the a005/a006 flip, every aafx ride). The unit's
a020/a023 are knockbacks that merely share the player character's mount numbers, and her
"calm mount" clips are authored AT COCKPIT HEIGHT (ground-level they play
as a tilted board). Eyeball BOTH halves of any new pair before wiring it.

## Combat

Melee (`primary`): a frontal-arc `takeDamage` sweep (`attackReach`/
`attackArc`/`attackDamage`) with a forward lunge; the pilot hides for the
swing. AOE (`secondary`, travel mode): the enemy `AoeWave` element reused
with `_friendly` on — it damages everything with `takeDamage` EXCEPT the
player, once per target as the front passes, and credits the pilot.
`aoeDamage`/`aoeRadius`/`aoeSpeed`/`aoeMedia` dats.

**The export prune trap**: runtime-spawned media (`aoe_orb.glb`,
`red_ring.glb`, `orange_orb.glb`, `lock_ring.glb`…) exists only in
engine dat defaults, which the exporter's reference sweep cannot see —
builds silently lose them while the editor looks fine. Name every
spawned-at-runtime file in a project script (dats are swept).

## Particles (§18.52, the reference action game sprite pipeline)

The fx system accepts a MEDIA image as the particle sprite: Particles
dats `fxTexture` (media name) + `fxColor` (tint) ride the same emitters
as the canvas presets. The reference game's own effect sprites extract cleanly:
`<pack>.cpk → effect/texture/*.wtp`, slice by `DDS ` magic, PIL → PNG
(the big combat sheets are in `core/<asset>`, still undug). The
aircraft bursts named Particles elements at its seams — dats
`thrusterFx` (loop, visible only while piloted), `seamFx` (every
hide/reveal and fold), `strikeFx` (melee), `blastFx` (AOE),
`killFx` (a strike that kills something).

## Lock-on in the cockpit

Travel mode runs the character's §18.43 lock-on unchanged (Z/R3): the
camera lock-track centers the target and the face-the-aim turn makes the
mech face the enemy. Other modes release automatically. The marker wears
`alchemy_circle.glb` — the reference game's extracted magic-circle sprite on a cap-up
translucent plane (`lockMarkerMedia`/`lockMarkerNode` player dats),
spinning via the marker's `ringSpin`. Hardening that came out of this:
keydown ignores `e.repeat` (OS key-repeat + focus churn once storm-toggled
locks ~16/s), and the marker element is spawned ONCE per session and
reused hidden across toggles — destroy/respawn per toggle cost a renderer
rebuild each way, which in a nine-tile scene was a permanent stutter.

## Sync doctrine

The pilot's `actionAge` is the master clock: `env3d.setClipTime`
(injected via the game3d facade — raw renderer exports are not
element-reachable) slaves the hull's mixer to it every paired tick, so
the duet cannot drift across tab suspends or clock clamps. Related
engine fix that this surfaced: a LOOPING held action must never trip the
`frames-2` "action finished" edge — the forward branch now guards on
`clip.loops` like the reverse always did.

## The the flight craft numbers (flight1)

Sixteen unit clips: Idle/Board/Unboard/Cockpit, Travel_Move (a01b),
Travel_Boost (a01e), QB_L/R (a030/1), Attack_Melee (a02a), Attack_Shoot
(a025), ToFlight (a508), ToTravel (a530), Cruise (a500), Bank_L/R
(a532/3), Cruise_Attack (a501). Pilot pack `<pack>`: Board / Exit /
Cockpit / Prone / Transform / TransformBack. The wider taxonomy (97 <asset>
mots, thumbnailed and classified — `aafx` is 16 riding attitudes, every
one with a player character pair) is §18.52's enrichment shelf.

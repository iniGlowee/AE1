# Movement Systems: Ladders, Air, Dashes — and the IK/Camera Caveats

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

The movement subsystems layered on top of the matcher, and the rules that
keep them from fighting each other. Companion to
[Motion Matching](06-motion-matching.md) (the data) and
[Weapon-Type Classes](07-weapon-archetypes.md) (the families).

---

## The ladder system

**Three pieces:** a ladder *element*, a climb *protocol*, and a matcher
*mode*.

**The element** (`engine/ladder.js`, `(extends Ladder)`): any model whose
glb carries indexed rung sockets `rung_00..rung_NN` (empty child nodes,
ascending up the ladder — `meshforge.py`'s `sockets` block emits exactly
this). The class publishes `ladderInfo()` — center line, `yBottom`/`yTop`,
rung pitch, every rung height, `faceYaw`, outward normal (`(faceNormal
±1)` picks the approach side). It advertises geometry and does nothing
else. Existing examples: `wall_ladder` (22 rungs, 0.28 m pitch, 6 m deck)
and `sky_ladder` (286 rungs, the 80 m freefall test tower).

**The protocol** (`_mmLadderTick` / `_mmLadderEnter` in
`engine/the motion-matching driver †`) — the reference action game doctrine throughout:

- **Proximity mount, no button.** Walk into the ladder and she grabs.
  **Air grab** works at collision height mid-fall; the grab yaw eases at
  9 rad/s (an instant `setYaw` snapped 180° in one frame).
- Raw stick up/down. Default climb = the `Ladder_Step_A/B` one-rung pair
  (1.4 m/s); holding the evade keys (`Shift`/`KeyC`/pad LT-LS) boosts into
  the faster `Ladder_Climb_A`.
- **Descending is the climb reversed** — `playAction(clip, {rate: -1})`
  starts on the last frame and wraps backward. (The extracted
  `Ladder_Descend` mot 0041 is actually a flip-off dismount; it's parked.)
- Idle on the ladder = `Ladder_Idle` pose hold; between clips the pose
  simply holds — the protocol chains clips itself, no search.
- **Top exit**: a random pick from the exit pool (`Top_Exit_B/C/D/E`),
  triggered at `deckY − clipRise(chosen)` so each exit's authored rise
  lands her exactly on the deck (`mm.clipRise(name)` reads the baked root).
- **Jump releases**, with a 0.5 s re-grab cooldown so she doesn't re-stick.

**The mode** (`api.setLadderMode(on)` in `engine/the motion-matching core †`): on —
gravity, ground, walls, facing, and search all suspend; `playAction` clips
apply full 3D root motion (climbs rise); **entering the mode zeroes the air
state** (`airT`, glide, freefall, double-jump) because an air grab is a
landing — a dive must not resume on dismount. Off — locomotion re-matches
immediately: floor catches her on a deck, the ledge branch starts a fall
over a drop; those are exactly the reference game's two exits. Ladder clips are
named-only (`set: Ladder` → `action`), so the search can never volunteer a
climb mid-run.

---

## The air system (jumps, falling, freefall, glide)

**The arc is physics; the pose is motion matching.** Measured from GASP's
own jump family: G = 9.8 m/s², v0 = 4.5 m/s — the animators used real
gravity. Root motion is consumed **only while grounded** (an air clip's
root is synthetic bookkeeping; consume the fall loop's root and a 1 m hop
sinks 30 m). Phases: TAKEOFF (rising) → FALL → LAND (when time-to-ground
drops inside the landing window, recomputed every frame because ledge edges
move the answer).

With a weapon family equipped, the air layer works like this
(bare-handed, GASP's pre-aligned landings do their original aligned thing):

- **Takeoffs**: the family's stand/run takeoffs, biased +40 over foreign
  clips; family takeoffs are exempt from the gait band (they're authored
  against the reference game's speed scale, not GASP's).
- **Falling**: the family's 2-frame `_Jump_Loop_Fall` pose hold. All
  weapon-family landings are *gated out* of alignment selection, so a
  weapon descent lives in the fall loop until contact.
- **Landing happens AT CONTACT** — the touchdown hook in `stepAir` plays
  the family's at-contact absorb by intent: `reqSpeed > 4` → `_Land_Roll`
  (full commit — a roll is a committed move), `> 0.8` → `_Land_Run`, else
  `_Land_Stand`. Installed as a cancellable action (0.12 s commit; move
  intent cuts the recovery; a 1.6 s cap ends the baked idle tails).
- **Double jump** (`airT` resets, once per flight): jump pressed mid-air →
  full fresh impulse + the family's flip clip, name-installed. Blocked
  during a freefall (once diving, you ride it).
- **Freefall** (the skydive): a fall past **2.2 s** installs
  `_Freefall` — dive-in, the flag/starfish spread, the authored flip
  upright. Touchdown during it is the **`_Freefall_Slam`** (crater landing,
  0.9 s commit) instead of the landing menu. Damage intentionally not
  implemented yet.
- **Glide** (the pod catch): a fall past **5 s** (~122 m) installs
  `_Glide_Enter` → `_Glide_Cycle` and **waives the slam** — glide landings
  use the normal touchdown menu.
- **Maintenance chains, not searches.** Freefall and glide own the sky:
  their chain swaps happen at `frames − 5` (a 0.1 s-clamped tick advances
  3 frames — swap *before* the exhaust or a forced re-search drops her
  back into the fall pose mid-dive; measured, twice). While either is
  active the alignment yield returns false — their landing *is* the
  touchdown hook. The freefall's own exhaust hands off to the family's
  fall-loop hold.
- The **80 m sky tower** at (−8, −10) in scene 1 exists to test all of
  this: 4.0 s fall = fall loop → freefall at 2.2 s → slam. Glide needs
  >5 s; teleport higher to test it.

## The dash system

the reference game's grammar: **the run button IS the dash button.** The press edge while
moving fires the family's directional dash (`weaponDashes` map, FRONT/BACK/
LEFT/RIGHT, from the item's `(mmDashes ...)` dat); *holding* it flows the
burst into the sprint tier — `sprintBoost` plays the run clip faster while
`travelBoost` scales travel (momentum builds slightly with sprint time).
There is no infinite dash-cycling: the sprint tier is the boosted run, and
the authored `_Sprint` clip stays parked. The dash clips are the trimmed
first 24 frames of the source dashes; their tails (and all weapon-set
loops) are **arc-length resampled at load** — the raw mots surge and the
un-repaired dash→run seam visibly settled the body backward.

---

## Foot IK: the rules and the scars

`updateFootLock(dt, enabled)` runs with
`enabled = grounded && state !== 'traversal' && !ladderOn && !actionOn` —
**IK serves searched locomotion only.** Ladders (protocol owns the body),
traversal (authored clips own it), and actions (strikes, landings) all
opt out; without the gates the IK planted feet on ladder rails mid-climb.

Inside the lock, the load-bearing design points:

- The lock pins **deviation, not position**: the IK target rides the
  clip's own authored ankle arc; only displayed-vs-authored error is
  corrected. (Heel-to-toe packs *travel* through stance; pinning position
  snapped every stride.)
- A **leash** (`ikRelease`): past the limit the lock itself slides —
  bounded error, no release snap.
- **Per-foot ground**, every frame: each foot rides the surface under
  *itself* (curbs, edges); beyond ±0.45 m it unplants. **Pelvis
  grounding** lowers the hips by the measured reach deficit when a lock
  sits below her ground level.
- **`ankleH` is read from the clip's features, never the displayed
  skeleton.** A plant firing during a stop's blend catches the displayed
  foot mid-swing (~0.5 m up) and the per-foot ground pass would pin the
  lock at ground+0.5 for the whole stance — the "her foot thinks it's on
  a tall rock" bug, one leg at a time.
- **Carried things are never ground.** Mounted items are parented under
  the host's hand *bone* — outside the character's excluded mesh subtree —
  so the ground/foot raycast prunes anything whose parent `isBone`. Before
  that rule, the 3.5 m lance trailing by her leg was a walkable floor and
  she planted a foot on her own spear.

## Camera & facing notes (GASP vs the reference action game packs)

- **`strafeOn` excludes weapon states entirely**:
  `tune.strafe && !(weaponTag && (state === weaponTag || state === 'air'
  || state === 'traversal'))`. A weapon claims turn-to-face in *all* its
  states — the strafe warp leaking into a weapon-state jump corkscrewed
  the spine (1.6° max deviation after the fix, camera 90° off).
- **Traversal sheathes the weapon.** The character watches the traversal/
  ladder edge (`state === 'traversal' || mm.inLadder`) and dispatches
  `onSheathe`/`onUnsheathe` — bare-hand GASP clips own vaults and climbs,
  and the meshes vanish reference-game-style; the weapon *tag* stays claimed so
  combat locomotion resumes on landing.
- The camera boom/collision tuning was built for GASP speeds and holds up
  at the reference game's 11 m/s sprint; the one camera-adjacent regression to check on
  a new family is facing (strafe exclusion) and the landing run-out, not
  the boom.
- Headless-testing caveat for all of the above: driving `mm.update()` or
  `ch._mmTick()` from the console runs *against* the live rAF loop —
  first-segment flakes are usually harness artifacts. Screenshots must be
  read inside a double-`requestAnimationFrame` (a WebGL canvas reads black
  outside its draw frame), and `mm.teleport(x, z, y)` takes **(x, z, y)** —
  passing y in the second slot has bitten twice.

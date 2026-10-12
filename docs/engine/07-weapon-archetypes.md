# Weapon-Type Classes (Database-Driven Combat)

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

How the Combat Bracers (type-3 fists) and the Dragoon Lance (spear) work,
and the exact order of operations for bringing in the next weapon class
(e.g. `smallSword`). Prerequisite reading:
[Motion Matching](06-motion-matching.md) for the pack pipeline.

---

## The idea

A weapon class is **not** a set of scripted animations. It is a *family* of
motion-matched clips that the engine swaps in wholesale the moment the
weapon is equipped:

- **A tag** (`combat`, `spear`, ...) names a search table. While the tag is
  claimed, ordinary locomotion — idle, walk, run, stops, starts — is
  searched from that family's clips instead of the bare-handed ones. This
  is `wantState` machinery, same rank as crouch.
- **A clip-name prefix** (`Bracer_`, `Spear_`) names the family's clips.
  Every family uses the *same role grid* — `<Prefix>_Run`,
  `<Prefix>_Jump_Double`, `<Prefix>_Freefall_Slam` — so the engine's named
  installs are pure prefix substitution.
- **Two set names** in the pack: the ground set (`Combat`, `Spear`) and the
  air set (`CombatAir`, `SpearAir`).

All three live in one registry in `engine/the motion-matching core †`:

```js
const WEAPONS = {
  combat:     { prefix: 'Bracer',     set: 'Combat',     airSet: 'CombatAir' },
  spear:      { prefix: 'Spear',      set: 'Spear',      airSet: 'SpearAir' },
  shortSword: { prefix: 'ShortSword', set: 'ShortSword', airSet: 'ShortSwordAir' }, // Cypress Stick (c0xx)
  unarmed:    { prefix: 'Unarmed',    set: 'Unarmed',    airSet: 'UnarmedAir', yieldsToCrouch: true },
};
```

**`unarmed` is the DEFAULT family.** The character claims it whenever the
equipped item declares no `weaponTag` of its own — empty hands, the key,
the portal gun, the bazooka — via the fallback in
`the motion-matching driver †.setCombatWeapon` (`tag || 'unarmed'`, plus the
`Unarmed_Dash_*` evades as default dashes). It is the reference game's out-of-combat
moveset (the `0001`–`006c` mots: plain walk/run/sprint, the dash grid,
the jump family, four double-jump variants) and it uses the same ~25-clip
role grid as the weapons, minus the attack roles. Its one registry
difference: `yieldsToCrouch` — the crouch key drops to GASP's crouch clips
(the default family curates none), while *real* weapons keep outranking
crouch (the C-key-interrupts fix). GASP now answers only for **traversal**
(vaults/climbs/ledges), **crouch**, and nothing else; the old un-prefixed
the reference action game clips that used to share the stand table with GASP were retired from
the pack when this family was curated — that mixed table was why
bare-handed movement never felt right.

Everything downstream — clip tagging (`tagOf`), parked-clip filters, gait
tables, air-family bias, touchdown landings, glide/freefall/slam/double-jump
installs, action caps, the arc-length loop repair — routes through this
registry. **Adding a weapon class is one registry line + curated clips + an
item script.** No other engine edits should be needed; if you find yourself
editing elsewhere, you have probably found a hardcode that belongs in the
registry.

the reference action game itself validated this shape: each weapon's mots mirror the others
one-for-one on the same id grid (`c0xx` small sword, `c2xx` heavy sword,
`c4xx` spear, `c6xx` bracers — `c#01` is always the stance, `c#0a` the run,
`c#3b` the double jump...). The convention is the game's, not ours.

---

## The animation checklist (what a family needs)

~31 clips per family. Column "search?" says how the engine reaches the clip:
**searched** (in a table, the matcher picks it), **parked** (baked and
name-reachable but excluded from search), **named-only** (installed directly
by engine machinery or `playAction`).

### Ground set (`set: <Family>` — e.g. `Spear`)

| Role name | the reference action game mot (spear example) | trim | search? | Notes |
|---|---|---|---|---|
| `_Stance` | `c401` Stand Cycle | — | searched | combat-ready idle loop |
| `_Idle` | `c402` Idle | auto | searched | relaxed idle |
| `_Walk` | `c404` Walk Cycle | — | searched | the walk gait tier |
| `_Walk_to_Run` | `c408` | — | searched | the authored acceleration — this is what makes full-stick-from-rest look the reference action game |
| `_Walk_Stop` | `c409` | auto | **parked** | stops are parked in sparse sets (they out-idle the idles); stopping is the still-gate's re-match |
| `_Run` | `c40a` Run Cycle | — | searched | the run tier; gets `isRunGait` (sprint boost + run spin-up multiply it) |
| `_Run_L`, `_Run_R` | `c40d`/`c40c` inclined | — | **parked** | curved roots; the procedural pivot superseded them. Parked clips **may not vote in the gait table** — that exclusion is registry-driven |
| `_Run_Stop_L/R` | `c40f`/`c40e` | auto | **parked** | |
| `_Sprint` | `c411` Dash Front, **untrimmed** | — | **parked**\* | Weapon families: the reference game's in-combat "sprint" IS the dash-front clip, so the sprint tier plays `_Run` × `sprintBoost` and this stays parked. \***`authoredSprint: true`** in the registry (the unarmed family, mot `0006` — a real cycle) flips it to **searched**: it becomes the sprint tier itself (`isSprintGait`: rides `travelBoost` and the momentum ramp, never the `sprintBoost` rate — cadence stays authored), gets `loops` **forced** (a 14-frame cycle misses the loop detector's similarity gate; it loops by authorship), and releasing sprint bars the clip from the tier-edge re-match (`sprintReleaseDrop` — the query trajectory still reads sprint speed at release, so the sprint frame otherwise wins and self-sustains: **fast clips self-trap exactly like slow ones**) |
| `_Dash_F/B/R/L` | `c411/c415/c419/c41d` | **0:24** | named-only | the burst only; fired off the run button's press edge |
| `_Light_1/2/3` | `0300/0301/0302` | auto | named-only | the light string (`playCombatAttack`); capped at 0.9 s by the engine |
| `_Heavy_1` | `0310` | auto | named-only | capped 1.4 s |
| `_Counter` | `0330` | auto | named-only | capped 1.4 s; not wired to input yet |

### Air set (`set: <Family>Air` — e.g. `SpearAir`)

| Role name | the reference action game mot | trim | search? | Notes |
|---|---|---|---|---|
| `_Jump_Start_Stand` | `c431` Jump 1/3 | — | searched (air) | standing takeoff |
| `_Jump_Start_Run` | `c43e` Jump 1/3 | — | searched (air) | running takeoff; family takeoffs are exempt from the gait band |
| `_Jump_Loop_Fall` | `c432` 2/3 Cycle | — | searched (air) | bakes to 2 frames — the engine force-loops and pose-holds it |
| `_Jump_Land_Stand` | `c434` 3/3 | — | named-only* | at-contact absorb; *lives in the air table but landings are never alignment-selected for weapon families — the **touchdown hook** plays them at contact by `reqSpeed` (>4 roll, >0.8 run, else stand) |
| `_Jump_Land_Run` | `c436` Landing Run | — | named-only* | |
| `_Jump_Land_Roll` | `000c` roll-to-sprint (shared mot) | — | named-only* | full commit — a reference action game roll is a committed move |
| `_Jump_Double` | `c43b` Double Jump | — | named-only | once per flight; restarts the air clock (re-arms the glide window) |
| `_Freefall` | `00a4` Sky Dive (shared) | — | named-only | installs at airT > 2.2 s; exhausts into `_Jump_Loop_Fall` |
| `_Freefall_Slam` | `00a5` Landing (shared) | **0:120** | named-only | the crater landing; 0.9 s commit |
| `_Glide_Enter` / `_Glide_Cycle` | `00a6`/`00a7` Sky Dive (shared) | — | named-only | installs at airT > 5 s; outranks freefall (no slam after a glide) |

The "shared" mots are weapon-agnostic in the reference action game; bake them **once per family
under the family's prefix** (the `/convert` payload lets one mot produce
many named clips). That keeps the engine a pure prefix template — worth the
handful of duplicate kilobytes.

Naming rules that matter: strike/dash/sprint names route to `action`
(named-only) by the `(Light|Heavy|Counter|Dash|Sprint)` pattern; `Glide`
and `Freefall` names route to `action` within the air set; everything else
in the air set joins the air table; a clip that must never be searched must
avoid the phase keywords (`Start`, `Loop`, `Land`) — that is why the double
jump and freefall are reachable by name only.

---

## The item side: mesh + script

**Mesh**: a glb whose **origin/axis sits at the grip point** with the shaft
along local +Y (the exporter convention). One mesh, one axis → it binds to
the right hand (`(socket "rightHand")`), and the built-in equip mounts it.
A *paired* weapon (the fists: two meshes, two axes) declares `(fistPair
"OtherElement")` + `(pairSocket "leftHand")` and mounts the second mesh in
its script — see `type3fist.ags.txt`; that pairing is the **only**
structural difference between the fists' script and the lance's.

**Grip tuning**: `mountX/Y/Z` (position) and `mountOffsetX/Y/Z` (degrees)
are read **live** by the renderer — tune in Properties during play. Facts
learned the hard way: the hand bone's local **+Y is the forearm line**
(elbow→hand), so a reference action game spear-style along-arm carry is a near-identity
rotation; grip conventions come from the source game, not from geometry
metrics — when in doubt, render a **titled contact sheet** of candidate
orientations and let the director point at one.

**Script** (`dragoonlance.ags.txt` is the clean single-mesh template):

```
(weaponTag "spear")                                  ; the registry tag
(mmAttacks "Spear_Light_1 Spear_Light_2 Spear_Light_3")
(mmHeavy "Spear_Heavy_1")
(mmDashes "Spear_Dash_F Spear_Dash_B Spear_Dash_L Spear_Dash_R")
```

Hooks: `onEquip` → `actor.setCombatWeapon(this.weaponTag, this.mmDashes)`;
`onUnequip` → `setCombatWeapon(null)`; `onPrimary`/`onSecondary` → the
combo pattern (0.35 s cancel window via `combatActionAge()`, 1.2 s cold
reset, heavy resets the chain); `onSheathe`/`onUnsheathe` → unmount/mount
(the character dispatches these on the traversal edge — the reference action game vanishes the
weapon for vaults and ladders). Declaring `weaponTag`/`mmAttacks` makes the
item "database combat," which automatically bypasses the legacy glb
action-clip attack path.

---

## Order of operations for the next class (`smallSword` walkthrough)

> **DONE (2026-09-10):** this walkthrough was carried out for real as the
> **`shortSword`** class (the Cypress Stick, `c0xx` mots) — see the reproducible
> runbook with the exact mot→role→trim table and headless commands in
> [`07a-weapon-onboarding-shortsword.md`](07a-weapon-onboarding-shortsword.md).
> One correction to step 1 below: the small-sword counter is `01e0` (not the
> spear's `0330`), and its attack block is richer (7 light-ground combos
> `0100-0106` — the first three become Light_1/2/3).


1. **Survey the mots.** Curator, search "Small Sword" — the `c0xx` block is
   the locomotion grid, `01xx` the attacks. Confirm each role in the tables
   above has a source id (they will — the grid is complete per weapon).
2. **Curate.** Name them `Sword_<Role>`, sets `Sword` / `SwordAir`, with
   the trims from the tables (dashes `0:24`, slam `0:120`, `auto` on
   attacks/stops/idles). Shared mots (`000c`, `00a4-00a7`) get baked again
   as `Sword_*` in the same convert payload.
3. **Convert + bake** (one `/convert` call, ~31 clips), then
   `refresh_ae1_pack.py locomotionPack` (editor on Projects page, reload).
4. **Registry line** in `engine/the motion-matching core †`:
   `sword: { prefix: 'Sword', set: 'Sword', airSet: 'SwordAir' }` — and add
   the prefix to the `WP` alternation next to it, a `sword: []` bucket in
   `tables`, and a `tagCounts` line. Seed `GAIT_RATE` with the family's
   run-rate corrections (start from the bracer/spear values `0.89` /
   walk-to-run `1.22` — same converter, same root undershoot — and retune
   on feel).
5. **Item script**: copy `dragoonlance.ags.txt`, change names/dats/mount.
   Attach to the sword element; make it `pickable` with `hasPhysics`.
6. **Verify** (headless or by hand): equip → `Sword_Stance` idle; walk /
   run / sprint speeds on sword clips; light×3 + heavy; dashes; jump chain
   is all-`Sword_` (fall loop included — the family bias covers the
   fallback path); double jump; freefall + slam off the sky tower; weapon
   switching sword↔lance↔fists↔bare with zero cross-family clip leaks;
   walk→stop idle feet stay planted.
7. **Grip pass** with the director (contact sheet), persist mount numbers
   in the script, Build & Ship.

Steps 1–3 are an afternoon; 4–5 are minutes; 6–7 are the real work.

## Known traps (each cost a debugging round — don't rediscover them)

- **Parked clips may not vote in the gait table.** The inclined runs'
  curved-root pace once captured the run tier and the request system asked
  for a speed the table couldn't serve — full stick walked forever.
- **Speed ramps belong in the output domain.** The whole matcher is
  calibrated to *snapped* speed requests; a swept request self-traps (walk
  pins the measurement, continuity wins). The reference game's gradual build-up = the
  authored `_Walk_to_Run` clip + the run spin-up (`runUpT`, 70%→100% over
  0.7 s) multiplying playback rate.
- **Every family-conditional path needs the family bias — including
  fallbacks.** A weapon-claimed descent spends almost all its time in the
  air search's LAND→fall-loop fallback; it was unbiased and picked the
  pose-cheapest fall loop *across all families* (bracers fell in the
  spear's fall pose 78/78). It silently "worked" with one family.
- **The request snaps, the sprint boosts, the dash is the run button** —
  don't re-derive these; read the momentum block in `step()`.
- **Self-traps are symmetric.** The walk self-trap (slow clip pins the
  measured speed, continuity wins forever) has a fast twin: an authored
  sprint cycle won the release-edge re-match because the query trajectory
  still read sprint speed, and then sustained itself. Any searched clip
  whose pace differs strongly from the tier it should hand off to needs an
  exit rule (tier-edge exclusion), not just a request change.
- **`detectLoop` is a heuristic; authorship outranks it.** Short the reference action game
  cycles (2-frame pose holds, the 14-frame sprint) can miss the wrap
  similarity gate. If the mot is authored as a cycle, force `loops = true`
  — an un-looped "loop" can neither vote a gait tier nor sustain.

# 9. The Enemy System

*(DESIGN.md §18.40 — the combat room round. For the player-side combat that
hits these enemies, see [Weapon Archetypes](07-weapon-archetypes.md).)*

AE1 has two tiers of inhabitant:

| class | file | what it gives you |
| --- | --- | --- |
| `NPC` | `engine/npc.js` | wander + validated routes, health/`takeDamage`, passive dialogue, ground snap, the topple death, the proximity swipe |
| `Enemy` | `engine/enemy.js` | everything above **plus** a clip-driven animation state machine and a selectable combat brain |

`Enemy extends NPC extends PassiveDialogue extends Hitbox` — nothing is lost
down the chain. The Goober still runs on plain `NPC`; the Stubby (the Combat
Room's inhabitant) is the reference `Enemy`.

## The animation state machine

An Enemy names its clips in dat; every clip lives in the element's own glb
(or `animLibs` libraries — `resolveClip` searches both):

```
(idle "Idle")            ; looped stand
(move "Walk")            ; looped wander walk
(run "Run")              ; looped chase — falls back to (move) if empty
(attacks ("Attack_1" "Attack_2"))  ; one-shots, picked at random per swing
(hit "Hit")              ; one-shot small-damage reaction
(hitBig "Hit_Big")       ; one-shot heavy reaction (>= bigHitDamage)
(death "Death")          ; one-shot; the mixer CLAMPS its last frame,
                         ; so the corpse pose holds itself. No clip named
                         ; = the NPC topple inherits.
```

States crossfade through the renderer's shared mixer (0.3 s default; the
class passes tighter fades for reactions). One-shots report back through
`onFinished` — that is how an attack hands the body back; a 4 s
`attackTimeout` backstops a lost finish event.

## The brain — all in one place, chosen by dat

Per Austin's spec, behavior trees live **in the base class**, and the
inheriting script only picks one:

```
(aiType "melee")             ; hostile-on-sight melee brain
(aiType "friendly")          ; never fights; the inherited wander, full stop
(friendlyUntilAttacked true) ; melee brain that stays peaceful until the
                             ; first takeDamage — then provoked FOR LIFE
```

`friendlyUntilAttacked` is a plain boolean dat, so the editor renders it as a
live checkbox in Properties automatically (editors.js infers controls from
value types — zero editor code).

The melee brain each tick: wander until the player is inside `aggroRange` →
chase at `chaseSpeed` (straight steering; the wander probe cadence checks for
walls — no A* yet, a blocked chase holds the glare) → inside `attackRange`,
swing a random `(attacks …)` clip → **one strike per swing**, applied at
`attackWindup` seconds in, only if the target is still inside
`attackRange × 1.15` *and* the `attackArc` facing cone (dodging works) →
`attackRate` cooldown **starting when the swing ends** → repeat. Past
`leashRange` (default 2.5 × aggro) it disengages back to the stroll but
stays provoked.

Damage in: `takeDamage` provokes, then staggers — the hit clip interrupts
everything (even a mid-swing attack, which still pays its cooldown) for
`hurtTime`/`hurtTimeBig` seconds. Fatal damage plays `(death)` once, the
death-cry tree fires, and the body vanishes after `vanishAfter`.

Adding a new brain = one more branch in `enemy.js::_enemyTick` keyed off
`aiType` — scripts stay one-line consumers.

## The enemy asset pipeline (NO retargeting)

Enemies keep their **native skeleton** and play plain clips — the polar
opposite of the player pipeline (mot → retarget → pose database). The whole
bake is one command:

```
blender --background --python motion-matching/tools/bake_enemy_glb.py -- ^
  --blend "<extracted model .blend>" ^
  --mots  "<unpacked emXXXf.dat directory>" ^
  --clips "Idle=<asset>,Walk=<asset>,...,Death=<asset>" ^
  --out   "<out>.glb"
py -3 motion-matching/tools/import_ae1_media.py --as stubby.glb <out>.glb
```

The tool strips LOD/shadow meshes (`--drop`, default `-LOD\d|-SHADOW`),
drives the game's Blender add-on mot importer headless per clip, stashes each
action to NLA, exports one glb, then **strips every animation channel that
targets a scene-root node**. That last step is load-bearing:

> **The root-channel lesson.** The glTF exporter samples an object-level
> translation/rotation track for the armature into every clip. AE1 locks
> root drift only on *library* clips — a model's own clips play untouched —
> so the mixer stomped the element transform every frame and the enemy
> rendered at the world origin while its element moved. Enemy clips must be
> in-place; the AI owns travel. `strip_root_channels()` in the bake tool
> enforces this forever.

### Where enemy animations live (the reference action game)

Same convention as the player: `<asset>` → `<asset>`. The `f`-suffixed
dat is the motion pack (118 mots for <asset>); the numbered dat is
model+params. **The game ships its own labeling**: `<asset>.dat/AnimationTable.csv`
maps semantic states to motion ids (`a0000l` idle → `<asset>.mot`,
`0500`/`0510`/`0600-0602` attacks, `01xx` damage reactions, `0190` death,
`03xx` stun) — no triage gallery needed. Variants (<asset>-<asset>, em000b…)
re-skin the same rig and **reuse <asset>**, so palette-swap enemies cost
one mesh bake.

## The Combat Room

Scene 5 ("Combat Room", `scenes/scene-5.json`): a 22 m walled arena
(`combat_room.glb`, meshforged) reached through the red-framed
`CombatDoor` beside the range door in Scene 1 (`combat-door.ags.txt` —
a Hitbox + `goToScene`, the standard door recipe), with
`combat-door-back.ags.txt` leading home. Two species live there, one of
each temperament:

| | Stubby (<asset>) | Medium Biped (<asset>) |
| --- | --- | --- |
| script | `stubby.ags.txt` | `biped.ags.txt` |
| temperament | `friendlyUntilAttacked true` — potters until hit | hostile on sight |
| health / damage | 60 / 8 | 150 / 4 — the tank |
| swings | 2 attacks, ~2 s | 3 attacks, 3-4 s, windup 0.9 |
| skeleton | 47 bones, 11 clips, 4.4 MB | 64 bones, 12 clips, 9.1 MB |

The biped was the pipeline's proof run: **one bake command + one script +
one scene element** (`AnimationTable.csv` again supplied every id — DASH is
`0020`, attacks from `EmInfo` at `0500/0510/0520`). Two animated enemies
coexist fine because they wear *different* glb files — the
one-instance-per-glb ceiling below is per FILE, not per scene.

## Adding enemy species N+1 — the recipe

The biped proved this list is complete; nothing else was touched. In order:

1. **Pick the machine and read its table.** Extracted models live at
   `<local path> reference game\extracted\<cpk>\em\<id> - <name>\`
   (500 blends, all of cpk006/016/100). Open the *game's own*
   `<id>.dat/AnimationTable.csv` in the CPK unpack for locomotion/damage/death
   ids, and `<id>EmInfo.csv` for attack motion ids (`M0_XXXX` rows). Ids are
   per-species — <asset>'s dash is `0021`, <asset>'s is `0020`. Never guess;
   the table knows.
2. **Check the blend's mesh names** (`inspect_blend.py`) only if the bake's
   default `--drop` regex (`-LOD\d|-SHADOW`) might not fit; both <asset> and
   <asset> fit it as-is.
3. **One bake command** — `bake_enemy_glb.py` with the `Name=motStem` map
   (Idle/Walk/Run/Attack_*/Hit/Hit_Big/Death; bake `Walk_B`/`Stun` too, they
   are nearly free). Then `import_ae1_media.py --as <name>.glb`.
4. **One script** — copy `biped.ags.txt`, change the clip names if they
   differ, and tune the personality dats. The knobs that make species feel
   different are all dat, no code: `health`/`attackDamage`,
   `attackWindup`/`attackRate`/`attackTimeout` (scale to the attack clips'
   real lengths — a 4 s swing needs `attackTimeout 5`),
   `hurtTime`/`hurtTimeBig` (scale to the reaction clips),
   `chaseSpeed`, `attackRange` (arm length), `friendlyUntilAttacked`.
5. **One scene element** — model `media` = the new glb, `node` = the armature
   name (= the em id), scale 1, `y 0.01`. A *different* glb file per species
   is what lets them all animate at once.
6. **Playtest, Build & Ship.** Watch for: facing (fix with `(faceOffset)`),
   feet at floor, and the attack cadence reading as fair.

## Known limits (v1)

- **One animated instance per glb file.** A second element wearing the same
  glb renders as a static clone (render3d's one-glb-one-timeline rule). A
  room full of stubbies needs either per-instance glb copies (cheap — dedupe
  by name in media) or a renderer change. Start here when Austin asks for
  "a bunch of enemies".
- Chase is straight-line steering with a blocked-probe hold — no pathfinding
  around obstacles yet.
- Enemy→player strikes are distance + facing arc, not per-bone hitboxes.
- `Stun`/`Stun_Loop`/`Walk_B` are baked into stubby.glb but unused by the
  v1 brain — free material for a future stagger/knockdown system.

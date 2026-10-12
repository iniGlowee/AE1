# 11. Attack Archetypes — classified enemy attacks

*(DESIGN.md §18.44. The enemy-side twin of [Weapon Archetypes](07-weapon-archetypes.md):
where that page classifies what the PLAYER swings, this one classifies what
enemies do to the player — per-animation, per-damage, event-dispatched,
script-tunable.)*

## The classification table

Every Enemy may classify its attack animations in dat:

```
(attacks ("Attack_1" "Attack_2" "Attack_Trumpet"))
(attackSpecs (
  ("Attack_1"       "melee"  8)
  ("Attack_2"       "melee"  8)
  ("Attack_Trumpet" "aoe2"   6  "speed" 3.5 "radius" 6 "windup" 0.8)))
```

Row shape: `(clip kind damage [key value]...)`. Extra keys become numbers on
the spec (`speed`, `radius`, `range`, `windup`, `pad` today; anything
tomorrow). **A clip with no spec is a plain melee swing at `(attackDamage)`**
— every enemy that predates this system runs unchanged. Kinds:

| kind | execution (at the spec/default `windup` into the clip) | spec keys |
| --- | --- | --- |
| `melee` | the striking mesh OVERLAPPING yours is the hit — AABB sweep every frame until it lands or the clip ends; dodging out works | `pad` (overlap forgiveness; defaults to reach×0.3 — see the bind-pose trap below) |
| `ranged` | spawns an `EnemyRound` — the slow orange orb (the reference game's red spheres, blockout tier) flying straight at your center as of the shot; overlap pops it and deals the damage; never hurts other enemies | `speed` (m/s, 5), `range` (m, 30) |
| `aoe1` | spawns an `AoeWave` in **ring** mode — the red circle racing outward at ground level from the stomp | `speed` (radius m/s, 4), `radius` (max, 7) |
| `aoe2` | `AoeWave` in **orb** mode — the thin translucent sphere growing from the attack point | same |

Both AOE modes damage the player **once, when the wave FRONT passes
through them** — standing behind a passed ring is safe. Unknown kinds warn
loudly; future kinds (guns, lasers, magic) are new branches in the
attacking tick of `enemy.js` and nothing else.

## The combat event — who, what, where, when, why, at whom

The moment an attack STARTS (the telegraph — dodging needs the warning, not
the receipt), the enemy dispatches:

```js
{ attacker, name, clip, kind, damage, x, y, z, t, state, aiType, target }
```

- to the target's **`onEnemyAttack (evt)`** script hook (a new RUN_INFO
  combat mode — `(runInfo incoming onEnemyAttack)` on the player script),
- and onto **`world.attackEvents`** — the global feed (last 32, timestamped
  with sim time) that any element can read every tick.

## Damage getters/setters — the AngelScript tuning surface

```js
enemy.getAttackSpec("Attack_3")        // {kind, damage, speed, radius...} copy
enemy.setAttackSpec("Attack_3", {damage: 12, radius: 9})   // merge
enemy.getAttackDamage("Attack_3")
enemy.setAttackDamage("Attack_3", 2)   // live — the NEXT swing deals 2
```

All runtime-mutable, so a higher-order AngelScript system — an area buff, an
enrage event, a difficulty scalar — is a loop over enemies calling setters.
Verified live: nerfing a stubby punch to 2 mid-fight dealt exactly 2.

## The spawned execution elements

`engine/enemyattacks.js` — `EnemyRound` + `AoeWave`, both builtins, both
SPAWNED like the LockMarker (scene.add; game3d's element-count rebuild loads
the glbs; `roundMedia`/`ringMedia`/`orbMedia` dats keep the exporter
shipping them). Dumb on purpose: numbers arrive from the attacker's spec at
spawn; they move, test, and remove themselves.

meshforge grew a `sphere` shape and a `"color"` texture kind (flat RGBA,
`alpha` < 1 = BLEND translucency, mild emissive) for the three signal
meshes: `orange_orb.glb`, `red_ring.glb`, `aoe_orb.glb`.

## The roster after this round

| enemy | classified attacks |
| --- | --- |
| Stubby (<asset>) | 2× melee 8 + **Trumpet aoe2 orb** (6 dmg, 6 m) |
| Medium Biped (<asset>) | 2× melee 4 + **Attack_3 stomp aoe1 ring** (8 dmg, 8 m, lands at windup 1.2 into the slam) |
| **Small Flyer (<asset>)** — NEW | **ranged** 5 dmg orb, 4 m/s, fired from ~7 m |

The flyer proved two things: `(hoverHeight 2.2)` floats the same
wander/chase brain at altitude (the ground snap targets ground+hover; death
drops it — the machine falls out of the sky), and a ranged enemy needs ZERO
new brain code — `(attackRange 9)` makes the chase stop at ~7 m and fire
from there. The reference game's flyers shoot from their hover pose, so `Attack_Shoot` IS
the idle mot baked under an attack name (its motion pack ships no attack
animation at all — check `AnimationTable.csv` before assuming ids exist:
<asset>'s pack has 29 mots and no `05xx`).

## Traps found and paid for

- **Bind-pose boxes don't swing.** Render bounds come from bind-pose
  geometry; GPU skinning never moves them. The stubby's punch visibly
  reaches 1.7 m but his box is 0.9 m deep, and his brain stops OUTSIDE his
  own box — pure mesh-overlap whiffed forever. The melee `pad`
  (reach×0.3) is the swing's forward extension.
- **`Hitbox.intersects(other)` asks the OTHER side for `.bounds()`** — and
  the player is a Model, not a Hitbox, so it silently never hit. The melee
  test reads both boxes straight from `env3d.boundsOf`.
- **A 1-frame clip ends the attack before the windup** (onFinished fires
  instantly, the round never spawns). Attack clips must outlive their
  windup — the flyer's 1-frame `3000` pose was unusable as a clip.

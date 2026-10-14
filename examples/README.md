# AE1 examples — rescued from the 3D project purge (2026-09-03)

When the eleven 3D game projects were retired (see `docs/3d-projects-chronicle.html`
for the full history), every script, scene fixture, and asset that existed
**nowhere else** was copied here. These are working reference implementations —
drop the script into any project's `scripts/`, add an element that uses it, and
it runs. The § numbers refer to DESIGN.md.

| Folder | What it is | Born in | § |
|---|---|---|---|
| `portals/` | The complete render-to-texture portal gun + portal eye (`PerspectiveCamera` as an element, wall-normal placement, the ARMED anti-ping-pong latch, mirrored-yaw walk-through continuity) | 3d-sandbox → -mm | 18.30/18.32 |
| `weapons/` | The type-3 fist PAIR weapon (both arms, bind-pose mirror derivation, `mountExtra`/`pickupAs`) and the lance (the weapon-registry second class). The only pair weapon ever built. | 3d-sandbox-mm | 18.14/18.39 |
| `enemies/` | Biped (aoe1 tank), Flyer (the only ranged/hovering enemy), horde + gauntlet spawners (§18.46 instancing, ring-scaled difficulty) | 3d-sandbox-mm, playtest1 | 18.40/18.44/18.46 |
| `fishing/` | The whole fishing feature: TriggerBox state machine (chair-spawns-under-you, E-toggle grammar, cleanup safety net) + the only non-vehicle camera course (sweep-and-push "admire the catch"). The superseded Hitbox rev is kept beside it as the migration lesson. | fishing1 | 18.49/18.50 |
| `pause-menu/` | The engine's only working menu: faction CSS hand-port, the reference series' flower dial (original inline SVG art), pure-AGS DOM UI over the paused loop. Gated behind the MENU_PROTO debug flag. | forest1 | 18.64 |
| `lighting/` | Fixture-derived lamps (the reference action game maps carry no light data — glow-material centroids ARE the lamps; 1500 cd / 55 m for interiors) + the fully-tuned factory PostFX profile (dofSharpRange 14, dynamicRes band, the measured renderScale datapoints) | factory1 | 18.57/18.59/18.60 |
| `audio-volumes/` | The three-layer audio model: ambience bed, music volume box, bitcrush FX volume (equal-power dry/wet). No later project authored an AudioFXVolume. | 3d-sandbox | 18.19/18.34 |
| `projectiles/` | Bazooka + missile: scene-element-as-ammo-template, `projectileAt` mid-clip spawn, aim assist (`aimWeight`/`aimMaxDeg`), muzzle-flash + breech-smoke socket particles | 3d-sandbox | 18.15/18.16/18.22 |
| `passive-dialogue/` | Proximity voice with the silence roll (`passiveChance`) and the talking-sign idiom ("a sign that only sometimes works is a broken sign") | 3d-sandbox | 18.18/18.21 |
| `destructibles/` | `whiteboard.ags.txt` — the best teaching script in the repo: `__bind__` rest pin, the shared-glb sibling-restore trap, pose freezing, `containsPoint` retirement | 3d-sandbox | 18.10/18.25 |
| `scatter/` | The only `Scatter` archetype ever authored (`spawnSnap`, `(x y z yaw scale)` rows) | 3d-sandbox | 18.23 |
| `doors/` | Key-gated quest door (voiceLine etiquette), the clear-the-room victory door (polls enemy `_dead`), the clean no-clip key gate | 3d-sandbox, playtest1 | 18.28/18.45 |
| `ladders/` | the reference action game ladder + the 286-rung 80 m sky ladder (the freefall/slam tuning fixture) | 3d-sandbox-mm | — |
| `forges/` | Goober: mesh, clips, and voice all generated (meshforge/clipforge/audioforge) + the death-delay scene warp | 3d-sandbox | 18.25–18.27 |
| `fixtures/` | Scene JSONs preserved as data: the MM Range (29 mmbox traversal blocks), the playtest duel (per-instance `attackSpecs` overrides in pure scene dat), flight1's nine-tile LOD-pair shape, factory1's five arena-light placements, playtest1's README (the mmbox rule) | various | 18.46/18.53 |
| `media/` | The small irreplaceable glbs: flyer/biped enemies, the fist pair, the lance, the book pod + pod bolt, fishing kit (koi/chair/pier/water), goober, dungeon kit, sky ladder + tower, VFX orbs/rings, the reference action game effect sprites, the generated day-sky HDRI (`DAY_LAKESIDE.hdr`, the only daylight sky) | various | — |

Things NOT kept (rebuildable from the CPK pipelines documented in DESIGN.md and
docs/ROADMAP.md): the baked map glbs (city tiles + LOD twins, tower, factory,
forest tiles, colosseum, bunker), the fat Mixamo-era animation libraries, and
per-project exports. The current character stack (hero.glb, npc_native.glb,
npc_commander.glb, flight_unit.glb, all mm packs, the lucky takes) lives on in
`projects/devroom`.

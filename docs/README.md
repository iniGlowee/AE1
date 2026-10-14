# AE1 Documentation

**Angel's Egg 1** — a local, browser-based game engine. Point-and-click adventures first,
architected so other project types slot in without rework.

AE1 exists to remove the barrier between having an idea for a game and having a game. The
tool is simple at the surface and unbounded underneath: everything you can click, you can
also script, and everything you script is ordinary JavaScript on ordinary objects.

---

## Who are you?

**I want to make a game.** → [Guide](guide/) — start with
[Getting Started](guide/01-getting-started.md).

**I want to work on AE1 itself.** → [Engine](engine/) — start with
[Architecture](engine/01-architecture.md), then read
[Lessons](engine/05-lessons.md) before you change anything.

**I'm picking this up cold / I'm a fresh AI session.** → [`../respawn.md`](../respawn.md).

**I want to know *why* something is the way it is.** → [`../DESIGN.md`](../DESIGN.md) is the
decision record. Code comments cite it by section (`DESIGN.md §7.1`). These docs describe
*what is*; DESIGN.md remembers *why it is*, including the mistakes that shaped it.

---

## The whole loop, in one breath

```
server.ps1  →  Projects  →  Wizard  →  Workspace
                                          ├─ import media
                                          ├─ place elements
                                          ├─ attach Angel Scripts
                                          ├─ ▶ Play
                                          └─ Build & Ship  →  a game anyone can host
                                                              or double-click
```

## Contents

### Guide — making games

| | |
|---|---|
| [1. Getting Started](guide/01-getting-started.md) | Run it, make a project, make something happen |
| [2. The Editor](guide/02-the-editor.md) | Panes, layout, play, undo, shortcuts |
| [3. Elements](guide/03-elements.md) | What things in a scene are, and what they have |
| [4. Angel Script](guide/04-angel-script.md) | The language: `dat`, `def`, methods |
| [5. Standard Library](guide/05-standard-library.md) | Every call you can make from a script |
| [6. Media](guide/06-media.md) | Importing art and audio; why names matter |
| [7. Scenes](guide/07-scenes.md) | Rooms, and moving between them |
| [8. HUD & Inventory](guide/08-hud-and-inventory.md) | Things that outlive a scene; health bars |
| [9. Build & Ship](guide/09-build-and-ship.md) | Exporting, and modding what you exported |
| [10. Dialogue](guide/10-dialogue.md) | Conversations, choices, and making them do something |

### Engine — working on AE1

| | |
|---|---|
| [1. Architecture](engine/01-architecture.md) | How the pieces fit and why they're split that way |
| [2. Code Map](engine/02-code-map.md) | Every file, what it owns |
| [3. Principles](engine/03-principles.md) | Five rules, and what each one forbids |
| [4. Extending](engine/04-extending.md) | Adding panes, properties, base classes, project types |
| [5. Lessons](engine/05-lessons.md) | Real bugs, and the invariants they bought |
| [6. Motion Matching](engine/06-motion-matching.md) | The lab, the curator, the reference action game extraction toolchain, packs, and the character weight-paint routine |
| [7. Weapon-Type Classes](engine/07-weapon-archetypes.md) | The weapon-family system (bracers, spear, …), the per-family animation checklist, and the order of operations for a new class |
| [8. Movement Systems](engine/08-movement-systems.md) | Ladders, air/freefall, dashes — and the foot-IK & camera caveats |
| [9. Enemy System](engine/09-enemy-system.md) | The Enemy base class: clip state machine, selectable AI brains, friendly-until-attacked, and the no-retarget enemy bake pipeline |
| [10. Combat Feel](engine/10-combat-feel.md) | The impact layer: kill slow-mo + hit stop (the loop's time-effects core), gamepad rumble, and the player character's hurt reactions |
| [11. Attack Archetypes](engine/11-attack-archetypes.md) | Classified enemy attacks: per-clip kind + damage specs (melee/ranged/aoe1/aoe2), the onEnemyAttack combat event, spawned rounds + AOE waves, script-tunable damage |
| [12. Instancing](engine/12-instancing.md) | Prototype/instance with overrides: per-instance animation over one shared glb, per-instance tint, spawnInstance/instancesOf from AngelScript — the Stubby Horde |
| [13. Fox Camera & Shaders](engine/13-fox-camera-and-shaders.md) | The stealth-game-feel camera (raw input, damped chase, 3-octave handheld sway, the 28 mm lens) + the PostFX layer (character-follow cinematic DOF, grain, vignette, CA) + the reference action game environment pipeline |
| [14. Fishing & Camera Courses](engine/14-fishing-and-camera-courses.md) | CharacterCameraCurve/Course (character-relative cinematics, one-active rule, onStart/onEnd) + the reference action game fishing state machine on the player character's real <asset> animations |
| [15. Aircraft](engine/15-aircraft.md) | The pilotable-vehicle base element: character-root contract, Asura hover (Armored Core hands) + Cygnus jet (Ace Combat hands), transform rules, chase camera, camera-course seams — the flight unit |
| [16. Follower Pod](engine/16-followerpod.md) | The floating companion base element: camera-relative shoulder follow, its own fire/special buttons, PodBolt (the friendly EnemyRound), lock-target aiming, the vanish-while-piloting rule — the companion pod on the real pod skeleton |
| [17. Debug Menu](engine/17-debug-menu.md) | The reference-game-style debug flag wall: SELECT+START / tilde freezes the frame (hard pause — loop + renderer clocks), WASD/d-pad + SPACE/A toggles wired flags (AI freeze, invincible, slow-mo, wireframe, FPS meter) and inert project flags any script can query |
| [18. Dialogue, Possession & NPCs](engine/18-dialogue-possession-npcs.md) | world.uiLock + the DOM DialogueUI, per-NPC trees via onInteract, onCall event routing, autopilot/possession body-swapping, pivot assist, and the native the companion character no-retarget bake pipeline (the backward canonical compass) |
| [19. Character Models & Takes](engine/19-characters-models-takes.md) | The 008 authored-head the player character (face bones for facial mots), the character-glb swap checklist (alpha/PBR/node-name), the hair MASK-vs-hash doctrine, the mocap-take pipeline (grounding, sync, strip), FIRST_PERSON |
| [20. Native Build Architecture](engine/20-native-build-architecture.md) | Breaking out of the browser: the AGP game package, the QuickJS + bgfx Windows runtime that mirrors the engine (scripts run unmodified), the platform seams (env3d, audio, input, UI modules), and the phased plan — editor stays in the browser forever |
| [21. AGP Format](engine/21-agp-format.md) | The AE1 Game Package spec (v1): manifest.json + data.json + game.aepack, the target-neutral container the browser build and a native runtime both read from the same bytes. Build & Ship `target` (browser/agp) |

Also: [The 3D Projects Chronicle](3d-projects-chronicle.html) — the full history of the eleven retired 3D
projects (Jul 23 – Aug 31 2026): what each built, the lessons in their own words, and where every rescued
script went (`examples/`).

---

## Conventions in these docs

- **Bold claims are load-bearing.** If a doc says something *must* be true, there's usually a
  bug behind it — see [Lessons](engine/05-lessons.md).
- Code references use `path/to/file.js:symbol`.
- `DESIGN.md §N` points at the decision record.
- Anything marked **not built** is honest about it. AE1's docs do not describe features that
  do not exist.

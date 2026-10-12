# 2. Code Map

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

~15,000 lines of JavaScript, plus the Python server and exporter. Every file, what it owns, and
what you must not break.

---

## Root

### `server.ps1` — 188 lines

Resolves Python, bootstraps `.venv`, starts the server, opens Brave incognito.

**Resolves via the `py` launcher.** Bare `python` on Windows frequently resolves to the
WindowsApps stub, which opens the Microsoft Store, reports success, and does nothing. Paths
under `\WindowsApps\` are filtered explicitly.

A failed dependency install **warns and launches anyway** — dependencies are optimization-only.

### `server.py` — 1107 lines

stdlib `http.server`. Owns every read and write.

- `Paths` — resolved once at startup.
- `write_json` — **atomic** (temp + rename). Journaling runs constantly; a half-written file
  would corrupt exactly what the journal protects.
- `route(method, pattern, raw=False)` — decorator. `raw=True` hands the handler a `RawBody`
  (bytes + headers) for media upload.
- `slugify` — conservative on purpose: rejects path separators, traversal, and Windows
  reserved device names.
- Media: content-addressed by `sha256[:32]`. Import is a no-op for identical bytes.
- `_send(..., immutable)` — media caches forever (the filename *is* the hash); everything else
  is `no-store`, because a stale editor file looks exactly like data loss.
- `_serve_static` — resolves before comparing. A path is safe only if where it *lands* is
  inside the root.

### `exporter.py` — 970 lines

Build & ship. See [Architecture](01-architecture.md#export).

- `ENGINE_MODULES` — the dependency order. Hand-maintained deliberately.
- `bundle_engine()` — concatenator for a known input. **Refuses on name collision.**
- `bundle_modules_3d()` — the 3D counterpart: walks the ES-module graph from
  `three3d/game3d.js` (three.js + engine, 34 modules), topo-sorts, ships
  `{order, deps, modules}` inlined in `index.html`; the page rebuilds it as Blob URLs at boot so a
  3D game double-clicks on `file://` (`DESIGN.md §18.8`). Guards against three.js doc-comment
  prose: non-`.js` relative specs, self-references, and specs with no file are all skipped.
- `strip_glb_to_clips()` — animOnly glbs ship as node graph + clips ONLY (stdlib GLB surgery,
  183.5 MB → 168 KB). Forced by V8's ~1 GiB string cap: seven fat libraries made a 1.89 GB
  index.html whose JSON could not even be materialised — dead on double-click. Best-effort: any
  surprise ships the original bytes + a warning; near-cap builds warn (`DESIGN.md §18.10`).
- `collect_media_refs()` — sprites (scenes *and* HUD) + inventory icons.
- `collect_name_refs()` — **assets named in scripts OR in element dat.** Without the script half,
  sounds ship pruned and the game falls silent; without the dat half, a video named in a
  per-element dat override (`(video "Position_001")`) ships pruned and the game goes black.
- Staging + swap: **never delete the previous build before the new one is ready.**
- The Pillow warning fires only when Pillow is *actually* missing — "no image happened to shrink"
  is normal and must not read as a broken install.

### `DESIGN.md` — 1892 lines

The decision record. Code comments cite it by section. Read it before arguing with a design
choice — the argument has probably already happened.

---

## `/engine` — shared by the editor and every shipped game

### `element.js` — 755 lines

`AE1Element`, `ELEMENT_SCHEMA`, and `COMPONENT_SCHEMA`.

**The schema is the single source of truth.** One declaration per property generates: the
accessors, the `getX`/`setX` pairs, **the entire Properties panel**, defaults, and
serialization. Adding a property to every element in AE1 is one line.

- Values live in `_props` behind **real accessors**, so `this.x = 5` *and* `el.setX(5)` are
  both observable. Plain fields would make the accessors decorative and let script mutations
  vanish unsaved.
- `new.target.agsDat` seeds dat properties — the compiled subclass carries its own without
  `AE1Element` knowing AGS exists.
- `_extra` preserves **unknown keys**. An element must never delete data merely because it
  doesn't currently understand it.
- `uuid()` — guarded. `crypto.randomUUID` is secure-context gated, and a shipped game must not
  die on `file://`.
- The AGS standard library: `say`, `find`, `goToScene`, `playSound`, `give`, `has`,
  `setSprite`, `voiceLine` (§18.29 — playSound AS THIS ELEMENT'S VOICE: registers in
  `world.voices` and cuts the same element's previous line first; `emitVoice` is an alias
  for it now). All degrade to no-ops off-world.

> `name` **must** default to `''`. A non-empty default is truthy and shadows the generated
> fallback name, so every element arrives called "Element".

`COMPONENT_SCHEMA` does for the optional bags what `ELEMENT_SCHEMA` does for the base: one
declaration generates the Properties panel rows. Components were invisible to the panel before
it existed — a sprite could only be set by dropping art on the viewport, and never edited after.
Components: `sprite` (2D), `model` + `light` (3D). Each carries a `dim` marker.

**The transform is 3D on the base** (`z`, `rotationX`, `rotationY`, `scaleZ`; `rotation` = Z),
because a transform is what every element HAS, not a component (`DESIGN.md §18.3`). A `dim`
marker (`'2d'`/`'3d'`) on a field or component hides it from the wrong project type — a 2D author
never sees `Z`, a 3D author never sees `Layer`. 2D is the z=0 subset and stays byte-compatible.

`setComponent(slot, key, value)` is the **one door** for component writes. Bags are plain data
with no accessors, so `el.components.sprite.frame = 3` changes the picture and is never saved.
It replaces the bag rather than mutating it, so a snapshot taken before the write cannot change
underneath the caller — which is what play-mode restore depends on.

`defineDatAccessor` / `definedInChain` — **never regenerate an accessor OR a `getX`/`setX` pair
that already exists in the chain.** The property guard stops a subclass shadowing a built-in's
reactive accessor (`AE1Video.poster` seeks when you change it). The pair guard checks BOTH
`get${C}` and `set${C}`, so a dat key can't clobber a hand-written std-lib method with no matching
getter — `musicLevel` silently overwrote `setMusicLevel`, and `sprite` → `setSprite` would too.
See [Lessons](05-lessons.md).

### `scene.js` — 182 lines

`AE1Scene`. Elements as a `Map` keyed by id.

- Hierarchy is a `parent` id **on the child only**. Two directions means two things that can
  disagree.
- `remove()` removes descendants — orphans that render but can't be selected are miserable.
- `reparent()` refuses cycles.
- `replace()` — swap an instance keeping its id. What rehydration needs.
- `setWorld()` — hands the world down to every element.

### `hud.js` — 177 lines

`AE1HudElement`, `AE1Inventory`.

- Items are `{id, name, icon, ext}` — **data, not elements**. An element dies with its scene.
- `add()` is idempotent by id.
- `draw()` — the hook that makes custom HUDs possible.

### `ags/reader.js` — 200 lines

The s-expression reader. **One reader for both `dat` and `def`** — that's why LISP.

Greedy: stops at the first non-`(` token, which is how the JS section needs no delimiter.

Only whole-token numbers parse as numbers — `3d-model` stays a symbol.

### `ags/compiler.js` — 524 lines

`.ags.txt` → a class factory.

- `scanMethods()` — finds top-level `function` declarations. Skips function bodies whole, so
  nested declarations are never hoisted. Handles strings, template `${}` holes, comments.
  **Known limit:** a regex literal with an unbalanced brace can confuse it. Fails loud.
- `toMethod()` — `function use(a){}` → `use(a){}`. **This is why `super` works** — only class
  methods get a `[[HomeObject]]`.
- Validation skips `runInfo` checks when the file has `extends` — it can't see the chain.
  `compileAll` re-validates against the real prototype.

### `ags/runtime.js` — 291 lines

- `BUILTINS` — `Element`, `Text`, `Button`, `Video`, `Sprite`, `DialogueDelegate`, `DialogueBox`,
  `HudElement`, `Inventory`, `SaveHandler`. Resolved by `(extends …)` through the same path as
  any script, so an author cannot tell which bases the engine ships and which they wrote.
- `RUN_INFO` (in `compiler.js`) is the **whole vocabulary of dispatch modes.** A mode absent from
  it does not exist, however well a class dispatches it.
- `buildClass()` — merges `agsDat` **and `agsDef.runInfo`** down the chain. Both. Missing the
  second means a subclass silently never gets called.
- `compileAll()` — all scripts together; `extends` can name any of them. A script never
  extends itself. Cycles are **named**, not left to blow the stack.
- `rehydrate()` — the moment an element *becomes* a Door. **Never downgrades on a compile
  error** — that cost a data-loss bug.
- `buildSchedule()` — **flat arrays per mode**, built once at load. Never
  iterate-all-and-check-per-frame.
- `dispatch()` — catches per method. One bad script costs that element, never the game.

### `world.js` — 368 lines

`AE1World`. The HUD, audio, the media name table, the current scene, scene changes.

`goToScene` contract: outgoing scene gets `onUnload` and is dropped; incoming gets `onLoad`;
**the HUD is untouched**.

`resolveMedia(nameOrHash)` — authors write names, not hashes.

### `loop.js` — 239 lines

`GameLoop`. Takes a scene **or** a world.

- **`dt` clamped to 100ms.** A background tab pauses rAF; the first frame back would otherwise
  teleport everything.
- `onHover` fires on **enter**, `onExit` on leave — not per frame, or it'd just be a second
  `onTick`.
- `rescan()` — rebuild the schedule when the live element set changes. The world calls it on
  `@add`/`@remove`. **Without it a spawned element renders and never answers a click**, because
  the tables are built once.
- `actor` — the `player`-tagged element, else a stub that still answers `has()` from the
  inventory.

### `renderer.js` — 168 lines

`drawElements(ctx, elements, opts)`. Takes a **list**, not a scene — the world composes scene
+ HUD and the renderer has no business knowing which is which.

An element with a `draw` method owns its rendering. A thrown `draw` costs that element, never
the frame.

> **Both paths share one transform.** `draw()` used to get a bare translate, so rotation and
> flip were silently ignored on every Text, Video and Button. See [Lessons](05-lessons.md).

`frameGrid(img, sprite)` / `frameRect(img, sprite)` — spritesheets. A frame size of 0 means an
ordinary image; otherwise the default path uses the 9-argument `drawImage`. Frames are **data**
and live here, so any element can show one. Out-of-range indices **wrap**, never clamp — an
out-of-bounds source rect draws nothing and throws nothing, so the element would just vanish.

### `sprite.js` — 237 lines

`AE1Sprite`, the `(extends Sprite)` built-in. Owns **motion only** — clips, `fps`,
`play`/`stop` — and drives `components.sprite.frame` on a clock.

> **The one built-in with no `draw()`, on purpose.** Staying on the default path is what gives
> it rotation, flip, opacity and the decoding placeholder for free. See `DESIGN.md §5.3.1`.

`(animations (walk 0 7) (idle 8 11))` — nested arrays of primitives, the only shape the reader,
`structuredClone`, and `serialize()`'s JSON comparison all agree on.

### `three3d/render3d.js` — 850 lines · `three3d/game3d.js` — 165 lines · `three3d/hdr.js` — 107 lines

The **shared 3D renderer** and the **shipped 3D game boot**. `render3d.js` builds a three.js scene
from AE1 elements + their glbs and keeps it synced (transform, animation clip, per-part visibility,
light params), reading only the components — the SAME module the editor's `viewport3d.js` calls,
so a shipped 3D game renders like the editor (Principle 2). API: `ensureGlb`, `build` (binds, does
NOT frame — callers decide), `update(el)`, `renderFrame`, `frameCamera` (returns `{center,
radius}` so an orbit wrapper can aim its target too), `dispose`. `game3d.js` wraps it with the game
loop, decodes inlined glbs to Blob URLs, and frames once at boot. `setView(el)` drives the VIEW
from a ThirdPersonCamera element during play (YXZ euler); `groundAt(el,x,z,fromY)` is the injected
ground raycast (skinned meshes skipped, self excluded, **floors must face up** — normal.y ≥ 0.5).
More injected geometry (the `env3d` channel, wired identically by both hosts): `boundsOf`
(AABB), `sweepBlocked` (NPC route validation), `clipTime` (attack-clip fraction → projectile
spawn timing), `nodePos` (named child node world position — muzzles), `aimPoint` (view-center
raycast → the §18.16 focal point), `groundInfo` (`{y, el}` — the ground WITH its owning
element, same raycast as groundAt; surface tags like `(groundType …)` are read off `el` by
the footstep machine, §18.20). Debug ink: `applyPath` (cyan routes/trails — geometry
REALLOCATES when a growing trail outruns its buffer) and `applyAim` (warm aim tracer);
`clearDebug()` drops every line — the editor calls it on play exit. `applyAimAssist` (inside
applyMount): a wielded weapon pivots ABOUT ITS GRIP so the barrel (grip→muzzle) seeks the
`model.aimAt` focal — weighted (`aimWeight`), clamped (`aimMaxDeg`), togglable (`aimAssist`),
all live weapon dat. Spawned elements: hosts
rebuild on element-count change and `build()` hands a twice-claimed node a clone
(`spawnClones`), so a fired round renders beside its template.
CAPTURES + THE PORTAL PASS (§18.30): an element with a `camera` component (the
PerspectiveCamera built-in writes one from dat) gets an invisible EYE — `applyCapture`
keeps a `THREE.PerspectiveCamera` + `WebGLRenderTarget` per element (position = element
x/y/z, aim = component normal), `renderCaptures` fills every target before the main
render. A `portal` component (`{a:[x,y,z,nx,ny,nz], b:[…], aCam:"PortalEyeA",
bCam:"PortalEyeB"}` — the gun writes it from `aimPoint`'s surface normal) gets two oval
slots (orange/blue ring + face); each FACE samples its PARTNER's eye by UV with
shader-side gamma (targets skip tone mapping/sRGB — see lessons), visible only when both
portals stand and the cross-wired eye exists. Faces hide while captures render (GL
feedback). Groups are `userData.noAim`, which `aimPoint`'s collector skips — a shot at a
portal must land on the WALL. Both sweeps (portal groups, capture targets) run in build.
MID-BUILD, `groundAt`/`groundInfo` answer null (`buildsInFlight`) — a half-built scene
must not answer geometry questions (the sunken-goober lesson, §18.31).
PORTAL CONTINUITY (§18.32): claimed eyes are re-posed EVERY FRAME in `renderCaptures` as
the play camera expressed through the portal pair (entry-local → 180° → exit-world, play
camera's projection, clip plane at the exit surface) and faces sample screen-space —
correct parallax through the oval. THE HAND HOLDS ONE THING (§18.32): `applyMount` evicts
other mounted meshes from the bone; `build()` sends unclaimed mounted meshes home to
their glb parents (cached glbs let a mount outlive its scene — the ghost-key bug).
World-side (§18.32): `world.carried` (inventory stash across goToScene) renders and ticks
via `orderedElements` and both hosts' element suppliers.
NEAR-PLANE FADING (§18.33): `applyFadeMaterials` (at ensureGlb + on spawn clones) gives
every static mesh a fading material twin (Bayer-discard shader via onBeforeCompile, band
1.2→3.2 m); `applyNearFade` (in update) swaps per element — `(nearFade false)` opts out,
mounted items and skinned meshes exempt. Twins live as DIRECT mesh props (clone()
JSON-mangles userData). CLIP TRIMS (§18.35): `stepTrims` after the mixers enforces
`model.end` — looping clips wrap, one-shots fire onFinished at the trimmed end. HEAD LOOK
(§18.35): `model.headLook [yaw,pitch]` → neck/head split in applyProcedural.
THE USERDATA LAW (§18.36): every object-valued renderer cache (`ae1Parent`, `ae1Grip`,
`ae1Muzzle`, `ae1RightHand`, `ae1Proc`, fade twins, `ae1AimQ`) is a DIRECT property —
never userData (clone() JSON-round-trips it; a stored Object3D is circular and the throw
unbound every element after it). `cloneWithSkeleton` (§18.36) is the spawn-clone path:
SkeletonUtils.clone hand-rolled, rebinding cloned SkinnedMeshes to CLONED bones. AIM
ASSIST is LOW-PASSED (§18.37): the correction quaternion slerps at 0.12/frame
(`obj.ae1AimQ`) so the walk bob stays out of the muzzle.
World-side (§18.38): `world.carriedAux` — projectile templates named by carried weapons
travel between scenes (ticked/rendered/found via world.find + both host suppliers; a
scene's own copy wins). Projectile `(spawnGrace 0.6)` — flight hits inside the first
grace-metres don't count (a muzzle against a mesh must not kill the round at birth), and
the spawn direction uses the §18.36 pushed-out focal (a near hit behind the muzzle flew
the round backwards). ThirdPersonCharacter turns are ALWAYS FORWARD (§18.37, `_turnDir=1`
— reversed playback's hard-cut entry retired). EDITOR (editors.js): `.pane-search`
substring filters on Outliner + Media Collection — display-only, repaint re-applies.
Both live in `three3d/` because they import three.js — **exempt from the 2D bundler** (like
`vendor/`); in a shipped game they arrive through `bundle_modules_3d`'s inlined blob graph, so the
export is ONE double-clickable file. `DESIGN.md §18.8–18.9`.

### `model3d.js` — 131 lines

`AE1Model`, the `(extends Model)` built-in — a 3D character whose skeleton plays clips, driven by
Angel Script. `play("walk")`/`stop()`/`bindPose()`, `onLoad` rests on the idle. Sets the `model`
component's clip; the 3D renderer plays it (the Sprite split). `(animations (idle "…"))` maps
friendly names to real glTF clip names; `(animLibs ("file.glb"))` names glbs contributing CLIPS
only (§18.10). `_aliasList()`/`_libList()` normalise the single-item collapse (`DESIGN.md §18.7`).
State machines are the author's script — nothing here hard-codes states.

### `the motion-matching core †` · `the motion-matching driver †` · `ladder.js` — the motion-matched character

`the motion-matching core †` is the matcher: a **hand-diverged fork** of the motion-matching lab's core
(never re-carve, never lab-publish — see [Motion Matching](06-motion-matching.md)). It owns
the search tables and cost model, the `WEAPONS` family registry
([Weapon-Type Classes](07-weapon-archetypes.md)), root motion + the arc-length loop repair,
inertialization, foot IK + pelvis grounding, the air system (takeoff/fall/land phases,
touchdown hook, double jump, freefall, glide), ladder MODE, and the live `tune` block.
`the motion-matching driver †` is the AE1-owned glue and is **never carved**: input → `mm.update`,
the ladder climb PROTOCOL, item equip/`setCombatWeapon`, `playCombatAttack` + the strike
sweep, traversal sheathe dispatch. `ladder.js` is `AE1Ladder` (BUILTIN `Ladder`): publishes
climb geometry from `rung_NN` sockets; the character does the climbing
([Movement Systems](08-movement-systems.md)).

### `input.js` — 162 lines · `hitbox.js` — 150 lines · `npc.js` — 230 lines · `thirdperson.js` — 950 lines · `projectile.js` — 135 lines · `passivedialogue.js` — 145 lines · `skybox.js` — 56 lines

`scatter.js` (65 lines) is **`AE1Scatter`**, BUILTIN `Scatter` (§18.23): one ARCHETYPE
element, many render copies — `(spawns ((x y z [yaw] [scale]) …))` + `(spawnSnap true)`
(per-copy ground drop). Clones share geometry/materials (render3d `applyScatter`, in build
AND update — first paint is build's inline chain); copies are dressing: no elements, no
collision. InstancedMesh when counts demand it.

`particles.js` (80 lines) is **`AE1Particles`**, BUILTIN `Particles` (§18.22): flame/smoke/
splash/explosion presets bound to a host element + node/socket (+ node-frame offsets) via
the `fx` COMPONENT — its enum gives the Properties dropdown for free. `(fxLoop false)` = an
EVENT: `burst()` bumps a monotonic component counter; weapons auto-burst their hosted
non-looping effects at projectile spawn. The SIM and canvas-generated textures live in
render3d (`applyFx`/`stepFx`/`fxTexture` — zero media files, per-particle size/alpha via a
small point shader, dt clamped).

`musicbus.js` (~170 lines) is **`AE1MusicBus`** (`world.musicBus`, §18.34): the
background-MUSIC layer — Web Audio around a MediaElementSource (no fetch/decode, so
file:// exports keep working via blob: URLs). One source, two branches: dry, and a
WaveShaper bitcrush staircase + lowpass into wet — equal-power crossfaded by the FX
volumes, `setTargetAtTime` smoothed. `want/unwant` (music boxes claim the bus),
`setCrush` (FX boxes report their depth), `dispose` on world stop.

`audiovolumes.js` (~130 lines) is **`AE1AudioBackgroundMusicVolume`** +
**`AE1AudioFXVolume`**, BUILTINs (§18.34): rectangular regions (element transform =
centre/size/yaw), a `volume` component the renderer draws as translucent teal/magenta
boxes (`applyVolumeBox` — authoring ink, `noAim`, hidden with the element). Music box
ticks player-inside → bus.want; FX box ticks closeness → bus.setCrush. Ambience is
renamed **BackgroundAudioAmbience** ('Ambience' aliased) — three audio layers, all
allowed to sound at once.

`perspectivecamera.js` (70 lines) is **`AE1PerspectiveCamera`**, BUILTIN
`PerspectiveCamera` (§18.30): an invisible EYE — dat (`fov/near/far/aspect/captureSize`)
→ `camera` component → render3d's capture kit draws the scene from the element's
position along its `aimAlong(nx,ny,nz)` normal into a private target each frame; any
surface may display it. Portals park one at each oval centre (perpendicular to the
wall); monitors/mirrors are future tenants for free.

`ambience.js` (55 lines) is **`AE1Ambience`**, BUILTIN `Ambience` (§18.19): the scene's
looping background music as a dat-driven element — `(music "file.mp3") (musicFade 400)`,
`_ambBegin` on load, `setMusic("file"|"")` swaps/stops. Rides AE1Audio's MUSIC channel, so
one-shots (dialogue) layer beside it; any element's std-lib `stopMusic`/`playMusic` controls
it scene-wide.

`passivedialogue.js` is **`AE1PassiveDialogue extends AE1Hitbox`** (§18.18): ambient voice by
PROXIMITY — near = the Hitbox volume + `senseRange`, a roll every `passiveCooldown` speaks a
random `passiveLines` entry at `passiveChance` odds (silence is the remainder; no immediate
repeats). `emitVoice(el, name)` tags every line into `world.voices` ({el, audio, base, name})
— exported for reuse; `voiceBusy` enforces ONE voice world-wide; the emitter live-attenuates
`base × (1 − dist/hearRange)`. GC is playSound's own ended/error release + the registry drop.
Dispatches `onSpeak(line)`. Scripted conversation stays dialogue.js's — nothing shared.

`npc.js` is **`AE1NPC extends AE1PassiveDialogue`** (§18.12, §18.21 — every NPC can chat by
proximity via `(passiveLines …)` dat; the builtin runInfo lists `_pvTick` EXPLICITLY, and
passivedialogue.js precedes npc.js in ENGINE_MODULES): wander waypoints + `drawPaths` route
(`debug.path` component → renderer polyline), `health`/`takeDamage` (dispatches `onHit`),
death = TOPPLE + vanish (physics as animation) + the `(deathSounds …)` EVENT tree — always
plays one, no silence roll, never waits for the voice channel. E → `onInteract`. Its walk machine (`_npcAnimate`): `(animLibs …)` +
`(move "file.glb")` play while a leg is underfoot, `(idle …)` at stops — an unset clip pins
`'__bind__'` explicitly, because with libraries attached an EMPTY clip resolves first-anywhere
and a stopped NPC would walk in place; death always rests (the topple is the animation).
Passed-through waypoints stay in 'move' — only a rolled pause switches, else corners flap.
Wander is factored into `_wanderTick` (+ `_drawRoute`, `_findPlayer`) so richer brains can reuse it.

`enemy.js` is **`AE1Enemy extends AE1NPC`** (§18.40 — [Enemy System](09-enemy-system.md)):
the clip-driven combat state machine (`(run)(attacks (…))(hit)(hitBig)(death)` dats on top of
NPC's idle/move), a base-class brain selected by `(aiType "melee"|"friendly")` with
`(friendlyUntilAttacked true)` (provoked-for-life on first `takeDamage`), aggro/chase/leash,
one strike per swing at `attackWindup` inside reach × `attackArc`, cooldown paid at swing END,
hit-reaction staggers, and a clamped one-shot death clip (no clip = NPC topple inherits).
Its `_enemyTick` REPLACES `_npcTick` in runInfo — never list both, or two brains fight.
Enemy clips must be in-place: `bake_enemy_glb.py::strip_root_channels` guarantees it
(own-glb clips are not root-drift-locked; the mixer would stomp the element transform).
Hitbox gained `intersects` (AABB), `damage`, and `hasPhysics`
(v1: gravity + floor in `_hbTick`). `skybox.js` is **`AE1Skybox`** (§18.13): an .hdr sky —
background + IBL via the `sky` component, `setSky`/live `skyOpacity`/`skyRotation`/`skySpin`;
decoding is `three3d/hdr.js`, a hand-rolled Radiance parser (RGBELoader isn't vendored).

The **third-person kit** (`DESIGN.md §18.9`). `AE1Input` is plain DOM: key codes, mouse buttons as
`Mouse0`/`Mouse2`, and **free-look** deltas — no button held: captured (pointer lock) they arrive
on the window; uncaptured, only movement OVER THE CANVAS counts (editor panes stay safe; a
shipped game's canvas is the whole window). Lock refusals (embedded iframes reject silently) are
caught + warned once; free-look covers the gap. Edges (`pressed()`) are one frame wide, closed by
the **game loop's** `onFrame` — never a render tick (two rAF callbacks are two clocks; see
lessons). The wheel arrives as discrete steps (`consumeWheel`).
`hitbox.js` is **`AE1Hitbox`** — an invisible AABB volume via `env3d.boundsOf`, the base for
pickable items (§18.11); dat carries the socket + world-unit mount offsets.
`thirdperson.js` holds three built-ins, all pure math on element fields (no three.js, ships in the
classic bundle): **`Controller`** — the mapping table as dat, editable in Properties, class
defaults when absent; **`ThirdPersonCamera`** — yaw/pitch orbit written to plain transform fields,
applied to the view by `render3d.setView` during play ONLY (the editor keeps its orbit camera);
**`ThirdPersonCharacter extends Model`** — camera-relative WASD, turn-to-face, gravity + jump onto
`world.env3d.groundAt` (injected raycast), singleton per scene (second goes inert, loudly),
dispatches `onPrimary`/`onSecondary`/`onJump`/`onLand`. **Facing is a world yaw composed onto the
rest orientation** via a hand-rolled quaternion kit (`M = Ry(Δ)·M_rest`) — never a bare
`rotationY` write, which spins a baked-rotation armature about a tilted axis (see lessons:
"Walking backwards flipped the character upside down"). **The directional locomotion machine**
(§18.10): states `idle`/`move`/`turn`/`strafeLeft`/`strafeRight`/`backLeft`/`backRight`/`air`
tracked from input pattern + physics; `animate(state)` called on each CHANGE — default plays the
state's dat-named clip (clips addressed by FILE: `"file.glb"` or `"file.glb#Clip"`) or
`bindPose()`. The 180 `turn` is a one-shot: pivot in place, `onFinished` (from the renderer's
mixer) hands over to `move`; alternate reversals play REVERSED (timeScale −1). **During a turn
the CLIP owns all rotation** — the heading holds (origin fwd / target rev), and hand-offs are
**ramps over the `turnBlend` crossfade** (a blend of pure yaw is linear in angle, so the timed
heading lerp cancels it exactly while limbs blend — see lessons: "The turn-around spun her
360°"). Turns are grounded-only; jumps don't fire mid-turn; `air` owns the body until landing;
**`interact`** (E) is an uninterruptible one-shot that owns the body until `onFinished` — and
dispatches `onInteract`. **Items** (§18.11): E in a pickable Hitbox → `pickUp` (hide, inventory,
auto-equip); equip writes a `mount` component → `render3d.applyMount` parents the object to a
host bone (auto-detected right hand or `(sockets …)`); wheel cycles; Shift+E → `dropEquipped`
(0.8 m ahead); `onPickup/onDrop/onEquip/onUnequip` go to the item, `onPrimary/onSecondary`
forward to the equipped item.
Strafes and backward diagonals HOLD the heading — and every state is classified by `rel` (travel
− heading, the movement angle AGAINST THE BODY), never by raw keys: facing the camera, A = her
body-right = the strafe-RIGHT clip. **Mouse-steer**: while moving, a rotating camera
(`cam._lookMoved`) turns the body to camera-forward, replacing travel-facing that frame; still
mouse → directional system; idle → free orbit.
`(animOpts (air (loop false) (startFrame 12)))` tweaks any state's playback
(loop/speed/start/startFrame+fps/fade) — `animOptsFor` normalises the reader's collapses.
Override `animate` in script for a richer machine.

`projectile.js` is **`AE1Projectile extends AE1Hitbox`** (§18.15): a TEMPLATE element that
hides at play start (the Outliner also hides it while a weapon's `(projectile "…")` names it —
editors.js), spawned as fresh rounds by the character's `_projectileCheck` at
`(projectileAt 0.5)` of the attack clip (`env3d.clipTime`; `_projFired` latches one per pull).
`launch(from, dir)` noses the mesh along a full-3D flight (yaw via the quat kit, then pitch
about the yawed right axis); `_projTick` advances speed+acceleration, draws the `debug.path`
trail, deals `damage` to the first `takeDamage`-volume entered (the round hears `onHit` too),
and self-removes at `range`. **The aim triangulation** (§18.16) decides `from` and `dir`:
rounds leave the weapon's `(muzzleNode "SocketMuzzel")` (`env3d.nodePos`) toward
`env3d.aimPoint`'s FOCAL POINT — the camera's view-center raycast (shooter subtree, spawned
rounds, and skinned meshes excluded). `(drawAim true)` draws camera → focal → muzzle
(`debug.aim` → render3d `applyAim`, near end raised 0.3 ABOVE the eye — a view-axis line
projects to a dot; raised, the tracer descends from the top of the view over the character's
head); the trigger pull SNAPS a projectile-weapon wielder's heading to the focal bearing; a
projectile weapon deals no melee sweep damage. Uses `PROJ_DEG` (bundle scope).

### `dialogue.js` — 525 lines

`AE1DialogueDelegate` owns the **conversation** (tree, node, choices, actions);
`AE1DialogueBox` owns the **presentation**. `AE1DialogueChoice` is a spawned Button, never
authored.

> **A choice is a Button in the HUD.** This file adds no input machinery — `loop.pick()` already
> hit-tests and `AE1Button` already dispatches. A DOM overlay would be `pointer-events: none`,
> outside the letterbox, and absent from the editor entirely. See `DESIGN.md §12.7.1`.

- `dlgParseTree()` — `(dialogue …)` → nodes. **Normalises the single-node collapse**: a one-node
  tree arrives shaped differently than a two-node one, because `formValue` collapses a
  single-item rest.
- A conversation ends on the **delegate's** `onUnload`, never the box's — the HUD never unloads.
- `say()` routes here when the project has a box, and **declines mid-conversation.**

### `text.js` — 149 lines

`AE1Text`, the `(extends Text)` built-in. Wrapped, aligned, shadowed glyphs via the `draw()`
hook — the same hook an author has. There is no privileged text pipeline.

Greedy wrap, cached (wrapping measures every word; text changes rarely). System font stacks
only — a webfont means a CDN or a payload, and AE1 ships neither.

### `button.js` — 164 lines

`AE1Button`, the `(extends Button)` built-in. **Extends Text**, because a button *is* text with a
background and a hover state, and a second glyph painter would be a second thing to keep agreeing.

The simple case is zero methods: `(label …)` + `(target "Scene")`. The expert case overrides
`press()` and keeps everything else — Principle 4 in one class.

> Hover swaps `_props.color` directly and puts it back. Mutating dat would journal an edit every
> time the pointer crossed a button.

### `video.js` — 386 lines

`AE1Video`, the `(extends Video)` built-in. A `<video>` drawn with `drawImage`, **not a DOM
overlay** — an overlay sits outside the canvas and cannot be layered under a prompt.

- Cache holds **4**: a decoder is far more expensive than pixels. Eviction drops `src`, because
  pausing alone leaves the decoder alive.
- `(poster N)` — the frame shown **at rest**, for authoring. Play always starts at 0.
- `_seekWhenReady()` — **the only way to seek.** `readyState: 4` does not imply seekable; a raw
  `currentTime` write silently no-ops on a first load. See [Lessons](05-lessons.md).
- Names are prefixed (`videoCache`, `videoKey`) — the export flattens every module into one scope.

### `gesture.js` — 56 lines

First-gesture unlock. Browsers refuse audio and unmuted video until the user interacts, so the
intent is held and fired on the first gesture.

Shared by `audio.js` and `video.js` deliberately: it lived privately inside `AE1Audio`, video
needed the identical eight lines, and **two copies of a rule this subtle are two chances to fix
only one of them.**

### `save.js` — 325 lines

The save envelope. JSON, meant to be opened — same instinct as readable exports.

Built to **grow**: a version number, unknown keys preserved through a round trip (same reason as
`_extra`), and every field outside the envelope optional. Where a save *goes* is the host's
business — the editor POSTs to the server, a shipped game offers a download. Both mirror to
localStorage as the "Continue" slot.

### `savehandler.js` — 175 lines

`AE1SaveHandler`, the `(extends SaveHandler)` built-in. **The engine owns the envelope, the
moment, and the ordering; the handler owns the contents** — because the engine cannot know what
matters in a given game.

In the HUD layer, because it must outlive every scene: a handler rebuilt on each scene change
could not restore the scene it was rebuilt for. State for a scene the player is not in is parked
in `world.pendingSceneState` and applied when that scene loads, *before* its `onLoad`.

### `settings.js` — 127 lines

Per-player preferences. **Deliberately not part of a save**: a save is a moment in a playthrough,
settings are how someone likes their games, and loading an old save must not reset their volume.

localStorage, keyed per game. Legitimately allowed to be lost — clearing browser data resetting
your volume is a shrug; losing a save would not be.

### `media.js` — 132 lines

Decoded-image LRU, count-based, capped at 120. `mediaURL(base, …)` takes a **base**, because
editor and export store media in different places but must resolve it with the same code.

### `audio.js` — 210 lines

`HTMLAudioElement`, not WebAudio — WebAudio needs `decodeAudioData` → `fetch` → blocked on
`file://`.

**Autoplay is blocked until the user interacts.** Music started in `onLoad` fails on the first
scene; the intent is held and fired on the first gesture. One-shots are *not* queued.

**Three effect shapes** (§18.20): `playMusic` (exclusive, crossfades, loops), `play` (one-shot,
self-releasing on ended/error), and `loop` (a looping effect with a caller-owned
`handle.stopLoop()` — footsteps, hums; overlaps allowed; `world.loopSound(name)` resolves
media names).

**Two volume axes.** `musicVolume` (player setting) × `sceneLevel` (per-area, default 1) =
`_musicTarget()`, which every volume path reads. `setSceneLevel()` — surfaced to scripts as
`this.setMusicLevel()` — fades the playing track to a new per-area loudness without touching the
player's preference. `clampVol`, not `clamp01`: the export flattens every module into one scope
and `settings.js` already owns `clamp01`.

### `game.js` — 221 lines

The exported game's boot. Builds a world, letterboxes the canvas, routes input, renders the
dialogue box, exposes `window.AE1`.

**All data is handed in, never fetched.**

---

## `/editor`

### `js/scene-store.js` — 1330 lines

The centre. Project, scenes, HUD, scripts, media, selection, journal, undo, play.

**The biggest file, and the one to read first.** If something in the editor is confusing,
it's usually here.

### `js/workspace/viewport3d.js` — 374 lines

The **3D viewport**, for `game-3d` projects. `mountViewport` delegates here when
`project.type === 'game-3d'` (lazy import, so a 2D session never loads three.js). **All rendering
is `engine/three3d/render3d.js`** — the same module a shipped 3D game uses, so the two cannot
drift (Principle 2): AgX + RoomEnvironment, `frustumCulled=false`, BLEND→alphaTest, transform /
parts / light / animation sync all live THERE. What lives here is editor-only:
**decomposition & merge** (a glb no element represents is unpacked into AE1 elements, one per
top-level node — every element gets a `model` component recording `{media, node}`, lights a
`light` component; never twice), **backfill** (sub-mesh names for the Parts toggles, clip names
for the Animation dropdown), the **orbit camera** (aimed via `frameCamera()`'s returned center),
overlay messages, render-on-demand, and store event wiring. **Play mode**: while the store plays,
the pane IS the game — input attaches to the canvas (pointer lock on click), `world.input3d` +
`world.env3d.groundAt` are wired, the view is the scene's ThirdPersonCamera, and every frame syncs
every element; Stop restores the orbit pose exactly (`DESIGN.md §18.5`–`18.9`).

> **three.js is vendored** (`engine/vendor/three/`, pinned 0.180.0), resolved through the import
> map in `editor/index.html` — never a CDN (Principle 5). `exporter.py` exempts `vendor/` from the
> bundle-membership guard: three.js is loaded on its own, not concatenated. See `DESIGN.md §18`.

### `js/history.js` — 142 lines

Snapshot undo. Bursts coalesce (~450ms), so a drag is one step. Whole-project snapshots
(scene + HUD), 60 deep. Restoring is muted, or it pushes itself back on the stack.

### `js/workspace/area.js` — 366 lines

The Blender area tree. Split/join/maximize.

> **Object identity IS the addressing scheme.** Headers close over their node; `findParent`
> uses `===`. Putting a *clone* in the tree orphans the live header — that cost a silent bug
> where a pane's own Close button did nothing.

Panes are cached by leaf id and reused, so an editor keeps its state when the tree changes.
Divider drags mutate style directly — a rebuild per pointermove would remount every editor 60
times a second.

### `js/workspace/editors.js` — 1456 lines

Every pane: viewport, outliner, properties, media, script, console. An editor is
`{label, mount(el, ctx) -> dispose?}` — that's the whole contract.

**Returning a disposer is mandatory** for anything holding a subscription, observer, or loop.

### `js/api.js` · `settings.js` · `prefs.js` · `ui.js`

The single doorway to the server; durable settings (**server-side**); throwaway session state
(localStorage); DOM helpers, modals, toasts.

### `js/views/` — projects, wizard, workspace, ship

The wizard's steps are **data**, not code paths. Adding one is an entry in `STEPS`.

### `css/theme.css` — 152 lines

**Every colour, size, and duration.** A hardcoded hex anywhere else is a bug.

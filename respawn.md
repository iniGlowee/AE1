# respawn.md

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

**You are picking up AE1 cold.** This file exists so a session that has never seen this
project can be useful within a few minutes. Read it top to bottom before touching anything.

---

## What this is

**AE1 — Angel's Egg 1.** A local, browser-based game engine. Point-and-click adventures first,
architected so other project types slot in without rework.

Austin's goal, in his words: *remove the barrier as much as possible for people and myself
making games.* Simple to the novice, unbounded to the expert. He wants it to be a "reliable
and beautiful application that should last for all time."

He works at a design level and delegates architecture. **He asks for design opinions and
expects real ones** — including pushback. He has been consistently right when he pushes back
(the LISP call, the icons-in-dat call), so take his instincts seriously.

**~15,000 lines of JavaScript**, plus ~2,100 of Python and the CSS. No dependencies in the
browser — with one deliberate exception: **three.js, vendored** (`engine/vendor/three/`, pinned
0.180.0, import-map resolved, never a CDN) for the 3D project type.

---

## MOTION-MATCHING LANDED (2026-08-01) — the matcher is an AE1 character now

The motion-matching engine (the sister project at `…\GameDevelopment\motion-matching` —
read ITS respawn.md before touching the matcher core) drives a playable
character inside AE1. Verified in editor play: she walks the 3d-sandbox-mm
world in motion-matched GASP mocap at 2 m/s, camera follows, ground raycast
feeds the matcher, stops clean.

- **`engine/the motion-matching core †`** — the matcher core (4.2k lines), CARVED from
  motion-matching's play.js by `scratchpad the surgery script`-style marker cuts: lab
  shell (renderer/HUD/fixtures/54-invariant suite) removed, async factory
  `the motion-matching factory †({packs, rig, characterRoot, groundBase})` added. THE LAB
  REMAINS THE SOURCE OF TRUTH — tune there, re-carve here; never hand-diverge
  the core.
- **`engine/the motion-matching driver †`** — `(extends the motion-matching character †)`:
  subclasses AE1ThirdPersonCharacter (keeps every instanceof: camera, audio
  volumes, passive dialogue) but replaces the tick wholesale — no clip state
  machine, no animLibs; the matcher poses bones directly. Lazy init on first
  bound tick (~180 MB of databases fetch async). Element fields mirror the
  driver every frame (that IS the render transform + what the camera reads).
- **Hooks added to BOTH hosts** (game3d.js + viewport3d.js, Principle 2):
  `env3d.objectFor(el)` → the bound THREE object.
- **BUILTINS**: `the motion-matching character †` registered in ags/runtime.js.
- **Project `3d-sandbox-mm`** (+ .ae1proj): clone of 3d-sandbox; player script
  extends the motion-matching character †, dat carries `(mmPacks "<pack> <pack>")`
  + literal media names so the exporter's reference scan keeps them; player
  element wears `hero.glb` (node `UE5_Manny_DEFORM`). Media imported content-
  addressed: hero.glb 177 MB (merged:true) + six db files (~181 MB).

**Lessons paid for:** (1) the 2b armature authors scale 0.01 (cm rig) and
applyTransform stomps node transforms with ELEMENT fields — an element at
scale 1 rendered her a hundred metres tall; the class now SELF-DETECTS cm
rigs from their own anatomy (pelvis ~100 units up vs ~1) and sets the element
scale, so there is no authoring to get wrong. (2) The editor's autosave
stomps direct scene-JSON edits made while that scene is open — close/reload
the editor before disk-editing scenes, or the open session writes the old
values back. (3) REPLAY POLLUTION: editor-play bindings persist across play
sessions, so stopping leaves the bones mid-stride and the next play's driver
would capture a wrecked rest map. `skeleton.pose()` is NOT the cure on a cm
rig — it rebuilds bone locals by decomposing world-space bind matrices,
which smears the armature's authored 0.01 into the bone locals (pelvis gains
scale 0.01, character renders at 1/100 = invisible). The class instead
snapshots the graph's true loaded bind on FIRST init (fresh glb build) into
`obj.userData.__mmBind` and restores that exact snapshot on every later
init — the snapshot rides on the persistent binding. viewport3d's exitPlay
runs the same restore on STOP (the element is torn down with play, so the
host must un-pose the skeleton or the edit viewport freezes mid-stride).
Verified: three
consecutive play sessions, identical pelvis metrics (local ~98.6, world
0.94–0.99 m), clean idle/walk each time. Debug handles: `window.__mmChar`
(element), `window.__mmObj` (bound rig), `window.__mmAE1` (driver api).
(4) GROUND RAY FROM HER OWN HEIGHT OSCILLATES: the driver queries
`groundBase(x, z, charY)` and the lab's ground was an analytic plane, but
AE1's is a raycast — an origin sitting exactly ON the floor she stands on
misses it (fp epsilon), so ground alternated hit/null every frame and the
old `null → 0` fallback teleported the floor to 0: charY square-waved
0 ↔ −0.042 at frame rate ("bouncing while moving"). The wrapper now casts
from `fromY + 0.35` (the driver's own step-up tolerance, so the ray sees
exactly the floors the driver considers standable) and holds the LAST KNOWN
ground on a null answer (void / mid-build) instead of snapping to 0.
Measured after: y flat to the sample across a full walk.

**THE WIELD FRAMEWORK RUNS ON THE MATCHER NOW (2026-08-02).** Pickup (E),
drop (Shift+E), inventory wheel, hand-socket mounting, aim assist and
ON-CALL ACTION CLIPS all work on the motion-matching character † — verified in play
(lance picked/mounted/swung; bazooka equipped via wheel, fired, missile
spawned mid-clip, matcher resumed). How: pickup/equip/inventory are
INHERITED from the old kit untouched; `_mmTick` lifts its aim block; an
action (`_mmActionStart/_mmActionEnd` + onFinished, 6 s safety timeout)
FREEZES the driver (update simply not called) and lets the entry mixer own
the tracked bones — renderFrame runs after the tick, so a playing clip wins
the frame, and release is the new `'__none__'` renderer sentinel
(render3d.js: stop the action, restore NOTHING — `'__bind__'` would flash
the rest pose for a frame). `_modelBegin` must hold `clip: '__none__'` from
load or the empty-clip fallback auto-plays the first library clip. The
clips themselves are `2b_actions.glb` (sword_attack, fire_bazooka),
retargeted from the old Mixamo one-shots by
`motion-matching/tools/retarget_actions.py` — joint-frame DIRECTION matching,
because delta retargeting would carry the T-pose/A-pose rest difference
into every frame. `_mm.setYaw` makes the trigger-pull aim snap HOLD after
the clip (element rotationY alone snapped back on the first resumed frame).

**THE LAB SYNC LOOP** is documented in `motion-matching/AE1-SYNC.md` (read it
before touching the motion-matching core † or rebaking): the surgery script (now in
motion-matching/tools/) re-carves the core from play.js — its NEW_HEAD/
INPUT_STUB/TAIL strings are the AE1-owned blocks, edit them THERE;
tools/publish_ae1.py (or the lab's "Publish to AE1" button, serve.py's
POST /publish) re-carves + refreshes the db packs and action library in the
clone's media. AE1's Projects page links to the lab (port 8010). The lab is
a tool UI (Databases/Tuning/Import & Rebake panels + green viewport debug
overlay); `motion-matching/packs.json` decides WHICH dbs publish and under what
prefix, and new FBX packs arrive via `motion-matching/import/<name>/` (see
AE1-SYNC.md §2b). AE1 SCRIPTS SWITCH DATABASES AT RUNTIME:
`this.setPacks("<pack>")` on a motion-matching character † rebuilds the driver
on the named published prefixes (verified live mid-play) — per-level packs,
cutscene packs, state-dependent movement sets are one call each.

**BUILD & SHIP WORKS FOR THE MOTION-MATCHING GAME (2026-08-02)** — verified
booting AND playing (matcher loads 1296 clips, walk, pickup, swing) over
http and by double-click file://. Three exporter lessons: (1) the DATABASE
PACKS are kind-"other" media and now INLINE like the glbs (game3d's
`world.mediaUrlFor` hands them out as data: URLs — fetch decodes those
natively; the character prefers the hook, the editor host has none and
serves the hashed files over http). (2) V8'S SINGLE-STRING CAP IS ~512 MiB
OF CHARS, not "~1 GiB": the 640 MB data JSON died in JSON.parse and the
page went BLACK WITH NO ERROR. Every inlined asset now ships as ITS OWN
`<script type="ae1-b64">` block — the biggest single asset bounds the
strings, not the game's total; boot collects the blocks without ever
concatenating. (3) The reference scan works unchanged: all 12 dead
player_character libs pruned automatically once no script named them —
nothing to configure, the Build button stays a button. The shipped
index.html is 647 MB (hero.glb + both databases + course); first paint takes
~20 s of decode.

**FOOTSTEPS RUN ON THE MATCHER (2026-08-02), non-destructively:** the old
kit's `_footTick` machinery (surface map from the ground element's
`(groundType …)`, loop lifecycle, touch-only-on-change) is inherited
UNCHANGED; `_mmFootTick` in the motion-matching driver † derives the three
fields its old physics maintained (`_grounded`, `_state`, `_groundEl`) from
the DRIVER's public api — grounded && speed > 0.5 && not air/traversal/
action ⇒ 'move'. The matcher core untouched. Verified: floor loop on the
pavers, live swap to grass at the boundary, silent at rest, SILENCED during
a swing, and the post-stop stride keeps sound until the feet actually stop.

**Honest edges (v1):** interact/grab one-shot not baked for the player character (pickup is
instant); footstep cadence is the authored loop, not per-plant one-shots
(the driver's `ikState` plant edges are there when per-step sounds arrive);
traversal AABBs come only from elements tagged `mmbox` (none tagged yet —
vaulting is loaded but has nothing to vault); fingers/twists hold rest
during action clips; db fetch happens per play (content-addressed =
browser-cached after the first).

---

## THE DOCS TAB (2026-08-02) — a markdown reader with deep links

`editor/docs.html` (the topbar's **Docs** button, its own tab) renders the
repo's markdown: guide + engine docs (`docs/**`, now a static root),
DESIGN.md/respawn.md (named root allowlist — a reader for OUR docs, not a
file browser), and the motion-matching manuals straight off the lab server
(:8010 sends CORS for exactly this page). Self-contained: its own ~100-line
renderer (fenced AND 4-space-indented code, tables, lists, blockquotes),
GitHub-style heading slugs, and the deep-link scheme every tool uses:

    /editor/docs.html?doc=<key>#<heading-slug>

Keys live in the REGISTRY at the top of docs.html (curated + grouped, not
scanned). Cross-doc `.md` links inside documents route through the viewer
automatically; externals open a new tab. FIRST LIVE DEEP LINK: the lab's
Import & Rebake note → `?doc=mm-sync#2b-adding-a-pack-…` — the pattern for
wiring any tool help text to its manual section.

---

## GAMEPAD INPUT (2026-08-02) — the lab's controller support is engine-wide

`AE1Input` polls the browser Gamepad API (no library): pad buttons fold into
the SAME code system as keys (`PadA PadB PadX PadY PadLB PadRB PadLT PadRT
PadSelect PadStart PadLS PadRS PadUp/Down/Left/Right`; triggers count held
past 40%), and a mapping string may name ALTERNATIVES, space-separated —
`(jump "Space PadA")` — any held one fires. Sticks: `input.stick()` (left,
deadzone WITH HYSTERESIS — engage 0.20 release 0.12, the lab's lesson: a
single threshold chatters at a resting thumb and every flip forces a
re-match) and `input.lookStick()` (right). Poll is lazy-once-per-frame,
re-armed by endFrame().

**The Controller element owns the toggle**: `(gamepad true/false)` dat —
`ctl.gamepad = false` from any script kills pads live (the keyboard/
controller switch a settings menu exposes), `padLookSpeed` = camera deg/s at
full right-stick. Consumers re-read every tick: the camera orbits on the
right stick, BOTH characters merge the left stick into their move axes (the
motion-matching character passes the ANALOG deflection through — she walks at
half stick because `amount` feeds the gait bands), run = LT/stick-click,
crouch = B, dpad up/down cycles the inventory alongside the wheel.

Verified with a synthetic `navigator.getGamepads` shim in editor play: half
stick walk 2.0 m/s, LT run 4.99, right stick 180°/s orbit exact, PadA jump
(air → 1.01 m → land), toggle-off deadens a hard-forward stick to 0.0 and
toggle-on resumes — all live, no reload. TRAP FOUND ON THE WAY: a scene's
own Controller dat OVERRIDES class defaults (as designed), so old projects
pin `(jump "Space")` and pads look dead — both sandbox projects' controller
scripts now carry the pad alternatives. A physical pad still deserves a
hands-on pass (axis signs on non-Xbox pads, browser mapping quirks).

---

## The state of things

**The full loop works, end to end, verified:**

```
server.ps1 → Projects → Wizard → Workspace
                                   ├─ import media
                                   ├─ place elements
                                   ├─ attach Angel Scripts
                                   ├─ ▶ Play
                                   └─ Build & Ship → a game that plays by double-click
```

Built and working: the launcher, server, project list, wizard, the Blender-style area system,
the element/scene model, continuous journaling, the **Angel Script compiler** (with real
`super`), the scheduler and game loop, **play mode** with snapshot/restore, the **Media
Collection**, **build & ship**, the **persistent HUD layer with an Inventory**, **scene
navigation**, **audio**, and **undo/redo**.

**The 3D project type (`game-3d`) is a working GAME now** — render, decompose, animate, a full
third-person character with directional locomotion and mouse-steer, items with bone-socket
mounting, weapon combat against wandering NPCs, and a double-clickable single-file export.
The whole arc: `DESIGN.md §18.1–18.12` and the sections below. **Not built:** snapshots
(the Save-as-version feature).

**Also built and verified** — each of these came out of Austin's front-end project, then of the
three features he asked for after it. Nothing below is in progress:

- ✅ **Text** (`engine/text.js`, built-in `Text`). Wrapped, aligned, shadowed. Verified in the
  editor *and* in an export.
- ✅ **Video** (`engine/video.js`, built-in `Video`). Autoplay with gesture-unlock, `onEnded`
  → `goToScene`. Verified in an export with text layered over it. See also **Video in the
  editor**, below.
- ✅ **Button** (`engine/button.js`, built-in `Button`, extends Text). Hover, `press()`,
  `(target "Scene")` needs no code. A hamburger draws its own bars via `draw()`.
- ✅ **Saves** (`engine/save.js`). **"Save" means two unrelated things here — don't conflate
  them** (full table: `DESIGN.md §16` top):
  - **Project journaling** persists the *developer's work* (scenes, HUD, scripts) continuously
    as they edit. Automatic, not opt-in, its whole job is that authored work is never lost. The
    "Saved" indicator reports *this*.
  - **Player saves** (this bullet, `save.js`) persist a *player's playthrough* in a shipped
    game. Different files, different trigger, different lifetime — they share no code, and play
    mode does not journal, so a game's save feature can't rewrite the project being built.

  The player-save envelope is extensible: timestamp + scene + the author's open
  `data` bag. Editor writes `/projects/<slug>/saves/` silently; a shipped game **downloads** the
  file (no server exists) and both mirror to localStorage as a "Continue" slot. Loading is
  always a file picker. Austin's call, and a good one: external save files are moddable, which
  is the same instinct as readable exports.
  **Not yet saved: the inventory and per-scene state.** Deliberate — "decide later". The
  envelope is built to grow (unknown keys survive a round trip).
- ✅ **Settings** (`engine/settings.js`). Its own localStorage slot, keyed per game —
  **deliberately NOT in saves**: a save is a moment in a playthrough, settings are a preference,
  and loading an old save must not reset someone's volume. Engine reads musicVolume /
  soundVolume / muted; everything else is the author's open bag.
- ✅ **The front end is complete.** Splash → Intro (video, hover-to-skip) → Main Menu (looping
  muted video + hamburger) → New Game (Start writes a save) / Load Game (Continue + Load from
  file) / Settings (live rows, +/- buttons, mute, reset) / Credits (paragraph). All seven
  scenes verified in a shipped export.

- ✅ **SaveHandler** (`engine/savehandler.js`, built-in `SaveHandler`). A world-level element in
  the HUD layer with `capture(save)` / `restore(save)` hooks the save routine invokes. **The
  engine owns the envelope, the moment, and the ordering; the handler owns the contents** —
  because the engine cannot know what matters in a given game. Helpers for inventory, scene,
  and HUD capture. State for a scene the player is not in is parked in
  `world.pendingSceneState` and applied when that scene loads, *before* its onLoad.
  Deliberately expandable — Austin called this a tutorial/dev effort.

- ✅ **Spritesheets** (`engine/sprite.js`, built-in `Sprite`; `frameGrid`/`frameRect` in
  `renderer.js`; `COMPONENT_SCHEMA` in `element.js`). **The frame is data, the animation is
  behaviour** — the frame lives in the `sprite` component and the *default* renderer path draws
  it, so any element can show frame 4 of an atlas from Properties. `(extends Sprite)` adds only
  the motion: clips, `fps`, `play`/`stop`, `onFinished`.
  **`AE1Sprite` is the one built-in with no `draw()`, deliberately** — staying on the default
  path is what gives it rotation, flip and opacity for free. `DESIGN.md §5.3.1`.
  Verified: 8/8 frames draw the right pixels, out-of-range wraps, clips stay in range, and the
  **exported game agrees with the editor pixel for pixel**.
  This also gave the Properties panel its first ability to edit components at all.

- ✅ **Dialogue trees** (`engine/dialogue.js`, built-ins `DialogueDelegate` + `DialogueBox`).
  **The delegate owns the conversation; the box owns the presentation** — the SaveHandler split
  again. The tree is dat, in LISP, so it needs no new parser and ships loose for modders.
  **A choice is a Button in the HUD**, so this added *no input machinery at all*: `loop.pick()`
  and `AE1Button` already do it. `(extends DialogueDelegate)` + a tree = clicking a character
  talks, with zero code. `(does method)` on a node is how a conversation changes the game.
  **say() now draws in the box when the project has one**, falling back to the old DOM line /
  Console when it doesn't. `DESIGN.md §12.7`, `docs/guide/10-dialogue.md`.
  Verified: a full conversation clicked through in the editor *and in a shipped export* —
  same nodes, same choices, item granted, clean exit.

- ✅ **Video in the editor** (`(poster N)` dat on `Video`; the transport in `mountViewport`).
  Video always played during Play — the gap was *authoring*: the editor draws on demand, so a
  video sat on frame 0, and frame 0 of an intro is black. Select a video and get ▶/⏸, a
  scrubber, and **Set poster**, which writes `(poster 3.5)` into dat — the UI writing data the
  script owns. **Authoring only: Play always starts at 0**, and stopping Play returns to the
  poster. `DESIGN.md §12.5.1`.
  This forced two engine fixes: **`defineDatAccessor` now walks the prototype chain** (a
  subclass was shadowing every custom accessor a built-in defined — no built-in could have a
  reactive dat key), and **all seeking goes through `_seekWhenReady`** (`readyState: 4` does not
  imply seekable).

**Austin's original brief is fully built, and so is everything he has asked for since.** Next
work is his to choose.

### What Austin asked for, in the order he asked

1. ✅ **Spritesheets** — done, above.
2. ✅ **Dialogue trees** — done, above.
3. ✅ **Video in the editor viewport** — done, above.

### The two format traps, and why they keep biting

The greedy reader (stop at the first non-`(` token) is what lets the format need no delimiter.
It also creates two mistakes that are *natural* to make, and I made each of them repeatedly
while writing the built-in templates — **knowing the rule**:

1. **`(runInfo …)` beside its method.** Everything after the first `function` is JavaScript.
2. **`;` comments in the methods section.** `;` is LISP; `//` is JavaScript.

Both now produce a diagnostic naming the mistake (`STRANDED_RE`, `LISP_COMMENT_IN_JS_RE` in
`ags/compiler.js`). **If you write an AGS template and it fails to compile, read the error —
it is almost certainly one of these two.**

**The `front-end` project on disk is the working front end**: Splash → Intro (video) → Main
Menu (looping video + hamburger) → New Game / Load Game / Settings / Credits. Built with
placeholder ffmpeg videos; Austin will swap in real assets. The New Game / Load Game / Settings
/ Credits scenes exist but are **empty** — they are where the next work goes.

There is a `south-park` demo project on disk — three characters, a key, a door, a scene
change. It's a test bed, not the point. Austin has said explicitly it is **not** the focus.

The **`3d-sandbox`** project IS the 3D project type's living demo — and Austin is actively
building it into a real place. **Current cast** (20 media files, ~25 elements): character
**"the player character"** (`player.ags.txt`, extends ThirdPersonCharacter — full locomotion clip set + jump +
interact + attack), hero **"Companion"**, **"Villager"**, **"Enemy"** (extends NPC, the machine
enemy), **"Lance"** (weapon, damage 50) + **"key"** (non-weapon) pickables,
**"Skybox"** (`PSX_NIGHTSKY.hdr` — the world is NIGHT), Camera, Controller, and a furnished
PSX-style plaza: tiled floor (`sampleFloor`), grass (`ForestFLoor`), office set
(`scene1_map_details`: desk, couch, bookcase, whiteboard reading "EDITABLE!") — much of it
currently hidden via the Outliner while he arranges. The scene renders live via the
**three.js viewport** (`editor/js/workspace/viewport3d.js`, chosen by `mountViewport` for 3D
projects); console handle: `document.querySelector('.viewport-canvas').__r3d`. **three.js is vendored** at `engine/vendor/three/` (pinned 0.180.0, MIT),
resolved through an import map in `editor/index.html` — never a CDN. Two increments done: **render-first** (the glb renders) and **decomposition** (the glb becomes AE1
elements). Each top-level glTF node is now a real AE1 element — Cube/Plane with a `model` component,
Light with a `light` component — shown in the Outliner, editable in Properties, and **bound** so
moving an element moves it in the viewport. The transform is 3D on the base element (`z`,
`rotationX`, `rotationY`, `scaleZ`; `rotation`=Z; hidden in 2D via a `dim` marker; 2D stays
byte-compatible). The viewport now loads **multiple glbs**, **merges** a newly-dropped `.glb` into
the current scene (its objects join as elements, nothing removed), and plays **animation** — an
`AnimationMixer` per animated glb plays the clip the element's `model` component names (empty =
first clip = idle, so a character rests with no script); `this.playAnimation("walk")` drives it
from Angel Script. Verified with an 18 MB Mixamo/the reference action game character (65 bones, idle clip, textures) merged
into `scene-1`. **Render fidelity** matches Blender now: AgX tone mapping, a procedural
`RoomEnvironment`, `frustumCulled=false` on skinned meshes (else parts vanish by camera angle),
and a **BLEND→alphaTest** rescue for models exported all-transparent (else everything shows through
everything). Ripped models ship duplicate/alternate meshes with no "priority" flag, so the Model
component has a **Parts** show/hide list (`model.parts`/`model.hidden`) to drop the extras in-engine.
Also built (`DESIGN.md §18.7`): **`AE1Model`** (`engine/model3d.js`, `(extends Model)`) — scripted
animation (`this.play("walk")`, onLoad→idle) with friendly clip aliases; **clip-name discovery** (a
dropdown of the glb's real clips in the panel, so nobody types `Armature|mixamo.com|Layer0`); and
**live lights** (a `light` component now drives its three.js light — edit colour/intensity/cone and
it changes). The **shipped 3D game** is COMPLETE and keeps the double-click promise
(`DESIGN.md §18.8`): the renderer is `engine/three3d/render3d.js`, SHARED — the editor's
`viewport3d.js` *calls* it (only decomposition, backfill, orbit camera, and store wiring are
editor-side) and `game3d.js` wraps it with the game loop, so editor and build cannot drift
(Principle 2). The export is ONE self-contained `index.html`: `bundle_modules_3d` in `exporter.py`
(Python stdlib — no Node) walks the ES-module graph from `game3d.js` (28 modules: three.core,
three.module, addons, engine), topo-sorts it, and inlines `{order, deps, modules}` as JSON; at
boot the page rewrites each `from 'spec'` to a Blob URL, leaves first, and
`await import(entryBlobUrl)` — because `file://` blocks fetching module FILES but happily runs an
inline module that imports `blob:` URLs. glbs are inlined base64 → Blob URLs the same way.
**Verified ON `file://`:** boots, binds 4 elements, `AE1Model.onLoad` plays the idle, mixer
advances in real time, frame renders matching the editor. Also fixed: the exporter's Pillow
warning fired when *no image happened to shrink* — it now checks whether Pillow is actually
missing.

**The third-person kit is built and verified in play mode** (`DESIGN.md §18.9`,
`engine/thirdperson.js` + `engine/input.js`): `Controller` (mappings as dat, editable in
Properties, `+Ctrl` button in the Outliner), `ThirdPersonCamera` (mouse-look orbit, the PLAY view
only — the editor viewport keeps its orbit camera and restores it on Stop; auto-created when a
character script attaches), and `ThirdPersonCharacter extends Model` (camera-relative WASD,
turn-to-face, gravity + edge-triggered jump onto `render3d.groundAt`'s raycast — floors must face
UP — singleton per scene, dispatches `onPrimary`/`onSecondary`/`onJump`/`onLand`). GROUND SNAP
`(snapDown 0.5)`: while grounded, floor within the tolerance below is still floor — feet follow a
downhill grade instead of machine-gunning fall-clip restarts + onLand every frame (lessons:
"Slopes machine-gunned the landing"); only a drop past it falls. All pure math
on element fields, no three.js, ships in the classic bundle. The demo: `projects/3d-sandbox` has
**`player_character.glb` (183 MB, armature, textures, NO clips — T-pose is correct)** unpacked as
element "Player" with `player.ags.txt` `(extends ThirdPersonCharacter)`, plus Camera + Controller.
Verified numerically in editor play: exact jump arc, landing on the cube top at y=1.00, falling
off edges, `onLand`/`onPrimary` reaching the script, Stop restoring everything. **Facing is a
world yaw composed onto the rest orientation** (quat kit in thirdperson.js) — Austin caught the
character flipping upside down walking backwards, because this armature ships `rotationX 90`
baked and a bare rotationY write turns about a tilted axis. Verified upright in every direction
BY SCREENSHOT — numbers alone hid this once (lessons: "Walking backwards flipped…").

**The animation state machine v1 is live** (`DESIGN.md §18.10`): `(animLibs ("file.glb"))` pulls
CLIPS from other glbs (meshes ignored — never decomposed, hidden, unwalkable), clip resolution is
own-glb-then-libraries with empty = first-anywhere, and `ThirdPersonCharacter` tracks
`idle`/`move`/`air`, calling `animate(state)` on change — default plays the state's dat clip
(`idle`/`move`/`air` keys) or `bindPose()` (the `'__bind__'` sentinel; the renderer restores a
load-time REST SNAPSHOT, never `Skeleton.pose()` — that vanished a scaled character, see
lessons). The demo: `player_character_idle.glb` (175 MB) is the Player's library; she idles in
the editor AND in play, T-poses while moving/falling, idles again on stop/land. Verified by
screenshot at every state.

**Directional locomotion is COMPLETE** (`DESIGN.md §18.10`): seven `animOnly`-flagged library
glbs (the "Anim" pill in the Media Collection — a flagged glb never merges as elements and never
renders; rule: a glb renders only while some element uses it as its model). Clips are addressed
BY FILE (`(move "player_character_walk_forwards.glb")` — all Mixamo clips share one name);
library clips get root drift locked (ground-plane position tracks pinned; physics owns position).
States: `move` (turn-to-face), the one-shot 180 `turn` (onFinished → move; alternate reversals
play REVERSED, timeScale −1), `strafeLeft/Right` + `backLeft/Right` (heading HELD — the body
fronts its line), `air`, `idle`. **States are classified by the movement angle RELATIVE TO THE
FACING (`rel` = travel − heading), never by raw keys** — facing the camera, A is her body-right
(strafe-RIGHT clip) and S+A is a body-forward diagonal (walk); key-based selection was wrong the
moment she turned around (Austin caught it). Verified with the full both-facings × all-inputs
matrix and by screenshot.

**The turn no longer double-rotates OR snaps** (Austin caught both, then caught the fix's fix):
a turn clip carries ROOT ROTATION, so during 'turn' the heading HOLDS (origin fwd / target rev)
and the CLIP rotates. Hand-off rules, hard-won: **exits ramp over `turnBlend`** (dat, 0.25 s —
a blend of pure yaw is linear in angle, so the timed heading lerp cancels the fading root yaw
exactly while limbs crossfade); **forward entry fades** (start pose un-turned); **reversed entry
is a HARD CUT** — its start pose sits 180° away and a quaternion blend at exactly 180° picks an
arbitrary hemisphere (it stacked with the entry ramp into a fresh spin). Also: turns are
grounded-only and jumps can't fire mid-turn — W/S mid-air no longer interrupt the jump clip.
`fade` is a playback option everywhere. Lessons: "The turn-around spun her 360°".

**The jump is wired** (`player_character_jump.glb`, animOnly-flagged by Austin himself — the
pill workflow held on first real use, zero strays): `(air "player_character_jump.glb")` +
`(animOpts (air (loop false) (startFrame 0)))`. `animOpts` is the general per-state tweak
surface (loop/speed/start/startFrame+fps); `playAnimation` carries `start` onto the model
component ("Start (s)" in Properties) and the renderer restarts on a REQUEST KEY, so finished
one-shots hold instead of re-firing. Verified: jump plays once, re-jump replays, land → idle.

**Mouse-steer + play-mode pointer** (`DESIGN.md §18.10` tail): while MOVING, an
actively-rotating camera turns the body to camera-forward (steer replaces travel-facing that
frame; still mouse → directional system; idle → free orbit untouched). Editor play hides the
cursor and Esc backs out (Esc frees the locked mouse — browser-reserved — Esc again stops play,
`onPlayKey` in viewport3d).

**Item-authored SOCKETS + per-weapon attacks** (`DESIGN.md §18.14`): Blender Empties parented
to a mesh export as child nodes — `(gripNode "SocketRightHand")` (or Socket*Right*Hand
auto-detect) aligns THAT node's frame onto the hand bone, replacing manual offsets (bazooka sat
right at all-zero offsets). `(attack "file.glb")` on the ITEM overrides the character's attack
clip while wielded (bazooka fires fireBazooka.glb; lance falls back to the sword swing).
SocketLefthand is recorded but two-hand hold needs IK — future. Demo: bazooka-2.ags.txt
(damage 90, gripNode, attack; Austin re-imported the glb with a muzzle socket — the element's
script is now bazooka-2.ags.txt, the old bazooka.ags.txt is an orphan file).

**PROJECTILES are live** (`DESIGN.md §18.15`, `engine/projectile.js`, BUILTIN `Projectile`):
a mesh element `(extends Projectile)` is a TEMPLATE — hides itself at play start, and the
OUTLINER hides it in edit mode while a weapon names it (`(projectile "MIssile")` — hidden not
removed; un-name to get it back; its script stays editable on disk). The weapon fires at
`(projectileAt 0.5)` of its attack clip via `env3d.clipTime`; ONE round per trigger pull
(`_projFired`); the round is `new tpl.constructor(tpl.serialize())` + `_spawned` +
`scene.add()`. Both hosts REBUILD on element-count change, and `build()` clones a glb node
claimed twice (`spawnClones`) so template + round both render. Flight: speed/acceleration/
range/damage/drawPaths/faceOffset dat, straight 3D line, first damage-taker volume hit →
`takeDamage` + the round's own `onHit`, range → self-remove. A projectile weapon deals NO
melee sweep damage (the round carries it — point-blank used to double-dip). Demo:
missile_projectile.glb → element "MIssile" (`missile-2.ags.txt` — note BOTH spellings are
Austin's: element "MIssile", glb node "missle").

**The AIM TRIANGULATION is live** (`DESIGN.md §18.16` — the gun/grenade/throwable baseline):
rounds spawn AT the weapon's `(muzzleNode "SocketMuzzel")` (another Blender-Empty node,
`env3d.nodePos`, /muzz/i auto-detect) and fly toward the CAMERA FOCAL POINT —
`env3d.aimPoint` raycasts through the exact view center (excludes shooter subtree, spawned
rounds, skinned meshes; first static hit else `aimDist` out). `(drawAim true)` on the
character draws the warm-orange camera → focal → muzzle tracer live (`debug.aim` →
`applyAim`; the camera leg starts 0.3 ABOVE the eye so the tracer DESCENDS from the top of
the view over her head — a view-axis line projects to a dot). **Lines draw ONLY while a
projectile weapon is wielded**, and `aimPoint` prunes candidates BEFORE the raycast —
post-filtering skinned hits paid a per-vertex CPU skinning pass on the character every tick
(the "slow until you pick up the bazooka" bug; see lessons).
At the trigger pull of a projectile weapon she SNAPS heading to the focal bearing (melee
keeps facing). **AIM ASSIST**: the wielded mesh pivots ABOUT THE GRIP so the barrel seeks the
focal — priority: grip anchors position, muzzle steers, left hand ignored; weapon dat
`(aimAssist true) (aimWeight 0.75) (aimMaxDeg 30)`, all live in Properties. The clamp keeps a
shoulder carry a carry; the leveled fire pose lands on the line. Play-exit calls `r3d.clearDebug()` — routes/trails/tracers never linger into
edit mode. **Never render mid-build**: `r3d.build()` is async and a half-built scene piles
every node at its raw glb origin — both hosts hold the last good frame while a rebuild is in
flight (play entry + spawn recounts) and draw only after a full update pass.

**PASSIVE PROXIMITY DIALOGUE is live** (`DESIGN.md §18.18`, `engine/passivedialogue.js`,
BUILTIN `PassiveDialogue extends Hitbox`): stand `(senseRange 3)` beyond a character's volume
and it MAY speak one of `(passiveLines (…))` — `(passiveChance 0.6)`, the rest is silence by
design; `(passiveCooldown 8)` paces rolls (runs while away too — boundary-dancing can't
spam); no immediate line repeats. Voices are TAGGED in `world.voices` ({el, audio, base,
name} — `emitVoice`/`voiceBusy` exported for reuse): ONE voice world-wide, and the emitter
attenuates live — `base × (1 − dist/hearRange)` (walk away, he fades). GC rides playSound's
ended/error cleanup; the registry drops the tag the same moment. `onSpeak` RUN_INFO
dispatches the line name. 3D exports INLINE audio (mp3/ogg/wav/m4a) like glbs — game3d
overrides `world.audio.url` hash→name→Blob URL. Demo: "the companion character" (renamed from 92;
armature.ags.txt extends PassiveDialogue; his idle clip persists on the scene's model
component, no Model script). Verified: lines/no-repeat/no-overlap/silence live; the
walk-away trace matched the falloff formula exactly. Scripted conversation stays
DialogueDelegate's — passive shares nothing with it, deliberately.

**PORTALS ARE LIVE — the Scene 3 room** (`DESIGN.md §18.30`): kill the goober → 3 s → Scene 3
(scene-3.json, HAND-AUTHORED; forged big-white-room `room1.glb` + forged `portalgun1.glb`).
The GUN (portalgun.ags.txt, plain Hitbox, `isWeapon false` so clicks don't swing — but full
bazooka wield dat: glb-authored `SocketRightHand`/`SocketMuzzel` via meshforge's new
`"sockets"` feature, gripNode/muzzleNode/aimAssist/mountOffsetY 180; `armed` in
ThirdPersonCharacter = "fires rounds OR declares a muzzle", so it aims like the bazooka with
no template round while the lance stays raycast-free): wielded LEFT click = orange portal,
RIGHT = blue, placed at `aimPoint` — which also returns the surface normal (nx/ny/nz).
THE VIEW MODEL IS AUSTIN'S: a new BUILTIN base **PerspectiveCamera**
(`engine/perspectivecamera.js` — invisible eye; dat fov/near/far/aspect/captureSize;
`aimAlong(nx,ny,nz)`; render3d `applyCapture`/`renderCaptures` fill a private target per
frame; ANY surface can display any eye — monitors/mirrors come free). The gun parks hidden
eyes `PortalEyeA/B` (portaleye.ags.txt, aspect 0.63 = the oval) at each oval centre aimed
along the wall normal — the PERPENDICULAR view out — and writes `aCam/bCam` names into the
`portal` component; each face displays its PARTNER's eye (what you'll see after stepping
through), UV-sampled with shader-side gamma (render-to-target skips tone mapping + sRGB).
Faces hide while captures render (GL feedback loop otherwise) and open only when both
portals + the cross-wired eye exist. (The first attempt mirrored the play camera through
the portal frames — mathematically the classic trick; its `matrixWorldInverse`-by-hand
lesson survives in 05-lessons.) Walk-through = the gun's `warpTick`: chest within ~1 m of
an oval → out 1.2 m along the other's normal, heading snapped to exit normal; the ARMED
latch (re-arm only after stepping clear of BOTH) kills ping-pong — a plain cooldown CANNOT,
because you LAND inside the exit's own trigger. Portal groups are `userData.noAim` (a shot
at a portal hits the WALL); portals + eye targets die in the build sweep. Verified: sockets
mount straight, perpendicular through-views live (the player character visible in the far eye), blue→orange
hop, no-bounce, round trip.

**AMMUNITION TRAVELS + SPAWN GRACE** (`DESIGN.md §18.38`): goToScene stashes projectile
templates named by carried weapons in `world.carriedAux` (ticked/rendered/findable like
carried, NEVER inventory; scene's own copy wins — the travelling twin drops);
`_projectileCheck` + `world.find` search aux. Proven by DELETING scene-3's hand-copied
MIssile and live-firing a travelled round. The tree no-fire was TWO bugs, both fixed: the
spawn direction used the raw focal (a hit beside the lens sat BEHIND the muzzle →
`focal − muzzle` pointed backwards) — the §18.36 push-out now applies at spawn; and
`(spawnGrace 0.6)` on Projectile — hits inside the first grace-metres of flight don't
count, so a muzzle pressed against a mesh doesn't kill the round at birth (point-blank
large targets still land: they outlast the grace).

**THE POLISH PASS** (`DESIGN.md §18.37`): Outliner + Media Collection got substring
FILTER boxes (`.pane-search` in editors.js — display-only, hides rows/tiles, repaint
re-applies); scene-3.json carries its own MIssile template (ammunition is a scene element
— no template, no spawn; consider templates auto-travelling with carried weapons later);
aim-assist delta is LOW-PASSED (~150 ms slerp, direct prop) so the walk bob stays out of
the muzzle; turns play ALWAYS FORWARD (`_turnDir = 1` — reversed playback's hard-cut
entry read as a snap; alternation retired, machinery dormant). DEFERRED by Austin: rounds
sometimes not spawning when firing at very-near meshes (trees).

**THE USERDATA LAW + THE BUG-HUNT ROUND** (`DESIGN.md §18.36`, lessons "userData is a
JSON grave"): NO Object3D/Material EVER in userData — clone() JSON-round-trips it; a
stored Object3D is CIRCULAR and the throw killed the claim pass mid-loop, unbinding every
later element (the REAL invisible-weapon bug; all ae1* object caches are DIRECT props
now). `cloneWithSkeleton` rebinds cloned SkinnedMeshes to CLONED bones (a carried lance's
clone rendered at the RACK lance's armature). A focal NEARER than the character is pushed
out along the camera ray (+3 m past her) before assist/lines/snap — the camera looking AT
her had the assist bending the barrel at her knees; the gaze clears HARD on the trigger
snap (no more head spin against the fire clip). `musicBus.sceneChange()` in goToScene —
the crushed music no longer follows the player through the door. Editor truth after Stop:
volume boxes duck-typed off class methods + drawn in build; scatter keeps last placement
when ground is unanswerable (no more floating palms). Known minor: fresh-load volume
boxes may not draw until first Play.

**NEAR-PLANE FADING** (`DESIGN.md §18.33`): static meshes DITHER OUT near the camera
(Bayer discard injected into every glb material at load; per-fragment so only the near
part of a wall fades; band 1.2→3.2 m tuned to the camera boom). Default ON everywhere,
`(nearFade false)` opts out; skinned meshes and WIELDED items exempt. Material twins are
DIRECT props on meshes, never userData (clone() JSON-mangles userData — that broken
intermediate shipped briefly and made carried clones invisible). Two aim/feel fixes ride
along: heading snap at the trigger uses the CAMERA→focal bearing (a hit nearer than the
character used to spin her backwards), and `_groundHit` only walks glb scenes (volume
boxes/portal ink can never become floors).

**THREE AUDIO LAYERS + THE FX ILLUSION** (`DESIGN.md §18.34`): Ambience renamed
**BackgroundAudioAmbience** ('Ambience' aliased); NEW **AudioBackgroundMusicVolume** /
**AudioFXVolume** base elements (engine/audiovolumes.js — translucent teal/magenta boxes
shaped by ordinary transform Properties, authoring ink only) + **engine/musicbus.js**
(`world.musicBus`): Web Audio WITHOUT breaking file:// (MediaElementSource around an
<audio>; blob: URLs in exports are same-origin). Music box = player-inside plays
`(music …)` on the bus; FX box = equal-power dry/wet crossfade into a WaveShaper
bitcrush + lowpass — ONE source, two branches, so sync/phase problems are architecturally
impossible (Austin's ask, answered structurally). All three layers play simultaneously by
design; voiceLine's one-voice rule stays per-element, never cross-layer. Demo wired in
scene 1 (MusicBox plaza-wide, FxBox at the sign) — verified live including bus stop/resume
at the region edge. TRAP: editing scene JSON on disk while the editor is OPEN gets
clobbered by journaling (park the editor first), and PowerShell utf8 writes a BOM the
server's json.loads rejects — write BOM-less.

**MOVEMENT FEEL** (`DESIGN.md §18.35`): `(turnMove 0.5)` keeps momentum through the 180
pivot, `(turnMaxTime 0.4)` caps it (forced exit = the clip-finished hand-off);
`(animOpts … (end/endFrame))` trims clip tails (render3d `stepTrims` wraps loops / fires
one-shot finishes at the trimmed end; also `playAnimation({end})`); HEAD LOOK — character
publishes `model.headLook [yaw, pitch]` clamped `(headLookMax 60)`, procedural layer
splits neck 35 / head 65, all ramped. Real transition quality = future authored blend
graphs; these are the mechanical 80%.

**POCKETS OUTLIVE SCENES + TRUE PORTAL CONTINUITY** (`DESIGN.md §18.32`): inventory now
PERSISTS across scenes — `goToScene` stashes the outgoing character's `_inv` (the element
instances) in `world.carried` and the incoming character adopts it (`equipIndex` re-issued →
mount snapshots against the new armature); carried items tick + render via `orderedElements`
and both hosts' element suppliers; `(keepAcrossScenes false)` opts out; menu scenes leave the
stash alone; `world.stop()` clears it. `pickUp` REFUSES duplicate names (`(stackable true)`
opts out — GUI/stacking/saves come later, Austin's call). THE GHOST-KEY BUG: glbs are cached
across scenes, so a hand-mounted mesh OUTLIVED its scene and welded itself beside the next
equipped weapon — render3d now evicts other mounted meshes from the bone in `applyMount` AND
`build()` sends unclaimed mounted meshes home. PORTAL CONTINUITY (Austin: must FEEL like
walking through): claimed eyes are posed per-frame as the PLAY CAMERA through the portal pair
(entry-local → 180° → exit-world, play camera's own projection), faces sample SCREEN-SPACE →
correct parallax; clip plane at the exit surface; unclaimed PerspectiveCameras keep their
authored pose (monitors unaffected). `warpTick` rotates heading AND camera yaw by the pair's
relative yaw (verified: in facing north, out facing west, camera followed, 90° exact).
Verified whole: key+bazooka picked in scene 1 → both in scene 2 → rack bazooka REFUSED →
lance picked → exactly one mesh on the hand bone → all four items in scene 3.
THE GIANT-BAZOOKA HAUNTING (Austin's screenshots, lessons): the twice-claimed-node rule
gives a carried item meeting a scene's own copy a CLONE, but the claim pass re-resolved
every build — next scene (no competitor) rebound the ORIGINAL, orphaning the clone
visible + mount-scaled ×10 + owned by nothing. Fixed with two invariants in the claim
pass: an element that ever received a clone KEEPS it (stable binding across scenes), and
any clone its element no longer binds is REMOVED at build. Verified: bazooka equipped
through scene 1→2→3, no giants, unequip hides + rescales + goes home.

**THE SUNKEN GOOBER** (`DESIGN.md §18.31`, lessons): Austin found Scene 2 "empty" — the
goober was ALIVE one metre under the floor. At scene load his ground snap consumed a
HALF-BUILT-scene answer (nodes at raw glb origins while ensureGlb resolves), and his short
ground ray (feet + 0.5), now starting under the real floor, never saw it again. Fix, both
ends: `groundAt`/`groundInfo` answer null while `build()` is in flight (`buildsInFlight` —
§18.13's never-render-mid-build doctrine now covers geometry QUESTIONS too), and the NPC
`_groundSnap` clamps per-tick movement (a snap is a STEP, never a teleport) + retries from
head height on a miss, so a buried NPC self-recovers. Verified across repeated scene-2
reloads: y = 0 every time.

**voiceLine — one voice per ELEMENT** (`DESIGN.md §18.29`, element.js std-lib): Austin heard
the goober growl UNDER his own death cry — event sounds bypassed the §18.18 registry. Every
element now has `voiceLine(name, {volume})`: registers in `world.voices` AND cuts the same
element's previous line first (self-interruption is a bug; two characters overlapping is a
scene). `emitVoice` is a thin alias now; the door creak uses it (door1-2.ags.txt). Verified:
second line cuts the first, one registry entry per speaker.

**CLIPFORGE is live** (`DESIGN.md §18.25`, `clipforge.py` at project root, stdlib): English →
JSON spec (node name, baseline euler = the ELEMENT's live rotation, world-axis rotation
keys) → a minimal animOnly .glb, `--upload <slug>` imports + Anim-flags it via the API.
DOCTRINE (memory: ae1-generated-assets-doctrine): generate MECHANICAL/PROP motion freely
(doors, topples, spins — offer PROACTIVELY when a request implies one); NEVER quality
humanoid motion (Mixamo's job); crude humanoid placeholders OK as explicit scaffolds; simple
runtime motion often belongs in §18.24's procedural layer instead. Proof: the whiteboard —
"wobble and knock it over when hit" → 912-byte clip + whiteboard.ags.txt (script-defined
`takeDamage` makes ANY prop a weapon target). THE DESTRUCTIBLE-PROP SETTLE PATTERN (all
three traps bit): pin `'__bind__'` at load (empty clip + libs auto-loops the topple);
onFinished FREEZES the final key into the ELEMENT transform + clears the clip (a shared-glb
sibling's rest restore stands held poses back up); script `containsPoint` → false once
fallen = the wreck is scenery, E and rounds ignore it. The stress
test also caught PROJECTILE TUNNELING: hit tests now SUB-STEP the flight segment (~12 cm)
— a point-per-frame test sailed through thin targets. Exporter "could not strip" warnings
on forged clips are correct noise (already minimal, ships whole).

**PLAY STARTS THE GAME, not the open scene** (Austin's testing doctrine, §18.28 tail):
`store.play()` boots `project.entryScene` (same as the shipped build) regardless of which
scene the editor is viewing; Stop restores the edited scene. Mid-game level access is for
future IN-GAME debug tools (teleports/checkpoints/saves) — never the editor's current view.

**THE SCENE 2 QUEST is live** (`DESIGN.md §18.28`) — the forge stress test passed: key →
locked house door (door1-2.ags.txt: equipped-key check, baked-in forged open clip pinned at
load, onFinished → `goToScene("Scene 2")`) → scene-2.json (HAND-AUTHORED — scenes are
directory-scanned; scene-2-bound media pre-flagged `merged` so it skips Scene-1 auto-merge)
→ the GOOBER (goober.ags.txt: 300 HP, forged mesh/waddle/breathe/growl/death-cry, swipes 5).
ENGINE ADDITIONS: ThirdPersonCharacter `(health 100)` + `takeDamage` (zero does NOTHING
yet, by decision); NPC swipe `(attackRange/attackDamage/attackRate)`, opt-in — range 0 =
harmless, no chase. Talking signs = PassiveDialogue + audioforge lines, chance 1. All
verified live including the 5-damage swipe, cross-scene weapon paths, and the death rites.

**AUDIOFORGE is live** (`DESIGN.md §18.27`, `audioforge.py` at project root): English → a
spoken .mp3 in the media collection. Backends: edge-tts neural (pip, ONLINE at synth; cute
presets — "ana" child voice is the flagship, "nanami" ja-JP) with automatic OFFLINE
fallback to SAPI Zira/David via PowerShell (+`--pitch +25%` = budget-anime; ffmpeg on PATH
converts wav→mp3). `--rate/--pitch`, JSON batch, `--upload <slug>`. Wiring is dat
(passiveLines/deathSounds) or `this.playSound(...)`. Proof: the companion character's 5th passive line ("Hello
world, from the forge!", voice ana, 3.14 s) forged + uploaded + wired in one message.
Voice QUALITY stays Austin's vocaloid/FL-Studio pipeline; piper-tts = offline-neural
upgrade path.

**MESHFORGE is live** (`DESIGN.md §18.26`, `meshforge.py` at project root, stdlib):
English → a textured prop .glb — box/cylinder/plane primitives baked into ONE NODE (one
element on import, clipforge-animatable by name), hand-written 128 px PNG textures
(crate/planks/metal/checker/stripes/solid over value-noise grain, NEAREST = PSX crunch),
and an optional BAKED animation block (clipforge's key format) — the renderer auto-plays a
model's own first clip, so props ship pre-animated with zero wiring. `--upload <slug>`
posts WITHOUT the Anim flag (models SHOULD merge). Proof: "a 2 m shipping crate" → 25 KB
crate1.glb with ±1.5° sway, merged + textured + animated in one message. Blockout tier BY
DOCTRINE (memory: ae1-generated-assets-doctrine) — organic models stay in the artist
pipeline.

**THE PROCEDURAL LAYER is live** (`DESIGN.md §18.24`): a weighted BIAS over playing clips,
applied in render3d AFTER the mixers — only while a clip drives the bones (else a per-frame
nudge ACCUMULATES and corkscrews the skeleton; that guard is load-bearing). NOT IK, by
honest design: REACH (`(reachWeight 0.5)` on the character) bends RightArm/ForeArm toward an
interact target's volume centre + snaps her heading to face it (ramp in AND out; the
ramp-out aims at the REMEMBERED point); FOOT PLANT (`(footPlant true)`) rays under the feet
(ONE per frame, alternating; idle/locomotion states ONLY — a one-shot clip owns the body,
and plant-under-a-fire-stance read as recoil), settles the hips by the lower foot's drop
(clamp 0.35, smoothed, applied as a WORLD-down vector through the parent's quaternion —
`hips.position.y +=` on a rotX-90 armature pushes along world Z, the recoil bug; lessons),
tilts the sampled foot to its slope normal. Bones auto-detected (mixamorig names; the placeholder NPC's
bone0 skeleton skips silently). Flat ground = no-op. NOTE: `_groundHit` prunes skinned
meshes BEFORE casting now (the aimPoint lesson lived on in its sibling) — ground physics
sped up engine-wide (75 fps, above the pre-procedural baseline).

**SCATTER is live** (`DESIGN.md §18.23`, `engine/scatter.js`, BUILTIN `Scatter`): repeated
static dressing as configuration — the element is the ARCHETYPE, `(spawns ((x y z [yaw]
[scale]) …))` places renderer clones SHARING its geometry/materials (one mesh, many rows);
`(spawnSnap true)` drops each copy to the ground under its x,z, and the row's y rides ON TOP
as an offset (y 0 = on the grass; the snap must never EAT the y column — that bit). Snap
plants the mesh's FOOT, not its origin — glbs often bake the origin partway up the model
(the palm holds ~2.5 m of trunk below its origin; snapped by origin, trunks sank to the
fronds). Copies are DRESSING by design: no elements, no scripts, no collision. Live in
the EDIT viewport (applyScatter runs in build AND update — a component applier hooked only
into update() misses first paint; that bit once). Demo: tree034/palmTree1.glb → "PalmGrove",
six snapped palms around the plaza. InstancedMesh is the next step for hundreds.

**PARTICLES are live** (`DESIGN.md §18.22`, `engine/particles.js`, BUILTIN `Particles` + the
sim in render3d): four presets — flame/smoke/splash/explosion — picked by the `fx`
COMPONENT's enum (the Properties "+ Particles" button and Effect dropdown came FREE from
COMPONENT_SCHEMA). ZERO texture assets: canvas-drawn soft radial sprites at first use
(64 px, additive for glows, normal for smoke/splash); CPU sim over pooled THREE.Points with
a tiny per-particle size/alpha shader; dt clamped 0.1 s. Anchor: `(fxHost …) (fxNode …)` +
node-frame offsets; `(fxLoop false)` = an EVENT fired by `burst()` — and every non-looping
effect HOSTED on a weapon bursts automatically at projectile spawn (muzzle flash + breech
smoke = zero code; demo elements "MuzzleFlash"/"BreechSmoke" on the Bazooka). Play-exit
clears live particles (clearDebug). Sprite-sheet flipbooks are the documented next step.

**DEBUG TOGGLES live in dat** (until the debug-menu overlay exists): `(drawAim …)` on the
PLAYER (player.ags.txt) draws the aim triangle; `(drawPaths …)` on the MISSILE
(missile-2.ags.txt) draws its flight line muzzle→focal (the "beam" — ink only, the
trajectory maths run regardless); `(drawPaths …)` and `(wander …)` on an NPC (enemy.ags.txt)
draw his route / freeze him in place (route cleared, replans on re-enable). All flip live in
Properties → ANGEL SCRIPT during play. All currently OFF/normal.
**E is GATED**: the interact one-shot plays ONLY when something pickable or touchable is in
reach — a stray E at empty air does nothing at all (the long uninterruptible grab pantomime
held the player hostage; Austin's call).
Projectile TEMPLATES never render anywhere — `wantsVisible` in render3d (duck-typed
`launch && !_spawned`); rounds exist on screen muzzle-to-hit only.

**NPCs SPEAK now** (`DESIGN.md §18.21`): `AE1NPC extends AE1PassiveDialogue` (which extends
Hitbox — nothing lost) — every NPC gets the companion character's proximity-chatter machine via dat alone
(`(passiveLines …)` in enemy.ags.txt: seven pascal_audio lines); `_pvTick` refuses the dead.
TWO gotchas honoured: the builtin runInfo lists `_pvTick` EXPLICITLY (hand-built defs don't
merge up), and passivedialogue.js precedes npc.js in ENGINE_MODULES (base before subclass in
one bundle scope). `(deathSounds (…))` is the DEATH EVENT TREE — no silence roll, never
waits for another voice (voiceBusy is passive-only); fires in takeDamage's death block via
emitVoice. Tuning note: the companion character's 7.7 s lines vs his 8 s cooldown nearly saturate the one-voice
channel and starve other talkers nearby — by design, but mind line lengths vs cooldowns.

**FOOTSTEPS BY SURFACE are live** (`DESIGN.md §18.20`): `env3d.groundInfo` returns `{y, el}`
off the character's EXISTING physics raycast — the ground's identity, not just its height;
floor elements carry `(groundType "floor"/"grass")` dat (floor-2x1.ags.txt,
plane001.ags.txt — NOTE: the walkable grass is element **Plane001**/ForestFLoor; "Plane" is
hidden and never catches the ray, tagged anyway). `AE1Audio.loop()`/`world.loopSound()` is
the new looping-effect channel (caller-owned `stopLoop()`, overlaps fine — reuse for hums/
rain). The character's `_footTick` (runs even on attack/interact frames so firing silences
steps): loops the `(footsteps (floor "…") (grass "…"))` mapping while grounded in a
locomotion state; the loop is TOUCHED ONLY ON CHANGE (same surface = seamless, the
no-skipping rule); unmapped/untagged ground walks silent. Verified live by src hash on both
surfaces + silence on idle/stop.

**AMBIENCE is live** (`DESIGN.md §18.19`, `engine/ambience.js`, BUILTIN `Ambience`): the
Skybox pattern for the ears — `(music "backgroundAudio.mp3") (musicFade 400)` starts the
scene's looping theme on the MUSIC channel, so dialogue/one-shots layer beside it, never over
it. Scene-level control is the std-lib: ANY element can `this.stopMusic()` /
`this.playMusic(…)`; the element's `setMusic("file"|"")` swaps/stops with its fade. Demo
element "Ambience" (ambience.ags.txt). Verified live: loop + a passive line simultaneously,
stop from the player character's script, restore via setMusic. Verified: camera centered on the wandering NPC → fire → round left the muzzle,
converged, "[Missile] hit NPC", exactly 90 damage once. Aiming is look-and-shoot;
grenades/throwables should reuse this, NOT rebuild it.

**Asset removal has a real order now** (`merged` flag on media entries, §18.12.1): a glb
auto-merges ONCE per import; deleting its elements is permanent (they used to RESURRECT, making
removal a deadlock with the in-use media guard). Remove = delete elements → delete media tile →
re-import. ALSO: failed glb loads no longer cache forever (a re-uploaded file retries), and a
re-export that changes a glb's top node leaves any old element pointing at a dead node —
unbound + hidden by the unclaimed rule; repoint `model.node` or delete + re-merge.

**Visibility is honest now** (Austin hid his new office set and it kept rendering): `applyParts`
skips the BOUND ROOT (`traverse` visits the object itself first — on mesh-rooted glbs it stomped
the element visibility one line after it was applied), and `build()` hides ORIGINAL top-level
nodes no element claims (a deleted element's mesh used to haunt the scene; the glb-level rule
was all-or-nothing). Lessons: "Hidden furniture kept rendering".

**Binding is a LOAD-TIME nodeMap** (Austin's lance welded itself into her hand): a mounted item
is reparented into the host skeleton, so live `getObjectByName` on the glb scene missed it on
rebuild and the cross-glb fallback bound the lance element to a CHARACTER's "Armature" (every glb
has one). render3d's `entry.nodeMap` (captured at ensureGlb) is now the only resolver. Lessons:
"The lance welded itself into her hand".

**The SKYBOX is live** (`DESIGN.md §18.13`, `engine/skybox.js` + `three3d/hdr.js`): `(extends
Skybox)` + `(sky "PSX_NIGHTSKY.hdr")` — a hand-rolled Radiance decoder (RGBELoader isn't
vendored; ~100 lines, validated 2048×1024 in 52 ms) makes the .hdr the background AND
(`lightScene true`) the IBL, so night makes the world night. `skyOpacity`/`skyRotation`/
`skySpin` live-read (the mount pattern); `setSky()` swaps; .hdr files INLINE in 3D exports
(file:// can't fetch). glbs CANNOT hold world environments (Blender exports them empty —
Austin's 132-byte skyboxNight.glb proved it; deletable). DEBUG: the live editor renderer is at
`document.querySelector('.viewport-canvas').__r3d` — permanent console handle.

**NPCs + COMBAT are live** (`DESIGN.md §18.12`, `engine/npc.js`): `(extends NPC)` = wandering
waypoint walker (grounded, quat-composed facing — the kit is EXPORTED from thirdperson.js now)
with `(health 99)`; `(drawPaths true)` draws the route via the generic `debug.path` component →
render3d polyline. **Wander is VALIDATED** (env3d.blocked — a horizontal ray sweep; skinned + hidden don't count):
waypoints need ground under them and clear lines; blocked mid-leg → the WHOLE route replans
(one-leg drops churned unvalidated legs); `(idleChance)`/`(idleTime)` make stops linger.
The player's attack SWEEPS weapon-AABB vs damage-takers, once per swing, for
the weapon's `(damage 50)` dat; `takeDamage` dispatches `onHit (attacker, amount)`; zero health →
TOPPLE (physics-as-animation, world-axis tip composed onto rest) → vanish after `(vanishAfter 3)`.
E on a NON-pickable hitbox dispatches `onInteract` to IT (poke the machine). `hasPhysics` on every
Hitbox: v1 gravity+floor for free items — the SEED of the physics system, not the tree. Demo:
"Enemy" (enemy_no_animations.glb, a machine enemy) — wander/path/poke/two-strike-kill/topple/
vanish all verified; screenshot shows the cyan route. NOTE: bundle-collision guard forced
`NPC_DEG` (not DEG) in npc.js — concatenated scope. **NPCs animate now**: `(animLibs
("pascal_moving.glb")) (move "pascal_moving.glb")` in enemy.ags.txt — the walk clip plays
while a leg is underfoot, stops/death pin `'__bind__'` EXPLICITLY (with libs attached an
empty clip resolves first-anywhere and a stopped NPC walks in place); `(idle "file.glb")`
is there when an idle clip exists. The clip is a subtle up-down bob — Austin confirmed it
working (a bone-quaternion probe on one bone can read static; trust his eyes + the clip
being `current` on the mixer).

**The ITEM SYSTEM is live** (`DESIGN.md §18.11`, `engine/hitbox.js`): `(extends Hitbox)` = an
invisible AABB volume (renderer's `env3d.boundsOf`); E inside a pickable one → hide + inventory +
AUTO-EQUIP (first item); equip = a `mount` component the renderer turns into BONE PARENTING (the
virtual socket — auto-detects a right hand, `(sockets …)` dat overrides; world-unit offsets ÷
bone world scale). Grip dat: `mountX/Y/Z` (world units) + `mountOffsetX/Y/Z` (DEGREES) +
`mountScale` — read LIVE by the renderer while mounted, so Properties tweaks during play move
the grip in real time. Scroll wheel cycles; Shift+E drops 0.8 m ahead; `onPickup/onDrop/onEquip/
onUnequip` dispatch to the item, and `onPrimary/onSecondary` FORWARD to the equipped item (the
wield framework). **`(isWeapon true)` + `(attack "file.glb")` turn left click into the `attack`
one-shot** (uninterruptible like interact; hooks fire first; unarmed clicks stay hooks-only) —
wired for DragoonLance + player_character_sword_attack1.glb, verified armed/unarmed. Demo items: DragoonLance (weapon, damage 50) + **key** (key.ags.txt, non-weapon — clicking with
it does NOT swing). **Scroll cycling verified with both**: wraps in BOTH directions (backward
from slot 0 → the LAST item; the first two-item test caught `equipIndex(-1)` emptying the hand —
fixed: the hand only empties with the inventory). Still true: no 2D HUD overlay in 3D yet
(inventory is data + the in-hand item is the visual). NOTE: Austin
renamed the elements — the character element is now "the player character", the hero "92".

**`interact` state (E)**: an UNINTERRUPTIBLE one-shot — owns the body (no move/jump/actions/state
change) until the clip's onFinished; grounded-only, never mid-turn, requires a configured clip
(else no exit → no entry) — and requires A TARGET: E with nothing pickable or touchable in
reach does NOTHING (the empty-air grab pantomime held the player hostage every stray press).
Dispatches `onInteract` (RUN_INFO). Wiring: `interact: 'KeyE'` on the
Controller (dat-merge — existing Controller elements get it free), `(interact "file.glb")` dat on
the character, loop forced false. Austin's `player_character_interact.glb` is wired and verified.

**Mouse-look is FREE-LOOK everywhere** — no button held. Captured (pointer lock) → deltas on the
window; uncaptured → deltas over the game canvas ONLY (editor mouse crosses panes without
swinging the camera; a shipped game's canvas is the whole window). An embedded preview iframe
rejects `requestPointerLock()` SILENTLY ("root document not valid" — Austin hit it); `AE1Input`
catches + warns once, and free-look covers the gap. Verified: canvas hovers orbited 63° at
exactly 0.15°/px with zero buttons; Outliner hovers moved nothing.

**The 3D export double-clicks again** (Austin's 1.89 GB build died before boot — V8's ~1 GiB
string cap meant JSON.parse could not even materialise the data): `strip_glb_to_clips` in
exporter.py rebuilds each animOnly glb as node graph + clips only (183.5 MB → 168 KB, pure
stdlib GLB surgery; best-effort — failures ship the original with a warning), the exporter warns
near the string cap, and game3d decodes glbs LAZILY via `data:` URL fetch (native base64 — the
old per-char `Uint8Array.from(atob…)` froze the page for minutes). Build: 260 MB, boots on
`file://` in ~2 s, the stripped library drives the character's idle. Lessons: "The build died
before boot — at a size".

**Still open (3D):** lateral collision (characters walk through geometry, deliberate); viewport
picking; light KIND changes. `DESIGN.md §18.5–18.10`.
Full rationale + decisions: `DESIGN.md §18`.

The **`room-simple`** project is a virtual tour Austin is building now: a warning screen, then 11
video "positions" you navigate by clicking thirds of the screen, with hover captions and a
background music track whose loudness varies by area (`setMusicLevel`). Fully built and verified
**structurally** — navigation, captions, per-area loudness, dead ends, and a shipped export all
work — but **awaiting media**: eleven `Position_*/position_*` videos and one `background.*` audio
track that Austin drags in. Until then the videos render black. Built from two reusable scripts
(`tour-video`, `tour-region`) + a `Caption` HUD; the exit map lives in `DESIGN.md` history and
the scene files.

---

## Run it

```powershell
.\server.ps1              # http://localhost:8000, opens Brave incognito
```

Testing without the launcher (what I've been doing):

```powershell
py -3 server.py --port 8000 --root <abs-path-to-AE1>
```

**Clean up after yourself.** Delete test projects (`DELETE /api/projects/<slug>`), remove
`settings.json`, stop the server. Leave `/projects` and `/exports` as you found them.

---

## Architecture in 90 seconds

```
server.ps1 → server.py (stdlib http.server) → browser
                                                /engine   SHARED with shipped games
                                                /editor    editor only
```

**The one thing to internalize:** `/engine` is shared between the editor and every exported
game. Not copied — *the same files*. The editor adds a camera and chrome; the game adds a
letterbox. Everything else is identical.

That is **Principle 2**, and it exists because "works in the editor, breaks in the export" is
the worst failure a game engine can have — it's discovered by players, after shipping.

**The test for where code goes:** *does a player's browser need this?* Yes → `/engine`. No →
`/editor`.

```
AE1World ─── hud:   AE1Scene ─── AE1HudElement / AE1Inventory   (persistent, never unloaded)
         ├── scene: AE1Scene ─── AE1Element                     (swapped on goToScene)
         ├── audio: AE1Audio
         └── loop:  GameLoop
```

`editor/js/scene-store.js` is the editor's centre — project, scenes, HUD, scripts, media,
selection, journal, undo, play. **Editors read from the store and subscribe to it; they never
talk to each other.** It's a star, not a graph.

---

## Angel Script, briefly

`.ags.txt`. Three sections. **Not interpreted** — it compiles to a real JavaScript class.

```
<?dat
(locked true)          ← LISP. Becomes REAL properties on the element.
(key "brass_key")
?>
<?def
(extends Openable)     ← prototype chain. Built-ins: Element, Text, Button, Video,
                       ←   Sprite, HudElement, Inventory, SaveHandler
(name "Door")
(runInfo use (onClick onCall))   ← WHEN methods run. Arrays mean "both".
; comment is a semicolon here

function use(actor) {            ← plain JavaScript
  if (!actor.has(this.key)) return this.say("It's locked.");
  return super.use(actor);       ← real super. Works because we emit a class body.
}
// comment is a slash-slash here
ags?>
```

**Why LISP:** one reader parses both `dat` and `def`, and the reader stops at the first
non-`(` token — which is why the JS section needs no delimiter. Austin's call; it was right.

**Why `super` works:** `toMethod()` rewrites `function use(a){}` → `use(a){}` and emits
`class extends __Base`. Only class methods get a `[[HomeObject]]`. This is the single most
important trick in the compiler.

**dat AND runInfo both merge down the chain.** Missing either breaks inheritance silently.

Full reference: `docs/guide/04-angel-script.md`, `docs/guide/05-standard-library.md`.

---

## Invariants you must not break

Each of these is a real bug that already happened. Full stories in
`docs/engine/05-lessons.md` — **read it before changing engine code.**

1. **Never downgrade an element because its script failed to compile.** A typo once deleted
   every `dat` property on disk.
2. **`AE1Element` preserves unknown keys** (`_extra`). Never delete data you don't understand.
3. **Playing must not edit the project.** Snapshot on play; the journal is silent during play.
4. **A build is never destructive before it has something to swap in.** A failed rebuild once
   destroyed the working build.
5. **`runInfo` inherits, like `dat`.** Otherwise a subclass silently never gets called.
6. **Object identity is the area tree's addressing scheme.** Never clone a node into it.
7. **Assets named only in scripts OR in element dat must not be pruned.** A sound named in a
   script would ship silent; a video named in per-element dat (`(video "Position_001")`) would
   ship black. The exporter scans both.
8. **Selection draws in its own pass**, after every element.
9. **Writes are atomic; saves never overlap.**
10. **An honest indicator beats a reassuring one.** "Saved" must mean saved.
11. **Both render paths share one transform.** `draw()` used to get a bare translate, so
    rotation and flip were silently ignored on every Text, Video and Button. A property on the
    base element means the same thing for every element, or it means nothing.
12. **Every `engine/**/*.js` is in `ENGINE_MODULES`.** An unlisted module is absent from every
    shipped game while everything referencing it still ships — a `ReferenceError` on load, from
    a build that reported success. The exporter now refuses.
13. **The schedule is rebuilt when the live element set changes.** The tables are built once, so
    an element spawned mid-play renders perfectly and never answers a click. `GameLoop.rescan()`,
    called by the world on `@add`/`@remove`.
14. **A new dispatch mode must be in `RUN_INFO`.** That list is the compiler's whole vocabulary.
    `onFinished` shipped without it, so the syntax AE1's own guide taught was rejected — and no
    test caught it, because the tests wrote the schedule table directly and never compiled.
15. **Never regenerate an accessor an ancestor defines** (`definedInChain`). Every compiled
    subclass used to shadow any custom dat accessor a built-in wrote, so no built-in could have a
    dat key that *does* something when it changes.
16. **Seek video through `_seekWhenReady`, never a raw `currentTime` write.** `readyState: 4`
    does not imply seekable; on a first load the assignment silently does nothing.
17. **A dat key never generates a `getX`/`setX` pair when either already exists.** A dat key
    `musicLevel` silently overwrote the std-lib `setMusicLevel`; `sprite`→`setSprite` would too.
    The generated method *existed and was the wrong one* — the trap is that it looks wired.
18. **Never edit a project's files on disk while the editor has it open.** The unload beacon and
    journaling save the editor's in-memory copy back over your write. Close the project or make
    the editor re-read (`store.open`) first. (How `pos-005a` kept reverting during this build.)
19. **Frame-scoped input state is closed by the loop that CONSUMES it.** `input.endFrame()`
    belongs in the game loop's `onFrame`, never a render tick — two rAF callbacks are two
    clocks, and the wrong one cleared every pressed() edge before dispatch saw it (eaten jumps).
20. **Facing is a world yaw composed onto the whole rest orientation** (the quat kit), never a
    bare `rotationY` write — a baked armature rest (rotationX 90) makes the euler Y a TILTED
    axis. Walking backwards flipped her upside down. Same family: root position AND root
    rotation are locked out of library clips — physics owns WHERE, the element owns WHICH WAY.
21. **A blend across exactly 180° picks its hemisphere arbitrarily.** Never build cancellation
    maths on one (the reversed-turn entry re-spun her); ramps run only where the blend path is
    determinate, hard cuts where it is not.
22. **The rest pose is a snapshot, not a computation.** `'__bind__'` restores load-time node
    locals; `Skeleton.pose()` recomputes through matrixWorld and vanished a 0.01-scale character.
23. **Element→object binding resolves through the LOAD-TIME nodeMap**, never a live scene
    search — mounted items are reparented into skeletons, and the cross-glb name fallback
    welded a lance into a hand forever (every glb has an "Armature").
24. **Inlined data has a hard ceiling (~1 GiB V8 string) and a slow floor (per-char decode).**
    animOnly glbs ship stripped to clips; decode goes through the native data:-URL path; builds
    near the cap warn at export, not at double-click.
25. **One glb, one animation timeline — only the element bound to the ORIGINAL may drive it.**
    A second element wearing the same glb renders a *clone*, and a clone is never posed by the
    mixer (it is a snapshot, moved by `applyTransform` alone). Two elements reaching the state
    machine meant they fought every frame: Scene 1's range door cancelled the quest door's
    opening swing with its own `'__bind__'`, so the key stopped opening the way to Scene 2 —
    and before that pin it auto-played the swing (an UNSET clip plays the glb's FIRST clip) and
    swallowed the finish, because `onFinished` went to whichever element touched the entry last.
    Now: clones return early from `applyAnimation`, and the finish goes to the element that
    STARTED the playback (`entry.playEl`), not merely the last one seen.

---

## How to work here

**Drive the app. Do not trust inspection.**

Almost every real bug was found by loading the page and clicking, and the worst ones produced
**no error at all**. A clean console does not mean no exception — the browser swallows throws
inside event listeners. Install `window.onerror` when something silently does nothing.

**When a test fails, suspect the test.** Twice I nearly "fixed" correct engine code; both times
the test data was wrong.

Useful loop (the browser pane can execute JS against the running editor):

```js
const { store } = await import('/editor/js/scene-store.js');
store.diagnostics                 // compile errors
store.scene.all()                 // elements
store.world?.inventory.items      // during play
document.querySelector('.ws-play').click();   // toggle play
```

**Verify against disk**, not just memory — the journal is the thing that must be right.

---

## Conventions

- Code comments cite `DESIGN.md §N`. **DESIGN.md is the decision record** — 814 lines of *why*,
  including the mistakes. Update it when a decision changes.
- `docs/` is the manual (what is). `DESIGN.md` is the record (why). `respawn.md` is this.
- **Every colour, size, duration is in `editor/css/theme.css`.** A hardcoded hex is a bug.
- The comments in this codebase explain **why**, especially where the reason is a bug that
  already happened. Match that. Don't write comments that restate the code.
- Austin likes honest reporting: say what's broken, what you couldn't verify, and what you
  guessed.

---

## Things I could not verify

- **Anything paced by rAF.** The automation pane is `visibilityState: "hidden"`, so
  **`requestAnimationFrame` never fires** and `GameLoop` sits at `frames === 0` with
  `running === true`. Pressing Play there looks exactly like a broken feature — it cost me
  three wrong diagnoses before I checked `loop.frames`. **Check that first.**
  Sprite *logic* was verified by driving the real dispatch path on a fixed clock
  (`loop._safeDispatch('onTick', 1/12)`), which exercises the schedule tables and the merge
  chain deterministically. Frame *pacing* under real rAF was not.
  Video preview is the same story: the `<video>` genuinely plays (`paused === false`, verified),
  but that the viewport **repaints each frame** while it does was not observable here.
  Clicks are fine — `pointerDown` is synchronous, so every dialogue and button test is real.
  **Worth one manual look: press ▶ on a video in the editor and see if it moves.**
- **`file://` play (2D).** Verified *structurally*: zero module tags, zero fetches, zero absolute
  URLs, and a built game makes exactly two kinds of request (the page + relative images). Strong
  evidence, not proof. **Worth one manual double-click.**
  (**3D is verified for real**: the browser pane CAN load `file://` — open it with
  `preview_start {url: "file:///…/index.html"}` — and the exported 3D game booted, bound, animated,
  and rendered there with `location.protocol === "file:"`. If a tool rejects `file://`, try the
  preview pane before concluding it can't be done.)
- **Audio actually sounding.** Verified that the right files are requested with the right
  parameters; never heard it.
- **`Ctrl+Space`** — the automation harness delivers `key:''`, so the shortcut couldn't be
  tested. Windows may eat it (IME). The header double-click is the fallback.

---

## What's next

**Ask Austin; do not pick for him.** As of 2026-07-25 he has named the next frontier
himself (session close): **a Shader layer** (per-scene custom shaders as a base element),
**Scene FX** (blur, FOV, camera movement effects), **Cutscenes + Quicktime Events**
(trigger volumes → in-engine renders with scripted animations, camera curves, camera FX),
**a new engine font**, **an interactable dialogue system + trees for 3D**, and **enemy
lock-on**. Claude pitched five composites back (see the session-close message): the
Director timeline element (absorbs cutscenes/QTE/camera scripting), a ScreenFX post stack
(absorbs shader layer/scene FX, reuses the render-target + FX-volume patterns), Z-target
lock-on, the in-engine blend-graph editor (the real fix for movement feel), and the
in-game debug toolkit (teleport/checkpoint/save tools — his stated testing doctrine).

Older candidates that still stand, in rough order of design weight:

- **What a save remembers.** The biggest open question, and it keeps getting louder. Two gaps are
  still deliberately parked from the original save work: the **inventory** and **per-scene
  state**. Dialogue sharpened it — a conversation's position *is* per-scene state (the thing
  `SaveHandler` parks in `world.pendingSceneState`), and "which lines have I already heard" is
  the first thing a real game wants. The envelope was built to grow; growing it is a design
  conversation, not a coding one.
- **Conditional choices.** `(if hasKey …)` gating a dialogue choice. Deliberately left out — he
  chose "tree + progression + actions" when asked. It is the first thing a second conversation
  will want, and it overlaps the save question above, so design them together.
- **The 3D game's obvious next tenants** (the frameworks exist; these fill them): a **2D HUD
  overlay in 3D games** (visible inventory slots, health bars, a real CROSSHAIR for §18.16 —
  no compositor yet; inventory is data + the in-hand item), **grenades + throwables** (Austin
  has named these; they REUSE the §18.16 muzzle/focal baseline — arc instead of line),
  **combos + hit windows** on the attack, **NPC aggro/AI** (they only wander; `onHit` is the
  hook), **lateral collision** (`hasPhysics` v2 — bodies still walk through meshes),
  remaining state clips (run, per-item wield idles).
- **3D interactivity.** **Viewport/game picking** (click a 3D object → select in editor /
  `onClick` in play). Smaller: light KIND changes (spot→point doesn't rebuild).
- **Snapshots** (Save-as-version). Untouched since the start.
- **A pass on the front-end project with real assets.** It was built against placeholder videos.
  The poster/scrub work exists precisely for laying out against real footage — it has never been
  used on any.

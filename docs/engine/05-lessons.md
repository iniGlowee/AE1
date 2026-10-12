# 5. Lessons

Real bugs from AE1's construction, and the invariants they bought.

This is the most valuable file here. Every entry is a rule someone would otherwise re-break,
and most were **invisible to code inspection** — they were found by loading the page and
clicking the thing.

**The failure mode to fear is not a crash. It is silence.**

---

## Data loss

### A typo in a script destroyed the element's data

**What happened:** renaming `touch` → `tuoch` broke compilation. No compiled class → the
element rebuilt as plain `AE1Element` → which knows nothing of the script's `dat` keys → they
vanished from `_props` → the next journal write persisted a scene without them.

**A typo permanently deleted the author's work**, in the tool whose central promise is that
work is always saved. Caught only because a `clicked` field disappeared from a screenshot.

**Invariants:**
1. **Never downgrade an element because its script failed to compile.** A broken script means
   "I can't build a better class right now," never "discard this element's state."
2. **`AE1Element` preserves unknown keys** (`_extra`) and serializes them back. An element must
   never delete data merely because it doesn't currently understand it.

Two fixes for one bug, deliberately. Once wasn't enough.

### A failed rebuild destroyed the working build

**What happened:** the exporter did `rmtree(out_dir)` up front. On Windows that throws
`WinError 32` if *anything* holds the folder — a browser tab playing the game, an Explorer
window, an antivirus scan. By then it had half-deleted the previous build. `index.html` was
simply gone.

**Invariant:** **a build is never destructive until it has something to swap in.** Stage to
`<out>.building`, swap on success. If the swap fails, the old build survives and the error
names the likely cause.

### Play mode would have rewritten the project

**What happened:** (caught in design, not in production.) A running game mutates elements
constantly — doors unlock, counters tick. With continuous journaling every one of those writes
would stream to disk, so pressing **Play** would permanently rewrite the author's scene into
whatever state they stopped in. Unity has shipped this confusion for a decade.

**Invariant:** **playing must not edit the project.** Snapshot on play, suspend the journal,
restore on stop. One guard in `journal()` carries the whole guarantee.

Four consequences, each a real bug avoided:
- The unload beacon must save the **snapshot**, not live game state.
- `close()` must stop play first, or a rAF loop outlives the scene and restores over the *next*
  project opened.
- Rehydrating mid-play must rebuild the scheduler tables, which hold references to old
  instances. (Doing this correctly gave live script reload for free.)
- The save indicator must say **"Not saving"** — `play()` flushes without awaiting, so that
  flush resolves *after* the play event and overwrites the label. The indicator would lie at
  exactly the moment its honesty matters.

---

## Silence

### Clicking a character did nothing

**What happened:** `runInfo` didn't inherit. `dat` merged down the chain; scheduling didn't. A
`Cartman` that `(extends Kid)` and defines no methods had an **empty** runInfo — nothing
registered for `onClick`.

Class correct. Methods present. Compile clean. Never called.

That's the **template-method pattern** — a base owning `talk()`, subclasses overriding
`speech()` — which is the natural way to write a cast of characters. No synthetic test found
it. Writing three actual characters found it in a minute.

**Invariant:** **inheriting behaviour must mean inheriting when it runs.** `buildClass` merges
`runInfo` as well as `dat`.

**Corollary:** per-file validation can't see the chain, so it skips `runInfo` checks when a
file has `extends`; `compileAll` re-validates against the real prototype.

### A pane's Close button did nothing, with a clean console

**What happened:** `doSplit` put `{...node}` — a *copy* — in the tree while the pane's cached
header still closed over the original. `findParent` locates by `===`, so the live header
addressed a node that no longer existed and threw.

**The browser swallows exceptions thrown inside event listeners.** So `read_console_messages`
came back empty and it presented as "close just doesn't work." Found only because a
20-iteration loop reported the pane count stuck.

**Invariant:** **object identity is the area tree's addressing scheme.** Never clone a node
into the tree.

**General lesson:** a clean console does not mean no exception. Install a `window.onerror`
listener when something silently does nothing.

### The exporter would have shipped the game silent

**What happened:** asset pruning followed sprites only. Sound effects are named *nowhere* but
inside scripts (`playSound("boing.mp3")`), so nothing pointed at them and all three were
pruned. The game would play fine in the editor and be **silent in the build**.

**Invariant:** **`collect_name_refs()` scans script text AND element dat for asset names.**
Deliberately crude — filenames can be built at runtime, so no static analysis is complete.
Over-keeping costs bytes; wrongly pruning silently breaks a shipped game. The trade isn't close.

**The dat half was added later, and cost nothing to miss until it didn't.** A tour named its
background videos in per-element dat (`(video "Position_001")`) so one shared script could drive
eleven scenes. That name is in neither a script nor a hash-bearing component, so the
sprite-and-scripts sweep pruned every video — a build that was **black in the export and perfect
in the editor**, the exact failure this whole family of checks exists to prevent. dat is
author-owned, so every string value in it is now fair game for a name match.

### Rotation did nothing on every Text, Video and Button

**What happened:** the renderer had two paths. The default path translated to the element's
centre, rotated, and flipped. The `draw()` path — taken by every element that owns its
rendering — got a bare `translate` and nothing else.

So `rotation`, `flipH` and `flipV` were **silently ignored on every Text, Video and Button in
AE1**. Set rotation to 45 and nothing happened. No error, because there was nothing to throw:
the code did exactly what it said, and what it said was incomplete. The docs even blessed it —
`DESIGN.md §12.3` described the context as arriving "unrotated", so the bug had a specification.

**How it was found:** not by looking. By reading back the transform matrix a real `AE1Text`
receives inside `draw()` and comparing it to the default path's:

```
draw() path:    {a: 1,      b: 0,      c: 0,      d: 1}      ← identity. no rotation.
default path:   {a: -0.707, b: -0.707, c: -0.707, d: 0.707}  ← rotated and flipped.
```

**Invariant:** **both render paths share one transform.** A property on the base element means
the same thing for every element, or it means nothing.

**Two things that made this safe to fix:** an unrotated element gets a byte-identical matrix to
before, so nothing that worked changed; and nothing on disk used rotation or flip — because the
feature did not work, so nobody could have.

**The general lesson:** *a documented contract that exists only because the code forgot to do
something is not a decision — it is a bug that has been written down.* When a doc and a
property list disagree, one of them is lying. Check which.

### An export shipped a class that did not exist

**What happened:** `ENGINE_MODULES` in `exporter.py` is hand-maintained. `engine/sprite.js` was
added and the entry was not. The bundler concatenated every module *except* that one — while
`ags/runtime.js`, which registers `Sprite: AE1Sprite` in `BUILTINS`, shipped happily.

The build reported **success, with no warnings**. The shipped game threw a `ReferenceError` on
load and rendered a black page. The editor was perfect throughout, because the editor loads
real ES modules and never touches the bundler.

**Invariant:** **every `engine/**/*.js` must appear in `ENGINE_MODULES`, or the export fails
and names the file.** Order is still hand-maintained — dependency order is a thing to think
about. Membership is not.

**The tell:** the bundle's module markers ran `video.js → scene.js`. The symbol was referenced
four times in the output and defined zero times. The collision check already refused *duplicate*
definitions; nothing refused a **dangling** one.

**A false alarm inside a real alarm.** The first time this appeared, the cause was two servers
listening on port 8000 — Windows let both bind, and the stale one (holding the pre-edit
`exporter.py`) answered the export. So the first diagnosis was wrong. The *underlying* gap was
real anyway, and worth a guard. **Check what is actually serving before you debug what it
served.**

### A spawned element rendered perfectly and never answered a click

**What happened:** the loop's schedule is flat arrays built **once**, at `start()` (and rebuilt
on `goToScene`). That is what keeps it from iterating every element every frame. The cost is
that the tables go stale the moment the live element set changes: an element added mid-play is
drawn by the renderer — which walks the scene, not the tables — and is invisible to dispatch.

So it looks right, sits there, and does nothing when clicked. No error, because nothing is
wrong; it is simply not in a list.

Found while building dialogue choices, which are spawned Buttons. Without a rebuild every
choice in the game would have been decorative.

**Invariant:** **the schedule is rebuilt whenever the live element set changes.**
`AE1Scene.add`/`remove` fire `@add`/`@remove`, `AE1World._change` catches them, and
`GameLoop.rescan()` rebuilds. Immediately, not marked-dirty-for-next-tick: a click can arrive
between frames, so "next tick" is a real window in which a new element is visible and dead.

**Related:** this is the same shape as the `runInfo`-didn't-inherit bug — *the class was
correct, the method was there, the compile was clean, and it was never called.* Any time
something in AE1 renders but does not respond, ask whether it is in the tables.

### A base class's dat accessor was silently shadowed by every subclass

**What happened:** `AE1Video` defines a real `poster` setter — changing it seeks the video, so the
Properties panel moves the picture. It never ran.

`defineDatAccessor` skipped a key only if `hasOwnProperty(proto, key)` — the class's **own**
prototype. `buildClass` calls it for every key in the merged `agsDat`, so a compiled
`(extends Video)` subclass regenerated a plain accessor for `poster` **on itself**, shadowing the
one on `AE1Video.prototype`. The generated setter stored the value and did nothing else.

Class correct. Property present. Setter written. Never called. The same shape as the `runInfo`
bug, and it took a `getOwnPropertyDescriptor` on the live prototype chain to see it — from
inspection the code looks obviously fine.

**Invariant:** **never regenerate an accessor an ancestor defines.** `definedInChain()` walks the
prototype chain (stopping at `Object.prototype`, so a dat key named `toString` still gets one).
Skipping is safe: a generated accessor and an inherited one do the same thing to `_props` — the
only difference is behaviour a base deliberately added.

**Why it matters beyond video:** this made a whole category impossible. **No built-in could have
a reactive dat property**, because any script extending it silently flattened the behaviour back
to a plain store. Every future built-in that wants "changing this does something" depends on
this fix.

### A dat key silently shadowed a hand-written standard-library method

**What happened:** `TourVideo` had a dat key `musicLevel` and the engine had a std-lib method
`setMusicLevel()` (sets audio loudness). `defineDatAccessor` generates a `getX`/`setX` pair for
every dat key — but its guard checked only whether `getMusicLevel` already existed, not
`setMusicLevel`. There was no `getMusicLevel`, so it generated the pair and **overwrote
`setMusicLevel` with a setter that just stored the dat value.**

So `this.setMusicLevel(0.35)` set a property named `musicLevel` and never touched the audio. And
it looked completely wired: a `setMusicLevel` function existed, the element had a `world`, the
`world.audio` had the real method — everything checked out. It was simply the *wrong*
`setMusicLevel`. Found only by reading the value back (`sceneLevel` never moved) and then walking
the prototype to see which function `setMusicLevel` actually was.

**Invariant:** **never generate a `getX`/`setX` pair when EITHER already exists in the chain.**
`sprite` → `setSprite`, `component` → `setComponent`, and any dat key colliding with a std-lib
setter would have broken the same way. When a method already carries that name, it wins.

**The general lesson:** *a function existing is not a function doing what you think.* Same family
as the poster accessor a subclass shadowed — the machinery was present and named correctly and
called the wrong code. When a wired-looking call does nothing, confirm the identity of the thing
you're calling, not just that it exists.

### The editor's unload beacon clobbered a file written on disk

**What happened:** twelve scenes were generated by writing JSON to disk directly (far faster than
authoring each in the editor). One scene kept reverting to an old version. The editor had the
project open in another tab; its `pagehide` beacon (§ the sendBeacon backstop) saved the *current*
scene's stale in-memory copy back to disk on every reload — silently overwriting the freshly
written file. Only the one loaded scene was affected, which made it look like a random flake.

**Invariant / workflow rule:** **the editor is an owner of every open project's files.** Never
edit a project's scenes/hud on disk while that project is open in the editor — the next journal
or unload beacon will win. Either close the project first, or after writing, make the editor
**re-read from disk** (`store.open`) so its memory matches before it can save again.

**The general lesson:** two writers, one file. The same shape as the `parent`-on-both-ends and
the clone-in-the-area-tree bugs: when two things can write the same state, they will eventually
disagree, and the quiet one wins at the worst time.

### The engine rejected the syntax its own docs taught

**What happened:** `AE1Sprite` dispatches `onFinished` when a `(loop false)` clip ends, and
`docs/guide/03-elements.md` told authors to write `(runInfo hitTheGround onFinished)`. The
compiler validates every mode against `RUN_INFO` in `ags/compiler.js`, and **`onFinished` was
not in it**. Every author following the guide would have gotten
*"Unknown runInfo onFinished"* and a class that failed to compile.

The sprite tests never caught it because they wrote the schedule table directly to test
dispatch, bypassing the compiler entirely. It surfaced only when the NEXT feature added its own
modes and hit the same wall.

**Invariant:** **a new dispatch mode is not shipped until it is in `RUN_INFO`.** The list is the
compiler's whole vocabulary; a mode absent from it does not exist, no matter how well the class
dispatches it.

**The general lesson:** *a test that reaches past a layer does not test that layer.* Writing
`tables.onFinished = […]` proved the loop calls the method. It proved nothing about whether an
author could ever get there — and the author's path was the broken one.

### `give({icon: "key.png"})` rendered nothing

**What happened:** the inventory's draw expected a *hash*; an author naturally writes a *name*.
Every other media call resolved names. This one didn't.

**Invariant:** **anywhere an author names media, resolve it.** Resolve in `give()` (so the
stored item is stable) *and* at draw time (so an icon typed into the Properties panel works).

---

## Wrong, but quietly

### Every element was named "Element"

**What happened:** `ELEMENT_SCHEMA.name` defaulted to `'Element'`. The constructor only
generates a fallback name when `!this._props.name`. `'Element'` is **truthy**, so the generator
never fired. An Outliner of identical rows — exactly the uselessness the fallback existed to
prevent.

**Invariant:** `name` defaults to `''`. **A default that shadows constructor logic is a bug.**

### Choice buttons outlived the scene they belonged to

**What happened:** the dialogue box despawns its choice buttons in a hook wired to `onUnload`.
The box lives in the HUD. **The HUD is never unloaded** — that is the entire point of it — so
the hook fired only at `world.stop()`. A conversation interrupted by `goToScene` left three
buttons hanging over the next room: visible, clickable, and answering a delegate that no longer
existed.

The comment above the hook confidently explained that it prevented exactly this. It was
written before the code was driven, and it was wrong.

**Invariant:** **a conversation is ended by the DELEGATE's `onUnload`, not the box's.** The
delegate is the thing that belongs to a scene, so it inherits the layer rule for free: a
delegate in a scene ends its conversation when that scene unloads; a delegate in the HUD (a
narrator that follows the player through a door) does not, and should not.

**The general lesson:** *"it has an onUnload" is not the same as "it unloads."* Before relying
on a lifecycle hook, ask what layer the element is on — in AE1 that is the whole difference
between a thing that dies with a scene and a thing that does not.

### The selection outline was invisible

**What happened:** drawn inline with the selected element, so any higher-layer element painted
over it. Select a door with a trigger volume on top and the Outliner says "selected" while the
viewport shows nothing.

**Invariant:** **selection is UI, not scene content.** It draws in its own pass, after every
element. The scene never occludes it.

### Maximize maximized the wrong pane

**What happened:** reading `.pane:hover` at keypress time. `:hover` is empty whenever the
pointer sits over a divider or hasn't moved since load — so it silently fell back to an
arbitrary pane.

**Invariant:** **keyboard targeting is tracked state, not a CSS query.** `pointerenter` /
`focusin` track the active pane.

### A script extended itself

**What happened:** the natural inventory is `(name "Inventory")` + `(extends Inventory)`,
meaning the *built-in*. But `(name …)` registers in the by-name table, so the lookup found the
script itself → "inheritance cycle" → silent fallback to `AE1Element`, losing everything
`Inventory` provided.

**Invariant:** **a script can never extend itself.** Self is excluded from the lookup so the
name resolves onward to the built-in.

### The import scanner read three.js's prose as imports

**What happened:** `bundle_modules_3d` finds dependencies with a `from '<spec>'` regex, not an
AST — and three.js's doc comments are full of import-shaped prose. GLTFLoader's docs contain
`loaded from 'https://…'` and `from '../textures/texture.png'`; every addon documents its own
import line (`@three_import … from 'three/addons/loaders/GLTFLoader.js'`), which resolves to
*itself* — an instant cycle. Unguarded, the very first bundle failed on its own vendored library.

**Invariant:** regex-not-AST scanning needs **prose guards**: a relative spec that isn't `.js` is
prose, a module's reference to itself is its own usage example, a spec whose file doesn't exist is
prose too. If a future addon (DRACOLoader, KTX2Loader) breaks the 3D export at bundle time,
look at its comments before its code.

### The "Pillow is not installed" warning fired with Pillow installed

**What happened:** the exporter warned "Pillow is not installed" whenever *zero images shrank* —
but already-optimised PNGs don't shrink, and a project of mp4s has nothing to shrink. The warning
diagnosed a cause it never checked, and the report sent whoever read it to reinstall a package
that was fine.

**Invariant:** **a warning must test its own premise.** If the message names a cause ("X is not
installed"), the condition must check that cause (`import PIL` fails), not a downstream symptom
(`optimized == 0`).

### The render tick ate every jump

**What happened:** `AE1Input.pressed()` edges (jump, action buttons) are one frame wide, cleared
by `endFrame()`. In the editor, TWO rAF callbacks run per frame — the 3D viewport's render tick
and the game loop — and the viewport's registered first, so it ran first, and its `endFrame()`
cleared every edge **before the game loop's dispatch read it**. Space did nothing. Held keys
worked fine (`down()` isn't edge-based), which made it look exactly like a jump-logic bug.

**Invariant:** **frame-scoped input state is closed by the loop that consumes it** —
`input.endFrame()` belongs in the game loop's `onFrame` (after dispatch), never in a render tick.
Two rAF callbacks are two clocks; anything "per frame" must name WHOSE frame.

### The character stood on the inside of a box

**What happened:** the third-person ground query is a downward raycast. With no lateral collision,
walking into the cube put the cast origin (knee height) INSIDE it — and the first hit was the
cube's own bottom face, from inside. `groundAt` said "floor at 0.05" and the character hovered,
riding the bottom of a box it was standing inside.

**Invariant:** **a floor must face up.** Every ground hit's world normal is checked
(`normal.y >= 0.5`); a downward or steep face is a wall, not a floor. DoubleSide exports make
this mandatory — the raycaster reports every face, so the normal is the only tell.

### Walking backwards flipped the character upside down

**What happened:** the third-person character turned to face travel by writing `rotationY`. But
`player_character.glb`'s armature ships a baked `rotationX 90` (Blender Z-up), and the element
euler renders as `Rx·Ry·Rz` — the Ry is applied in the PRE-rotated frame, so its axis isn't world
up. At heading 180 (walking backwards) the composition put the character upside down under the
floor, feet poking through.

The worse half of the story: the earlier strafe test "passed" — it sampled x/y/z/rotationY
NUMBERS mid-turn, and the numbers looked right, but the character was lying on its side the whole
time. Nobody screenshotted mid-turn. Austin found it in thirty seconds of actually playing.

**Invariant:** **facing is a world yaw composed onto the whole rest orientation**
(`M = Ry(Δ)·M_rest`, via the quaternion kit in `thirdperson.js`), never a bare `rotationY` write —
and **"drive the app" means LOOK at it**, not read its numbers. A transform bug is invisible in a
table and unmissable in a frame.

### The T-pose that vanished

**What happened:** `bindPose()` first used `THREE.Skeleton.pose()` to return a character to its
bind pose. `pose()` rebuilds bone locals from the inverse bind matrices **through `matrixWorld`**
— and under an element-scaled armature (this character is authored in cm, element scale 0.01) the
decomposition detonates: the mesh didn't T-pose, it *disappeared*. Numbers looked perfect
(`state: 'move'`, `clip: '__bind__'`, position marching along); only the screenshot showed an
empty floor where a character should be.

**Invariant:** **the rest pose is a snapshot, not a computation.** At glb load the renderer
records every non-top-level node's local position/quaternion/scale — the file's authored rest,
which for a clip-less character IS the T-pose — and `'__bind__'` restores exactly that. Top-level
nodes are excluded because elements own their transforms.

### The build died before boot — at a size

**What happened:** the 3D export inlines every glb as base64 in one JSON `<script>`. Seven fat
animation libraries pushed `index.html` to 1.89 GB — past **V8's ~1 GiB string cap** — so
`textContent`/`JSON.parse` could not even materialise the data. A double-clicked build died with
nothing on screen; the export had reported success. And the decode had a second cliff hiding
under the first: `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))` invokes the callback **per
character** — at 175 MB that froze the page for minutes even once the size fit.

**Invariant:** **inlined data has a hard ceiling and a slow floor.** The exporter strips animOnly
glbs to node graph + clips (`strip_glb_to_clips`, 183.5 MB → 168 KB), warns when inlined models
near the string cap, and decodes lazily through a `data:` URL fetch (native base64), never a
per-char callback. A megabyte inlined is a megabyte parsed, decoded, and held — three times.

### Hidden furniture kept rendering (and a deleted cube haunted the scene)

**What happened:** two visibility bugs at once, found when Austin dropped an office set whose
glb has PLAIN-MESH top-level nodes (no armature wrapper). One: `applyParts` used
`obj.traverse(...)` — and traverse VISITS THE OBJECT ITSELF FIRST — so on mesh-rooted elements
it set the bound root's `visible = true` (not in the empty hidden-parts set), stomping the
element visibility applied one line earlier. Every hidden desk, couch, and bookcase kept
rendering; the older armature-rooted models hid fine, which disguised it for weeks. Two:
deleting ONE element of a multi-node glb left its mesh haunting the scene — only whole-glb
hiding existed, and nothing owned an orphaned node.

**Invariant:** **`traverse` includes the root — part sweeps skip `o === obj`** (the root's
visibility belongs to the ELEMENT; parts are descendants). And **an original top-level node
renders only while an element claims it** (bound directly, or containing something bound):
`build()` hides the unclaimed. The glb-level rule covers all-or-nothing; this covers the rest.

**What happened:** element→object binding resolved with `getObjectByName` on the glb's scene. A
picked-up item is REPARENTED into its host's skeleton (the socket mount), so on the next rebuild
(play-stop, scene event) the live lookup missed it — and the cross-glb fallback grabbed the first
same-named node anywhere. Every glb here ships a top-level "Armature", so the lance element bound
to a CHARACTER's armature: the real lance stayed welded in the hand forever, the fallback drove a
character with the lance's transform, and the editor-time backfill even journaled the character's
mesh list onto the lance's `parts`. A fresh play could not drop it — the new inventory had never
picked it up.

**Invariant:** **binding resolves through a name→object map captured at LOAD, never a live scene
search.** Reparenting is a legitimate runtime state (mounts); lookups must be immune to it. And a
cross-glb name fallback is only as safe as the names are unique — "Armature" never is.

### The turn-around spun her 360°

**What happened:** the 180-turn clip carries ROOT ROTATION — the hips yaw 180° inside the
animation — and the character controller was ALSO sweeping the element heading during the turn.
Two rotations, compounded. Forward playback half-hid it in speed; the REVERSED turn (pressing W
after facing the camera) starts at the clip's fully-turned end pose, so pre-flip + sweep read as
a wild full-circle spin before settling.

**Invariant:** **one rotator at a time.** While a turn clip plays, the heading HOLDS (origin for
forward, target for reversed — target + the clip's initial +180 = origin) and the clip does all
visible rotating. Same family as root position drift: the physics owns WHERE, the element owns
WHICH WAY, and a clip that also does either must have that authority taken away.

The first fix made the hand-offs **hard cuts** — yaw stable, but the LEGS snapped between poses.
The keeper (Austin's suggestion — interpolate the offset over a constant): hand-offs are **ramps
over the `turnBlend` crossfade**. The mixer's blend of a pure yaw is *linear in angle*, so a
heading lerp timed to the same window cancels the clip's blending root yaw **exactly** while the
limbs blend. When two constraints seem to force a trade (stable yaw vs smooth pose), look for the
axis on which the blend is linear — that is where both can be had.

**With one caveat that bit immediately:** at EXACTLY 180° apart, a quaternion blend picks its
path by hemisphere — arbitrary, and on the reversed turn's entry it went the opposite way to the
ramp, stacking into a fresh 360° spin. Linear-in-angle holds only when the blend path is
determinate. So the ramp runs where the endpoints are unambiguous (the exits, and forward entry);
the reversed entry — two poses 180° apart — is a hard cut, which its near-walk start stance
absorbs invisibly. **A blend across exactly 180° is a coin flip; never build cancellation maths
on top of one.**

### Slopes machine-gunned the landing

**What happened:** walking DOWN a grade, the ground ray returns a floor a few millimetres
lower every frame. The grounded test treated ANY gap (`y > groundY + 1e-4`) as airborne: the
fall clip restarted, gravity closed the gap in a frame, `onLand` fired, and the next step
re-opened it — an air-anim flicker and a wall of "[Player] landed" for the whole descent.

**Invariant:** **a grounded character SNAPS DOWN within a tolerance; only a drop past it is a
fall.** `(snapDown 0.5)` dat: while grounded, floor within half a metre below is still floor —
her feet follow the grade (and steps up, as before). A jump is untouched — it leaves the
ground through `_grounded`, which the snap never reads. Verified: a full downhill walk
(y +0.01 → −1.17) with ZERO landings, and one jump = exactly one `onLand`.

### Firing the bazooka shoved her back and forth

**What happened:** the procedural foot-plant added its settle to `hips.position.y` — the
armature's LOCAL Y. This armature bakes rotationX 90, so the hips-parent's local Y points
along WORLD Z: the "settle" pushed her forward/back, not down. Idle it was a 5 mm nothing;
during the fire clip the feet swing, the per-frame rays land somewhere new each frame, and
the oscillating offset read as recoil. The same family as "walking backwards flipped her
upside down": **a bone-local axis is NOT a world axis on a baked-rotation armature.** Bone
offsets are computed as world vectors and converted through the parent's world quaternion —
never written onto a raw local component. (Fixed alongside: the plant now runs only for
idle/locomotion states — a one-shot clip owns the whole body.)

**And the frame drop that came with it:** the per-foot ground rays went through
`_groundHit`, which still POST-FILTERED skinned meshes — the exact aimPoint lesson, one
function over. A ground ray from knee height starts INSIDE the character's dense mesh, so
every physics tick had always paid a full CPU skinning test, and the foot rays tripled it.
`_groundHit` now prunes candidates before the cast; the fix sped up ground physics
engine-wide (75 fps, above the pre-procedural baseline). **When a lesson names a function,
grep for its SIBLINGS** — the same disease usually lives next door.

### The frame rate tanked until the bazooka was picked up

**What happened:** the aim triangulation (§18.16) raycast through the view center every tick
with `intersectObjects(scene.children, true)` and filtered skinned hits from the RESULTS. But
since three r151, **raycasting a SkinnedMesh skins every vertex on the CPU** — and at spawn the
camera center sits square on the character's dense mesh, so every tick paid a full-model
skinning pass before the filter threw the hit away. Austin caught it by feel: "slow until you
pick up the bazooka" (armed, she aims off her own silhouette more often).

**Invariant:** **prune raycast candidates BEFORE the cast, never filter after.** A rejected hit
still cost its full intersection test, and skinned meshes make that cost per-vertex. `aimPoint`
now walks the scene itself — hidden and excluded subtrees never entered, skinned meshes never
candidates. Same shape as the schedule-rescan lesson: the cheap-looking library call hides
where the work happens. Also policy, not just performance: debug ink draws only when it means
something (the aim triangle needs a projectile weapon in hand; unarmed draws nothing and pays
nothing).

---

## CSS and layout

### Maximizing a pane rendered it empty

**What happened:** the content was there; `bodyRect.height` was **0**. Inside a split, panes are
flex children sized by their parent. Maximized, a pane mounts directly under `#workspace`,
which isn't a flex container — so `.pane-body { flex: 1 1 0 }` resolved a zero basis against
nothing.

It also hit a case I hadn't tested: closing panes down to a single root leaf collapses
identically. One CSS rule fixed both.

**Invariant:** a flex child mounted outside a flex parent needs explicit size.

---

## Platform

### `python` isn't Python

Bare `python` on Windows frequently resolves to the WindowsApps stub, which opens the
Microsoft Store, reports success, and does nothing. **Resolve via the `py` launcher** and
filter `\WindowsApps\`.

### `cgi.FieldStorage` was removed in Python 3.13

The stdlib's multipart parser is gone. AE1 posts each file as a **raw body** with the name in
a header — simpler than hand-rolling multipart, and it gives per-file progress and per-file
failure.

### `readyState: 4` does not mean a video can seek

**What happened:** the editor's poster seek did nothing. `video.currentTime = 3.5` returned, no
error, no event — and `currentTime` read back `0`.

The video reported `readyState === 4` (HAVE_ENOUGH_DATA) and `buffered === [[0, 6]]`: the whole
file, decoded and ready. But **`seekable` was `[[0, 0]]`**, and assigning `currentTime` to a
video that reports nothing seekable is silently a no-op.

It only happens on the **first** load. The same asset seeks perfectly the second time, because it
comes from the HTTP cache and `seekable` is populated by the time `loadeddata` fires. Which is
exactly the sort of works-on-my-machine difference that ships broken.

**What made it expensive:** three innocent things looked guilty first. The test video was
suspected (built with `concat -c copy`, so plausibly bad timestamps — it was fine). The server's
Range support was suspected (it returns a correct `206 Partial Content` — it was fine). The
encoder was suspected (a re-encode behaved *worse*, because it had just been imported and was
therefore on its first load — the real tell, misread).

**Invariant:** **seek through `AE1Video._seekWhenReady`, never a raw `currentTime` write.** It
checks `seekable`, clamps inside the duration, and retries on `progress`/`canplay` if the browser
is not ready yet.

**The general lesson:** *readiness is not one flag.* A media element has `readyState`,
`buffered`, `seekable`, and `duration`, and they become true at different moments. Ask the one
that answers the question you are actually asking.

### `crypto.randomUUID` is secure-context gated

`file://` is *specified* as potentially trustworthy, but a shipped game that dies the moment a
script spawns an element is not acceptable. `uuid()` falls back to `getRandomValues`, then
`Math.random`. For element ids, uniqueness is the requirement; unpredictability isn't.

### `sendBeacon` can only POST

The unload backstop can't PUT. The scene and hud routes accept POST purely for it. Without
that it would 404 silently — the worst possible failure for a last-ditch save.

### `requestAnimationFrame` never fires in the automation pane

The browser pane the tooling drives reports `document.visibilityState === "hidden"`, and a
hidden page gets **zero** rAF callbacks. `GameLoop` is rAF-driven, so pressing Play there
leaves `loop.running === true` and `loop.frames === 0` forever.

This looks exactly like a broken feature. An animation that never advanced was diagnosed three
ways — stale schedule tables, a dead accessor, an undecoded sheet — before the actual cause
turned out to be that **nothing was ticking at all**. `loop.frames === 0` is the tell; check it
first, before suspecting the code under test.

**The workaround, and its honest limits:** drive the real dispatch path on a fixed clock —
`loop._safeDispatch('onTick', 1/12)` — which exercises the schedule tables, the methods, and
the merge chain, deterministically. What it does **not** prove is that rAF delivers sensible
`dt` values in a real window. Frame *logic* is verifiable here; frame *pacing* is not.

### `Ctrl+Space` may never reach the page

Windows binds it to IME layout switching. **Never make a shortcut the only way in** —
double-clicking a pane header does the same thing and can't be intercepted.

---

### A manually-posed camera renders from the origin, silently

The portal pass poses a virtual camera by writing `matrixWorld` directly
(`matrixAutoUpdate` and `matrixWorldAutoUpdate` both false, as they must be). Every
frame rendered "successfully" — but the through-view was garbage: top half wall, bottom
half void. `render()` only derives `matrixWorldInverse` (the actual VIEW matrix) inside
`camera.updateMatrixWorld()`, which auto-update-off cameras never run. The inverse stayed
IDENTITY, so the scene was drawn from the world origin — which happened to sit half
inside the floor slab. No error, no warning, a perfectly plausible-looking wrong image.

**Lesson: if you write `matrixWorld` by hand, you own `matrixWorldInverse` too.** And two
siblings from the same feature: a render into a `WebGLRenderTarget` skips tone mapping
and the sRGB output pass (convert in the sampling shader or it reads as a cave), and a
virtual camera standing behind a wall needs a `renderer.clippingPlanes` plane at the
portal surface — the classic trick's third component, easy to forget because the main
camera never needs it.

---

### A half-built scene answers questions too

§18.13's rule — never render mid-build — stopped the HOSTS from drawing a scene whose
nodes still sat at raw glb origins. But the geometry channel (`groundAt`) kept
answering during that window, and an NPC's ground snap trusted it: the goober snapped
to a surface that only existed mid-build, ended up a metre under the real floor, and
his short ground ray (feet + 0.5) — now starting BELOW the floor — never saw it
again. Austin found Scene 2 empty; the monster was there all along, walking in the
underworld. No error, ever. It looked like a missing element, and the element was
fine.

**Lesson: a mid-build scene must not answer questions, and one bad snap must not be
forever.** `groundAt`/`groundInfo` now return null while `build()` is in flight, and
the NPC snap clamps per-tick movement and retries from head height on a miss — a
buried NPC climbs back out on its own.

---

### A cache is a haunting waiting to happen

glbs are cached across scene changes — deliberately, they're expensive. But a MOUNTED
item's mesh had been re-parented INTO the character's hand bone, and the character's glb
is the same cached object in every scene. Result: the scene changed, the inventory
vanished, and the key's mesh stayed welded to the hand — invisible to every sweep
because it no longer lived under its own glb's top nodes. Equipping the lance put two
items in one grip.

**Lesson: when you re-parent a node OUT of its cached home, every cleanup that walks
the home tree misses it.** Track the way back (`userData.ae1Parent`) and enforce the
invariant at both ends: the mount evicts other tenants from the bone, and the build
sends every unclaimed mounted mesh home.

The sequel was worse: the twice-claimed-node rule (a carried bazooka meeting the
scene's rack copy) hands the second claimant a CLONE — and the claim pass re-resolved
every build, so in the NEXT scene, with no competitor, the carried item bound the
ORIGINAL again and the clone was orphaned: visible, mount-scaled ×10, parented to a
cached hand bone, owned by nothing. Austin met a 25-metre bazooka hanging in the sky.

**Lesson: a binding must be stable, and an unowned mesh must not exist.** An element
that ever received a clone keeps it; any clone its element no longer binds is removed
at build. If no update will ever move, hide, or rescale an object again, deleting it
is the only honest cleanup.

---

### userData is a JSON grave

Three faces of one bug, found weeks apart: fade-material twins stored in `userData`
became junk on clone (invisible weapons); the mount's `ae1Parent` Object3D stored in
`userData` made `clone()` THROW on a circular structure — killing the claim pass
mid-loop and unbinding every element after it (invisible weapons again, new
mechanism); and any bone or node cached in `userData` was one clone away from the
same grave. `Object3D.copy` does `JSON.parse(JSON.stringify(userData))` — that is
the contract.

**Law: no Object3D, Material, or any live reference in `userData`. Ever.** Direct
properties survive as references on the original and — correctly — do not transfer
to clones, which re-derive their own caches. Booleans and strings may stay.

---

### The editor clobbers disk edits, and PowerShell writes BOMs

Two authoring-pipeline traps from one feature: appending elements to a scene JSON on
disk while the editor was OPEN did nothing — continuous journaling re-saved the
in-memory scene over it moments later. Park the editor off the page (or go through the
store) before editing scene files by hand. And the fix re-broke itself: Windows
PowerShell 5.1's `-Encoding utf8` writes a BOM, and the server's `json.loads` refuses
it — "Could not load scene" with a perfectly valid-looking file. Write scene JSON
BOM-less (`[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`), the same
lesson the forges learned as readers (`utf-8-sig`), now learned as a writer.

---

## Two false alarms

Twice I nearly "fixed" working code:

**A door click did nothing** — `pick` had correctly returned a leftover trigger volume sitting
on top of it.

**A door refused the key** — a dedupe had kept an untagged leftover player, so the actor fell
back to the stub whose `has()` is always false.

Both times the engine was right and the **test data** was wrong.

**Lesson: when a test fails, suspect the test.** AE1's engine has been correct more often than
its tests have.

---

## The meta-lesson

Sort the bugs above by how they were found:

| Found by | Count |
|---|---|
| Loading the page and clicking | most of them |
| Reading the code | ~none |
| A thrown exception | a few |
| **Silence** | **the worst ones** |

The bugs that cost real data — the typo that deleted `dat`, the rebuild that destroyed the
build, the sounds that would have shipped pruned — produced **no error at all**. They looked
like nothing happening.

**Drive the thing. Watch what it does. Distrust silence.**

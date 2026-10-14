# AE1 — Angel's Egg 1

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

A local, browser-based game creation engine. Point-and-click adventure games first;
architected so that other project types slot in without rework.

> **This file is the decision record — the *why*, including the mistakes that shaped it.**
> Code comments cite it by section (`DESIGN.md §7.1`).
>
> For *what is*, read [`docs/`](docs/README.md): a guide for making games, and engine docs for
> working on AE1 itself. To pick this project up cold, start with
> [`respawn.md`](respawn.md).

**Status: the loop described in §0 is closed.** Project list → wizard → scaffold → author →
import media → script → play → build → a game anyone can host or double-click.

Built and verified: the launcher and server; the project list and wizard; the Blender-style
area system (§9.1); the element/scene model (§5); continuous journaling (§3.1); the Angel
Script compiler (§6) with a working `super`, inheritance chains, dat merging, and runInfo
validation; the scheduler and game loop with Play mode (§7); the Media Collection (§4.1); and
build & ship (§8).

The end-to-end proof: in a **built, exported** game — clicking the cook gives a hint, hovering
the door describes it, clicking it calls `super.use()` up a `Door → Openable → AE1Element`
chain, and a lamp swings on `onTick`. The build pruned an unreferenced asset, and the game
requests only `index.html` plus its images.

Also built: the **persistent HUD layer** with a built-in `Inventory` (§12), **scene navigation**
(§13) with an AGS standard library, **audio** (§14), and **undo/redo** (§15).

*Verified:* a locked door refuses without the key; an NPC grants it; the door calls
`goToScene("Scene 2")` — and **the inventory arrives in Scene 2 still holding the key, as the
same instance**, while Scene 1's elements are dropped. Stop restores everything.

**Not yet built:** the 3D project type (§10), animation tooling, spritesheets, and dialogue
trees.

---

## 1. Principles

These are the tiebreakers. When a decision is close, the higher principle wins.

1. **The filesystem is the only source of truth.** The browser is a disposable view.
   Nothing important survives in the browser, so nothing can be lost by closing it.
2. **One code path.** The editor and the exported game run the same engine, the same
   AGS compiler, the same scene loader. "Works in the editor, breaks in export" must be
   structurally impossible, not merely tested against.
3. **The export is readable.** Mods and authorship use the same surface. Structured JS,
   JSON scenes, loose `.ags.txt`. Compression is the host's job; clarity is ours.
4. **Simple to the novice, unbounded to the expert.** Every feature must have an obvious
   default and a scriptable escape hatch.
5. **Built to last.** Prefer stdlib and vendored dependencies over anything that rots.
   No CDN, ever.

---

## 2. Topology

```
server.ps1 ──> resolves the `py` launcher (NOT bare `python`; see §2.1)
           ──> bootstraps .venv, pip install -r requirements.txt (first run only)
           ──> launches server.py on :8000
           ──> opens Brave in incognito at http://localhost:8000

server.py  ──> stdlib http.server + custom handler
           ──> REST over /projects and /exports
           ──> multipart upload for media
           ──> serves /engine, /editor, /vendor

browser    ──> thin client. Editor UI + engine runtime.
```

### 2.1 Python resolution

On the dev machine, bare `python` resolves to the WindowsApps stub, which opens the
Microsoft Store rather than executing. `server.ps1` must resolve the interpreter via the
`py` launcher and fall back to explicit paths, filtering out any path under
`\WindowsApps\`. This is a documented first-run failure for anyone who clones this.

### 2.2 Why incognito is a feature

Incognito wipes localStorage on close. Rather than fight this, it enforces Principle 1:
a feature *cannot* be built that depends on the browser durably holding state, because the
browser doesn't. The memory model is correct by construction.

---

## 3. Storage model

| Layer         | Holds                                                   | Lost on close? |
|---------------|---------------------------------------------------------|----------------|
| Filesystem    | Projects, scenes, media, scripts. Plus `settings.json`:  | No             |
|               | panel layout and theme — see §9.2.                      |                |
| localStorage  | Throwaway session state only (last-opened project).      | Yes, harmless  |
| IndexedDB     | Decoded media cache, keyed by content hash.              | Yes, harmless  |
| JS heap       | Active scene + its referenced media only.                | Yes, by design |

**No cookies. No sessions.**

Media resolves lazily by hash through a cache with an eviction budget. A 400-asset project
never holds 400 assets in memory. Switching scenes drops the previous scene's handles.

### 3.1 Persistence: continuous journaling

`beforeunload` cannot await a network request. "Save on close" as a discrete action is not
implementable — the page is gone before the request lands.

Inverted: **every meaningful edit journals to the server as it happens.** Disk is never
more than a moment stale. Therefore:

- "Close = autosave" is trivially true; it already happened. The notification is honest.
- Crash, power loss, or a browser update costs nothing.
- Switching workspaces is a journal flush and a manifest load. No save prompt.
- **Save** is repurposed: it marks a **named, restorable snapshot** — a version, not a
  persist. This is the more valuable button.

Trade accepted: no "undo by quitting." Revert and snapshot restore carry that weight
instead. Delete and revert become correspondingly more important to get right.

**This is the developer's project, not a player's playthrough.** Journaling persists the game
being *built*; the entirely separate player-save system (§16) persists a game being *played*.
See the table at the top of §16 — the two share no code.

---

## 4. On-disk layout

```
server.ps1
server.py
requirements.txt
/engine                     runtime: loop, render, scheduler, AGS compiler,
                            physics, pathfinding, audio, AI
/editor                     the IDE: project list, wizard, scene workspace
/vendor                     three.js et al, vendored. no CDN.
/projects
  mygame.ae1proj            name, metadata, engine version, → folder pointer
  /mygame
    /scenes      *.json
    /media       <hash>.<ext>        content-addressed
                 manifest.json       hash → friendly name, tags, import settings
    /scripts     *.ags.txt
    /snapshots   <timestamp>/        named versions from the Save button
/exports
  /mygame                   self-contained, drag-droppable to any host
```

### 4.1 Content-addressed media

Media files are named `<sha256[:32]>.<ext>`; `manifest.json` maps hash → friendly name, kind,
size, and tags. This gives, for free:

- **Dedup.** One footstep sound used in 40 scenes exists once on disk and once in export.
  Re-importing identical bytes is a no-op, not a duplicate — dropping the same folder twice
  costs nothing. *Verified: same bytes under a different name returns `duplicate: true`.*
- **Cheap rename.** Renaming touches one manifest line, never a file or a reference.
- **Safe reference.** Scenes reference hashes, so a reference can never dangle from a rename.
- **Free `immutable` caching.** The filename IS the hash of the bytes, so those bytes can
  never change — media is served `public, max-age=31536000, immutable` while every other
  route stays `no-store`. That is why a scene with 200 sprites doesn't refetch them all on
  reload. Live authoring source must never be cached: a stale editor file would show old work
  and look exactly like data loss.

**Uploads are raw bodies, not multipart.** `cgi.FieldStorage` — the stdlib's multipart parser
— was **removed in Python 3.13**, and the browser can POST a `File` directly. One request per
file also gives per-file progress and per-file failure, which one batched multipart post
cannot. The filename rides in `X-Filename`, percent-encoded, because headers are latin-1 only
and asset names are full of spaces, accents, and CJK.

**Delete is refused while an asset is in use.** Content addressing stops a reference dangling
on *rename*, but nothing stops a *delete* — and a scene of invisible broken sprites is a
miserable thing to debug. The dialog names the elements still using it.

**One import failure must not sink the batch.** Dropping forty assets and losing all of them
because one was a broken PNG would be infuriating; failures are reported per file and the
rest proceed.

**No IndexedDB layer.** §3 reserved one for decoded media. It isn't needed: AE1 serves from
localhost and content-addressed files are `immutable`, so the browser's own HTTP cache already
IS that layer. Building another would be a cache in front of a cache. `engine/media.js` keeps
a small LRU of decoded `Image` objects (count-based — the honest limit is "how many can be on
screen and recently used") and evicts beyond it, which is the "pull when needed, never hold
400 assets" half of the memory model. Revisit only if profiling says otherwise.

---

## 5. Data model

**Prototypes now, components as element properties.**

A scene is a JavaScript object holding elements, which are JavaScript objects. AGS is an
**abstraction over that object system** — it is how an author configures a JS element
without writing engine plumbing. Nothing more exotic than that.

At load, for each element:

| From AGS         | Applied to the JS element |
|------------------|---------------------------|
| `dat` section    | instance properties       |
| method bodies    | methods                   |
| generated UUID   | `id`   (immutable)        |
| authored name    | `name` (random if absent) |
| `extends`        | prototype chain           |

Because `dat` becomes real properties on the element, a script reading `this.locked` is
reading the same field the properties panel edits and the scene file stores. **One value,
one place.** That identity is the entire point of the abstraction — there is no bridge to
keep in sync, no serialize/deserialize step, and no way for the editor and the runtime to
disagree about what an element is.

### 5.1 The base element

Every element inherits from `AE1Element` before anything an author writes. The property set
is drawn from `java.lang.Object` (identity), a commercial engine's `AActor` (transform, lifecycle, tags),
and Blender's 2D plane object (dimensions, parent, visibility) — because those three have
already converged, over decades, on what an object in a scene needs to be. Competing with
simple tools early means giving authors the standard vocabulary from day one.

| Group      | Properties                                                    |
|------------|---------------------------------------------------------------|
| Identity   | `id` (UUID, immutable), `name`, `type`, `tags[]`               |
| Transform  | `x`, `y`, `layer`, `rotation`, `scaleX`, `scaleY`              |
| Dimensions | `width`, `height`                                              |
| Render     | `visible`, `opacity`, `flipH`, `flipV`                         |
| Hierarchy  | `parent`, `children[]`                                         |
| Lifecycle  | `onLoad`, `onUnload`, `onTick`                                 |
| Object     | `toString()`, `equals(other)`, `clone()`                       |

Every property has a getter and a setter (`getName()`/`setName()`, `getX()`/`setX()`), and
setters chain. Both `el.setX(5)` and `el.x = 5` route through the **same** accessor, so both
are observable — the values live in a private `_props` bag behind real property descriptors.

That is not a detail. AGS methods will write `this.locked = false` directly, and continuous
journaling only works if the engine *sees* that write. Storing values in plain fields would
make the accessors decorative and let every script mutation vanish unsaved.

### 5.2 The schema is the source of truth

`ELEMENT_SCHEMA` in `engine/element.js` declares each property once — group, label, type,
default, range. From that single declaration AE1 generates:

- the property accessors
- the `getX()`/`setX()` pairs
- **the entire Properties panel**
- defaults and serialization

Adding a property to every element in the engine is one line. Nothing else learns about it.
This is the same instinct as `runInfo` living in the `def` block: declare it once, let the
machinery read the declaration.

> **Watch the defaults.** `name` must default to `''`, not `'Element'`. A non-empty default
> is truthy and silently shadows the generated fallback name in the constructor, so every
> element arrives called "Element" — an Outliner of identical rows, which is no Outliner at
> all. Cost me a bug.

### 5.3 Inheritance vs. components

```jsonc
{
  "id": "8f14e45f-...",           // UUID, immutable
  "name": "Kitchen Door",         // authored, or generated
  "extends": "Openable",          // → JS prototype chain
  "parent": null,                  // hierarchy — distinct from `extends`
  "x": 880, "y": 220,              // base properties, flat on the element
  "width": 120, "height": 260,
  "layer": 1, "visible": true,
  "components": {                  // optional data bags
    "sprite":   { "media": "a3f9c2…" },
    "collider": { "shape": "rect" }
  },
  "script": "door.ags.txt"
}
```

**Base properties vs. components** — an earlier draft put `transform` inside `components`
while §5.1 put `x`/`y` on the base element. Those contradicted. Resolved:

> **Base properties are what every element HAS. Components are what an element MAY have.**

A transform is not optional — there is no element without a position — so it is not a
component. A sprite or collider is optional, so it is. This also keeps `this.x` working in
AGS without a components lookup.

**`extends` vs. `parent`** are different axes and must never be conflated. `extends` is the
prototype chain (behaviour); `parent` is scene hierarchy (position, grouping). A door can
extend `Openable` while parenting a trigger volume.

Hierarchy is stored as a `parent` id **on the child only**, never as a `children` array on
the parent. One direction means one thing to keep true; two means two things that can
disagree, and every reparent would have to update both atomically.

- **Inheritance** carries identity and behavior (`Openable`, `Talkable`, `Carryable`).
- **Interfaces** are just elements with no visual representation that others `extend`.
  No new machinery — exactly as specified.

### 5.3.1 Spritesheets: the frame is data, the animation is behaviour

Spritesheets are a `sprite` component setting, as this section always said they would be.
What that meant in practice took one decision:

> **A spritesheet is nothing more than "draw region R of image I".**

So the frame lives in the component — `frameWidth`, `frameHeight`, `columns`, `frame` — and
the **default renderer path** reads it, switching to the nine-argument `drawImage`. A frame
size of 0 means an ordinary picture; there is no separate "is a sheet" flag to disagree with
the frame size. `AE1Sprite` (`(extends Sprite)`) adds **only the motion**: clips, `fps`,
`play`/`stop`, driving `frame` on a clock.

**`AE1Sprite` deliberately has no `draw()`** — the one built-in that doesn't. Everything it
would have had to reimplement, it instead inherits by never leaving the path every ordinary
element already takes: rotation, flip, opacity, the still-decoding placeholder. A sprite is
the thing you most want to flip (a walk cycle facing left is the same sheet mirrored), and
§12.3 explains why owning `draw()` used to mean losing exactly that.

The split also means the frame attributes work **without** the class: a plain element can show
frame 4 of an atlas from the Properties panel. `(extends Sprite)` is what you add when you
want it to move. That is what lets a future dialogue portrait or a hover-frame button use a
sheet without inheriting from `Sprite` — which matters, because `Button` already extends
`Text` and JavaScript has no multiple inheritance.

Clips are `(animations (walk 0 7) (idle 8 11))` — nested arrays of primitives, which is
exactly what the reader produces, what `structuredClone` copies, and what `serialize()`'s JSON
comparison can compare. A richer shape (objects, per-clip fps) would quietly break all three.

**`COMPONENT_SCHEMA`** (`engine/element.js`) exists because of this feature. Components had no
declaration anywhere, so the Properties panel could not show them: a sprite could only be set
by dropping art onto the viewport, and could never be edited afterwards. Now the panel is
generated from the declaration, exactly as it is for `ELEMENT_SCHEMA` — one more property is
one more line. A component is shown only when the element **has** it, because absent and blank
are different states.

Writes go through `setComponent(slot, key, value)`, which replaces the bag rather than mutating
it (a snapshot taken before the write must not change under the caller — that is what makes
play-mode restore trustworthy) and notifies once. `AE1Sprite` advances a frame through the same
door twelve times a second, which is safe only because **the journal is silent during play**
(§3.1). If the editor ever previews animation live, that is when this needs a transient
sibling — not before.

### 5.4 The store, and why editors don't know each other

`editor/js/scene-store.js` owns the loaded scene, the selection, and the journal. Editors
read from it and subscribe to it; **they never talk to each other**. Six panes that all know
each other is a graph; one store they all observe is a star, and only the star still makes
sense when the seventh pane arrives.

The store is editor-only. `/engine` carries no selection and no journal, because the exported
game has neither (Principle 2).

Journaling notes worth keeping:

- Saves are **debounced** (~350ms). Dragging an element fires a mutation per pixel.
- Saves **never overlap**. Two in flight can land out of order and write an older scene last,
  silently reverting the newest edit. A save in progress sets a flag and re-flushes after.
- Writes are **atomic** server-side (temp file + replace). A crash mid-write would corrupt
  exactly the work the journal exists to protect.
- `pagehide` + `sendBeacon` is a **backstop, not the plan** — and since sendBeacon can only
  issue POST, the scene route accepts POST alongside PUT solely for it.

---

## 6. Angel Script (`.ags.txt`)

AGS is **not an interpreted language**. It is a preprocessor that compiles to a JS class on
the element's prototype chain. `dat` becomes instance fields, `def` becomes the class
metadata and inheritance, methods become methods. Cost: AGS may never diverge far from JS
syntax. Benefit: ~200 lines of engine instead of an interpreter; `super.onClick()` simply
works; devtools debugging is free; it will still be correct in ten years.

### 6.1 Why the declarative sections are LISP

`dat` and `def` are s-expressions. `dat` declares what an element *is*; `def` declares how it
*behaves* and what it *inherits*. Both are declarative, so both are data — and in LISP, data
and declarations are the same notation.

This is not an aesthetic choice. It means **one reader parses both sections.** A single
~100-line s-expression reader, with no grammar to extend when a new declaration form appears,
because every form is already just a list. Adding `(mixin …)` or `(export …)` later costs
nothing at the parser level.

The third section needs no delimiter. The reader consumes s-expressions greedily; **the first
token that isn't `(` begins the JavaScript.** The format parses itself.

### 6.2 Format

```
<?dat
(health 100)
(locked true)
(key "brass_key")
(inventory ())
?>
<?def
(extends Openable)
(name "Kitchen Door")

(runInfo use  (onClick onCall))
(runInfo look onHover)
(runInfo think onTick)
(runInfo tidy  onUnload)
; helpers need no runInfo — they default to onCall

function use(actor) {
  if (this.locked && !actor.has(this.key)) return this.say("It's locked.");
  this.setLocked(false);
  super.use(actor);
}
function look()  { return this.say("A heavy oak door."); }
function think() { /* every tick while in scene */ }
function tidy()  { /* release handles, stop audio, clear timers */ }
ags?>
```

Everything in `dat` lands on the element as a real property, so `this.locked` in a method and
`(locked true)` in the file are the same field (§5). Accessors are generated for each: a
`dat` entry gets `getLocked()`/`setLocked()` for free.

### 6.3 `runInfo`

| Value                          | Meaning                                                |
|--------------------------------|--------------------------------------------------------|
| `onLoad`                       | Once, after the element renders and loads into scene.   |
| `onUnload`                     | Element leaves the scene. **Release everything here.**  |
| `onTick`                       | Every tick while present in the scene.                  |
| `onCall`                       | Invoked by another function or element. **Default.**    |
| `onClick`, `onHover`, `onExit`, `onDrag` | Engine input events.                      |
| `void`                         | Reserved/experimental. Handled as `onLoad`.             |

Arrays are permitted: `['onClick', 'onCall']` means the player clicking the door and a
cutscene script opening the door run the same code, written once. This is the most common
authoring pattern in the genre; it should be free.

> **Naming risk — `void`.** In every mainstream language `void` means "returns nothing."
> Here it means "runs on load." Expect authors to apply it to helpers and be surprised by a
> call at scene start. Flagged while renaming is still cheap.

### 6.4 Compilation

**How `super` works — the load-bearing trick.** The methods section is scanned for top-level
`function` declarations, which are rewritten `function use(a) {…}` → `use(a) {…}` and emitted
inside a real class body:

```js
new Function('__Base', `"use strict"; ${topLevelStatements}
  return class extends __Base { ${methods} };`)
```

This matters because **only class methods and shorthand object methods get a
`[[HomeObject]]`.** A plain function assigned onto a prototype does not, and `super` inside
it is a syntax error. Emitting real class methods buys the entire inheritance story — `super.use()`,
multi-level chains, overriding — for free from the language, with no engine machinery.

Verified working: two-deep `super` chains, dat merged down the chain, async and generator
methods, and `(runInfo use (onClick onCall))` registering one method in two tables.

**Scanner limitation, documented honestly.** Function bodies are skipped whole (so nested
declarations are never mistaken for top-level ones), and strings, template `${}` holes, and
comments are handled. A regex literal containing an unbalanced brace (`/\{/`) can confuse the
scan; detecting regex-vs-division needs a full JS tokenizer. The failure is **loud** — the
emitted class fails to parse and surfaces as a Console error — never silent corruption.

> **Only DIFFERENCES from the declared default are persisted.** `serialize()` writes a dat key
> only when its value differs from the class's `agsDat`.
>
> Writing every dat key made a script's declaration decorative: the moment an element was
> saved, its values were baked into the scene file, and editing `(trackProps …)` in the script
> changed nothing forever after — the author edits the design and sees no effect, with nothing
> to explain why. That was a real bug, found by editing a save handler's tracked properties and
> watching it ignore me.
>
> Persisting only differences gives the semantics you actually want:
> *never touched* → absent → follows the script, including later edits.
> *customised* → present → your value survives a script edit.
> Smaller scene files besides.

**`dat` is live state, not just a declaration.** A door unlocked during play must persist as
unlocked, so dat values serialize into the scene alongside schema properties. Dat is a
*default*, not a constant: the saved scene wins.

**Never downgrade an element because its script failed to compile.** This cost a real
data-loss bug. On a compile error there is no compiled class, so `_rehydrate` rebuilt the
element as plain `AE1Element` — which knows nothing of the script's dat keys, so they vanished
from `_props`, and the next journal write persisted a scene without them. **A typo silently
destroyed the author's data.** A broken script means "I cannot build a better class right
now," never "discard this element's state." Two fixes, both kept:

1. If an element has a script that did not compile, keep the existing instance untouched.
2. `AE1Element` preserves any key it does not recognise (`_extra`) and serializes it back.
   An element must never delete data merely because it does not currently understand it.

**`runInfo` inherits, exactly like `dat`.**

Without this, a subclass that inherits behaviour loses its scheduling. A `Bram` that
`(extends Kid)` and defines no methods of its own had an **empty** runInfo — nothing registered
for `onClick`, so clicking him did *nothing*. The class was right, the methods were there, the
compile was clean; he simply never got called. This is the template-method pattern — a `Kid`
base with `talk()`, subclasses overriding only `speech()` — which is the *natural* way to write
a cast of characters, and it was silently broken until real content exercised it.

**Inheriting behaviour must mean inheriting when it runs.** `buildClass` merges
`Base.agsDef.runInfo` under the subclass's own.

That forced a second change. `compileAGS` sees one file, so it cannot know whether a runInfo
method is inherited — erroring there would reject the ordinary case of a subclass rescheduling
an inherited method. So per-file validation **skips files with `extends`**, and `compileAll`
re-validates against the real prototype once the chain is built. Rename-drift is still caught,
now across inheritance too — the half of the check a per-file compile structurally cannot do.

> **Two comment syntaxes, one file.** `;` in `dat`/`def` (LISP), `//` in the methods
> (JavaScript). Inherent to the format's split, and easy to trip over — I did, immediately, by
> writing `;` inside a method body. The compiler reports it as a JS syntax error naming the
> file, which is survivable but not obvious. Worth a lint if it bites often.

### 6.5 Two traps the greedy reader creates

The reader stopping at the first non-`(` token is what makes the format need no delimiter.
It also creates two mistakes an author will make on their first real script — both silent, both
now caught with a diagnostic that names them.

**Declarations must all precede the first function.** Writing each `(runInfo …)` beside the
method it describes is the *natural* way to want to write this — and it puts every later form
in the JavaScript, producing a baffling `Unexpected identifier`. It bit me twice in one
session, and my own hamburger template shipped with the bug. `STRANDED_RE` detects a def form
in the JS section and explains exactly what happened. Matched by form NAME (`extends`, `name`,
`runInfo`) rather than a leading `(`, so real JavaScript like `(function(){})()` is never
mistaken for a declaration.

**dat cannot shadow a built-in element property.** `(visible false)` is silently ignored — the
scene file always carries a value for every schema key, and the scene wins — leaving the author
wondering why their element is on screen. Now a warning naming the property and where to set it
instead. `BASE_PROPERTIES` is duplicated in the compiler rather than imported from
`element.js`, so the compiler stays importable alone; a missed entry costs a warning, never a
wrong compile.

### 6.6 Built-in classes need static `agsDef` and `agsDat`

`buildSchedule` reads `constructor.agsDef`, and built-ins have no *compiled* def — so a bare
`Video` or `Button` with no script attached would never receive `onLoad`, `onClick`, or
anything else. Declaring a static `agsDef` fixes it, and `buildClass` merges it down the chain
so a script that extends the built-in inherits its wiring and can add its own beside.

Likewise `buildClass` defines dat accessors for compiled scripts only, so a built-in must call
`defineDatAccessors(Cls)` itself — otherwise its dat sits in `_props` with nothing able to read
it, and `this.video` is `undefined` on the element that owns the video.

**Other properties:**

- The scheduler tables need **only the `def` block**, so `compileAGS(src, {defOnly:true})`
  builds them without paying for `new Function` per script — the runtime's path for large
  scenes. The editor compiles eagerly, because it wants diagnostics the moment you stop typing.
- The compiler **validates that every `runInfo` names an existing method**. This is the
  declaration table's one weakness — drift on rename — and catching it is the entire reason
  to validate. Verified: renaming `touch` → `tuoch` surfaces in the Console within a keystroke.
- Inheritance cycles are **named** (`a → b → a`), not left to blow the stack.
- The compiler ships **in the runtime**, and `.ags.txt` ships **loose** in the export.
  Load-time compile is microseconds. Mods and authorship use the same surface (Principle 3).

---

## 7. Scene lifecycle

```
load manifest → resolve extends chains → parse def blocks → build scheduler tables
              → onLoad pass → tick loop {onTick set, input events} → onUnload pass → drop handles
```

The scheduler holds a **flat array per run mode**, built from `def` blocks at load — never an
iterate-all-elements-and-check-per-frame. This is the difference between a scene of 500
elements running at 60fps and not, and it is only cheap because the format declares run modes
separately from the method bodies.

`buildSchedule(elements)` and `dispatch(tables, mode, ...args)` are implemented in
`engine/ags/runtime.js`. `dispatch` catches per-method, because one bad script must never take
down the loop — a thrown `onTick` should cost that element, not the game.

**Rehydration** is the moment the abstraction lands: when an element's script compiles, the
element is rebuilt on its compiled class — dat becomes instance properties, methods land on
the prototype, the UUID stays the id, the authored name stays the name. `AE1Scene.replace()`
preserves identity, so selection, hierarchy, and every `parent` reference survive.

### 7.1 Play mode

> **Playing must not edit the project.**

A running game mutates elements by design — a door unlocks, a counter increments, a lamp
swings. With continuous journaling (§3.1) every one of those writes would stream to disk, so
pressing Play would permanently rewrite the author's scene into whatever state they happened
to stop in. Unity has shipped this confusion for a decade.

So Play is a **rehearsal, not an edit**:

1. Flush pending edits, then snapshot `scene.serialize()` — the same representation the disk
   holds, so what you return to is exactly what was saved.
2. Suspend the journal. One guard in `journal()` is what makes the whole guarantee hold.
3. On Stop, rebuild the scene from the snapshot. Restoring rather than undoing means there is
   no mutation a script can make that we fail to reverse.

Consequences that are easy to miss and were all real bugs or near-misses:

- **The unload beacon must save the snapshot, not the live game.** Closing the window
  mid-play would otherwise do exactly the damage suspending the journal prevents.
- **`close()` stops play first**, or a rAF loop outlives the scene and a snapshot restores
  over the *next* project opened.
- **Rehydrating mid-play must rebuild the scheduler tables.** They hold `{element, method}`
  pairs pointing at the old instances; without a rebuild the loop keeps dispatching to
  orphans and visibly ignores every edit. With it, script edits take effect live, mid-play,
  carrying current state across.
- **The save indicator must say "Not saving."** `play()` flushes without awaiting, so that
  flush resolves *after* the play event and overwrites the label — the indicator lying at the
  exact moment its honesty matters most. The dirty handler ignores events while playing.
- **In play mode the viewport is a game, not an editor.** A click fires `onClick` instead of
  selecting; selection chrome is hidden. Nudging an element mid-play would edit state Stop is
  about to discard — work the author would watch vanish.

Play mode is signalled hard: a green rail around the workspace, a green game frame, an amber
"Not saving", and a HUD reading `▶ PLAYING · 241f · 3.2s · changes discarded on stop`. An
author who forgets which mode they are in loses work.

### 7.2 Loop details

- **`dt` is clamped to 100ms.** `requestAnimationFrame` stops in a background tab, so the
  first frame back reports the entire time away — unclamped, that single dt teleports every
  moving element and detonates any physics. The game runs slow instead of exploding.
- **`onHover` fires on enter, `onExit` on leave** — not every frame while over. Per-frame
  hover would just be a second `onTick`, and leaves authors no way to say "on entry".
- **One bad script costs that element, never the game.** `dispatch` catches per method: an
  unplayable game is a far worse failure than one misbehaving door, and the author needs the
  game running to debug the door at all. Throws land in the Console.
- **`GameLoop` does NOT dispatch onLoad/onUnload.** Scene lifecycle belongs to the world —
  `goToScene` fires onUnload for the outgoing scene and onLoad for the incoming, and
  `world.start()` fires the HUD's onLoad once. When the loop *also* dispatched them, every
  element in the entry scene got onLoad **twice**: a script playing a sound on load played it
  twice, a counter counted two. Two owners for one responsibility is one owner too many. The
  loop owns `onExit` on stop, because hover is loop state.
- **`tags` earn their keep**: an element tagged `player` becomes the actor passed to every
  `onClick`. No player tagged → a stub actor whose `has()` returns false.
- **Rendering is deliberately NOT in `GameLoop`.** The editor draws with the viewport's
  pan/zoom; the exported game draws to fill the window. Keeping draw out of the loop is what
  lets one loop serve both (Principle 2).

---

## 8. Export / build & ship

Server writes `/exports/<name>/` directly. `exporter.py`.

### 8.1 The constraint that shapes everything

> **An exported game must play by double-clicking index.html.**

A `file://` page cannot `fetch()` its own scenes and cannot load ES modules — both are blocked
by origin rules. So the export **inlines the engine, the scenes, and the scripts** into
index.html as one classic `<script>`, and leaves media as loose files, because `<img src>` is
one of the few things `file://` still permits. (Those images taint the canvas, which costs
nothing: the game never reads pixels back.)

*Verified:* a built game makes exactly **five** network requests — `index.html` and four
relative-path PNGs. No module loads, no scene fetch, no script fetch, no API calls. Those are
exactly the requests `file://` allows.

`crypto.randomUUID` is **secure-context gated**. `file://` is specified as potentially
trustworthy, but that is not something to bet a shipped game on — if it were ever unavailable
the game would die the moment a script spawned an element. `uuid()` in `engine/element.js`
falls back to `getRandomValues`, then `Math.random`. For element ids, uniqueness is the
requirement; unpredictability is not.

### 8.2 The bundler

`bundle_engine()` concatenates the engine's ES modules into one classic script: strip
`import` lines, strip the `export` keyword, join in dependency order. This works **only**
because AE1 owns every module and keeps them to single-line named imports. It is a
concatenator for a known input, not a general bundler, and must never be pointed at
third-party code.

It **refuses on a name collision** rather than shipping one: concatenated modules share a
scope, so a duplicate top-level name would silently shadow, and the symptom would surface far
from the cause.

It also **refuses on an unlisted module**. `ENGINE_MODULES` is hand-maintained, deliberately —
dependency order is a thing to think about, not to infer. But the one mistake a hand-maintained
list invites is adding a file and forgetting to add it here, and that failure is silent and
total: the module is simply absent from the bundle while everything *referring* to it still
ships. Adding `sprite.js` and forgetting the entry produced a build whose `BUILTINS` table
named `AE1Sprite`, a class that did not exist — a `ReferenceError` on load, a black page, and
an export that reported **success with no warnings**. The editor was fine throughout, because
the editor loads real modules. That is the export-only break Principle 2 exists to forbid,
arriving through the build system itself.

Every `engine/**/*.js` must now appear in `ENGINE_MODULES` or the export fails, naming the
file. Order still has to be thought about; membership does not.

**Asset pruning follows names in dat, not only in scripts.** The collector keeps any imported
asset whose name appears in a script (`playSound("boing.mp3")`) — and, since a media name can
just as easily live in element dat, any asset named in a dat *value* too. A tour puts
`(video "Position_001")` as a per-element dat override so one shared script drives eleven
scenes; that name is invisible to both the sprite/hash sweep and a scripts-only scan, so without
the dat scan the videos prune to a **black build that plays perfectly in the editor** — the
export-only break Principle 2 exists to forbid. dat is author-owned, so every string value is
fair game; over-keeping costs bytes, wrongly pruning breaks the shipped game, and the trade is
not close.

Nothing is wrapped in an IIFE, so every engine symbol lands in global scope. That is
intentional — a modder in the devtools console of a shipped game wants `AE1Element` and the
compiler in reach (Principle 3).

### 8.3 Build steps

1. Collect scenes and scripts; **warn** on an element referencing a script that doesn't exist.
   A build is the moment to say "this will not work", not to ship it quietly.
2. Media: **prune unreferenced assets** (and `log()` what was dropped — silence reads as
   "everything shipped"), dedup by hash, optimize.
3. Bundle the engine; inline everything into `index.html`.
4. Also write `source/` — readable copies of scenes and scripts. The inlined ones RUN; these
   are what a modder reads and diffs.
5. `README.txt` explaining how to play and how to mod.

**No minification, no name mangling.** Scenes stay JSON, scripts stay text (Principle 3).
Gzip on the host recovers most of what minification would have.

> **Assets named only in scripts must not be pruned.** A sound reached solely via
> `playSound("bram-hey.mp3")` has no element pointing at it, so a sprite-only sweep prunes
> it and the game falls silent **in the build but not in the editor** — precisely the
> export-only failure Principle 2 exists to prevent. `collect_name_refs()` scans script text
> for asset names. Deliberately crude: an author can build a filename at runtime, so no static
> analysis can be complete. Over-keeping costs bytes; wrongly pruning silently breaks a shipped
> game. The trade is not close.

### 8.4 A build must never destroy the previous build

Builds go to `<out>.building` and swap in only on success. Deleting the old output up-front
cost a real failure: on Windows `rmtree` throws `WinError 32` if anything holds the directory
— a browser tab playing the game, an Explorer window, an antivirus scan — and by then it has
already half-deleted the working build. **A failed rebuild destroyed the last good one.**

If the swap itself fails, the old build is untouched, the new one waits in `.building`, and
the error names the likely cause. *Verified against a real lock.*

### 8.5 Optional dependencies stay optional

Pillow recompresses images if present. If absent — or if it throws, or if it makes a file
*bigger* — the original is copied and the build reports it plainly: *"The game is correct,
just larger."* A missing dependency changes the SIZE of a build, never its correctness, and
must never block one.

---

## 9. UI

Dark, minimal, sleek — the Blender / a commercial engine / Godot register. Dense but not busy.
Expandable top bar: settings, help, and room to grow.

### 9.1 The area system

Blender's model. The workspace is a binary tree; every node is a split (direction + ratio +
two children) or a leaf (one editor). Any leaf splits; any leaf closes and hands its space to
its sibling. Editors are a registry — `{ label, mount(el, ctx) -> dispose? }` — so the area
system never learns any editor's name.

Two things fall out of the tree rather than being built:

- **Maximize is "render this leaf alone."** The AGS editor's full-screen mode is not a second
  view or a code path; it is the same pane, momentarily unsiblinged. Choosing the harder
  layout model made the full-screen requirement free.
- **Any arrangement is expressible**, so the layout never needs extending for a new editor.

Panes are cached by leaf id and reused across re-renders, so an editor keeps its DOM, scroll
position, and canvas state when the tree around it changes. Divider drags mutate style
directly and never re-render — a rebuild per pointermove would remount every editor 60 times
a second.

Maximize is deliberately **not persisted**: it is a momentary view, and reopening a project
into a full-screen pane with the rest of the workspace apparently gone would read as data
loss.

**Ctrl+Space** is Blender's maximize shortcut, but Windows binds it to IME layout switching
and may swallow it before the page sees it. Double-clicking a pane header does the same thing
and cannot be intercepted. The shortcut is a convenience, never the only way in.

### 9.2 Where settings live — a correction

DESIGN.md originally filed panel layout under "localStorage, UI preferences only." That was
wrong. AE1 runs in incognito, so localStorage is wiped on every close — a layout the user
spent time arranging would reset every launch. Layout is *work*, not a disposable preference.

Durable UI settings (layout, theme) therefore live on the **server**, in `settings.json` at
the root. localStorage keeps only genuinely throwaway session state (last-opened project).
The principle was right; the filing was wrong.

Rule of thumb: **if the user would be annoyed to redo it, it goes to the server.**

**Project wizard** (modal, stepped, built to extend):
- Step 1 — name, metadata (author, description, …) → written to `.ae1proj`
- Step 2 — project type dropdown → currently only `point click adventure game`
- Create → scaffold directories, write `.ae1proj`, load the type's workspace template

Metadata is an open map. Project types are a registry. Both must accept new entries without
touching the wizard's core.

---

## 12. The persistent layer (HUD)

> **HUD elements live in the PROJECT, never in a scene.**

`hud.json`, beside `scenes/`. This is the whole reason they survive a scene change. If the
inventory lived in a scene, scene 1 and scene 2 would each hold their own copy and walking
through a door would silently reset it. One place, one instance, loaded once.

Consequences:

- HUD `onLoad` fires **once**, when the world starts. Scene `onLoad`/`onUnload` fire per scene.
  A HUD element never learns a scene change happened.
- HUD renders **above** every scene element and is hit-tested **first** — unconditionally, not
  by layer. An inventory hidden behind a background would be an unpleasant surprise, and there
  is no case where a scene element should occlude the HUD.
- The Outliner shows SCENE and HUD as separate sections. Hiding that distinction would make
  "why did my inventory reset?" an unanswerable question.

### 12.1 Built-in bases

`Element`, `Text`, `HudElement`, and `Inventory` are registered in `BUILTINS` (ags/runtime.js),
so an author writes `(extends Inventory)` and it resolves through the **same chain resolution**
as `(extends Openable)`. HUD elements needed no new machinery — this is the "hidden elements
that act like interfaces" idea from the original spec, finally doing real work. An author
cannot tell which bases the engine ships and which they wrote, and should not have to.

> **`HudElement` does not confer persistence.** Persistence comes from which layer an element
> lives in — `hud.json` vs a scene — and nothing else. `AE1HudElement` only affects draw and
> pick order.
>
> It originally set `this.isHud = true` in its constructor. That flag was **written once and
> read nowhere**, and worse, it was a lie waiting to happen: `(extends Text)` on a HUD element
> would report `isHud === false` while persisting perfectly. It is now a getter on
> `AE1Element` that asks the world, so it cannot drift from the truth.
>
> This is why `Text` extends `AE1Element` and works in both layers — there is no
> multiple-inheritance problem to solve, because persistence was never about the class.

### 12.5 Video

`AE1Video` (`engine/video.js`), built-in `Video`. A `<video>` drawn with `drawImage` via the
**`draw()` hook** — not a DOM overlay. An overlay would sit outside the canvas, ignore the
letterbox transform, and be impossible to layer elements over. `drawImage` puts video *in the
scene*, so a text prompt can sit on top of it and the camera applies to both.

(drawImage from a `file://` video taints the canvas. Costs nothing — the engine never reads
pixels back.)

**A built-in needs a static `agsDef` to have lifecycle.** `buildSchedule` reads
`constructor.agsDef`; built-ins have no *compiled* def, so a bare `Video` with no script
attached would never start or stop. `AE1Video.agsDef` declares `_videoBegin: onLoad` and
`_videoEnd: onUnload`, and `buildClass` merges it down the chain so a script that
`(extends Video)` inherits them and can add `(runInfo finish onEnded)` beside.

**A built-in also needs its own dat accessors.** `buildClass` defines them for compiled
scripts; a bare `Video` never goes through the compiler, so its dat would sit in `_props`
with nothing able to read it — `this.video` would be `undefined` on the element that owns the
video. `defineDatAccessors(AE1Video)` at module level. `defineDatAccessor` moved to
`element.js` for this: it is about elements, not compiling, and video importing the compiler
would be circular.

`onEnded` is a real `RUN_INFO` mode, dispatched by `AE1Video` through `loop.dispatchTo`, so an
author writes `(runInfo finish onEnded)` like any other mode rather than learning a video-only
convention. Never fires while looping.

Videos are paused **and their source dropped** on eviction and unload — pausing alone leaves
the decoder alive. The cache holds 4: a decoder is far more expensive than pixels.

> **Two AE1Video elements naming the same file share one `<video>`.** The cache is keyed by
> hash. Normal use (one video per file) is fine; two elements playing the same file would
> fight over `currentTime`. Not yet a real case; fix by keying per element if it becomes one.

#### 12.5.1 The poster frame, and video in the editor

**Video already played in the editor** — during Play, where the viewport drives its own rAF.
What did not work was *authoring*: the editor draws on demand, so a video at rest sits on frame
0 forever, and frame 0 of an intro is usually black. Laying a title over it means laying it over
nothing.

`(poster <seconds>)` is the frame shown **at rest**. Play always starts from 0; this is authoring
metadata, and it lives in dat on purpose — it is the author's choice, it belongs to that element,
it survives in the file, it appears in the Properties panel for free, and it undoes like anything
else. The viewport's **Set poster** button writes it: scrub to the moment you are designing for,
pin it, and that is what the editor shows from then on. The UI writes data the script owns, which
is the same instinct as everything else here.

Stopping Play returns to the poster, not to zero — an author should be looking at the frame they
chose.

**The transport is chrome, not engine.** It drives `AE1Video`'s own `play`/`pause`/seek — the
same code the shipped game runs — so nothing about it can make the editor and the export
disagree about a frame. It hides during Play (scrubbing a running game would be editing a
rehearsal) and pauses on deselect (a video playing behind a pane nobody is looking at holds a
decoder and, if it has a track, keeps making noise).

**Seeking goes through `_seekWhenReady`, never a raw `currentTime` write.** `readyState === 4`
does not imply seekable: on a first load the browser reports the whole file buffered while
`seekable` is still empty, and the assignment silently does nothing. See
`docs/engine/05-lessons.md` — the file, the server's Range support, and the encoder all looked
guilty before the real cause, which was asking one beat too early.

**This is why `defineDatAccessor` now walks the prototype chain.** `poster` needs a *reactive*
setter — changing it must move the picture — and every compiled subclass was regenerating a plain
accessor over the top of it. That fix is what makes "changing this dat key does something"
possible for any built-in, not just video.

### 12.4 Text

`AE1Text` (`engine/text.js`) draws wrapped, aligned text via the **`draw()` hook** — the same
hook an author has. There is no privileged text pipeline; Text is an ordinary element that
knows how to paint glyphs, which is the proof that `draw()` is enough to build real things
with.

Every knob is `dat` (size, font, colour, align, valign, lineHeight, padding, wrap, shadow), so
an author owns it from the first second and can override `draw()` to own it completely.

Wrapping is **greedy**, not Knuth-Plass: credits do not need optimal line breaking, and greedy
is what every browser does, so it matches what an author expects from having typed text
anywhere else. A word wider than its box is broken rather than allowed to bleed out of bounds.
Results are cached by `font|width|text`.

Fonts are system stacks only — a webfont means a CDN or a payload, and AE1 ships neither
(Principle 5).

> **A script may never extend itself.** The natural way to write an inventory is
> `(name "Inventory")` + `(extends Inventory)`, meaning the built-in — but `(name …)` registers
> in the by-name table, so the lookup found the script itself, reported an inheritance cycle,
> and silently fell back to `AE1Element`, losing everything `Inventory` provided. Self is
> excluded from the lookup so the name resolves onward to the built-in.

### 12.2 Items are data, not elements

An inventory holds `{id, name, icon, ext}`, never element references. Picking up a key cannot
move the key ELEMENT into the inventory, because that element is destroyed when its scene
unloads. Items are plain data, so they survive scene changes, serialize cleanly, and can be
granted by a script with no element to hand.

`add()` is idempotent by id — talking to the same NPC twice must not duplicate the key.

### 12.3 The `draw()` hook

**Any element with a `draw(ctx, api)` method owns its own rendering.** The renderer hands it a
context translated to the element's top-left, so the author works in local coordinates from
(0,0) to (width,height).

That single hook is what makes health bars, custom inventories, and arbitrary HUD chrome
possible from Angel Script alone. A thrown `draw` costs that element, never the frame — one
bad HUD script must not blank the game every frame forever.

**This section used to say "unrotated", and that was a bug wearing a spec's clothes.**

The `draw()` path got a bare `translate` while the default path rotated, flipped, and centred.
So `rotation`, `flipH` and `flipV` were **silently ignored on every Text, Video and Button in
AE1** — set rotation to 45 and nothing happened, with a clean console, because there was
nothing for the browser to complain about. It was found by reading back the transform matrix a
real `AE1Text` receives and seeing the identity where the rotation should have been.

Both paths now share one transform. The author's contract is unchanged — local coordinates
still run (0,0) to (width,height), and an unrotated element gets a byte-identical matrix to
before — they are simply honoured inside a rotated, flipped frame now, which is what those
properties always claimed to do. Nothing on disk relied on the old behaviour, because the old
behaviour was that these properties did nothing.

**The general lesson:** a documented contract that exists only because the code forgot to do
something is not a decision, it is a bug that has been written down. When the doc and the
property list disagree, one of them is lying.

### 12.6 Sprite

`AE1Sprite` (`engine/sprite.js`) — `(extends Sprite)`. Owns motion, not pixels. See §5.3.1 for
why the frame lives in the component and why this is the one built-in with no `draw()`.

`(animations (walk 0 7))`, `(animation "")` for the whole sheet, `(fps 12)`, `(playing true)`,
`(loop true)`. `play("walk")` switches clip and restarts it; calling it repeatedly with the
same clip does **not** restart, so `play("walk")` every frame while a key is held keeps the
cycle running instead of freezing it on frame 0. `(loop false)` holds the last frame and
dispatches `onFinished` once, through the loop — so an author writes `(runInfo done
onFinished)` like any other mode rather than learning a sprite-only convention, the same
reasoning as Video's `onEnded`.

The sheet itself is **not** dat. Video carries both a `video` dat key *and* a video component
and has to hedge between them on every read; there was no reason to repeat that. The picture
lives where pictures live.

## 12.7 Dialogue trees

`engine/dialogue.js`. Two classes, and the split between them is the design:

| | owns |
|---|---|
| `DialogueDelegate` | the **conversation** — tree, current node, choices, actions |
| `DialogueBox` | the **presentation** — where the line is drawn, where the choices sit |

The same division that made `SaveHandler` work (§16.3): the engine owns the structure, the
moment, and the ordering; the author owns the contents. A delegate knows what Bram says and
nothing about pixels. A box knows about pixels and nothing about Bram.

### 12.7.1 Why the box is elements, and not the DOM

**say() was already implemented twice.** A shipped game had a `<div class="ae1-dialogue">`; the
editor had a Console line. Neither shared anything with the other. That is Principle 2 quietly
slipped, and it was survivable for one-way flavour text.

A **choice** is not survivable. It has to be clicked, and the div is `pointer-events: none`,
sits outside the canvas, ignores the letterbox transform — and in the editor does not exist at
all. Choices built on it would work in the export and be invisible while authoring, which is
the precise failure Principle 2 exists to forbid.

So **a choice is a Button in the HUD layer**, and this feature adds *no input machinery
whatsoever*: `loop.pick()` already hit-tests, `AE1Button` already hovers and dispatches, and
`press()` is already the override point. It is also restyleable, because it is only dat.

`video.js` made the identical call for the identical reason — an overlay "would sit outside the
canvas, ignore the letterbox transform, and be impossible to layer elements over". When the
engine has already answered a question, answer it the same way.

**say() now routes through the box when the project has one**, falling back to the div (in a
game) or the Console (in the editor) when it does not. `game.js` suppresses its div whenever a
box exists, or every line would appear twice. A project with no box behaves exactly as it did.

While a conversation is running, `box.say()` **declines** — the box belongs to the conversation
then, and a stray `say()` must not wipe the choices out from under the player's cursor. The
line still reaches the editor's Console, which is the debug view of everything said.

### 12.7.2 The tree is dat

```
(dialogue
  (start
    (text "Hey. You look lost.")
    (choice "Who are you?" who)
    (choice "Never mind."))          ← no target: this choice ends it
  (who
    (text "Nobody important.")
    (does shrug)                     ← calls this.shrug() as the node opens
    (choice "Fair enough." start)))
```

This is what §6.1 promised: *"adding a new form later costs nothing at the parser level,
because every form is already a list."* Zero new parser. The reader already produces nested
lists of primitives.

A tree is a **declaration, not state**, so `serialize()` never writes it (§5 — only dat that
differs from the declared default is persisted). It stays in the `.ags.txt`, which ships loose,
so a modder edits the conversation in a text editor. That is Principle 3 falling out for free.

**`(does …)` vs `runInfo`.** A per-node action belongs to that node, so it is named in the tree.
`runInfo` is for the whole conversation — `onDialogueStart`, `onNode`, `onChoice`,
`onDialogueEnd`. A delegate is an ordinary element, so an action already has the whole standard
library: `this.give(…)`, `this.find("Door").unlock()`. That is how a conversation reaches out
and changes the rest of the game.

**Every node presents buttons**, including the ones with nothing to ask: a node with no choices
gets a single `(continueLabel)` button. One path through the class, rather than a conversation
path and a monologue path that have to be kept behaving identically.

**The single-node trap.** `formValue` collapses a single-item rest, so a one-node tree arrives
as the node itself while a two-node tree arrives as a list of nodes. `dlgParseTree` tells them
apart by whether the first item is a string. Same family as `(items ("New Game" "Load Game"))`,
which crashed a build: **dat is author-owned; never assume the shape of a key you did not
define.**

### 12.7.3 Who ends a conversation

`talk` is wired to `onClick` by the delegate's static agsDef, so `(extends DialogueDelegate)`
plus a tree needs **no code at all**. Clicking a character talks to them.

A conversation interrupted by `goToScene` is ended by the **delegate's** `onUnload`, not the
box's. This is not arbitrary: the HUD is never unloaded — that is the entire point of it (§12) —
so a hook on the box fires only at `world.stop()`. I wired it to the box first, believing it
covered scene changes; driving it proved otherwise, with three choice buttons hanging over the
next room, clickable, answering an element that no longer existed.

Putting it on the delegate inherits the layer rule for free: **a delegate in a scene ends its
conversation when that scene unloads; a delegate in the HUD — a narrator that follows the player
through a door — does not, and should not.** Persistence comes from which layer an element lives
in, never from its class.

One conversation at a time. Two delegates presenting into one box would fight over it every
node, and the player would answer whichever spoke last.

## 13. Scene navigation

`AE1World` (engine/world.js) owns everything outliving a scene: the HUD, audio, the media name
table, and the current scene. Shared by play mode and the export — if scene switching were
implemented twice, "the door works in the editor but not in the build" would be a bug waiting
to happen, and it is the single most important thing in a point-and-click that must not break.

`goToScene(nameOrFile)` accepts a **scene name** ("Scene 2"), because that is what the author
sees. The contract:

1. The outgoing scene's elements get `onUnload`, then are dropped.
2. The incoming scene's elements get `onLoad`.
3. The HUD is untouched.

**Editing** scenes is separate from **navigating** them: `store.switchScene()` fires no
lifecycle hooks and resets undo (undo reaching across scenes would be a trap). The author is
opening a file; the player is walking through a door.

### 13.1 The AGS standard library

Element methods, delegating to the world, degrading to no-ops off-world so a script never
explodes just because nothing is running:

| Call | Does |
|------|------|
| `this.say(text)` | a line of dialogue |
| `this.find(name)` | another element, this scene then HUD |
| `this.goToScene(name)` | leave for another scene |
| `this.playSound(name)` / `playMusic(name)` | audio, **by media name** |
| `this.give(item)` / `take(id)` / `has(id)` | the inventory |
| `this.setSprite(name)` | swap the picture (the door-opens case) |
| `this.inventory` | the project's inventory, if any |

Media is addressed **by name** (`playSound("bram-hey.mp3")`) because that is what the Media
Collection shows. Hashes are an implementation detail an author should never type.

## 14. Audio

`HTMLAudioElement`, not WebAudio: WebAudio needs `decodeAudioData`, which needs `fetch()`,
which is blocked on `file://` (§8.1). An `<audio>` tag with a relative src works from a
double-clicked page.

Music is one channel that crossfades; sound effects are fire-and-forget and may overlap. That
split is the genre's whole audio model.

**Autoplay is blocked until the user interacts.** Music started in `onLoad` therefore fails on
the very first scene — exactly where a game wants its theme. Rather than swallow it, the
intent is held and fired on the first gesture. A blocked one-shot is *not* queued: by the time
the player interacts, the moment it belonged to has passed.

Re-requesting the same music track is a no-op, not a restart — an `onLoad` that starts the
room's theme must not stutter it every time the player re-enters. That no-op is load-bearing
for a continuous soundtrack: every scene in a tour can call `playMusic` on load to keep one
track alive across scene changes, because the world (and its `AE1Audio`) outlives any scene.

### 14.1 Two volume axes

Loudness is the product of two independent things, and conflating them breaks one or the other:

- **`musicVolume`** — the player's preference (Settings, persisted). "How loud do I like games."
- **`sceneLevel`** — a per-area multiplier, 0..1, default 1. "This room is quieter than that one."

A tour hushed in the bedroom and loud at the desk varies `sceneLevel` per scene *without*
touching the player's setting; effective volume is `musicVolume × sceneLevel` (or 0 when muted),
folded into one `_musicTarget()` that `playMusic`, `setMuted`, and the settings-apply all read.
`setSceneLevel(level)` (surfaced to scripts as `this.setMusicLevel(level)`) fades the playing
track to the new product and remembers it for the next track. Without the shared target, a
volume slider would flatten the per-area level back to full the instant the player touched it.

## 16. Saves

> **"Save" means two unrelated things in AE1. Do not conflate them.**
>
> | | Persists | For whom | When | Opt-in? |
> |---|---|---|---|---|
> | **Project journaling** (§3.1) | the authored project — scenes, HUD, scripts | the **developer** | continuously, as they edit | no — fundamental |
> | **Player saves** (this section) | a playthrough — scene, `saveData`, whatever a handler captures | the **player** of a shipped game | when the game calls `saveGame()` | yes — a handler is added deliberately |
>
> They share no code, no trigger, and no lifetime. Journaling exists so a developer never
> loses their **work**; a save exists so a player can resume their **playthrough**. The
> editor's "Saved" indicator reports journaling, never a player save — and the one guard that
> keeps them apart is that **play mode does not journal** (§7.1), so playtesting a game's save
> feature cannot rewrite the project being built. When this document, the code, or a UI label
> says "save," check which of these two it means.

A save (the player kind) is **JSON, and meant to be opened**. Same instinct as readable exports
and loose `.ags.txt`: a modder editing their save in a text editor is doing the encouraged thing
(Principle 3).

`SOMENAME.ae1save.json` — the type is JSON, the full suffix identifies it. Same pattern as
`.ags.txt`.

### 16.1 The envelope

The format is an **envelope**, deliberately. Today it carries a timestamp and the current
scene; tomorrow the inventory, per-scene state, whatever. So the rules that matter are the ones
that let it grow:

```jsonc
{
  "ae1":  { "engine": "Angel's Egg", "engineVersion": "1.0.0-alpha", "saveFormat": 1 },
  "game": { "id": "dce0911b-…", "title": "Front End", "version": "0.1.0" },
  "saved": "2026-07-17T00:44:53.483Z",
  "scene": "scene-1.json",
  "sceneName": "Splash",
  "data": { "chapter": 3 }        // the author's open bag
}
```

- **A version number**, checked on load. A save from a newer build is refused with a message
  saying so, not misread.
- **Unknown top-level keys survive a round trip** (`world.saveMeta`). A save written by a newer
  build, loaded and re-saved by an older one, keeps its fields. Same reasoning as
  `AE1Element._extra`: never delete data you do not currently understand.
- **Everything but the envelope is optional.** A loader must never require something a past
  version did not write.
- **`data` is the author's bag** — `this.saveData.chapter = 2`. The engine never looks inside
  it. What a save *means* is the author's business; this format is the box around it.

**Validation is for humans.** Saves are meant to be hand-edited, so a malformed one is an
ordinary event, not an attack. Every message says what is wrong in terms the person editing the
file can act on. A save from *another game* is a **warning, not a refusal** — an author who
renamed a project should not be told their own save is invalid.

### 16.2 Where saves live — the host decides

> The engine captures and applies. **Where a save goes is the host's business.**

| | Durable copy | Convenience slot |
|---|---|---|
| **Editor** | `/projects/<slug>/saves/`, written silently by the server | localStorage |
| **Shipped** | a **download** — the player keeps the file | localStorage |

Same `this.saveGame()` in the script. The editor passes a `writeSave` callback; a shipped game
passes none and falls through to `download()`.

**A browser game has no filesystem.** It cannot write to `saves/` and cannot read from it — a
`file://` page cannot fetch, and a page cannot go looking on its own. So loading is *always* a
file picker, in both hosts.

That is a real constraint, and leaning into it is the point: **the file is the save, and the
file is yours.** The export ships a `saves/` folder with a README explaining exactly this, so it
reads as a design rather than as something broken.

**localStorage is never the durable copy.** Incognito wipes it, a `file://` game shares an
origin with every other local page, and clearing browser data clears it. It is the "Continue"
slot and nothing more. Keyed per game (`ae1.save.<gameId>`) so two games on one origin cannot
overwrite each other.

### 16.3 The save handler

> **The engine owns the envelope, the moment, and the ordering. The handler owns the contents.**

`(extends SaveHandler)` — a world-level element in the HUD layer that decides what a save
contains. `engine/savehandler.js`.

The engine cannot know what matters in a given game: whether a door being open is worth
remembering, whether an NPC's mood is state or scenery. So it stops guessing and asks:

```
function capture(save) {          // a save is being written — put things in
  save.inventory = this.captureInventory();
  save.elements  = this.captureScene(this.trackProps);
}
function restore(save) {          // one is being loaded — take them out
  this.restoreInventory(save.inventory);
  this.restoreElements(save.elements);
}
```

It lives in the **HUD layer** because it must outlive every scene — a handler rebuilt on each
scene change could not restore the scene it was rebuilt for. Same reasoning as the inventory
(§12). It draws nothing: machinery, not scenery, and without an explicit empty `draw()` it
would fall through to the renderer's coloured-block placeholder and paint a rectangle over the
game.

**A project with no handler saves exactly what it saved before.** Adding one is additive, never
a migration.

**Order is the design:**

1. `goToScene` **first** — `restore()` writes to elements, and the saved scene's elements do not
   exist until it loads. Reversed, a handler would restore a door in the scene being left, and
   then that scene would be thrown away.
2. `restore()` **second** — now there is something to write to.

**Deferred scene state.** A save can describe a door in Chapter Three. That door does not exist
until Chapter Three loads, so `restoreElements()` parks anything for another scene in
`world.pendingSceneState`, and `goToScene` applies it — **before that scene's `onLoad`**, so a
script's `onLoad` sees the world it was saved in rather than the file's default corrected a
frame later. Parked state is consumed on use: re-applying it on every future visit would
silently overwrite live play.

**A broken handler never blocks saving.** `capture()` throwing writes the save without the
handler's contribution and records `captureError`; a save missing the doors is recoverable, a
save button that throws is not. `restore()` throwing returns a warning — the scene has already
changed, and half a load beats stranding the player in the menu.

Helpers on the base: `captureInventory` · `restoreInventory` · `captureElement` ·
`captureElements` · `captureScene(keys)` · `captureHud(keys)` · `restoreElements`.
`captureScene` records only elements that *have* the named properties, so adding `locked` to
one door requires listing it nowhere.

### 16.4 The API

| Call | |
|---|---|
| `this.saveData` | the open bag — put anything in it |
| `this.saveGame()` | editor: writes `/saves`. shipped: downloads. Both mirror to localStorage |
| `this.loadGame()` | file picker → validate → apply. Overwrites the continue slot |
| `this.continueGame()` | load the localStorage slot |
| `this.hasSavedGame()` | is there one — for greying out "Continue" |

## 17. Settings

> **Settings are NOT part of a save.**

A save is a moment in a playthrough. Settings are how this player likes their games. Put volume
in a save and loading a six-month-old game silently resets someone's audio — they changed
nothing, and something changed. Different lifetimes, different storage.

| | Lives in | Lifetime |
|---|---|---|
| save | a file (+ a localStorage "continue" slot) | per playthrough, portable, moddable |
| settings | localStorage, keyed per game | per player, per machine |

That also licenses settings to be *lost*. Clearing browser data resetting your volume is a
shrug; losing a save would not be. Nothing here warrants a download prompt — which is exactly
why it can live where a save cannot.

**Defaults merge UNDER stored values** on load, so a setting added in a later build appears for
a player whose storage predates it, instead of being `undefined` forever.

The engine reads only `musicVolume`, `soundVolume`, `muted`. Everything else is the author's —
`settings` is an open bag exactly like `saveData`. `setSetting()` sets, applies, and persists in
one call, and applying pushes volume into **already-playing** music: a slider that does nothing
until the next track reads as broken.

| | |
|---|---|
| `this.settings` | read |
| `this.setSetting(k, v)` | set + apply + persist |
| `this.resetSettings()` | back to defaults |

## 15. Undo / redo

Snapshot-based (`editor/js/history.js`). §11 wondered whether the journal could BE the undo
stack; it cannot quite — the journal records state AFTER each change, with no inverse and no
notion of where one user action ends. But its instinct was right: undo works off the same
`serialize()` the journal writes, so there is one representation of project state and undo
cannot drift from what is saved.

- **Bursts coalesce.** The before-state is captured on the first change of a burst and
  committed ~450ms after the last. A 200-pixel drag is one undo step, not two hundred — undo
  must match what the user thinks they did, not what the mouse did. *Verified: 40 mutations
  → 1 step.*
- **Whole-project snapshots** (scene + HUD). A point-and-click project is a few KB, so 60 of
  them is under a megabyte. Inverse operations would be smaller but would need a correct undo
  for every mutation AE1 ever grows — a bug farm forever, in exchange for memory nobody is
  short of.
- **Restoring is muted**, or the restored state pushes itself back on the stack as a new step.
- **Disabled during play**, which has its own snapshot/restore. Undoing into a state the
  running game never had would be incoherent.
- **Never steals typing.** Ctrl+Z in the AGS editor undoes the text, not the scene.

## 10. Deferred, but shaping decisions now

- **3D project type.** Now started — see §18. glTF/`.glb` interchange, three.js vendored, a
  render-first foundation on disk.
- **Subsystem suite.** Pathfinding/AI followers, physics, shaders, speech. Mostly engine-level
  JS embedded into exports; some shipped as elements with AGS attached.
- **Animation tooling** for 3D objects.

---

## 18. The 3D project type

Started with `3d-sandbox` (a Blender scene: plane, cube, red spot light). The approach, and the
decisions locked while starting it:

### 18.1 glTF `.glb` is the interchange format

Not FBX, OBJ, or Collada. glTF 2.0 binary carries meshes, PBR materials, embedded textures,
lights (`KHR_lights_punctual`), cameras, the node hierarchy, and animations in **one file** — so
it drops into the media collection and is content-addressed exactly like an image. Blender exports
it first-class; three.js loads it first-class; it's an open Khronos standard that will still open
in twenty years. One file = one complete asset is what the drag-and-drop model needs.

**No Draco / KTX2 compression.** Both need an external decoder (`.wasm`) loaded at runtime, which
breaks the `file://`, no-dependency promise (§8.1, Principle 5). Ship uncompressed `.glb`.

What a real Blender export actually contained, verified against `scene.glb`: transforms are TRS
with **quaternion rotations** (this shapes the 3D transform to come); the spot light's intensity
is in candela (glTF physical units — three.js interprets it; AE1 will likely expose a friendlier
knob); **collections do NOT export as hierarchy nodes** by default, so a "Collection" grouping
flattens to sibling nodes unless the author toggles it on.

### 18.2 three.js, vendored — the first browser dependency

The 2D engine has zero browser dependencies. 3D can't: writing a glTF loader and a WebGL renderer
from scratch is months of reinventing a solved problem. three.js is the pragmatic choice — but to
keep the "runs by double-click, offline, forever" promise, it is **vendored, not CDN'd**: a pinned
version (0.180.0) checked into `engine/vendor/three/` and shipped in the bundle. It's a payload AE1
owns, resolved through an import map in the editor — never a network fetch. A hand-rolled renderer
stays a *later* optimization if profiling ever demands it, not a foundation.

The closure is `three.module.js` + `three.core.js` (the split core) + `GLTFLoader` +
`OrbitControls` + `BufferGeometryUtils` — all self-contained, MIT-licensed.

### 18.3 Render first, decompose second — both now built

The viewport (`editor/js/workspace/viewport3d.js`, chosen by `mountViewport` when
`project.type === 'game-3d'`) loads the `.glb`, **decomposes it into AE1 elements**, and renders
those elements with an orbit camera. Render-first came first deliberately, to de-risk the
foundation (vendored three.js, loader, WebGL, a real Blender file) before the element model. A dim
hemisphere fill is **editor chrome** (the lone red spot leaves the mesh unauthorably dark); the
shipped game will honour only the scene's own lights.

**The decomposition is the AE1-native mapping:** one top-level glTF node → one AE1 element. A mesh
node becomes an element with a `model` component (`{media: glb-name, node}`); a light node an
element with a `light` component (kind, colour, intensity, cone) — exactly parallel to how a 2D
sprite is an element with a `sprite` component. It runs **once**, when a `game-3d` scene is empty;
after that the elements persist and edits stick. Each element **binds** to its glTF object by node
name, and its transform drives that object — moving an element in the Properties panel moves it in
the viewport. Verified against `scene.glb`: quaternion → euler, candela and cone angles captured,
the cube movable and reset.

**The 3D transform lives on the base element** (§5.3: a transform is what every element HAS, not a
component). `ELEMENT_SCHEMA` gained `z`, `rotationX`, `rotationY`, `scaleZ`; the existing `rotation`
is the Z axis in both worlds. Fields carry a `dim` marker (`'2d'`/`'3d'`); the Properties panel
shows only the ones matching the project type, so a 2D author never sees `Z`/`Rotation X` and a 3D
author never sees `Layer`/`Flip`. 2D stays byte-compatible — the new fields default to no-ops
(`z:0`, `scale:1`) and 2D is the z=0 plane. *(Rejected: a `transform3d` component — it would split
where "position" lives and fight §5.3; and a per-type schema — it would make elements know their
project type, which they deliberately don't.)*

### 18.4 Many glbs, merge-on-drop, and animation

The viewport loads **every glb a scene references** and binds each element to its own file's node,
so a scene draws from several imports at once. Dropping a new `.glb` **merges** into the current
scene: any model-kind asset that no element yet represents has its top-level nodes decomposed into
new elements, added alongside what is already there — nothing removed. "Already represented" is
tracked by giving *every* decomposed element a `model` component recording its `{media, node}`, so
a glb is never unpacked twice. (Collections don't survive glTF export — verified — so merge is
"drop → objects join the scene," not name-matched.)

**Animation is script-territory, mirroring Sprite.** The `model` component carries the animation
STATE — `clip`, `loop`, `speed` — and the renderer plays it: one `AnimationMixer` per animated
glb, cross-fading to whatever clip the element asks for, ticked by delta each frame. An empty
`clip` plays the file's **first** clip, so a decomposed character idles with zero script. A script
drives transitions with `this.playAnimation("walk")` / `this.stopAnimation()` (element.js) — the
state machine is the author's Angel Script, exactly as intended. Verified against an 18 MB Mixamo
character: 65-bone rig, one 16.7 s idle, embedded textures, upright and meter-scaled; it merges
into `scene-1` beside the cube/plane/light, and the mixer advances the skeleton.

**Known rough edge:** a clip is addressed by its real name, and a Mixamo export names its idle
`Armature|mixamo.com|Layer0`. The empty-clip default sidesteps it, but calling a *specific* clip
needs that ugly string until clip-name discovery (a Properties dropdown fed by the glb) lands.

### 18.5 Matching Blender's look — three render gotchas

A textured character revealed three things the naive setup got wrong, none of them an export
problem (the glb was clean):

- **Skinned meshes must not be frustum-culled.** A `SkinnedMesh`'s bounding volume is its BIND
  pose, but the bones place the real vertices elsewhere, so three.js culls it against a stale
  sphere — parts of the character vanish at some camera angles and pop back when you orbit.
  `frustumCulled = false` on every mesh in a loaded glb. Cost is nil at this scale.
- **Tone mapping, or a bright light floods the frame.** Blender 4.x renders through **AgX**;
  three.js's default is none, so a physically-bright spot (glTF intensities are candela — the
  scene's spot was ~28,000) blows out to flat colour. `renderer.toneMapping = AgXToneMapping`
  compresses highlights the same way Blender does. The look went from flat pink to balanced.
- **PBR needs an environment.** Metal reads black and roughness reads flat with no environment to
  reflect. A procedural `RoomEnvironment` (via `PMREMGenerator`, no external file — it is what
  Blender's world lighting provides) restores material fidelity. It is editor FILL; the scene's
  own lights still light it.
- **Solid geometry exported as Alpha Blend must be rescued.** Ripped/downloaded models routinely
  ship with *every* material set to Blender's "Alpha Blend" (glTF `alphaMode: BLEND`). A
  transparent material stops writing depth, so nothing occludes anything — the backpack shows
  through the chest, the eyeballs through the face. On load, a `BLEND` material with no alpha
  cutoff is converted to an alpha CUTOUT (`transparent=false`, `alphaTest=0.5`, `depthWrite=true`):
  it writes depth (so it occludes) while still discarding fully-transparent texels (hair edges,
  eyelashes). True glass would want real blending — rare on a character, and the fix at source is
  Blender's material Blend Mode. Verified on reference-game-style character: 7 materials converted, the
  see-through gone.

The framing radius is also **capped** (~1.6 units): a 21-unit ground plane would otherwise push
the camera dozens of units back and shrink a 1.6 m character to a dot.

### 18.6 Per-part visibility — because glTF has no "priority"

A ripped/downloaded character routinely ships **alternate expressions and duplicate parts**
overlapping in one node — a `facial_normal` and a `facial_serious`, two pants variants — all
exported together. They z-fight (patchy grey, dark blotches), and **glTF records no flag for which
is the intended one**; that authorial choice was lost at export.

So AE1 lets the author make it. The viewport records a model node's sub-meshes into
`model.parts`; the Properties panel renders each as a show/hide checkbox; unchecking one adds it to
`model.hidden`, and the viewport stops drawing it (`applyParts`). Both lists persist on the element,
so "keep the normal face, drop the serious one" survives a reload — and it needs no trip back to
Blender. The fix at the source is still available (hide/delete the extras before export, or export
"visible objects only"), but the engine no longer *requires* it.

The blend→cutout `alphaTest` (§18.5) is tuned to **0.2**, not 0.5: high enough to occlude solid
geometry, low enough not to chew holes in soft-edged hair (which would show the scalp through).

### 18.7 Animation scripting, clip discovery, and live lights

Three editor-side pieces that complete authoring a 3D character short of the shipped game:

- **`AE1Model`** (`engine/model3d.js`, `(extends Model)`) — the scripting base. `play("walk")`,
  `stop()`, `onLoad` rests on the idle. It only sets the `model` component's clip; the renderer
  plays it — the Sprite split again, so the same script drives the viewport and (once it exists)
  the game. Clips get FRIENDLY names via `(animations (idle "Armature|mixamo.com|Layer0"))`, because
  a real Mixamo clip is named exactly that. **The single-alias collapse bites here too**
  (§12.7.2): one alias parses to a flat `["idle","…"]`, many to a nested list — `_aliasList()`
  normalises both. The state machine is the author's script; nothing in the engine hard-codes
  states.
- **Clip discovery** — nobody should type `Armature|mixamo.com|Layer0`. The viewport records a
  glb's clip names into `model.clips`, and the Properties panel renders the Animation field as a
  **dropdown** of them (empty = the first clip = idle). Same pattern as the Parts list.
- **Live lights** — a light element's `light` component now DRIVES its three.js light (`applyLight`):
  edit colour, intensity, cone in Properties and the light changes immediately. The decomposed
  values are faithful to the glb (a glTF spot is candela, so intensities are large — ~28,000 for
  the sample), and this is how you tame them. Changing the light KIND (spot→point) doesn't rebuild
  the light object yet.

### 18.8 The shipped 3D game — one file, double-clickable

A 3D game renders through `engine/three3d/render3d.js`, the **same module the editor viewport
uses** (`viewport3d.js` calls it; only decomposition, backfill, and the orbit camera are
editor-side) — so a shipped 3D game looks exactly as it did while authoring (Principle 2).
`game3d.js` wraps it with the game loop, and the export produces a single self-contained
`index.html`, same promise as 2D:

- **The file:// module problem, and the loophole.** three.js is ESM, so a 3D game can't be the 2D
  export's one classic `<script>` — and Chromium **blocks fetching module FILES on `file://`**
  (module scripts are CORS-checked; a `file://` origin is opaque). But it happily **runs an inline
  module script**, and an inline module may **import `blob:` URLs**. So the exporter inlines the
  whole module graph and the page rebuilds it at boot.
- **`bundle_modules_3d` — a mini ESM bundler in Python stdlib** (exporter.py). Walks the import
  graph from `three3d/game3d.js` (28 modules: three.core, three.module, three addons, the engine),
  topo-sorts it, and ships `{order, deps, modules}` as JSON in the page. At boot, leaves first,
  each module's `from 'spec'` strings are rewritten to the dependency's Blob URL, the module
  becomes a Blob URL itself, and finally `await import(entryBlobUrl)` boots the game. Discovery is
  the same regex-not-AST tradeoff as `bundle_engine`, with three guards for three.js's doc
  comments: non-`.js` relative specifiers are prose, a module's reference to itself is its own
  usage example, and a specifier whose file doesn't exist is prose too.
- **glTF inlined as base64.** `file://` can't `fetch()`, so each `.glb` is inlined in the data and
  decoded to a **Blob URL** at boot, which GLTFLoader loads fine. (An 18 MB character → a 27 MB
  `index.html`; unoptimised, deliberately — correctness first.) Model media is inlined *instead
  of* copied to `media/`, not both.
- **Asset collection follows component media.** A model's glb is named in `components.model.media`;
  `_dat_text` scans component values so it isn't pruned — the same "named in dat, not scripts"
  family as the tour videos (§8.2). Missing it shipped an empty 3D scene.

Verified **on `file://` itself** (and over http): the exported game boots, rebuilds three.js from
blobs, decodes the inlined character, binds every element, **runs the game loop so
`AE1Model.onLoad` plays the idle**, advances the mixer in real time, and renders — cube, plane,
spotlight, animated character, matching the editor. The double-click promise holds for 3D.

**Still open (3D):** viewport picking (click a 3D object → select its element), and light KIND
changes (spot→point doesn't rebuild the light object yet).

### 18.9 The third-person kit: Controller, ThirdPersonCamera, ThirdPersonCharacter

Three built-ins (`engine/thirdperson.js`) plus an input class (`engine/input.js`) make a playable
third-person scene. All of it is plain math on element fields — no three.js — so it ships in the
classic bundle, and the SAME scripts run in the editor viewport and a shipped game (Principle 2).

- **`Controller` is data, not code.** The key/mouse mappings (`forward "KeyW"`, `jump "Space"`,
  `primary "Mouse0"`, `sensitivity`, `invertY`) live in a scene element's dat — visible and
  editable in Properties, extendable by script for mode-switching. The character ASKS the
  controller which code means what; rebinding is a dat edit. No controller in the scene → class
  defaults, so play works before anyone adds one. `AE1Input` (`engine/input.js`) is the DOM half:
  key codes, mouse buttons as `Mouse0`/`Mouse2`, pointer-lock look deltas — it knows codes, never
  meanings.
- **`ThirdPersonCamera` is the play view, never the editor's.** Mouse look orbits yaw/pitch around
  the character — idling lets you inspect your own character (screenshots!) without moving them.
  It writes plain transform fields; `render3d.setView(el)` applies them to the VIEW camera (YXZ,
  yaw-then-pitch) during play only. The editor viewport keeps its orbit camera and restores it on
  Stop. Feel (distance, `lookHeight` — NOT `height`, which is a base schema field a dat key must
  never shadow) is dat.
- **`ThirdPersonCharacter extends Model`**, so animation aliases slot in later untouched.
  Camera-relative WASD (W walks where the camera looks, diagonals normalised), turn-to-face with
  shortest-path degrees (`turnRate`, `faceOffset` for models exported facing the other way),
  gravity + edge-triggered jump. **One per scene**: the first wins, a second goes inert with a
  console warning — silence would look like a broken controller.
  **Facing is NOT `rotationY`.** A glTF armature routinely ships a baked rest rotation (Blender
  Z-up exports carry `rotationX 90`), and the element euler renders as `Rx·Ry·Rz` — so writing
  `rotationY` alone turns the model about a TILTED axis: walking backwards flipped the character
  upside down under the floor. The heading is a **world yaw composed onto the whole rest
  orientation** (`M = Ry(Δ)·M_rest`), done with a ~30-line hand-rolled quaternion kit in
  `thirdperson.js` (the element layer never imports three.js), and all three euler fields are
  written together.
- **Ground is a raycast, injected.** The character's physics is pure math; the one geometry
  question — "what height is the floor at (x,z)?" — is injected as `world.env3d.groundAt` by
  whoever mounts the renderer (`render3d.groundAt`: downward ray, skinned meshes skipped — bind
  pose lies and they cost real time — self excluded, and **a floor must face UP**: a face whose
  world normal has y < 0.5 is a wall, not a floor. Without that filter a character walking through
  an un-collided box "stood" on its bottom face). Jumping onto the cube, walking off its edge and
  falling — verified numerically. No lateral collision yet, deliberately.
- **Action modes are RUN_INFO modes.** `onPrimary`/`onSecondary`/`onJump`/`onLand` dispatch to the
  character's script via the standard tables (`(runInfo swing onPrimary)`) — the same vocabulary
  rule as every mode (invariant 14).
- **The character comes with its camera.** Attaching a script that compiles to a
  ThirdPersonCharacter auto-creates a Camera element (visible in the Outliner, feel editable in
  Properties) if the scene has none. The Controller has a `+Ctrl` button in the Outliner's SCENE
  header (3D projects only). Both are template scripts an author immediately edits — the
  SaveHandler pattern.
- **Edges close on the game loop's frame.** `pressed()` (jump, actions) is one frame wide, and the
  editor has TWO rAF callbacks — the viewport's render tick registers first and would clear every
  edge before the game loop's dispatch saw it. `input.endFrame()` is therefore called from the game
  loop's `onFrame` (which runs after its dispatch), never from a render tick. One eaten jump found
  this; docs/engine/05-lessons.md has the story.

Verified end-to-end in play mode with `player_character.glb` (183 MB, armature, no clips — renders
in T-pose, correct): WASD moves camera-relative, the character turns to face travel, Space jumps a
physically exact arc, landing on the cube top at y=1.00 and falling off its edge both work,
`onLand`/`onPrimary` reach the author's script, and Stop restores the editor camera and discards
play movement.

### 18.10 Animation libraries and the state machine

A character's clips do not have to live in its own glb. `(animLibs ("file.glb"))` on a Model names
glbs that contribute **clips only** — an idle exported as its own file drives the character's
skeleton by bone-name match (the mixer is rooted at the character; three binds tracks by node
name, so a same-skeleton export just works). Everything downstream honours the split:

- **A library is never scenery.** The viewport does not decompose a glb some element lists in
  `animLibs` (script dat, readable in edit mode through the dat accessor) or `model.libs`
  (component) — and `build()` hides a pure library's meshes, the ground raycast refuses to stand
  on them, and framing ignores them. Declare the library FIRST, then drop the file; declared
  after, delete the auto-merged elements once and they stay gone.
- **Clip resolution is own-glb-first, then libraries**, and an EMPTY clip name defaults to the
  first clip anywhere — so wiring `model.libs` alone makes a mesh-only character idle in the
  editor with zero further configuration. The Animation dropdown backfills library clips too.
- **`bindPose()` / the `'__bind__'` sentinel** is "return to the T-pose", distinct from `stop()`
  ("freeze where you are"). The renderer restores a **rest snapshot** — every non-top-level
  node's local transform captured at load, exactly as the file shipped. NOT `Skeleton.pose()`:
  that recomputes bone locals through `matrixWorld` and detonates under an element-scaled
  armature — a 0.01-scale character's mesh vanished entirely while moving.
- **The default state machine lives on the character, the richer one in script.**
  `ThirdPersonCharacter` tracks `idle` / `move` / `air` from its own physics and calls
  `animate(state)` on each CHANGE (never per frame). The default `animate` plays the clip the
  state's dat names (`idle`, `move`, `air`) and falls back to `bindPose()` when a state names
  none — so a character with only an idle clip idles when still and T-poses while moving or
  falling, and tomorrow's walk clip is one dat line (`(move "walk")`), zero code. Overriding
  `animate(state)` in Angel Script replaces the machine wholesale (DESIGN §18.7: the state
  machine is script territory; the engine only says WHEN).

Verified visually in edit mode (she idles in the viewport, no duplicate library mesh standing
around) and in play: idle → walk (upright T-pose, camera glued 3.5 m behind) → idle again on
release → `air` + T-pose mid-jump → idle on landing. The 3D export inlines library glbs like any
model media (they are named in script dat, so the pruner keeps them).

**The `animOnly` media flag.** Dropping a companion animation glb used to auto-merge it as a
duplicate character standing in the scene. The flag (an "Anim" pill on model tiles in the Media
Collection; `PATCH …/media/<hash> {animOnly}`) marks a glb as a CLIP LIBRARY at the media level:
never decomposed into elements, mesh never rendered. Set it before dropping companions and they
never appear at all. Rendering enforces one rule with no special cases: **a glb renders only
while some element uses it as its model** — libraries, anim-only assets, and orphaned glbs all
just stop being scenery.

**Clips are addressed by FILE.** Every Mixamo export names its clip `Armature|mixamo.com|Layer0`,
so name-based lookup would always find the first library. A clip reference may be
`"file.glb"` (its first clip) or `"file.glb#ClipName"` — which is how the Player's dat reads:
`(move "player_character_walk_forwards.glb")`. Bare clip names still work for single-source
models.

**animOnly glbs ship STRIPPED — and the limit that forced it.** Seven 175 MB Mixamo libraries
pushed `index.html` to 1.89 GB, past **V8's ~1 GiB string cap**: `JSON.parse` could not even
materialise the inlined data and a double-clicked build died before boot, silently. The exporter
now rebuilds each animOnly glb as **node graph + animation tracks only** (`strip_glb_to_clips`,
pure stdlib GLB surgery: node indices preserved for the channel targets, accessors/bufferViews
re-packed into a fresh BIN, meshes/materials/textures/skins dropped) — 183.5 MB → 168 KB, and
the build fell to 260 MB. Best-effort by contract: any surprise ships the original bytes with a
warning, and a build whose inlined models exceed ~700 MB of base64 warns about the cap.
The decode had its own trap: `Uint8Array.from(atob(b64), cb)` runs the callback PER CHARACTER —
minutes of frozen page at 175 MB. `game3d` now decodes lazily per glb through a `data:` URL
fetch (the browser's native base64 path; tight-loop fallback). Boot: ~2 s. Verified on `file://`:
the stripped library drives the full character's idle in the double-clicked build.

**Root drift is locked out of library clips.** Motion clips ship root motion — the hips translate
across the ground inside the animation, fighting the element position (the physics owns WHERE the
character is; the clip owns how the body moves). Library clips get their root `.position` tracks'
ground-plane components (bone-local X/Y — this armature is Z-up-authored) pinned to the first
keyframe, once, in place; the vertical bob survives. A model's OWN clips are never touched.

**Per-state playback tweaks: `(animOpts …)`.** Any state's clip can be tuned without touching
code: `(animOpts (air (loop false) (startFrame 12) (fps 30)) (move (speed 1.2)))`. Options:
`loop`, `speed`, `start` (seconds into the clip), `startFrame`+`fps` (the same thing in
frames; fps defaults to 30), and `fade` (crossfade seconds into the clip; 0 = hard cut). The plumbing is general: `playAnimation(name, {loop, speed, start})`
writes a `start` field on the model component (visible in Properties as "Start (s)"), and the
renderer applies it when a clip (re)starts. The renderer's restart trigger is a REQUEST KEY
(clip + speed + start), not `isRunning()` — a finished one-shot whose request hasn't changed
holds its last frame instead of restarting every frame forever, while a re-jump (state left and
returned) or a reversed re-trigger restarts cleanly. The jump wears it first:
`(air "player_character_jump.glb")` + `(animOpts (air (loop false)))`.

**The directional locomotion machine** (states → dat keys), classified by the movement's angle
**relative to the FACING — never by which keys are down**. A directional clip only reads
correctly against the body: facing the camera, screen-left (A) is her body-RIGHT, so A must play
the strafe-RIGHT clip, and S+A is a body-forward diagonal (walk); key-based selection got every
one of those wrong the moment she turned around. With `rel` = travel − heading (signed, +90 =
body-left): `|rel| < 67.5°` → `move` (forward + forward diagonals, turning to face travel);
`rel ≈ ±90°` → `strafeLeft`/`strafeRight`; `rel ≈ ±135°` → `backLeft`/`backRight`;
`|rel| > 157.5°` → the **180 reversal**: play `turn` as a ONE-SHOT, pivot in place, and on the
mixer's `finished` (dispatched to the element as `onFinished` — the same contract as
Sprite/Video) hand over to `move`. Every other reversal plays the turn clip **reversed**
(`timeScale −1`, starting from the clip's end) so turning back mirrors turning away. Verified
with the full both-facings × all-input-combos matrix.

**During a turn, the CLIP owns all visible rotation.** A turn clip carries root rotation — the
hips yaw 180° inside the animation — so sweeping the element heading at the same time
DOUBLE-rotated her (a full 360° spin on the reversed turn, whose clip starts at its fully-turned
end pose). The heading therefore HOLDS while the clip plays: at the **origin** for forward
playback (the clip rotates origin → target) and at the **target** for reversed.

**Turn EXITS are RAMPS over the `turnBlend` crossfade** (dat, default 0.25 s). A hard cut kept
the yaw stable but SNAPPED the legs; a plain crossfade blended the legs but swept the yaw into a
spin. The resolution rests on one fact: the mixer's blend of a pure yaw is **linear in angle**,
so a heading lerp over the SAME window as the crossfade cancels the clip's blending root yaw
**exactly** — limbs blend, net facing stays put.

**…but a blend at exactly 180° picks its own side.** The reversed ENTRY blends two poses 180°
apart, and a quaternion blend at 180° chooses its path by hemisphere — it went the OPPOSITE way
to the entry ramp and the two STACKED into a fresh full spin (Austin caught it within minutes).
So the ramp maths live only where the blend path cooperates: **forward entry fades** (start pose
un-turned, nothing to fight), **reversed entry is a hard cut** (heading swaps to the target the
same frame the pre-turned clip lands — no travel, no spin, and the reversed clip's start stance
is near-walk so no visible snap), and **both exits ramp**. Verified by heading trace (entry:
one frame, 180→0, no intermediates; exit: a clean 5-step lerp) and mid-pivot screenshots.

**Turns are grounded-only, and jumps don't fire mid-turn.** The reversal detector used to run
before the air check, so pressing S (or W after a turn) mid-jump hijacked `air` into `turn`,
interrupting the jump clip. The `air` state now owns the body until landing.

**`interact` — the uninterruptible one-shot** (E by default; `interact` on the Controller). While
it plays it OWNS the body: no movement, no jump, no actions, no state change — held keys do
nothing, and the clip's `onFinished` is the only way out (which is why entering requires a
configured clip: no clip, no exit, no state). Grounded only, never mid-turn, E-during-E ignored.
It dispatches **`onInteract`** (a RUN_INFO action mode) so a script hooks the moment
(`(runInfo use onInteract)`); the clip is forced `loop false`; the state's dat key is
`(interact "file.glb")` and `animOpts` tweaks apply. When the clip ends with movement keys still
held, the machine resumes moving the same tick. Verified: frozen through half a second of held W,
jump refused, E-spam ignored, walk resumed at clip end.

**Mouse-steer: while MOVING, an actively-rotating camera turns the body.** Drag the mouse
mid-walk and she curves to face where the camera looks (camera-forward = orbit yaw + 180); the
steer replaces travel-facing for that frame. A STILL mouse hands control back to the directional
system, and idling never steers — the free orbit stays what it was built for, looking at your
own character. The camera flags `_lookMoved` per tick (pointer-locked deltas over a ½-px
deadzone); the character reads it. Verified: heading tracked a 60° camera swing to the degree,
held on mouse-stop, and stayed untouched through an idle orbit.

**Play mode owns the pointer.** The viewport cursor is hidden during play (`cursor: none`;
pointer lock hides it anyway while captured), and **Esc backs out**: under pointer lock the
browser reserves the first Esc for releasing the mouse, so it reads as Esc → mouse back,
Esc again → play stops and the editor returns. A shipped game keeps Esc = release lock only —
there is no editor to return to.

**FREE-LOOK: the mouse steers the camera with no button held.** Captured (pointer lock), deltas
arrive on the window — the cursor is gone, look is unbounded. Uncaptured, only movement **over
the game canvas** counts (`movementX/Y` come with ordinary mousemoves): in the editor the mouse
must cross other panes without swinging the camera; a shipped game's canvas is the whole window,
so uncaptured free-look is total there. The only uncaptured limitation is physics, not code —
the cursor stops at the screen edge, so capture is still better when available.

**Pointer lock can be REFUSED — and the refusal is silent.** An embedded preview iframe without
the `pointer-lock` permission rejects `requestPointerLock()` with "root document not valid", as
an unhandled promise rejection: no error, no lock. `AE1Input` catches the rejection and warns
once; free-look covers the gap in any embedding. Verified in the lock-refusing pane: hovers
across the canvas orbited the camera 63° — exactly 0.15°/px, zero buttons — and hovers across
the Outliner moved it not at all. Pure lateral → `strafeLeft`/`strafeRight`,
diagonal backward → `backLeft`/`backRight` — these HOLD the heading (the body keeps fronting the
camera line while the legs cross-step; that is what makes directional clips read). Verified
state-by-state and by screenshot: walk cycle mid-stride facing camera after her turn, strafe
cross-step with heading pinned, reverse turn at speed −1.

---

### 18.11 Items: Hitbox, pickup, inventory, sockets

The pieces:

- **`Hitbox`** (`engine/hitbox.js`, `(extends Hitbox)`): an INVISIBLE collision volume — the
  world AABB of the element's bound object, asked from the renderer via `env3d.boundsOf` (the
  same injected channel as the ground ray; the engine class stays pure math). `containsPoint`
  pads horizontally and accepts base-to-head-height vertically — a pickup must not demand pixel
  placement. dat: `socket`, `mountX/Y/Z` (world units), `mountOffsetX/Y/Z` (grip rotation,
  DEGREES), `mountScale`, `pickable` — and the renderer reads the grip numbers **LIVE while
  mounted**: tune them in Properties during play and the item moves in the hand in real time
  (verified: `mountOffsetX 90` leveled the hanging lance into a wielded spear mid-play).
- **Pickup**: E while standing in a pickable Hitbox → the element hides, joins the character's
  inventory (`character.inventory`, mirrored to `world.inventory` when one exists), the interact
  clip plays over the grab, and — first item or empty hand — it AUTO-EQUIPS. `onPickup` fires on
  the item.
- **Equip = the SOCKET mount**: a `mount` component on the item's model bag
  (`{host, bone, px..rz, scale}`) tells the renderer to PARENT the item's object to a bone of the
  host — the virtual socket. The bone comes from the character's `(sockets (rightHand "…"))` dat
  or is AUTO-DETECTED (a bone named like a right hand, Mixamo-style). Offsets author in world
  units; the renderer divides by the bone's world scale so cm-authored armatures need no
  arithmetic. Unmounting reparents home and returns the transform to the element. The item
  follows hand animation for free — that is what parenting to a bone IS.
- **Scroll wheel cycles** the inventory — wrapping in BOTH directions (scrolling back from slot
  0 lands on the LAST item; the hand only empties when the inventory does — the first two-item
  test caught `equipIndex(-1)` emptying the hand instead of wrapping). Equips dispatch
  `onEquip`/`onUnequip` to the items. Verified with lance + key: forward and backward cycles,
  exactly one item visible per step, the non-weapon key clicking without a swing.
- **Shift+E DROPS** the wielded item: out of hand and inventory, back into the world 0.8 m in
  front of the character, `onDrop` fired. No animation — letting go is not a ceremony.
- **The wield framework**: while an item is equipped, the character FORWARDS `onPrimary`/
  `onSecondary` to it — `(runInfo stab onPrimary)` on a lance script fires on left click while
  wielded. Future item-specific wield/walk/use animations hang off this same shape: the equipped
  element is `character.equipped`, and `animate(state)` overrides can consult its dat.
- **`isWeapon` turns the primary into a SWING.** With a `(isWeapon true)` item equipped and an
  `(attack "file.glb")` clip configured, left click enters the **`attack` state** — an
  uninterruptible one-shot exactly like `interact` (owns the body, `onFinished` exits, grounded
  only, never mid-turn; the mounted weapon rides the hand bone through the swing). The
  `onPrimary` hooks still fire first, so scripts hear the hit. Unarmed or non-weapon items:
  clicks stay hooks-only. Verified: unarmed click → no swing; armed click → `attack` +
  sword_attack1, W frozen mid-swing, clean return to idle, mid-swing screenshot.
- **New RUN_INFO modes**: `onPickup`/`onDrop`/`onEquip`/`onUnequip` (category `item`), dispatched
  TO THE ITEM with the actor as argument.

Verified end-to-end with `lance.glb` (`(extends Hitbox)`): walked into the volume, E —
inventory `["Lance"]`, auto-equipped, lance VISIBLY in her right hand tracking the idle
(screenshot; auto-detected bone); `[Lance] picked up by the player character` and `[Lance] stab!` both reached the
item script; Shift+E dropped it 0.8 m ahead with clean bounds at the new spot; picked back up and
re-equipped. NOT yet verified: scroll cycling (needs a second item to mean anything) and the 2D
HUD inventory strip (the 3D game has no 2D overlay compositor yet — inventory is data + the
equipped item in her hand IS the visual for now).

### 18.12 NPCs, combat, and the first physics

- **`NPC`** (`engine/npc.js`, `(extends NPC)`, extends Hitbox): a wandering, killable
  inhabitant. WANDER keeps a queue of three random waypoints inside `wanderRange` of its spawn,
  walked at `wanderSpeed`, grounded by the same ray as everyone, facing composed by the same
  world-yaw-over-rest quat rule as the player (the kit is exported from thirdperson.js now).
- **`(drawPaths true)` shows the route**: the NPC writes its waypoints to a `debug.path`
  component (a flat xyz polyline) and the renderer draws a line through it; flipping the flag
  clears it. The component is generic — anything can draw a debug polyline.
- **Waypoints are VALIDATED, not hoped for.** A candidate must have GROUND beneath it
  (`env3d.groundAt` — no strolling off the world) and a CLEAR straight line from its
  predecessor (`env3d.blocked`, a horizontal ray sweep: visible non-skinned hits are obstacles —
  characters move and hidden things don't exist, so neither counts). Rejected candidates
  re-roll, bounded per tick so a cramped corner never stalls a frame — a fully boxed-in NPC
  stands still rather than clipping out. The current leg is RE-PROBED every 0.4 s; if the world
  moved into it, the WHOLE route is thrown away and replanned from where it stands — dropping
  one leg made the next waypoint a target across a line nobody validated, and near an obstacle
  that churned bad leg after bad leg. And **stops linger**: `(idleChance 0.35)` of arrivals
  pause `0.4 + rand·(idleTime 2)` seconds. Verified: 75 audited legs, zero over void, zero
  through meshes, routes drawn around a couch dropped into the wander zone, pause and resume.
- **Health & damage**: `(health 99)` dat; `takeDamage(n, from)` subtracts, dispatches **`onHit`**
  (new RUN_INFO mode, `(attacker, amount)` args) to the NPC's script. The player's `attack` state
  SWEEPS each frame of the swing: the wielded weapon's AABB against every damage-taker; first
  overlap deals the weapon's `(damage …)` dat, ONCE per swing.
- **Death without an animation — physics IS the animation**: at zero health the body TOPPLES
  (a world-axis tip to 90° over ~0.6 s composed onto the rest orientation), rests on the ground,
  and vanishes after `(vanishAfter 3)` seconds. This is the declared direction for the physics
  system: procedural reaction in place of authored clips.
- **E reaches NPCs too**: a NON-pickable hitbox the player stands in hears `onInteract` on E —
  poke a machine, it answers in its script. Pickables still get picked; the two don't collide.
- **`hasPhysics` (every Hitbox)**: v1 = gravity + the floor. A free item (unmounted, visible,
  off the ground) falls at 14 m/s² onto whatever the ground ray finds and rests. The property
  surface for the full system (soft mesh collisions, morph-by-contact) lives here; the depth is
  future work — declared honestly as the seed, not the tree.

Verified end-to-end with `enemy_no_animations.glb` ("Enemy", a machine enemy): wandered 2.36 m
in 2.5 s with a 4-point cyan route drawn on the floor (screenshot); E → `[Enemy] the player character pokes me`;
strike one 99→49, strike two 49→−1 → toppled to 90° → gone at 3 s; `onHit` carried
`(attacker, amount)` into the script both times.

**NPCs animate** (added with `npc_moving.glb`): `(animLibs …)` + `(move "file.glb")` /
`(idle "file.glb")` on the NPC — the same by-file clip addressing as the player (§18.10),
libs copied dat → component at `_npcBegin` (the Model pattern; renderers read only
components). `_npcAnimate` is a two-state machine: `move` while a leg is underfoot, `idle`
at pauses and empty routes — an UNSET clip pins `'__bind__'` explicitly, because with
libraries attached an empty clip resolves first-anywhere and a stopped NPC would walk in
place. Death always rests the pose: the topple IS the death animation. Waypoints passed
through without a rolled pause stay in `move` — switching per corner would flap the
crossfade.

### 18.12.1 Removing a 3D asset — the `merged` flag

There was NO clean removal order before this: deleting a glb's elements RESURRECTED them on the
next sync (the glb read as "new" again), and deleting the media first was refused (in use) — a
deadlock. The fix: the first decomposition PATCHes **`merged: true`** onto the media entry, so
a glb merges exactly ONCE per import. Deleting its elements is now permanent.

**The order:** (1) delete the element(s) in the Outliner → they stay gone; (2) delete the media
tile → allowed, nothing uses it (deleting the entry also clears the flag); (3) re-import →
fresh entry, fresh auto-merge. A re-import of a CHANGED file gets a new hash and merges cleanly;
re-importing byte-identical content dedupes to the same hash. Existing projects self-heal: the
first sync marks every currently-represented glb merged.

### 18.13 The Skybox: an .hdr sky as an element

A glb CANNOT carry a scene's world environment (Blender exports it empty — Austin proved it
with a 132-byte "skybox" glb), so the sky is an **`.hdr` straight from the Media Collection**
(kind `other`; served like any media). `(extends Skybox)` + `(sky "PSX_NIGHTSKY.hdr")`:

- **A hand-rolled Radiance decoder** (`three3d/hdr.js`, ~100 lines): RGBELoader is not among
  the vendored addons and AE1 never reaches for a network, so the 1987 format is parsed
  directly — header, `-Y h +X w`, new-style RLE planes and the old repeat convention, shared
  exponent to Float32. Rows are flipped at decode so the DataTexture needs no flipY. Validated
  on the real asset: 2048×1024 in 52 ms.
- **Background AND light**: the equirect texture becomes `scene.background` and — with
  `(lightScene true)` — `scene.environment`, so a night sky makes the whole world night (the
  RoomEnvironment and base background restore when the sky clears). `skyOpacity` maps to
  `backgroundIntensity` (0 = black); `skyRotation` turns background and environment together;
  `skySpin` (deg/s) turns it over play time. All read LIVE (the mount pattern) — Properties
  tweaks apply immediately.
- **Scripts drive it**: `this.find("Skybox").setSky("dawn.hdr")` swaps; the dat accessors are
  the rest of the API. The renderer's sky pipe runs for UNBOUND elements (the Skybox carries no
  model — `update()` applies the sky before the binding check).
- **Media plumbing**: the host injects `mediaUrl(name)` (editor: the media route; shipped game:
  the same base64 → Blob URL path as glbs — `.hdr` files inline at export, since `file://`
  cannot fetch). Decoded textures cache per name; a bad file warns once and is treated as no
  sky, never a broken scene.

Verified: the PSX night filled the viewport at the sky angle; the scene relit to night by the
IBL (screenshots); `skySpin 30` advanced 45.9° in 1.5 s with `scene.backgroundRotation` matching
to the decimal; export inlines the .hdr. ALSO: the live renderer now has a permanent console
handle — `document.querySelector('.viewport-canvas').__r3d` — the 3D extension of the
drive-the-app doctrine.

### 18.14 Item-authored sockets and per-weapon attacks

The bazooka brought two upgrades the lance's framework anticipated:

- **The grip is AUTHORED IN THE GLB.** Blender Empties parented to the mesh export as child
  nodes ("SocketRightHand", "SocketLefthand" — Austin's approach, and it is the CORRECT one;
  the only care is applying transforms before parenting). `(gripNode "SocketRightHand")` — or
  auto-detect of a `Socket*Right*Hand` name — makes the renderer place the item so THAT node's
  frame lands exactly on the hand bone: authored sockets replace hand-tuned offsets, and the
  mountOffset numbers become fine-tune on top. Verified: the bazooka sat correctly in her hand
  with every offset at zero.
- **`(attack "file.glb")` on the ITEM** overrides the character's attack clip while wielded —
  the bazooka fires `fireBazooka.glb`, the lance (no attack dat) falls back to the character's
  sword swing. The same uninterruptible `attack` state carries both: verified frozen through
  held W mid-fire, weapon hook `onPrimary` still delivered ("[Bazooka] BOOM").
- **The left-hand socket is DATA, not yet a pose**: a true two-handed hold means IK (bending
  the left arm to reach `SocketLefthand`) — a future chapter. Today the firing animation is
  what places both hands, which reads correctly in practice. Stated honestly.

### 18.15 Projectiles: templates, mid-clip spawns, ballistics

`engine/projectile.js` — `AE1Projectile extends AE1Hitbox`, BUILTIN `Projectile`. A mesh
element `(extends Projectile)` is a TEMPLATE, not a prop:

- **Template lifecycle.** A projectile template NEVER RENDERS, anywhere: the shared
  renderer's `wantsVisible` hides any element with a `launch()` that was never `_spawned`
  (duck-typed — render3d stays class-free), so ammunition exists on screen only from the
  muzzle to the hit — in the EDITOR viewport, editor play, and the shipped game alike
  (Austin's call: no missiles lying around). `_projBegin` also flips the element's own
  `visible` at play start (engine-state honesty), and the Outliner hides it in EDIT mode
  while any element's dat names it (`(projectile "MIssile")` on the bazooka) — hidden, not
  removed, so un-naming it brings it straight back (editors.js filters
  `instanceof AE1Projectile` ∩ assigned). Its script stays editable on disk
  (`missile-2.ags.txt`) while it is off the list.
- **The weapon fires it MID-ANIMATION.** `(projectile "…") (projectileAt 0.5)` on the weapon:
  during the attack state the character polls `env3d.clipTime` (renderer: current action's
  `t/d`) and at the fraction spawns ONE round — `_projFired` latches per trigger pull. The
  round is `new tpl.constructor(tpl.serialize())` with a fresh id, `_spawned = true`,
  `scene.add()` — the same construct-and-add pattern dialogue spawning uses.
- **Spawn rendering.** Both hosts rebuild bindings when the element COUNT changes (play tick /
  game3d onFrame) — and since template and round claim the same glb node, `build()` gives the
  second claimant a `clone(true)` (the `spawnClones` map; stale clones removed per pass).
- **Flight.** `(speed)` m/s + `(acceleration)` m/s² along a straight 3D line, `(range)` m then
  self-expire (`scene.remove(this.id)` — a template merely re-hides), `(damage)` to the first
  damage-taker whose volume the round enters (`containsPoint`, the NPC health pool from
  §18.12), `(drawPaths true)` draws the trail in the same debug ink as NPC routes, and
  `(faceOffset)` corrects a nose-elsewhere model. On impact the round itself hears
  `onHit(target)` — `(runInfo boom onHit)`.
- **No double-dip.** A weapon that names a projectile does NOT also deal melee sweep damage —
  the round carries the hurt (first live-fire dealt 90 twice, sweep + missile; now once).
- **Trail buffers grow.** `applyPath`/`applyAim` reallocate their line geometry when a
  polyline outgrows its first buffer — `setFromPoints` on a too-small buffer clamps with only
  a console warning for a diagnosis.

Verified live: fire → "Missile round" appears in the Outliner at ~50% of the firing clip,
flies with acceleration, expires at range and leaves the list; centered shot dealt exactly 90
("[Enemy] hit for 90! Health now 9", "[Missile] hit NPC").

### 18.16 The aim triangulation: muzzle → camera focal point

The third-person-shooter baseline (guns now; grenades and throwables will reuse it):

- **The focal point.** `env3d.aimPoint(el, aimDist)` casts a ray from the play camera through
  the EXACT center of the view: first static mesh hit, else `aimDist` out. Excluded: the
  shooter's own subtree (the camera looks over her shoulder), spawned rounds, skinned meshes
  (their raycast geometry is the bind pose — an NPC still takes hits because the round
  crosses its VOLUME en route, §18.15).
- **The muzzle.** `(muzzleNode "SocketMuzzel")` on the weapon — another Blender-Empty-as-node,
  same authoring as the grip sockets — resolved by `env3d.nodePos(el, name)` (exact name,
  case-insensitive, then a `/muzz/i` scan). Rounds spawn AT the muzzle's world position and
  fly `normalize(focal − muzzle)` — full 3D, and the nose pitches about the yawed right axis
  to match.
- **The lines.** `(drawAim true)` + `(aimDist 60)` on the character — live-togglable dat, so
  the debug ink switches on and off in Properties mid-play: a warm-orange polyline
  camera → focal → muzzle, redrawn live (`debug.aim` component → `applyAim`, same lifecycle
  as NPC routes), **drawn ONLY while a projectile weapon is wielded** — unarmed there is no
  triangle to show and no focal raycast to pay for. The camera leg starts 0.3 ABOVE the eye —
  a line exactly along the view axis projects to a single DOT at screen center; raising the
  near end makes the tracer COME DOWN from the top of the view, over the character's head, to
  the crosshair (Austin's call — the muzzle leg seeks that descending line at the focal
  point).
- **The raycast prunes BEFORE it tests.** Since three r151, raycasting a SkinnedMesh skins
  EVERY VERTEX on the CPU — and the view center usually sits square on the character's dense
  mesh, so an intersectObjects-then-filter aimPoint tanked the frame rate every tick (Austin
  caught it as "slow until the bazooka is picked up"). `aimPoint` now walks the scene itself:
  hidden and excluded subtrees are never entered, skinned meshes are never candidates.
  Measured: 67 fps unarmed (no lines, no raycast), 71 fps armed with the full triangle.
- **Fire re-orients.** At the trigger pull of a projectile weapon the character SNAPS her
  heading to the bearing of the focal point (`_applyHeading`, the quat rule) — idle facing
  any way, the fired pose and the flight line agree. Melee attacks keep their facing.
- **AIM ASSIST — the barrel tracks the line.** While wielded, the weapon MESH pivots so the
  muzzle axis seeks the focal point, with Austin's priority order: the right-hand GRIP anchors
  position (the pivot is about that point — the weapon never leaves the hand), the MUZZLE
  steers orientation (grip→muzzle is the barrel line), the LEFT hand is cosmetic and ignored.
  The character writes `model.aimAt` each tick; `applyAimAssist` (render3d, inside applyMount)
  rotates in bone space about the grip. Weapon dat, all live: `(aimAssist true)` toggle,
  `(aimWeight 0.75)` — fraction of the full correction, subtle beats robotic — and
  `(aimMaxDeg 30)` capping the swing off the animated pose, so a shoulder-carry idle stays a
  carry (~160° off the line, nudged 30°) while the leveled FIRE pose lands on the line.
  Verified: uncapped correction measured 0.0° off the focal; capped local delta exactly 30°.
- **Debug lines are PLAY state.** Editor play-exit calls `r3d.clearDebug()` — routes, trails,
  and tracers never linger into edit mode.
- **Never draw a half-built scene.** `build()` is async and mid-build every node sits at its
  raw glb spot — rendering during it PILED the whole scene at the origin for the first play
  frames (Austin caught it at play start). Both hosts now HOLD the last good frame while a
  rebuild is in flight (play entry, and every projectile-spawn recount) — the first frame
  drawn after the build is a full script-applied update pass, so play opens correct. Editor
  play always starts from a fresh build (`lastCount` reset on exit), held, not drawn.

Verified live: tracer visible through her to the crosshair with the muzzle leg attached;
camera centered on the wandering NPC → fired → round left the muzzle, converged on the view
center, hit ("[Missile] hit NPC") — aiming is now LOOK-and-shoot, no body alignment needed.

### 18.18 Passive proximity dialogue

`engine/passivedialogue.js` — `AE1PassiveDialogue extends AE1Hitbox`, BUILTIN
`PassiveDialogue`. An idling character OVERHEARD, not interacted with (scripted conversation
stays the DialogueDelegate's domain — this deliberately shares nothing with it):

- **Sensing, not touching.** Near = the element's Hitbox volume padded by `(senseRange 3)` —
  `containsPoint` reused with a bigger pad, the same volume E-interactions use. The listener
  is the scene's third-person character.
- **Organic, not scripted.** On approach (and every `(passiveCooldown 8)` while lingering) a
  roll happens: `(passiveChance 0.6)` speaks one of `(passiveLines (…))` at random — never
  the same line twice running — and the rest of the time is SILENCE, by design. The cooldown
  runs whether the player stays or goes, so boundary-dancing cannot spam a character.
- **Voices are TAGGED.** Every line plays through `emitVoice(el, name)` →
  `world.voices` (a Set of `{el, audio, base, name}`) — any system can ask who is speaking
  from where and compare elements by proximity. Two rules ride the registry: **one voice
  world-wide** (`voiceBusy` — a second speaker skips its roll, no queue), and the emitter
  attenuates its own line LIVE: `volume = base × (1 − distance/hearRange)` per tick, so
  walking away fades him out (`(hearRange 12)`, `(passiveVolume 1)`).
- **GC by construction.** Lines ride `world.playSound` (AE1Audio one-shots), which already
  releases the element and its decoder on ended/error; the registry drops its tag the same
  moment. Verified: registry and the live-sound set both empty right after a line finished.
- **`onSpeak` (RUN_INFO 'dialogue')** dispatches to the speaker with the line name — a script
  can subtitle it.
- **3D exports inline audio** exactly like glbs and .hdr skies (file:// cannot fetch):
  mp3/ogg/wav/m4a ride `data.glbs`, and game3d overrides `world.audio.url` to resolve a
  hash → media name → the same Blob URL path. HTMLAudioElement plays blob: URLs on file://.

Demo: "the companion character" (Austin renamed the idling hero; armature.ags.txt now
`(extends PassiveDialogue)`; his idle keeps playing via the scene's persisted model-component
clip — no Model script needed). Four lines (`npc_audio_00N_idle_passive.mp3`). Verified live:
line on approach, three DIFFERENT lines at cooldown cadence with no repeats and no overlap,
two silent rolls at 60%, and the walking-away trace matched the falloff formula exactly
(2.18 m → 0.818, 5.02 m → 0.582 at hearRange 12).

### 18.19 Ambience: the scene's background music as an element

`engine/ambience.js` — `AE1Ambience extends AE1Element`, BUILTIN `Ambience`. The Skybox
pattern for the EARS: one element owns one environmental axis, dat-driven, no code.
`(music "backgroundAudio.mp3") (musicFade 400)` — the track starts with the scene and LOOPS
on AE1Audio's MUSIC channel, which is why dialogue can never destroy it: passive lines and
every other one-shot ride the separate sounds channel, they layer beside the theme (§8.1's
music/sounds split doing exactly what it was built for). Scene-level control is the STANDARD
LIBRARY, not this class — any element's script may `this.stopMusic()` (a scripted event
killing the theme) or `this.playMusic("other.mp3")`; the element's `setMusic("file"|"")` is
the polite front door with its configured fade. Re-requesting the same track is a no-op
(AE1Audio's contract), so scene reloads never stutter it.

Demo: element "Ambience" (`ambience.ags.txt`, def name "SceneMusic"). Verified live: loops at
the music setting (0.6); a companion character passive line played SIMULTANEOUSLY over it (caught live —
both channels at once); `the player character.stopMusic()` (another element, the scripted-event case) killed
it; `Ambience.setMusic(…)` brought it back looping. The 3D export inlines the mp3 like all
audio (§18.18).

### 18.20 Footsteps by surface

Three reusable pieces, composed:

- **Surface identity from the ground ray.** `env3d.groundInfo(el, x, z, fromY)` → `{y, el}` —
  the SAME single raycast the character's physics already pays, now also answering WHOSE
  floor it is (hit object → ancestor in the bindings map → element). The renderer never
  interprets: surface-aware systems read the element's dat. The character stores it as
  `_groundEl` every tick.
- **Ground tags are plain dat.** `(groundType "floor")` on the tile element,
  `(groundType "grass")` on the grass — one-line scripts extending Element. Any element can
  be a surface; anything untagged (furniture, a dropped bazooka the ray honestly reported
  mid-stride) is silent.
- **A looping-effect audio channel.** `AE1Audio.loop()` / `world.loopSound(name)` — not music
  (exclusive, crossfades) and not a one-shot (never ends alone): the CALLER owns the lifetime
  via `handle.stopLoop()`, overlaps allowed. Footsteps today; hums, rain, engines tomorrow.

The character's `_footTick` (runs every tick, INCLUDING the uninterruptible attack/interact
frames, so firing silences the walk): moving = grounded ∧ a locomotion state (move/turn/
strafes/backs — never air, attack, interact, idle). The loop is **touched only on CHANGE** —
same surface, same state → the same audio element keeps playing seamlessly (the no-skipping
requirement); a surface change swaps the source; anything else stops it.
`(footsteps (floor "footsteps_floor.mp3") (grass "footsteps_grass.mp3")) (footstepVolume
0.8)` on the character.

Demo caveat that mattered: Austin's "the plane" is the element **Plane001** (ForestFLoor.glb)
— the element named "Plane" is HIDDEN and can never catch the ground ray; both carry the
grass tag now. Verified live: idle silent → floor loop on the tiles (src = footsteps_floor's
hash) → stop silent; on the grass the loop is footsteps_grass's hash; stop → idle silent.

### 18.21 NPCs speak: NPC extends PassiveDialogue, and the death event tree

Two changes, one inheritance move:

- **`AE1NPC` now extends `AE1PassiveDialogue`** (which extends Hitbox, so nothing is lost) —
  every NPC gets the IDENTICAL proximity-chatter machine the companion character has, dat-only, dormant without
  `(passiveLines …)`. `_pvTick` already refuses to speak for the dead, so a toppled machine
  goes quiet by construction. Two hand-built gotchas honoured: the BUILTIN's `runInfo` must
  list `_pvTick` explicitly (hand-built agsDefs do not merge up the chain — the
  ThirdPersonCharacter precedent), and `passivedialogue.js` moved BEFORE `npc.js` in
  ENGINE_MODULES (a base class must precede its subclass in the shared bundle scope).
- **The DEATH tree `(deathSounds (…))`** is deliberately a DIFFERENT kind of tree than the
  passive one: it is an EVENT — no silence roll, and it does not wait for another voice
  (`voiceBusy` is passive-only; a death cry is diegetic and happens when it happens). One
  entry today; add more and one is picked at random. Fires inside `takeDamage`'s death
  block, tagged through `emitVoice` like every voice.

Demo: the placeholder NPC (enemy.ags.txt) — seven `npc_audio_00N_idle_passive.mp3` lines +
`npc_audio_001_death_event.mp3`. Verified live: his roll fired and played (caught by a
playSound spy — his lines are 2.2 s, easy to miss between polls), and the death blow set
`_dead`, started the topple, and put the death cry live in `world.voices` in the same tick.
A finding worth keeping: with the player character standing between them, the companion character's 7.7-second lines against his
8-second cooldown nearly SATURATE the one-voice-world-wide channel and starve the NPC's rolls
— organic crowd behaviour, by design, but worth remembering when tuning line lengths and
cooldowns for scenes with several talkers.

### 18.22 Particles: four effects, zero assets

`engine/particles.js` — `AE1Particles`, BUILTIN `Particles` — and the sim in render3d.
Four presets: **flame, smoke, splash, explosion** — the `fx` COMPONENT's `kind` is a real
enum, so the Properties panel grew a "+ Particles" button and an Effect DROPDOWN for free
(the component UI is generic over COMPONENT_SCHEMA).

- **Zero texture assets.** The sprites are drawn on a CANVAS at first use — soft radial
  gradients (feathered edges ARE the look; explosion gets offset blobs for the jagged read;
  64 px, hundreds may be on screen) → `THREE.CanvasTexture`. Nothing to author, fetch, or
  inline; file:// exports carry them by construction. Sprite-sheet flipbooks are the
  documented NEXT step when hand-authored atlases arrive; the preset surface won't change.
- **The sim** is CPU over pooled `THREE.Points`, one emitter per element, with a ~15-line
  point shader for per-particle size and alpha (PointsMaterial has neither). Presets say
  pool size, life/size/speed ranges, cone spread (1 = full sphere → radial burst), buoyant
  lift vs gravity, tint, and blending — additive for glows (flame, explosion), normal for
  smoke and splash. dt is clamped (0.1 s) so a background-tab return cannot teleport
  particles.
- **Anchoring** (`(fxHost "Bazooka") (fxNode "SocketMuzzel") (fxOffsetX …)`): host element →
  bound object → named node/socket/bone; the offset is applied in the NODE's frame. Empty
  host = the element's own transform. A hidden host stops emission.
- **Loop vs event.** `(fxLoop true)` emits continuously (staggered respawn — a stream, not a
  clump); `false` makes the element an EVENT that fires on `burst()` (a monotonic component
  counter, so two bursts in one frame both count). **Weapons fire their effects
  automatically**: at the projectile-spawn moment (§18.15) every non-looping Particles
  element HOSTED on the weapon bursts — the muzzle flash and breech smoke needed zero code.
- **Cleanup**: `clearDebug` (play exit) ends every live particle; effects are PLAY things.

Demo: "MuzzleFlash" (explosion at SocketMuzzel) + "BreechSmoke" (smoke, SocketRightHand,
offset −0.35 along the socket's X — "slightly behind the grip"). Verified: one burst count
per shot on BOTH at the spawn tick, and the screenshot shows the orange flash blooming at
the muzzle, smoke drifting behind the breech, and the last shot's embers fading over the
grass — while two rounds fly.

### 18.23 Scatter: one archetype, many placements

`engine/scatter.js` — `AE1Scatter`, BUILTIN `Scatter`. Repeated static dressing (trees,
pots, lamp posts) as CONFIGURATION instead of N imported duplicates:

- **The element is the ARCHETYPE.** It renders where it stands; `(spawns ((x y z) (x y z yaw)
  (x y z yaw scale)))` places renderer CLONES of its bound object — geometry and materials
  SHARED (three.js clone does not copy either), so a forest of one palm costs one mesh plus
  a list of rows. Per-row yaw composes onto the archetype's rotation; per-row scale
  multiplies its scale.
- **`(spawnSnap true)`** drops each copy to the ground under its x,z through the same
  `groundAt` ray everything else uses — and the row's y rides ON TOP as an offset (y 0 sits
  on the grass, y 2 floats two metres up). The first cut let the snap EAT the y column,
  which Austin met as "I can't control the height" — a mode that silently discards an
  author's number is a bug even when the mode is on purpose. **Snap plants the FOOT, not
  the origin**: many glbs bake the origin partway up the model (this palm carries ~2.5 m of
  trunk BELOW its origin — snapped by origin, only the fronds cleared the grass). The
  archetype's below-origin extent, measured from its live world box, is added back per copy
  scaled by the copy's factor. Clones are NOT part of
  the ray's roots (only glb scenes are), so copies never snap onto each other — and,
  deliberately, copies are DRESSING: no elements exist for them, no scripts, no hitboxes,
  no collision. A copy is a picture of the archetype, not a clone of its behaviour.
- **Live in the EDITOR viewport**: `applyScatter` runs in build AND update, reading the dat
  list directly — edit a row in Properties and the copy moves. Rebuild only when the list
  changes; transforms and visibility sync every paint. Copies of a deleted archetype are
  swept by `build()`.
- **True GPU instancing** (`InstancedMesh`) is the documented next step if counts grow into
  the hundreds; the dat surface will not change.

Demo: `tree034` (palmTree1.glb) → "PalmGrove" (tree034.ags.txt): six rows, snap on,
individual yaws and scales. Verified: six clones in the scene graph at their rows' x,z with
ground-snapped heights, visible in the edit viewport around the plaza. Caught during the
build: the FIRST paint comes from `build()`'s inline apply chain, not `update()` — a
component applier hooked only into update() silently misses initial load.

### 18.24 The procedural layer: reach and foot-plant

A weighted BIAS over the playing clips, applied in render3d AFTER the mixers each frame —
never a replacement, and ONLY while a clip is driving the bones (the mixer rewrites them
every frame, so the nudge can never accumulate; without that guard one nudge per frame
corkscrews a skeleton). Deliberately NOT IK — elbows and knees do not re-solve; a reach is
a directional pull and a plant is a settle + tilt. That is the honest cheap 90%, and full
IK is the heavyweight system this project does not need yet (told to Austin plainly; he
offered to cross it off — the light layer was worth keeping).

- **REACH** (`(reachWeight 0.5)`): at an interact with a real target, the character SNAPS
  her heading to face it and publishes `model.reach` = the target's volume centre (computed
  BEFORE pickUp hides the item — reaching toward where it WAS reads perfectly). The renderer
  bends RightArm (0.65×) and RightForeArm (0.45×) toward the point, world-space partial
  rotations composed bone-locally (the aim-assist math, reused), weight smoothed in AND out
  (the ramp-out keeps aiming at the remembered point — clearing the target must not snap the
  arm). Cleared at the clip's end.
- **FOOT PLANT** (`(footPlant true)`): while grounded, a ray under EACH foot; the hips
  settle by the LOWER foot's drop below the base plane (clamped 0.35 — past that is a
  ledge), smoothed; each foot tilts halfway to the slope normal under it. Flat ground is a
  no-op by construction. Bones auto-detected (mixamorig RightArm/RightForeArm/LeftFoot/
  RightFoot/Hips); elements without them (the placeholder NPC's bone0 skeleton) skip silently.

Verified live: interact near the key → reach weight ramped 0 → 0.498 with all five bones
found, ramp-out back to exactly 0 with the reach cleared; on the grass, per-foot ground
deltas read the real terrain (L +0.019, R −0.005 on a gentle patch) and the settle tracked
the lower foot. The demo terrain is gentle — the layer is correspondingly subtle, and
scales with steeper authored ground.

### 18.25 clipforge: English → keyframes → an animOnly .glb

`clipforge.py` (project root, stdlib) — the GENERATED-ASSET doctrine, agreed with Austin:

- **Claude generates MECHANICAL/PROP animation well** (doors, chests, topples, spins, bobs,
  camera moves): a JSON spec — target node name, a baseline euler (the ELEMENT's live
  rotation, baked in because the mixer overrides it during playback), world-axis rotation
  keys, optional position keys — becomes a minimal glTF-binary: one node carrying the
  target's NAME (library clips bind by name, §18.10) and one LINEAR-sampled animation.
  `--upload <slug>` POSTs it to the media API and PATCHes the Anim flag. Math-clean curves
  ARE what good looks like for rigid motion.
- **Never quality humanoid motion**: a walk is dozens of coordinated curves keyframed blind
  — robot-mime — and screenshot verification cannot judge temporal quality. Mixamo stays
  the humanoid pipeline. Crude humanoid PLACEHOLDERS (2-key poses) are acceptable as
  explicitly-temporary timing scaffolds. Simple runtime motion often belongs in the §18.24
  procedural layer instead of a baked clip at all.
- The proof: **the whiteboard**, from the prompt "wobble it and knock it over when hit" —
  a 912-byte `whiteboard_topple.glb` (decaying wobble → give way → 93° fall → bounce →
  hold), `whiteboard.ags.txt` (`extends Hitbox`, script-defined `takeDamage` makes any prop
  a target, `setComponent model.libs` wires the clip). Verified live: missile hit →
  `fallen: true` → toppled in the screenshot. **The DESTRUCTIBLE-PROP settle pattern**
  (three traps, all hit): (1) with a library attached, pin `'__bind__'` at load or the
  empty clip auto-plays the topple ON LOOP (the walked-in-place trap); (2) a prop on a
  SHARED glb cannot trust the held final frame — a sibling's rest restore stands it back
  up; `onFinished` FREEZES the final key into the element's OWN transform (precomputed with
  the forge's math: 91° about world X onto the −89.985 yaw = euler (91, −89.985, 0)) and
  clears the clip; (3) a script-defined `containsPoint` returning false once fallen makes
  the wreck SCENERY — E and further rounds ignore it. Verified: down at 91°, still down
  4 s later, untargetable.
- **Found by the stress test — projectiles TUNNELED thin targets**: the hit test sampled one
  point per frame, and an accelerating round steps 0.25–0.6 m — clean through a 10 cm
  board. `_projTick` now SUB-STEPS the flight segment every ~12 cm. (Also: the exporter's
  strip pass warns it "could not strip" a forged clip — correct and harmless, the clip is
  already minimal and ships whole.)
### 18.26 meshforge: English → a textured, optionally animated prop

`meshforge.py` (project root, stdlib) — clipforge's sibling, closing the loop: simple
geometric PROPS as real glbs, blockout-tier on purpose (organic/detailed modelling stays in
the artist pipeline).

- **Primitives**: box, cylinder, plane (double-winding, visible both sides), any number per
  prop, offsets baked into vertices so the whole prop is ONE NODE — exactly one AE1 element
  on import, and a clipforge target by name.
- **Textures are hand-written PNGs** (stdlib zlib, 128 px): crate (planks + frame + braces),
  planks, metal (rivets), checker, stripes, solid — all over a deterministic value-noise
  grain, all NEAREST-sampled: the PSX crunch this project wears on purpose.
- **Animations BAKE IN**: an optional `animation` block (clipforge's key format, reusing its
  quaternion math via import) rides inside the model — and because the renderer auto-plays a
  model's own first clip, a swinging sign or rocking crate ships PRE-ANIMATED with zero
  wiring. `--upload` posts WITHOUT the Anim flag: models SHOULD merge as elements.
- The proof: **"give me a 2 m shipping crate"** → a 25 KB `crate1.glb` (crate texture,
  ±1.5° baked sway) → uploaded → auto-merged as element "crate1", textured and animated on
  the plaza, its clip in the Animation dropdown. One message, no Blender.

### 18.27 audioforge: English → a spoken line in the media collection

`audioforge.py` (project root) — the third forge: "give the companion character a line that says hello" becomes
an .mp3 wired into his dialogue, no FL Studio session. Two backends, best-available wins:

- **edge** (default; `edge-tts` pip package, allowed by the venv policy — ONLINE at synth
  time): Microsoft's neural voices, native mp3. The cute-leaning presets Austin asked for:
  `ana` (en-US-AnaNeural, a child voice — the cutest on offer), `jenny`, `aria`, `guy`,
  `nanami` (ja-JP — anime-adjacent). Any raw voice name passes through.
- **sapi** (always available, OFFLINE): Windows' built-in David/Zira via PowerShell — the
  Microsoft-Sam tier Austin pre-approved. WAV out, auto-converted to mp3 when ffmpeg is on
  PATH (it is, at A:\…\ffmpeg). `--pitch +25%` on Zira is budget-anime, on purpose. The
  edge backend FALLS BACK to Zira automatically when offline.
- `--rate`/`--pitch` on both; JSON batch mode for line sets; `--upload <slug>` POSTs into
  the media collection. Wiring stays dat: `(passiveLines …)`, `(deathSounds …)`, or
  `this.playSound("file.mp3")` from any script.
- The proof: **"Hello world, from the forge!"** in the `ana` voice →
  `<asset>` (18.9 KB, 3.14 s) → uploaded → appended to the companion character's
  `(passiveLines …)` → verified resolving and playable in-world; his roll now picks it
  1-in-5. Known honest limits: neural needs internet (offline gets Zira); voice QUALITY
  work stays Austin's vocaloid/FL-Studio pipeline; fully-offline neural upgrade path if
  wanted: piper-tts (onnx, headless).

### 18.28 The Scene 2 quest: the forges build a level

The stress test Austin asked for — a full quest built almost entirely from English through
the three forges, with deliberately SMALL engine changes:

- **Engine (all of it):** `ThirdPersonCharacter` gained `(health 100)` + `takeDamage`
  (dispatches `onHit`; at zero NOTHING happens yet, by explicit decision), and NPC gained
  the SWIPE — `(attackRange 1.4) (attackDamage 5) (attackRate 1.2)`, opt-in (range 0 =
  every existing NPC stays harmless), no chase: linger in reach, get hurt.
- **Forged (15 assets in one batch):** the house (plank walls, roof, dark doorway), the
  DOOR (hinge at the node origin via vertex offset, open clip BAKED, pinned at load),
  the GOOBER (green checkered menace with eyes and a striped mouth), three talking signs,
  Scene 2's checkered ground, two goober clips (waddle + breathe), and six voice lines
  (three sign readings, the growl, the death cry — "tell my wife... I said... bleh" — and
  the door's spoken creak).
- **The quest chain:** key (wielded) → E at the door → `onInteract` checks
  `actor.equipped.name === "key"` → creak + forged open swing → the clip's `onFinished`
  calls `goToScene("Scene 2")`. Scenes are DIRECTORY-SCANNED — `scene-2.json` was authored
  by hand (player/camera/controller/skybox/ambience/ground/goober/signs/weapons/crate, all
  referencing existing media + scripts) and simply existed into the project. Scene-2-bound
  media was pre-flagged `merged` so it would not auto-merge into Scene 1.
- **Verified end-to-end in one sitting:** key pickup → door refused position tolerance
  taught a lesson (a THIN door's padded volume is small — stand close) → opened → Scene 2
  rendered (checker ground, night sky, signs, weapons rack) → the goober waddled his
  forged clip, GROWLED by proximity, swiped the player character for exactly 5 (100→95 on the new pool) →
  lance swing took 50 (weapon paths hold across scenes) → death: cry + topple + vanish.
- **The verdict on the forge experiment:** a level, a locked-door quest, a fighting
  monster with voice and animation, and the jokes — one conversation, zero Blender, zero
  DAW, zero recording booth. The artist pipelines stay for QUALITY; the forges own SPEED.
- **Play starts THE GAME, not the open scene** (Austin's testing doctrine): with two scenes,
  `store.play()`'s old `world.start(this.file)` would have booted play INTO whatever scene
  the editor was viewing. It now always starts `project.entryScene` — the same field the
  shipped build boots — so editing Scene 2 and pressing Play runs the real quest from the
  top, and Stop restores the editor to the scene being edited. Reaching a level mid-game is
  the future job of IN-GAME debug tools (teleports, checkpoints, custom saves): testing
  happens relative to the game, not the editor's current view. Verified: edit Scene 2 →
  Play → world is Scene 1 with the plaza → Stop → editor back on Scene 2. One trailing bug
  (Austin caught it): the scene DROPDOWN repainted only at play START, so after Stop it kept
  showing the PLAYED scene while the editor showed the restored one — it repaints on both
  edges now. During play the disabled dropdown honestly names the RUNNING scene.

### 18.29 voiceLine: one voice per element (the audio-overlap fix)

Scene 2 exposed a hole in the voice registry: `emitVoice` gated PASSIVE lines behind
"one voice world-wide", but EVENT-DRIVEN sounds (the goober's death cry, the door's
creak via raw `playSound`) bypassed the registry entirely — so the goober growled
under his own death cry, and nothing could see the creak playing at all.

The fix is a standard-library method on EVERY element — `voiceLine(name, {volume})`:
play a sound AS THIS ELEMENT'S VOICE. It registers in `world.voices` like a passive
line, and it enforces ONE VOICE PER ELEMENT — a new line from the same element cuts
that element's previous line first (a character interrupting HIMSELF is a bug; two
characters overlapping is a scene). `emitVoice` is now a thin alias for it, scripts
use it directly (`this.voiceLine("door1_creak.mp3")`), and the registry finally sees
every deliberate utterance in the world. Verified live: second line cuts the first,
registry holds exactly one entry per speaker.

### 18.30 Portals: the render-to-texture continuity trick

Scene 3 — the goober's death warps you (3s of dignity later) into a big white forged
room with a forged portal gun in the middle. Pick it up; LEFT click paints the ORANGE
portal on whatever the camera centre is looking at, RIGHT click the BLUE one. One of
each ever — a new shot MOVES that colour. Both open → each oval is a live window out
of the other, and stepping in walks you out of the other side.

- **Placement** rides the existing aim pipeline: `aimPoint` (§18.16) now also returns
  the hit's SURFACE NORMAL (`nx,ny,nz`, face normal through the object's world
  matrix), and the gun script writes a plain `portal` component —
  `{a: [x,y,z,nx,ny,nz], b: [...]}` — floors, walls, anything meshy is a valid
  canvas. Portal oval groups are flagged `noAim`, so a shot AT a portal lands on the
  wall behind it, never on the oval.
- **PerspectiveCamera, the invisible eye** (Austin's design, replacing a first
  attempt that mirrored the play camera through the portal frames — mathematically
  the classic trick, but its views confused more than they connected): a new BASE
  ELEMENT, `(extends PerspectiveCamera)` (`engine/perspectivecamera.js`, BUILTIN).
  It renders nothing itself; every frame render3d draws the scene from the
  element's position along its aim normal into a private `WebGLRenderTarget`
  (`applyCapture`/`renderCaptures`, keyed by the `camera` component the element
  writes from dat — `(fov) (near) (far) (aspect) (captureSize)`, plus
  `aimAlong(nx,ny,nz)`). Any surface can display any eye. Portals are the first
  tenant; monitors and mirrors are free later.
- **How portals use it:** Scene 3 carries two hidden eyes, `PortalEyeA/B`
  (portaleye.ags.txt — aspect 0.63 matches the oval). When the gun paints a
  portal it PARKS that portal's eye at the oval centre, aimed along the wall's
  surface normal — the PERPENDICULAR view out of that portal — and writes
  `aCam`/`bCam` (element names) into the portal component. Each face then
  displays its PARTNER's eye: look into orange, see what stands before blue —
  which is exactly what you will see after stepping through. Faces open only
  when both portals stand AND the cross-wired eye exists.
- **Renderer traps (in 05-lessons):** renders into a TARGET skip tone mapping and
  the sRGB output pass — convert in the face shader (`pow(c, 1/2.2)`) or the
  through-view reads as a cave. Faces hide while captures render — a face
  sampling the target being written is a GL feedback loop, not a mirror. And from
  the mirrored-camera attempt, kept for posterity: a hand-posed camera
  (`matrixWorldAutoUpdate=false`) never gets `matrixWorldInverse` derived by
  `render()` — invert it yourself or the view is silently from the world origin.
- **The gun mounts like the bazooka now:** meshforge learned SOCKETS (named empty
  child nodes — `"sockets": [{"name", "at"}]`), so portalgun1.glb carries
  glb-authored `SocketRightHand` + `SocketMuzzel` and the standard wield dat
  (`gripNode/muzzleNode/aimAssist/mountOffset…`). `armed` in ThirdPersonCharacter
  now reads "fires rounds OR declares a muzzle" — the portal gun gets the focal
  raycast and aim assist without a template round; the lance still pays nothing.
- **Walking through** is the gun script's `warpTick`, pure Angel Script: chest
  within ~1m of an oval centre → re-emerge 1.2m out along the OTHER portal's normal,
  height offset carried over, heading snapped to the exit normal. The ARMED latch
  kills ping-pong: a warp lands you inside the exit's own trigger (a floor portal
  especially — you STAND on it), so the gun re-arms only after you step clear of
  both ovals. Verified: blue→orange, stand still 2s (no bounce), orange→blue.
- Portals die with their gun (scene change, deletion) — the build sweep disposes
  eyes' targets exactly like scatter clones.

### 18.31 The geometry channel goes quiet mid-build (the sunken goober)

Austin walked into Scene 2 and found no monster. The goober was THERE — one metre
under the floor, alive, invisible, forever. At scene load the NPC's ground snap
(`this.y = groundAt(...)`) consumed an answer from a HALF-BUILT scene — nodes sit
at raw glb origins while `ensureGlb` resolves — snapped to a surface that never
existed, and then its short ground ray (feet + 0.5) started BELOW the real floor
and never saw it again. §18.13 already taught the hosts not to RENDER mid-build;
the same doctrine now covers the QUESTIONS: while `build()` is in flight
(`buildsInFlight`), `groundAt`/`groundInfo` answer null — and every caller already
treats null as "hold still". Defence in depth on the NPC side (`_groundSnap`): a
missed short ray retries from head height (an NPC under the floor SELF-RECOVERS),
and a snap is a STEP, never a teleport — the per-tick change is clamped, so one
garbage answer nudges him instead of burying him.

### 18.32 The pockets outlive the scene (and true portal continuity)

**Inventory persists across scenes** (Austin's call — the GUI, stacking, storage,
and saves come later; persistence comes NOW). A picked-up item is the PLAYER's,
not the scene's: `goToScene` stashes the outgoing character's inventory — the
element instances themselves — in `world.carried`, and hands it to the incoming
character (`_inv` adopted, `equipIndex` re-issued so the mount snapshots against
the NEW armature). Carried items live in no scene but tick and render
(`orderedElements` + both hosts' element suppliers include them), so the wielded
mesh rides the hand through every door. `(keepAcrossScenes false)` on an item
opts out; a scene with no character (a menu) leaves the stash untouched.

**No duplicate types**: `pickUp` refuses an item whose NAME is already in the
inventory — one "Bazooka" in the pockets is every bazooka; the scene's own copy
stays on its rack. `(stackable true)` opts out, ahead of the inventory GUI.

**The hand holds one thing** (the ghost-key bug): glbs are CACHED across scene
changes, so a mesh parented into a hand bone can OUTLIVE its scene — the old
inventory vanished but the key's mesh stayed welded to the hand, and equipping
the lance produced both at once. Two redundancies in render3d: `applyMount`
evicts any other mounted mesh from the bone before seating the new one, and
`build()` sends every unclaimed mounted mesh home to its original glb parent.

**Bindings are STABLE, clones die honestly** (the giant-bazooka haunting): a
carried item meeting a scene's own copy is a second claimant on one node, so it
gets a CLONE — but the claim pass used to re-resolve from scratch every build, and
in the NEXT scene (no competitor) the carried item bound the original again,
orphaning the clone with its in-hand transform: visible, mount-scaled ×10,
owned by no element, ever — a 25-metre bazooka in the sky. Two invariants now:
an element that ever received a clone KEEPS it (the mesh in your hand stays the
same object across scenes), and any clone its element no longer binds is
REMOVED from the scene at build — an unowned mesh that nothing will ever move,
hide, or rescale must not exist.

**True portal continuity** (Austin: "walking through should FEEL continuous"):
portal-claimed eyes no longer sit at a fixed perpendicular — every frame the
capture camera is the PLAY CAMERA re-expressed through the portal pair (world →
entry-portal-local → 180° turn → exit-portal-world) with the play camera's own
projection, and the face samples its target in SCREEN SPACE — so behind every
pixel of the oval is exactly what your eye would see if the wall were a doorway,
parallax and all. A clipping plane at the exit portal's surface removes the wall
the eye legitimately stands behind. UNCLAIMED PerspectiveCameras keep their
element-authored pose — monitors and mirrors are unaffected. And the teleport
itself carries the rotation: `warpTick` rotates the player's heading AND the
third-person camera's yaw by the portal pair's relative yaw (walk in at an
angle, walk out at the mirrored angle; the view keeps pointing "forward through
the portal" instead of cutting). Vertical portals (floor/ceiling) have no yaw
and fall back to facing the exit normal.

### 18.33 Near-plane fading (the reference action game trick, by its right name)

A mesh close to the camera DITHERS OUT smoothly instead of slicing across the
near plane — back the camera into a wall and the wall screen-doors away,
keeping the character in view. Per-FRAGMENT (only the near part of a long wall
fades), via a Bayer-matrix `discard` injected into every static glb material
at load (`injectNearFade` / `applyFadeMaterials` in render3d) — the pipeline
stays opaque (no transparency sorting) and the screen-door pattern sits at
home beside the PSX crunch. Distance is `length(vViewPosition)`: free in every
lit material and per-camera by construction. The band is tuned to the
third-person boom (~3.4 m): fully gone inside 1.2 m, fully opaque past 3.2 m —
just short of the character, so props she stands beside stay solid. EXEMPT:
skinned meshes (characters are what the fade protects) and WIELDED items
(part of the character; the band would shave them). Default ON for every
static mesh, scriptless elements included; `(nearFade false)` opts an element
out (per-mesh material twins swap in `applyNearFade`). Twins are stored as
DIRECT properties, never userData — `Object3D.clone()` JSON-round-trips
userData, which mangles a material into junk (the invisible-carried-weapon
bug rode that intermediate).

### 18.34 Three audio layers, and the FX-volume illusion

**The layers, named and separated on purpose:** `BackgroundAudioAmbience`
(renamed from Ambience; 'Ambience' stays a legacy alias) is the scene's
ambient bed on AE1Audio's crossfading channel. THE MUSIC BUS
(`engine/musicbus.js`, `world.musicBus`) is area-triggered background music,
routed through WEB AUDIO. Voices and effects keep their own registry and
one-shot channels — and the one-voice-per-element rule (§18.29) deliberately
does NOT apply across layers: ambience + music + a growl may all sound at
once.

**Web Audio without breaking file://**: the graph wraps a plain `<audio>`
element in a MediaElementAudioSourceNode — no fetch, no decodeAudioData. The
editor serves same-origin http; a shipped export plays inlined blob: URLs,
also same-origin. Nothing vendored.

**AudioBackgroundMusicVolume** (`engine/audiovolumes.js`, BUILTIN): a
rectangular region shaped with the ORDINARY transform tools — x/y/z centre,
scaleX/Y/Z metres, rotationY yaw, all in Properties — drawn as a lightly
translucent TEAL box (authoring ink; uncheck visible to hide it, the logic
never looks at it). While the player stands inside, its `(music "file.mp3")`
loops on the bus; walking out fades it; walking into another box hands the
bus over.

**AudioFXVolume** (same file, MAGENTA box): approaching its CENTRE crossfades
the live music into a REDUX (bitcrushed) twin. The illusion is architectural:
ONE source, TWO parallel branches — dry gain, and a WaveShaper staircase
(amplitude quantised to `(bits 6)`) + lowpass (`(crushTone 2400)`) into a wet
gain — mixed EQUAL-POWER (cos/sin) by the player's depth in the box, with
`setTargetAtTime` smoothing. Because both branches carry the one live signal
there is no second copy to drift, no phase to invert, and no panning tricks
needed — the failure modes Austin asked about are designed out, not worked
around. The file is never modified. Demo: scene 1's plaza-wide MusicBox
(backgroundMusic_scene_001.mp3) + an FxBox by the sign — verified live: dry
1/wet 0 in the open, wet rising toward the FX centre, clean revert, bus stops
outside the music region and resumes on return.

### 18.35 Movement feel: caps, trims, and the gaze

Three playability changes, all dat-tunable on the character, none touching
the clips themselves:

- **The 180 pivot must never feel like a lock**: `(turnMove 0.5)` keeps a
  fraction of walk speed flowing along the NEW travel direction while the
  pivot plays, and `(turnMaxTime 0.4)` is the pivot's time budget — when it
  runs out, the walk takes over exactly as if the clip had finished (the same
  exit ramp; a mid-clip hand-off trades a slight root-yaw mismatch for
  responsiveness, deliberately).
- **Clip TRIMS**: `(animOpts (turn (endFrame 22) (fps 30)))` — `end` /
  `endFrame` joins the existing `start`/`startFrame`/`speed`/`fade` per-state
  options. The renderer enforces the window each frame (`stepTrims`): looping
  clips wrap inside it, one-shots fire their finish at the trimmed end.
  Mixamo tails carry long settles; cutting them is most of "snappy". The same
  option rides `playAnimation(name, {end})` for every scripted clip.
- **HEAD LOOK**: when the camera points somewhere the body doesn't face, the
  gaze leads — the character publishes the camera bearing relative to her
  facing (`model.headLook = [yaw, pitch]`, clamped to `(headLookMax 60)`,
  off during one-shots and past ~100°), and the procedural layer (§18.24)
  splits it across neck (35%) and head (65%), everything ramped. Verified:
  camera swung 50° off her facing turns her head toward the lens.

The real fix for transitions remains authored blend graphs — that is a future
in-engine editor. These are the honest mechanical 80% until then.

### 18.36 The userData law, near-focal aiming, and dying music

A bug-hunt session (Austin's playtest) that ended in one LAW and three fixes:

- **THE USERDATA LAW: no Object3D or Material ever lives in `userData`.**
  `Object3D.clone()` JSON-round-trips userData; a stored material becomes
  junk, a stored Object3D (the mount's `ae1Parent` way-back pointer) is
  CIRCULAR and throws — which crashed the claim pass mid-loop and left every
  element after it unbound ("my lance is invisible", the third face of the
  same bug). All object-valued caches (`ae1Parent`, `ae1Grip`, `ae1Muzzle`,
  `ae1RightHand`, `ae1Proc`, the fade twins) are DIRECT properties now —
  which clones correctly do NOT inherit; they re-derive their own.
- **Clones carry their skeletons**: `cloneWithSkeleton` (SkeletonUtils.clone,
  hand-rolled — the addon isn't vendored) rebinds every cloned SkinnedMesh to
  the CLONED bones. Without it a carried lance's clone rendered wherever the
  RACK lance's armature stood.
- **A focal nearer than the character is not an aim target**: the camera
  looking AT her put the view-centre hit on the ground just past her feet —
  the aim assist bent the barrel at her knees and the trigger snap spun her
  at whatever stood beside the lens. A too-near focal is pushed OUT along the
  camera ray (player distance + 3 m) for the assist, the lines, and the
  snap; a fired round's own cast still hits the near thing if aimed at it.
  The gaze clears HARD on the snap (renderer drops a cleared head-look at
  ×4 and decays its remembered angles) — the head no longer fights the fire
  clip.
- **The music bus dies with its scene**: goToScene calls
  `musicBus.sceneChange()` — the claiming boxes just unloaded and nothing
  would ever release the track or zero the crush (the bitcrushed ghost
  followed the player through the quest door). New-scene boxes re-claim
  within a tick.
- **Editor truth after Stop**: volume boxes are duck-typed off class methods
  (the `volume` component only exists after a PLAY onLoad) and drawn during
  build (the on-demand editor may never update again); scatter NEVER falls
  back to the raw offset column when ground is unanswerable (mid-build null,
  §18.31) — it keeps the last placement, and an unplaced copy stays hidden.
  Known minor: on a fresh project load the volume boxes may not draw until
  the first Play.

### 18.37 The polish pass: filters, steadier aim, smooth turns both ways

- **Panel FILTERS** (Outliner + Media Collection): a small substring box in
  each toolbar HIDES non-matching rows/tiles; clearing it restores the list.
  Display-only by explicit design — no selection, no viewport, no game state,
  and a repaint re-applies the active filter instead of resetting it.
- **Every scene the bazooka can fire in needs its MIssile template** —
  ammunition is a scene element (§18.15), and Scene 3 didn't have one, so
  nothing spawned. scene-3.json carries its own copy now. (Design note for
  later: templates could auto-travel with the carried weapon.)
- **The assist is LOW-PASSED**: it reads last frame's bone pose, so the walk
  bob fed straight into the correction and the muzzle whipped mid-stride.
  The delta quaternion smooths over ~150 ms (direct prop, per the userData
  law) — on the focal, off the hip sway.
- **Turns are ALWAYS FORWARD now**: reversed playback (the alternating
  mirror) demanded a hard-cut entry — a 180° pose blend picks its hemisphere
  at random — and that cut read as "she jumped to face forward, then
  turned" (Austin's S-then-W case). Every turn enters over the `turnBlend`
  crossfade; the mirrored aesthetic was not worth the snap.
- ~~Known deferred: firing at very-near meshes~~ — un-deferred and fixed in
  §18.38 the same night.

### 18.38 Ammunition travels, and rounds survive their own birth

**Templates auto-travel with carried weapons** (Austin's call, closing the
§18.37 design note): when the inventory crosses a scene boundary, `goToScene`
also stashes every Projectile TEMPLATE a carried weapon names
(`world.carriedAux` — rendered, ticked, and findable like `world.carried`,
but never adopted into the inventory; a pocket holds weapons, not molds). A
scene that carries its OWN copy of the template wins — the travelling twin is
dropped so the name resolves to exactly one mold. `_projectileCheck` and
`world.find` both search the aux list, so a bazooka fired in a scene that
never heard of missiles just works. Proven: scene-3.json's hand-copied
MIssile was DELETED, the template travelled from scene 1, and a live-fired
round flew. (scene-2 keeps its own copy — its rack bazooka must fire for a
player who arrives empty-handed.)

**The near-mesh no-fire, un-deferred** — it was two bugs:
- The spawn's flight direction used the RAW focal: a hit beside the lens sat
  BEHIND the muzzle, so `focal − muzzle` pointed backwards and the round flew
  off past the camera. The §18.36 push-out (player distance + 3 m along the
  camera ray) now applies at the spawn too.
- **SPAWN GRACE** `(spawnGrace 0.6)`: the muzzle can sit against or inside a
  mesh, and a round born inside a volume died on its first sub-step. Hits
  inside the first grace-metres of flight don't count; a real point-blank
  target is still inside its own volume when the round clears the grace, so
  close shots still land.

### 18.39 Weapon-type CLASSES, and the registry that made the second one cheap

The type-3 fists proved a weapon could own the searched locomotion table
(§18.15's successor). The lance asked the real question: is the
SECOND weapon class cheap? It was not, at first — "Bracer", "CombatAir" and
"combat" were spelled into two dozen decisions across the matcher.

The fix is a registry, `WEAPONS = {tag: {prefix, set, airSet}}`, and the
observation that made it honest: **the reference action game authors every weapon class the same
moveset on the same role grid** (`c0xx` small sword, `c2xx` heavy sword,
`c4xx` spear, `c6xx` bracers — `c#01` stance, `c#0a` run, `c#3b` double
jump, one-for-one). So the engine is prefix-templated: clip tagging, parked
filters, gait votes, run rates, air-family bias, landings, glide/freefall/
slam/double-jump installs, action caps all derive from the equipped tag.
Adding a class = one registry line + ~31 curated clips + an item script.
The full checklist lives in `docs/engine/07-weapon-archetypes.md`.

Three findings the second family bought:

- **Parked clips may not vote in the gait table.** The inclined runs are
  excluded from search (their roots curve; the pivot superseded them), yet
  their pace captured the "run" tier and the request system then asked for a
  speed the table could not serve — full stick walked forever.
- **A speed ramp belongs in the OUTPUT domain.** The matcher is calibrated
  to snapped requests; a swept request self-traps (walk pins the measured
  speed, continuity wins). The reference game's gradual build-up is the authored
  `_Walk_to_Run` clip plus a playback spin-up (`runUpT`, 70→100% over 0.7 s).
- **Every family-conditional path needs the family bias, including
  fallbacks.** A weapon descent lives almost entirely in the air search's
  LAND→fall-loop fallback, which had no bias: with two families baked, the
  bracers fell in the SPEAR's fall pose, 78/78 measured. One family had
  hidden it perfectly.

Two body-level bugs surfaced in the same pass, both older than the spear:
the foot lock captured its ankle clearance from the DISPLAYED skeleton (a
plant during a stop's blend caught the foot mid-swing and pinned it half a
metre up for the whole stance — "she thinks her foot is on a tall rock"),
and mounted items are parented under a hand BONE, outside the character's
raycast exclusion, so the 3.5 m lance was walkable ground. Rules now:
ankle clearance comes from the CLIP's features; carried things are never
ground.

And a process note worth as much as the code: **grip conventions come from
the source game, not from geometry metrics.** An orientation sweep that
maximised "up-ness" chose a confident, wrong hold. What worked was
rendering a TITLED CONTACT SHEET of candidates and letting the director
point — the along-arm carry (shaft on the forearm, hand at the mesh's own
axis point) took four sheets and minutes, after an hour of measuring.

### 18.40 The Enemy class, the Combat Room, and the no-retarget bake

The first real combatant (docs/engine/09-enemy-system.md). Decisions:

- **Enemies keep their native skeleton.** No retarget, no pose database —
  `bake_enemy_glb.py` drives the reference action game mot importer over the extracted model
  blend and exports ONE glb whose named clips the renderer's mixer plays.
  The player pipeline's cost (weight paints, alignment poses, GAIT_RATE) is
  a per-CHARACTER cost; enemies sidestep all of it.
- **The brain lives in the base class**, selected by dat (`aiType`), with
  `friendlyUntilAttacked` as a live editor checkbox. Scripts are one-line
  consumers; adding a behavior tree is an engine change, on purpose — one
  place to reason about all combat AI.
- **`AE1Enemy extends AE1NPC`, and NPC survived.** The goober still runs on
  the old class; the rewrite Austin authorized became a subclass + a wander
  factor-out (`_wanderTick`) instead of a replacement. the NPC (the placeholder
  enemy element and `enemy.ags.txt`) was retired with his blessing.
- **Enemy clips are in-place; the AI owns travel.** The glTF exporter bakes
  object-level root tracks into every clip, own-glb clips are not
  root-drift-locked, and the mixer stomped the element transform — the
  stubby walked in place at the origin while his element crossed the room.
  `strip_root_channels()` in the bake tool is the law now.
- **<asset> was the right first enemy** because the game ships its own
  labels: `AnimationTable.csv` maps state → motion id, so the 118-mot pack
  needed no triage gallery. The variants (em0002…, desert/forest/factory
  stubbies) re-skin the same rig and reuse `<asset>` — the second enemy
  species costs one bake command.
- **Known ceiling:** one ANIMATED instance per glb (render3d's
  one-glb-one-timeline rule) — "a bunch of enemies" needs per-instance glb
  names or a renderer change. Recorded in docs 09 as the start-here.

### 18.41 Combat feel: time effects, rumble, hurt reactions

The impact layer (docs/engine/10-combat-feel.md). Decisions:

- **Time bends at ONE chokepoint** — the loop's `_tick` scales every dt it
  hands out (`_timeFxScale`), so hit stop and kill slow-mo slow the whole
  simulation uniformly, UE's global-dilation model. Effect clocks run on
  real time; concurrent effects combine by MINIMUM; scale never hits 0.
- **Global, not per-pair, on purpose.** Classic hit stop freezes only
  attacker+victim; with a one-player-two-enemy game the global bend is
  imperceptible and cost one function. Revisit if arenas grow.
- **The kill is the loud moment**: slowMo(0.7 s @ 0.12, ease 0.45) fires
  only on a killing blow (melee sweep or projectile); ordinary hits get
  80–130 ms hit stops. Values sit inside researched genre ranges (the publisher
  6–8 frame stops; Smash's damage-scaled hitlag; UE tutorials' 0.2–0.5
  dilation).
- **Rumble is garnish**: `input.rumble(strong, weak, ms)`, feature-detected,
  never throws, newest pulse wins. Keyboard players lose nothing.
- **the player character reacts under the reference game's rules**: her own damage mots (`Reaction` set,
  action-tagged like Ladder — named-only, never searchable) play from
  `takeDamage`; light hits never steal a swing, `bigHitAt`+ interrupts,
  ladder/traversal/air are reaction-proof, 0.8 s anti-stunlock.
- **Deferred by spec**: particles, sound, HUD; camera kick, directional
  reactions, and dodge-canceled stagger are researched and queued in docs 10.

### 18.42 One of each thing (carried items never duplicate on the ground)

Austin's rule, after a bracer "fell off" returning from the Combat Room: if
an item is in the player's inventory, NO copy of it may spawn on the ground,
in any scene, in any direction. The old behavior — the pickup-time dup guard
refused a second pickup but left a scene's authored copy VISIBLE on its rack
— broke the moment inventory persisted across scenes: re-entering an item's
home scene rehydrated its authored element at the authored transform while
the carried double rode the hand. Fixes, both in `world.goToScene`:

- **Authored copies of carried items are REMOVED from the incoming scene**
  (name match, stackables exempt — same key as the pickup guard). Removal,
  not hiding: a hidden twin still answers `find()` first and shadows the
  carried instance for every script.
- **The companion handoff transfers state.** When a scene's authored copy of
  a travelling `fistPair` companion takes over from the twin, it now COPIES
  the twin's mount component + visibility — the authored element is a fresh
  spawn at its rack transform, and without the twin's state a worn left
  bracer re-entered its home scene lying on the floor.

### 18.43 Lock-on

Dark-Souls Z-targeting (docs/engine/10-combat-feel.md#lock-on). Decisions:

- **The aim ray picks the target** — Austin's spec verbatim: the enemy
  nearest the camera→focal ray wins, so lock-on and the bazooka agree about
  what "aimed at" means. Score = perpendicular distance + 5% range tax.
- **The lock kit lives on the base character** (`_lockTick`/`_lockAcquire`/
  `_aimFocal` in thirdperson.js), called by both character systems; the
  camera reads `_lockTarget` off its target and owns yaw while it lives.
- **The marker is a spawned element, not authored** — `LockMarker` builtin,
  created on lock, `scene.remove`d on release. game3d's element-count
  rebuild loads its glb at runtime; `(lockMarkerMedia)` as a character dat
  keeps the exporter shipping it. Base class on purpose: the alchemy-ring
  future is a media + dat swap, not new machinery.
- **Opt-in forever**: `(lockOn "KeyZ PadRS")` — a player who never clicks
  the stick never notices the system exists.

### 18.44 Attack archetypes: classified, event-dispatched, script-tunable

Enemy attacks became typed data (docs/engine/11-attack-archetypes.md).
Decisions:

- **Per-animation classification in dat** — `(attackSpecs ((clip kind
  damage [key value]...)))`, kinds melee/ranged/aoe1/aoe2, unspecced clips
  degrade to plain melee so old enemies never notice.
- **The combat event fires at the TELEGRAPH** (attack start): who/what/
  where/when/state/target → the target's `onEnemyAttack` hook + the global
  `world.attackEvents` feed. Dodging needs the warning, not the receipt.
- **Damage is runtime-mutable per clip** (`get/setAttackSpec/Damage`) — the
  AngelScript surface for buffs, enrages, and difficulty, verified live.
- **Execution spawns dumb elements** (`EnemyRound`, `AoeWave` — the
  LockMarker spawn pattern): numbers injected at birth, they move, test the
  wave-front rule (once, front-passing), and remove themselves. meshforge
  grew `sphere` + translucent `"color"` materials for their signal meshes.
- **Melee = mesh overlap** (Austin's rule) with a reach-scaled pad, because
  bind-pose AABBs don't swing and `Hitbox.intersects` can't see a Model —
  both traps recorded in docs 11.
- **The flyer (<asset>) rode in free**: hoverHeight floats the existing
  brain, attackRange 9 makes it fire from distance, and its "shoot
  animation" is the hover pose — its mot pack ships no attack clips at all.

### 18.45 Player death and the restart contract

The "at zero, deliberately nothing happens" note in thirdperson.js finally
got its design conversation (docs/engine/10-combat-feel.md#2bs-death):

- **the player character dies with her own animations** — <asset> (Self-Destruct
  collapse) and <asset> (blown flat) in the Reaction set; both
  weaponless, so one pair covers every weapon family. Picked by
  killing-blow size, the same `bigHitAt` threshold as hurt reactions.
- **The corpse freezes honestly**: neutral-input driver steps through the
  clip, then no steps at all — the released skeleton holds her final frame.
- **`world.restart()` is the full-reset contract** — pockets emptied on
  both sides of the stash, sceneFile cleared to defeat the same-scene
  early-out, everything else rehydrates fresh. Death restarts at Scene 1
  today; checkpoints are a dat (`restartScene`) away.

### 18.46 Instancing and instance-overriding

Austin's "doozy" turned out half-built (docs/engine/12-instancing.md):

- **The declarative half already existed** — scripts are prototypes (dat
  defaults), elements are instances (override-only persistence). Named and
  documented rather than rebuilt; no `Instance` base element needed.
- **Per-instance animation** closed the real gap: clone-bound elements get
  their own mixer over the shared glb's clips, opt-in by an explicitly set
  clip so statues (rounds, item twins, door1's second) stay statues.
- **`spawnInstance(proto, overrides)` + `instancesOf(name)`** are the
  programmatic half; components deep-copied, `_protoName` stamped, onLoad
  dispatched. Behavior overrides are DAT overrides (aiType, attackSpecs,
  tint) — methods stay on the shared class.
- **`model.tint`** is the per-instance material story: lazy material clone
  + color multiply, `setTint(hex)` from any script.
- **The horde is the regression test**: 20 stubbies from one parked
  pacifist prototype, ring-scaled health/damage, eight tints, ~20 lines of
  AngelScript, one glb download.
- **Trap recorded**: an open editor tab journals + beacon-saves its scene —
  file-side scene edits lose; go through the live store or the Projects
  page.

### 18.47 The Fox camera, the shader layer, and the reference action game environments

The stealth-game-feel round (docs/engine/13-fox-camera-and-shaders.md). Decisions:

- **The camera is a lens, input stays raw.** the reference stealth game engine's model, verified
  from its extracted camera scripts (16–35 mm at f/1.875): never smooth the stick;
  damp POSITION per-axis with speed-loosened lag; sway is 3-octave noise on
  the OUTPUT rotation only, so steering/lock-on/aim keep clean state.
  `(handheld 0)` restores the rigid camera exactly. Chase lag retuned for
  the player character's 12 m/s sprint (drag ≈ speed × lag — the reference's constants trail double).
- **PostFX is an element, passes are a module.** One uber-pass (focal DOF /
  grain / vignette / CA) modeled on Austin's own ReShade preset for the reference action game;
  autofocus eases camera→chest distance the way CinematicDOF does. Zero
  cost absent; scaffolded for the rest of the Fox stack (bloom, tone
  shoulder, LUT, motion blur — ROADMAP).
- **Environments are museum assets now**: bulk_import already ate wd/ba/bg
  formats; export_static_glb.py is the missing half (LOD strip, single
  named root — from bpy.data.objects, the sub-collection trap — dds→png,
  --upload). Map tiles carry world offsets: grid-probe the floor, offset
  the element. First ground shipped: the flooded-city colosseum, live under
  the player character in the foxcam testbed.
- **docs/ROADMAP.md is the reassessed checklist** — the standing answer to
  "what next", refreshed this round.

### 18.48 The Light element

Light became first-class (docs/engine/13, "The Light element"). Decisions:

- **Element state, renderer objects** — the Light element carries position
  and dats; render3d's lightSets owns the THREE lights (create/retype/
  sweep). The seam is deliberately the future-GPU hook: shadows, probes,
  and eventual ray-traced backends replace the renderer half only.
- **sun/point/spot + a hemisphere fill on one element**, and `(follow
  true)(lightHeight N)` glues it above the player — the "sun above the
  character" ask, one script.
- **Invariant 17 struck again**: the follow dat was born `height` (base
  schema) and the sun hovered at half a metre. `lightHeight`. The invariant
  is real; check every new dat name against ELEMENT_SCHEMA.

### 18.49 Fishing and camera courses

The fishing1 round (docs/engine/14-fishing-and-camera-courses.md).
Decisions:

- **Camera cinematics are CHARACTER-RELATIVE curves** (the `Character`
  prefix, Austin's naming): curvePoints are offsets in the character's
  frame anchored at play() time — author once, plays anywhere. The
  ThirdPersonCamera hands its fields to a live curve and takes the orbit
  back untouched (_yaw/_pitch never written by curves).
- **One active curve, engine-enforced** — play() refuses while another
  holds. Courses conduct sequences by NAME through the global lookup and
  never touch the camera directly, so the rule holds by construction.
  onStart/onEnd are real RUN_INFO modes.
- **Fishing is a script, not an engine state**: the whole enter/cast/wait/
  miss-recast/catch/present machine is one Hitbox script chaining
  playAction on the new fishingPack pack (the player character's own <asset> block,
  action-only set — the Ladder/Reaction precedent, third verse).
- **The fish is data**: koi_carp.glb from the museum's etf roster (all 21
  fish + variants + junk already extracted — a fishing-game's whole
  bestiary one export call away).

### 18.50 TriggerBox, bloom, and the reference action game glow convention

The chair-under-her round (docs/engine/14, "TriggerBox, bloom..."):

- **TriggerBox is the audio-region idea made scriptable** — a volume
  dispatching onStart/onEnd (the camera-curve modes, reused) to its own
  script. Fishing walked from an E-press Hitbox to a walk-in volume that
  spawns the chair AT the character; any cutscene/ambush/checkpoint volume
  is now a two-hook script.
- **Bloom is threshold-extracted from emissive** (½-res bright pass, ¼-res
  gaussian bounces, additive) — dats on PostFX.
- **the reference action game marks glow with shaders, not textures**: no emissive map exists in
  the reference game's WMB4; `CNS*`/decal shaders × `g_Intensity > 1` is the marker,
  parked as custom props on imported materials. The static exporter wires
  those into glTF emissive automatically — the game's own art direction,
  recovered data-driven.
- Two doctrine scars: interact targets need visible render bounds (test
  through the REAL input path, not dispatchTo); long-lived editor tabs
  predate new builtins — reload after registering one.

### 18.51 The City Ruins and the flight unit

The flight1 round. Decisions and finds:

- **Main-game map tiles are now routine**: nine city-ruins center tiles
  pulled headlessly from Steam's <pack>/014 via LibCPK (the scripted
  recipe), museum-converted per-process, art-only exported — and the center
  tile g10716 sits AT the world origin (the crater is the map's center), so
  the cluster needed zero re-homing. 121/121 ground probes walkable.
- **The flight unit is <asset>** (already a museum blend), its 97-mot
  library is <asset>, and boarding is a SYNCED PAIR: the player character's <asset>
  and the unit's <asset> share an id — she climbs while it opens. The
  unit baked through the enemy pipeline (Board/Idle/Unboard/Cockpit); her
  side rode a new flightPack pack (set Flight, action-only — fourth verse).
- **The flight trigger is the fishing pattern verbatim**: an interactive
  TriggerBox, E to board (snap to the mount anchor, play the pair), the
  boarded state pauses on relinking Cockpit cycles until E dismounts.
  Ladder mode wraps the boarding so vertical root motion is honored.
- Honest note: the retarget's root-split parks most of a005's 2.5 m rise —
  her seated height in the cockpit is the polish knob (mount-anchor offset
  or a vertical-preserving re-bake) once seen on screen.

Austin's first playtest (the exploded flight unit) closed the round with
three engine-level finds:

- **The mot importer had a position-channel sign bug** (plugin
  `mot/importer/animationData.py`): game-space Z maps to armature −Y, but
  the parent-offset subtraction for channel 2 skipped the negation — every
  bone with a fore/aft rest offset landed 2× displaced. Invisible on
  characters (only hips/root key positions, near-zero fore/aft offsets);
  fatal on MACHINES, which animate whole part-bones by translation. The
  unit rendered as an exploded kit until the one-line negation fix; every
  future mechanical bake (vehicles, turrets, opening machines) rides it.
- **`world.env3d.groundAt` is frame-dependent** — do NOT use it to place
  scene objects. The reliable ground probe is the character herself:
  teleport, let gravity settle (≥1.4 s), read `element.y` (= feet). The
  City Ruins center is crater-rim rubble; the flat spot that hosts the
  unit is the boulevard around (−6, z −10.5), found by grid-probing the player character.
  A unit's element.y = its rendered bounds min (base of the model).
- **Seat cosmetics are dats, not code**: the boarded snap places her via
  `seatHeight` / `seatForward` / `seatYaw` (relative to the unit's origin
  and heading) on the FlightTrigger — live-tunable in the editor panel, no
  rebuild loop. The unit's walkable hull (renderer meshes count as ground)
  means she can clamber onto it; the trigger volume is sized to cover
  standing on the hull (sizeY 8) so E boards from there too.

### 18.52 Aircraft — the pilotable vehicle base element

Request 12: fly the flight unit. `engine/aircraft.js` (builtin `Aircraft`,
`(extends Aircraft)`) is the generic seam; the flight unit is its first tenant
(flight1's `flight-unit.ags.txt` is pure dat configuration).

**The root-of-truth contract**: the third-person character stays the root —
input, position, hitbox. Boarding puts her driver in LADDER MODE (physics
suspended, verticals honored) and the aircraft's physics drives her root
directly (`mm.teleport` + `setYaw` per tick); the aircraft element MIRRORS
her at (pilot − seat offsets), wearing pitch (`rotationX`) and roll
(`rotation`). Character-side, one block in `_mmTick` (after the dead block):
while `_pilotCraft` is set she only advances her held riding pose and
mirrors out — no interact, no combat, no locomotion (the fishing-state
doctrine). Weapons sheathe automatically (ladder mode's existing edge).

**Modes** (the flight unit's own canon): TRAVEL = "Asura", upright hover, Armored
Core hands — camera-relative inertial strafe, mech faces the camera aim,
boost held / QUICK-BOOST on a sub-0.24 s tap (the a030/a031 spin evades),
terrain-following hover that rises with ground but only ever DESCENDS
slowly on input (hoverRise/hoverFall), melee lunge + shot attacks (melee =
frontal-arc `takeDamage` sweep + hitStop). FLIGHT = "Cygnus", jet — Ace
Combat hands: throttle (Shift/Ctrl), stick pitch, roll-to-turn
(`bankTurnRate` × bank fraction), dive-gain/climb-bleed on speed, ground
skim clamp, and a `voidFloor` (past the map edge the ground ray answers
null — first test flight corkscrewed to −19 m over the abyss). F toggles
modes; flight→travel REFUSES above `travelEnterHeight` (and over void —
Infinity altitude). E boards (a TriggerBox calls `craft.board(actor)`) and
dismounts — travel only. The trigger is a thin doorman that FOLLOWS the
parked unit, so E re-boards wherever a flight ended.

**Clips are dats, both sides**: unit-side names live in the element's glb
(16 baked: Idle/Board/Unboard/Cockpit, Travel_Move(a01b)/Boost(a01e),
QB_L/R(a030/1), Attack_Melee(a02a)/Shoot(a025), ToFlight(a508)/
ToTravel(a530), Cruise(a500), Bank_L/R(a532/3), Cruise_Attack(a501));
pilot-side actions come from <pack> (Board/Exit/Cockpit +
Prone(a500, 2-frame hold — force-looped like the air cycles) /
Transform(a508) / TransformBack(a530)). The scene element's model
`clips` whitelist must list every baked clip or the renderer won't load
them. The pilot HIDES (`visible=false`) in flight mode and during travel
attacks (the hull swings through the seat); rides visible otherwise.

**Cameras**: travel keeps the fox orbit untouched (she IS the craft).
Flight publishes `pilot._flightCam` {yaw,pitch,roll,dist,fov} every tick;
a block in `AE1ThirdPersonCamera._camTick` (after the curve handover)
flies formation — eased chase position, banked horizon, FOV opening with
airspeed — and hands the orbit back (behind the craft: `_yaw = heading +
180`) the frame the field clears. Transitions conduct CharacterCameraCurve/
Course elements BY NAME (`boardCourse`/`exitCourse`/`toFlightCurve` dats):
the board shot is the low bottom-left art angle whose RELEASE is the hard
jump; the transform shot slides dead astern (character-relative anchoring
= the craft's nose, so "behind" is correct at any bearing) and the chase
picks up from almost exactly its final pose.

**Dispatches**: onBoard / onUnboard / onModeChange (compiler category
'aircraft').

The LONG pilot-polish session that followed (2026-08-26) is condensed in
docs/engine/15-aircraft.md: the aaf6 Travel_Idle pair, boost/QB clips
gated off, the CUT board/exit seams (the ID-pairing trap: unit a020/a023
are knockbacks sharing her mount numbers; her mounts are authored at
cockpit height), the exit's guaranteed drop above local ground, travel
strafe handedness (right = aim MINUS 90), the YXZ `rotationOrder` opt-in
(XYZ pitched a yawed craft into visible roll), stubby combat + the
_friendly AoeWave, the export prune trap for runtime-spawned media, the
looping-held-action frames-2 guard, and the reference action game effect-sprite pipeline
(fx `texture`/`color`, <pack> effect/texture → DDS slice → PNG).

Austin's first pilot playtest fixed three things: (1) the PARKED idle is
a015 (the authored 361f upright cycle) — a010 is a 51f flight-family cycle
that skips at the wrap; (2) **the PHASE LOCK**: `env3d.setClipTime`
(injected through the game3d facade — the raw renderer export alone is
NOT reachable from elements) slaves the hull's mixer to the pilot's
`actionAge` every paired tick (boarding/travel loops/toTravel/unboarding),
so the synced pair cannot drift across tab suspends or clock clamps —
verified by perturbing the mixer 2.5 s mid-travel: re-locked to one frame
on the next tick. Trust nothing that "started together"; slave one clock
to the other. (3) The mech faces the camera aim ONLY under movement
input, and entering travel parks the ORBIT behind the craft's heading
(`_acCamBehind`) — the camera adopts the craft, the craft never turns
for the camera (Austin's rule). The animation taxonomy that fed the bake (97 <asset> mots,
rendered and classified): a01x upright hover cycles, a02x travel melee,
a030/1 spin evades, a04x/a50x jet family (a500/1/2 cruise cycles), a508/
a530 transforms (BOTH with the player character rider pairs), aa0x second upright family,
aa30/1 65 m climbs, aafx = 16 riding-attitude cycles every one of which
the player character pairs, e0xx cinematics (<asset>/3 long jet cruises). Sheets in the
session scratchpad; re-bake candidates for later modes live there.

### 18.53 Performance doctrine (first pass, 2026-08-26)

Profile in flight1 (nine city tiles + skinned unit + PostFX): ~24 ms/frame
(41 fps) at pane size, p95 29 ms — CPU-bound at small resolutions.

Shipped levers:

- **Static matrix freeze** (render3d, automatic): after every build pass,
  children of bindings whose glb ships NO animations get
  `matrixAutoUpdate = false` (locals baked once). The bound ROOT stays
  live so applyTransform still moves the element; skinned/boned subtrees
  are exempt. A city tile's hundreds of child meshes stop recomputing
  identity matrices every frame.
- **`(renderScale 0.75)`** on the PostFX element (opt-in, clamp [0.4, 1]):
  the scene renders into a smaller target and the final pass upscales —
  ~1/scale² of GPU fragment cost back, softness hidden by the film layer.
  Measured no-op at small pane sizes (CPU-bound there); it pays at
  full-screen on GPU-bound machines.

Phase 2 (same day): baseline 24.5 ms/41 fps → **21 ms/48 fps** at the
same spawn view. Shipped: `powerPreference: 'high-performance'` +
devicePixelRatio CAP at 1.5 (a 2x display was paying 4x fragments);
**`(cullDistance N)` dat on any element** — a 1 Hz sweep hides the bound
object when the camera is beyond N of its RENDERED bounds center (tile
elements all sit at origin; the offset lives in the glb — measure bounds,
never element position). flight1 tiles carry 260.

**THE MEASURED NEGATIVE, do not retry naively**: joining each tile's
meshes into ONE object (`--join` in export_static_glb.py, kept for
small props) collapsed 350 draw calls to 43 — and dropped the scene to
6 fps. One bounds per tile DESTROYED per-mesh frustum culling: every
in-frustum tile drew ALL its triangles. At this scale the map is
vertex-bound the moment culling coarsens; the draw calls were never the
bill. The refined version (join per material within ~25 m spatial cells,
keeping culling granularity) is ROADMAP phase 3.

Future levers: spatial-cell material join (above); THREE.InstancedMesh
for repeated props; skinned mesh count on the 63 MB unit (the flight unit
renders every part always).

The measurement kit that found all of this: a rAF delta sampler pushed
into `window.__ft` (300 frames, report avg/p95/spikes) — cheap enough to
run before and after every perf-relevant change. Numbers, not feelings.

**Phase 3 (2026-08-26): LOD pairs + flight LOD — 45 → 75 fps in flight.**

Attribution first: element-ablation put the whole bill in the tiles
(9.1 ms of 22.4; PostFX ≈ 0, unit ≈ 0.2, stubbies ≈ 0). Three findings
reshaped the design before anything paid off:

- **`cullDistance` was silently inert since phase 2.** Two clobbers: the
  scene-JSON key never reached elements (applyData copies ELEMENT_SCHEMA
  keys only — fixed by promoting `cullDistance`/`cullDistanceMin` to real
  schema props, Render group), and applyTransform re-asserts
  `obj.visible = wantsVisible(el)` EVERY FRAME, overwriting the 1 Hz
  sweep a frame later. Verdicts now live on `userData.ae1CullHidden` /
  `ae1LodHidden`, and applyTransform/applyParts fold them in. Any future
  "sweep sets visibility" feature must ride those flags, not write
  `.visible` directly.
- **The nine wd1 "tiles" are NOT a spatial grid.** All nine overlap one
  ~±150 m area (bounds centers cluster near origin) — element-level
  distance swapping can never separate near from far. wd2 is a different
  map (the g20xxx distant-flyover world), not per-tile LOD twins; the
  museum blends carry 0 authored `-LOD` meshes (stripped at bulk import).
- **The bill is VERTEX PROCESSING, not texture bandwidth.** A full-geometry
  512-texture bake measured 23.2 ms — zero gain (measured negative #2).
  Decimation is the only lever that pays.

Shipped machinery:

- `export_static_glb.py --decimate 0.25 --texsize 512`: bakes a
  `city_<t>_lod.glb` twin per tile (unjoined — meshes must pair 1:1),
  81 MB for the set vs 278 full.
- **Per-mesh LOD pairs** (render3d `sweepLodPairs`, 1 Hz): a full element
  names its twin in the model bag — `lodPair: "city_<t>_lod"`,
  `lodDistance: 110`. Meshes pair by name + occurrence; each swaps
  against the camera's distance to its own world AABB (sphere-surface
  distance never fired — ruins meshes sprawl, spheres swallow the map;
  center distance decimated a near overpass in your face). A mesh whose
  box contains the camera is always full; an unpaired mesh never hides.
- **Flight LOD** (`env3d.setLodFar(on)`): honest AABB distance saves ~0
  on foot — the giant always-near meshes ARE the bill. But the full
  decimated set renders in 13.4 ms vs 22.4 (the whole tile bill gone),
  and at flight speed/altitude the decimation is invisible. The aircraft
  flips it: `_acToFlight` → true (the fold curve + seam flash hide the
  swap), the toTravel unfold / unboard → false. On foot nothing changes
  (D=110 keeps near geometry exact); in flight, 75 fps.

**Phase 3b (same day): BVH raycasts — combat 23 ms → 14 ms (71 fps).**

Austin's repro (fight the stubbies after flight round-trips → "massive
frame drop", recovers when they die) attributed to RAYCASTS, not the LOD
system: three.js has NO ray acceleration — every `groundAt` probe does
per-triangle tests against whatever the bounding spheres pass, and the
City Ruins megameshes made that **3.06 ms PER CALL** (measured), with
~400–700 probes/s at idle and every chasing enemy adding several per
tick. Three aggroed stubbies alone ate the frame budget; killing them
freed it — hence "frame rate returns when they're dead". A ray that
MISSES everything (off the map edge) is the worst case of all, which is
what "leaving the map causes a big drop" was. The same garbage churn was
behind the periodic 70–140 ms idle spikes (GC).

Fix: **three-mesh-bvh 0.9.1 vendored** at
`engine/vendor/three/addons/utils/three-mesh-bvh.module.js` (MIT; the
editor importmap's `three/addons/` prefix and the exporter's addon
resolver both pick it up unchanged). render3d patches
`BufferGeometry.prototype.computeBoundsTree` / `Mesh.prototype.raycast =
acceleratedRaycast` at module scope, and the static-freeze pass builds a
`boundsTree` for every static mesh (same no-animation gate; skinned
meshes keep the stock path — acceleratedRaycast only engages where a
tree exists, semantics unchanged). Measured: groundAt 3.06 → 0.24 ms;
lock-on combat vs 3 aggroed stubbies 14.2 ms/71 fps, identical after two
full flight round-trips; the idle GC spikes gone.

**LOCAL PATCH in the vendored lib** (marked `AE1 LOCAL PATCH` in the
file): three r166+ `Triangle.getInterpolation` returns null for a
degenerate (zero-area) triangle — the reference action game map meshes contain some, and
mesh-bvh's unguarded `intersection.normal.dot(...)` threw from every
enemy ground probe that grazed one (`_enemyTick ... reading 'dot'`). One
null guard; re-apply it if the lib is ever re-vendored. Editor Build &
Ship and the export API produce byte-identical builds (hash-verified) —
both read the project from disk through the same exporter.

### 18.55 The Follower Pod (2026-08-26) — the companion pod at the shoulder

the reference action game's pod as a base element (`engine/followerpod.js`, builtin
`FollowerPod`; docs/engine/16-followerpod.md is the full page; `pod1` is
the demo — flight1's City Ruins + the flight unit + stubbies, plus the book).

The shape of it: the pod is its OWN element with its own model + clips;
the HOST stays the root of truth (the pod chases a camera-relative
shoulder offset on a spring + bob and never pushes back); ONE button, two
gestures (`podFire "KeyQ PadRB"` — the Controller token grammar,
identical on keyboard and pad): tap-and-hold = a rate-limited stream of
`PodBolt`s at the host's lock target or the camera's aim point, a
DOUBLE-TAP inside `doubleTapTime` = the special — a charged shot on a
cooldown that detonates into a FRIENDLY AoeWave (§18.44's `_friendly`
mode; `podSpecial` stays as an optional dedicated extra button). The
AUTHORED idle clip carries the hover — the procedural bob is a slow
drift only (a stacked fast sine read as frantic bobbing). `PodBolt` is EnemyRound's mirror: hunts `takeDamage` +
`_npcAnimate`, never the player. Kills credit the HOST (combat-feel
hooks fire there). Named-Particles fx dats (`muzzleFx/hitFx/specialFx`);
`hitFx` is moved to the impact point before bursting. **The flight-unit
rule costs zero wiring**: the pod reads `host._pilotCraft` each tick —
set on board, cleared on dismount by the aircraft already — and hides
itself while piloting.

Asset facts, hard-won: the companion pod skin is **<asset> in Steam
data101.cpk** (DLC pod skins sit one per archive — 3012 cardboard/105,
3014/107, 3017/108; a character head = <asset>/<pack>; <asset>'s "eyelash"
material is the tell it is NOT the book). Pod MOTIONS live in <pack>
`wp/<asset>` — 45 `<asset>`; **the DLC skins share the <asset>
pod skeleton**, so the book plays pod motions unretargeted through
bake_enemy_glb.py. Clip truth by inspection: 0000 = the 180 f idle
hover, 0010 = the 25 f fire cycle (0011 is a 0-frame POSE, not the
loop), <asset> = a 33 f flourish (the special). Tooling grown for this:
`bulk_import_models.py` `cpkdlc` root; `bake_enemy_glb.py
--emissive-lift F` (base-color → emission at F — companion props were
silhouettes under the night City Ruins); the plugin `dat_unpacker`'s
extract path joins with a leading backslash and lands at the DRIVE ROOT.
Verified in pod1 through real inputs: Q burst 60→0 on a stubby, C
special one-shot another, E in/out of the flight unit hides/reveals.

### 18.56 The Debug Menu (2026-08-26) — the flag wall

The reference-game-style debug menu as a base element (`engine/debugmenu.js`,
builtin `DebugMenu`; docs/engine/17-debug-menu.md is the full page; wired
into flight1/pod1/tower1 as `DebugWall`). SELECT+START on a pad or tilde
on the keyboard freezes the game AT THAT FRAME and drops a wall of white
monospace flags; WASD/d-pad walks it, SPACE/A toggles, the same combo
resumes — flags apply as the loop restarts.

The freeze is a HARD pause, two new engine surfaces working together:
`loop.paused` stops onTick dispatch entirely (not dt=0 ticks — held keys
cannot queue actions through the freeze; onFrame still presents and
clears input edges) and `env3d.setPaused` stops the RENDERER's clocks
(mixers, instance timelines, procedural, particles; the clock delta is
still consumed so resume never sees a dt spike). While paused the menu
lives on its OWN rAF + listeners and polls the gamepad directly — the
paused loop cannot tick it. Combo arming requires full release between
uses.

Wired flags: AI_FREEZE (guard atop `_enemyTick`), INVINCIBLE (player
takeDamage patched once, wrapper reads the live flag), NOCLIP (free-fly
in the character tick — camera-relative WASD/stick, SPACE up, CTRL down,
SHIFT 3×, `mm.teleport` per tick with a neutral matcher update and the
§18.30 mirror kept honest — no gravity, no collision), SLOW_MO
(timeScale 0.3), FX_OFF (`env3d.setPostFxOff` — the whole shader stack
off, plain render path, for perf isolation), LOD_FAR (forces §18.53's
flight LOD), WIREFRAME, SHOW_FPS (persistent meter), POD_HIDE /
POD_NO_CD (guards in the pod tick). Project flags from the `flags` dat join the wall inert but
queryable via `world.debugFlag("NAME")` — the cheap gate for
experiments. Events: onDebugOpen/onDebugClose.

Verification trap for the notebook: Chrome throttles rAF to ~1 Hz when
the WINDOW is occluded even while visibilityState says visible — a
synthetic 120 ms keypress falls between ticks and "nothing happens".
The menu's own input is event-driven and immune; the open-combo runs on
the loop, so automation against a covered window must hold the key for
a full second.

**The game console proved the surfaces compose** (tower1
`scripts/console.ags.txt` — a PURE PROJECT SCRIPT, zero engine changes):
ALT+C freezes the frame through the same `loop.paused` +
`env3d.setPaused` pair and drops a quake-style command line. Commands
are the GAME's namespace, not the engine's (`blur.radius = 2;
blur.intensity = 99` → the ScenePostFX element's dofMaxBlur/dofAperture
dats), split on `;`, with `list`, `reset`, bare-name queries, and ↑/↓
history. Because the renderer reads PostFX dats every frame and keeps
presenting while paused, edits preview LIVE under the frozen frame.
Adding a command is one line in the script's `commands()` table — the
pattern any project copies. If a third project wants it, that is the
moment to promote a generic Console builtin (the DebugMenu precedent).

### 18.57 Environment light + fixture-derived lamps (2026-08-26)

Two lighting truths from the Factory arena. **`(envIntensity N)` on the
Skybox element** (render3d applySky → `scene.environmentIntensity`):
how strongly the sky HDRI LIGHTS PBR materials — separate from backdrop
brightness. Metallic floor maps at intensity 1 mirrored the night HDRI
into blue glass from above while the underside reflected the dark ground
half of the env — the "wrong texture" that was never a texture (Austin's
correct instinct: "it's reflecting the HDRI"). factory1 ships 0.45;
default 1 = old behavior. **Fixture-derived lights**: the reference action game map dats hold
NO runtime light data (the per-region tables were float-triple-scanned —
all noise; map lighting is baked). The honest reconstruction: meshes
wearing CNS/ois/dec materials with g_Intensity > 1 (the §18.50 glow
rule) ARE the authored lamps — extract their clustered centroids +
emissive colors (scratchpad extract_lights.py) and stamp AE1 Light
elements there. three r180 physical units: point lights want HUNDREDS
of candela (45 was invisible; 1500 over 55 m = real pools). Five lights
measured FREE at any resolution — light generously.

### 18.58 Spawn hold — gravity waits for the world (2026-08-26)

Big-map load race: the character ticks before the map binds; on a slow
load she fell through the arena floor (never reproducible on a warm
server-local load — the classic race signature). Fix in the character
tick: until the FIRST finite ground reading of a scene, `mm.teleport`
pins her at the authored spawn each tick (velocity zeroed); after first
contact, physics is untouched forever — cliffs still drop. Verification
must move her via ELEMENT writes (the external-moves path, which is what
a spawn is) — driving the mm directly probes stale element coords and
defeats the guard, which cost one false "the fix doesn't work".

### 18.59 Dynamic resolution (2026-08-26) — self-tuning render scale

Console-game auto-resolution as four PostFX dats: `(dynamicRes true)`,
`(targetFps 60)`, `(minScale 0.5)`, `(maxScale 1)`. The controller lives
in AE1PostFX's own tick and walks the EXISTING `renderScale` dat (the
renderer reads it live every frame — no new renderer surface at all):
wall-clock EMA of frame time, one adjustment per second, falls fast
(−0.06) and rises slow (+0.03) inside a 0.85–1.12 hysteresis band so it
never see-saws. WALL-CLOCK is load-bearing: tick dt is simulation time,
and hit stop / slow-mo would read as fast frames and pump resolution up
mid-freeze. `renderScale` becomes the starting value; the debug pause
stops adjustments for free (no ticks). Verified both directions in
factory1: at emulated 1440p it walked 0.75→0.5 (the floor) in seconds
and held a steady EMA; back at pane size it climbed to 0.68 and parked
at ~69 fps, stable inside the band. Console commands: `render.dynamic`,
`render.fps`, `render.scale`. factory1 ships it on; everywhere else it
is opt-in (default false).

### 18.60 DOF sharp range — the crisp mid-field (2026-08-26)

The uber-pass CoC ramped from ZERO distance off the focal plane
(`abs(z − focusDist)` immediately), so with focus on the character the
whole room past a few metres blurred — a thin focus ring in mush
(Austin: "I can't see anything outside the character area"). New
`sharpRange` uniform: `mag = max(abs(err) − sharpRange, 0)` — a DEAD
ZONE in metres around focus where CoC is exactly 0, ramp beyond. PostFX
dat `dofSharpRange` (default 0 = classic thin lens). factory1 ships 14
with aperture 0.2 / maxBlur 5 — stairs and barricades crisp across the
arena, only distant walls soften. Console: `blur.range`.

### 18.61 Camera feel — beats and momentum (2026-08-26)

Two changes to the Fox camera after Austin's "rigid, fast, dizzying".
**Sway rewrite**: the 3-octave sines ran to 9.3 Hz — motor territory,
read as machine vibration. Each octave is now a PAIR of nearby slow
frequencies BEATING, so amplitude itself swells and fades over ~10 s:
drift, not vibration. Nothing above 0.61 Hz at rest; sprint wakes one
1.7 Hz gait bob. Dat `swaySpeed` multiplies every frequency. **Look
momentum**: dat `lookSmooth` (0.07 s; 0 = the raw reference-stealth-game response) — the
orbit is carried by a smoothed VELOCITY: input accelerates it in over
the constant and glides out over the same after release (measured: a
3.6° flick coasted a further 1.8°). The look block now gathers deltas
(mouse + stick) and applies them through the filter EVERY tick, so the
glide-out works with the hands off; `_lookMoved` also reads true while
glide velocity is high, keeping mouse-steer honest.

### 18.62 The Forest & the generated day sky (2026-08-26)

`forest1`: the wd3 Forest river gorge — five tiles (g31417/18/19,
g31319, g31518), the lay-heaviest region yet (2,387 authored prop
instances, 18 unique models), 18 NAMED water meshes (river pool at
y≈−25, cascade steps down to −75 — the waterfall gorge), riverbank
spawn probed live. Tile identification by WATER-NAME SCAN of candidate
dtts (the city's southeast was dry; g31418 lit up with six hits). Size
by TIERED decimation: hero tile 0.35, neighbors 0.2, edge context 0.15
→ 437 MB (flat 0.4 was 660; no hi/low duplicate meshes exist —
"nolowmap_" is only a marker). **The generated day sky**: Blender's
Nishita physical atmosphere rendered to an equirect .hdr
(make_day_hdri.py — Cycles pano camera, late-afternoon sun). Physical
radiance is tens of thousands of nits, so `skyOpacity`/`envIntensity`
run ~0.01–0.1 (shipped 0.03/0.09; console `sky.opacity` + `sky.env`
tune live). TRAP for the notebook: a build script's string-replace on
"(lightScene true)" also matched INSIDE A COMMENT and corrupted the
skybox script — the whole script failed to compile, so there was NO
skybox and dat writes landed nowhere. The console error `[ags] …
Unexpected text in dat section` is the tell: when dats seem inert,
check console errors FIRST. Never regex-replace AGS scripts on strings
that can appear in comments.

### 18.63 The GREEN Forest — wd1, world identities & the ga0001 atlas (2026-08-27)

18.62's forest was built from the WRONG WORLD. The community docs settled the
identities: **wd1 = the entire LIVING world map** (city, desert, forest,
flooded city — one high-LOD grid), **wd2 = its authored low-LOD twins**,
**wd3 = the world AFTER the Big Bang** (Route C's scorched twin), wd4 =
wd3's low LOD, wd5 = standalone/underground. The burnt g314xx tiles have
living twins at the SAME coordinates: g11417/18/19 + g11319 (g11518
exists only post-bang). Rebuild = the 18.62 recipe re-run against wd1
(574–1,415 lay placements per tile, two extra prop models, tiered bake
0.35/0.2/0.15 → 554 MB).

The new trap: the living ground TEXTURES aren't in the tile dtts. Grass/
dirt/rock/asphalt splat albedos live in a global atlas — `wda/ga0001`
(wta table in <pack>, 141 MB wtp in <pack>; ga0002 is a second one).
The importer leaves those TEX_IMAGE nodes with NO image (labels
g_AlbedoMap1..3 intact), and the glTF baker then exports flat white —
the whole terrain renders as bone. Detection: diff the importer's
`materials.json` (material → sampler → texture id) against every
extracted dds; the diff IS the missing-id list. Fix: slice the ids
straight out of ga0001's wtp by wta offset/size, then patch the images
into the blends by material-name + node-label lookup and re-bake. The
five ids that exist nowhere are g_LightMap/EnvMap/IrradianceMap/
DetailNormalMap — baked-lighting inputs the export doesn't use.
Corollary lesson: a baked map GLB renders mostly WHITE in EEVEE even
when perfect in three.js — judge bakes in-engine, never by Blender
thumbnail. Spawn: the gorge is multi-level (upper ponds at y≈2 under
heavy canopy, castle decks to y≈44, the open river at y≈−25); the
sunlit sandy shelf at (46,−24,−80) beside the river channel (walkable
strip x 48–54, water x 56–62) is the fishing bank. Day sky retuned for
the living palette: skyOpacity 0.08, envIntensity 0.5.

### 18.64 The pause menu & the reference series dial (2026-08-27)

`forest1/pause-menu.ags.txt` — the first ACTIVE MENU, a pure-AGS
element on the 18.56 pause surfaces, gated behind the debug wall's
MENU_PROTO project flag (default OFF; flip it on the wall, then ESC or
pad START opens). While open the loop hard-pauses, so the menu runs its
own rAF + capture keydown — the debug wall's exact machinery.

Styling is the open-source faction CSS framework (MIT), ported by hand
into a scoped `<style>`: the sand parchment with the fine 0.3rem grid,
ink #454138 on panel #dcd8c0, tab rows that invert to ink when active,
the h1 hard-shadow title. THE DIAL is the reference series' first-game homage: a dark
disc floats over the panel's top-left corner, five ORIGINAL inline-SVG
flower sprites ride its edge like a clock face. A/D, arrows, or d-pad
LEFT/RIGHT (own gamepad poll, hold-repeat 350/160 ms) spin the disc via
one CSS transform transition (0.42 s settle curve); rotation
accumulates so it always turns the way you pressed. The node that lands
on the upper-right anchor notch illuminates (drop-shadow glow) and the
tab it corresponds to activates — with N nodes at 360/N° the end state
is rotationally identical, which is exactly the reference series look: the
disc spins, a new flower arrives lit, nothing else appears to move.
Tabs are a dat (`tabs "MAP ITEMS WEAPONS SKILLS SYSTEM"`); panel bodies
are placeholder content per tab.

CAVEATS: in the EDITOR, ESC belongs to stop-play — test the menu there
with pad START (in the export ESC is free; while the menu is open its
capture listener owns ESC for close-and-resume). And the browser-pane
automation cannot deliver real ESC keydowns at all — menu testing rides
dispatched KeyboardEvents, which exercise the same engine listeners.

### 18.65 The Bunker & the two model paths (2026-08-30)

`bunker-level`: the orbital Bunker, found the hard way. r550 (<pack> st5) is
AUDIO ONLY (sound banks + hap); the station is not in wd5 (g50100 = the
Copied City, mesh names say "Copycity"); the community docs doesn't list it. A
string-scan of every ba/bg/bh/et dat+dtt for "unker/angar" found it:
**<asset> (<pack>, 80 MB dtt)** — hangar01/02, controlroom, the seven
singlerooms, four corridor-ring floors, handrails, the station shell,
and a 16 km `universe` starfield sphere: the level ships with its own
space backdrop. <asset>/2/3 are the bunker doors, <asset>/<asset> props,
**<asset> = the companion character's ARMED flight unit (missiles) — the enemy stock for the
space battles**. Texture audit: self-sufficient except the known
LightMap/EnvMap aux ids and one glass albedo that exists nowhere.

Two lessons that cost the whole session:

**ba props bake SKINNED.** The ba family is armature-bound — every mesh
a SkinnedMesh, and groundAt EXCLUDES SkinnedMesh by design (CPU-skinning
cost, the aimPoint lesson). A skinned map renders fine and has no floor.
The rest pose IS the assembled model, so the fix is a strip pass before
the standard bake: apply/remove armature modifiers, clear armature
parenting, drop vertex groups, delete armatures (bake_bunker_static.py).

**The engine has TWO model paths, and maps must take the BOUND one.**
If the element's node name matches a glb node, the element BINDS it and
applyTransform overwrites the node's transform every frame — element
fields rule; any baked root-rotation stamp is neutralized (why the
tiles' legacy --rotate-x 180 is harmless). If nothing matches, the glb
is UNBOUND — and build() hides unclaimed top nodes, so the model
vanishes from render AND rays. Factory/Tower/forest tiles all bind
(node name == glb root name). Corollary: ORIENTATION FIXES GO ON THE
ELEMENT, never on the bake stamp — and VERIFY orientation by the
FURNITURE, not by mesh-family bounding boxes. The <asset> postscript
(Austin's "we are standing on the wall"): the identity orientation was
CORRECT ALL ALONG — the ±90 "fixes" were built on the skinned-mesh
nulls plus a misreading ("floorNN" = deck names, and the corridor ring
is the sphere's EQUATOR, so it stays walkable under ANY X-rotation —
ground probes can't tell orientations apart on this map!). The
discriminator was the GLASS: window panes lie flat under ±90 and stand
vertical only at identity. Walk surfaces (identity): equator ring at
y −2.3, control room's stepped decks at −32.5/−48.6, singlerooms and
hangars below. Spawn: the ring at (−45, −1.3, 15), flight unit down
the corridor.

## 11. Open questions

- `void` naming (§6.3).
- Snapshot retention policy — how many, pruned when?
- Element ID scheme: stable UUID vs. human-readable name. Rename cost vs. debuggability.
  Leaning UUID internally with a display name, matching the media manifest pattern.
- Undo/redo model, given continuous journaling. The journal may *be* the undo stack.

### 18.79 Live materials for animated surfaces (2026-08-30)

`env3d.materialsOf(el, pattern)` hands AGS scripts the live three.js
materials of an element's bound object by name-regex — the shared
originals, so a map's whole screen bank changes at once. First user:
bunker-level's `bunker-screens.ags.txt` flips the map's own in-game screen
materials emissive (emissiveMap = map, RepeatWrapping) and animates
offsets: the code-column crawl, the Earth display's scan sweep, the
2x3 operator-dashboard atlas hopping pages, the faction emblem breathing.
No rebake — the game's baked textures ARE the screen content. Facade
note: world.env3d in game3d.js is a hand-built forward list; a new
render3d capability does nothing until forwarded there.

### 18.80 The ring gravity stabilizer (2026-08-30)

the reference action game's bunker ring keeps the player upright by rotating camera+gravity.
AE1's physics is y-down to the bone, so bunker-level rotates the WORLD
instead (Austin's call: no forced camera — a "fixed camera box" comes
later): `ring-stability.ags.txt` samples the floor normal under the
player each tick (groundInfo now returns the world-space hit normal `n`)
and feedback-rotates the MAP ELEMENT about the contact point under her
feet until the normal points up. Character, camera, and every scripted
element stay untouched. Key insights: (1) rotate about her feet, not the
element origin — apply the Euler delta, then shift the map by
omega x (mapPos - feet); (2) on authored-flat floors leveling IS
unwinding (measured tilt == map rotation), so no separate homing mode
for rotation — only the accumulated translation needs reeling home once
rotation settles, gated to when she's moving so her own walk masks the
drift; (3) deadband is a completion epsilon, not a target-zeroing band —
zeroing the target inside a wide deadband parks the map meters off pose.
Verified: 10 deg tilt levels to 0 with max 4.4 cm/tick floor motion and
full pose recovery. Mid-ring it rests at rotation = -bank, as designed.

**18.80 addendum — quaternions or bust (same day):** per-axis Euler
feedback leveled the first ring stretch and died deeper in: with ~90 deg
of accumulated pitch, corrections written to the roll FIELD come out as
world YAW (XYZ cross-coupling), so one tilt axis went uncorrectable and
the far ring read crooked (Austin: "worked for longer... crooked again").
v2 composes the correction as ONE world quaternion (setFromUnitVectors
(normal, up), slerped by gain, premultiplied) and decomposes back into
all three Euler fields; pivot compensation went exact too
(newPos = P + qStep*(oldPos-P)). AGS scripts reach THREE math classes
through env3d.objectFor(el) — borrow constructors from the bound
object's own quaternion/rotation/position. Verified: levels through 90
deg accumulated pitch and a 40 deg compound tilt to <0.5 deg underfoot.

**18.80 addendum 2 — holonomy and the arming gate (same day):** walking
the FULL ring loop broke the junction: "keep the floor level" carried
around a closed path deposits a net world-YAW (holonomy — the floor
reads level, so the leveler is satisfied, but the bunker returns twisted
and translated vs the door/elevator elements). Yaw never changes a floor
normal, so v3 strips the accumulated world-y twist relative to home
EVERY tick (twist/swing decomposition of qNew*qHomeInv about +y) —
invisible increments, and the loop closes back onto the authored pose.
Plus Austin's region gate as an armed state machine: leveling can only
START on floor banked past (engage 3) degrees — the outer ring — and
once armed it stays authoritative until the map is exactly home (snap
within 5 cm / 0.05 deg), then disarms. Interior slopes can never nudge
the world. Verified: injected 25/18/12 deg pitch/yaw/roll + offset pose
recovers to exact home; flat interior never arms.

### 18.81 Dialogue v1 + the UI lock + the game font (2026-08-30)

Talking to NPCs, the extremely-simple version Austin asked for. Three
pieces: (1) ENGINE `world.uiLock` — while truthy, the motion-matching
character updates on neutral input (the piloting/death pattern): she
idles, no locomotion/interact/combat/inventory. (2) `dialogue.ags.txt`
(bunker-level): a DialogueUI element that renders a DOM overlay box (the
debug-menu pattern — 3D projects have no 2D HUD canvas): speaker name,
line, FF-style options with a white &#9656; cursor; up/down or
dpad/stick to move, E / pad-X to confirm; an option with no `next`
closes (two-tick unlock tail so the confirming E cannot re-open). It
parks the NPC's wander and faces him at the player; NPC dat
(displayName "the companion character") names the header. Trees are plain objects passed by
the NPC's own onInteract — per-NPC dialogue is ~15 dat-file lines.
(3) THE FONT: kind-"other" media rides data.bins into exports, so
`ps2_helvetica.ttf` (Austin's PS2 Helvetica) is project media,
registered as a FontFace ("PS2Helvetica") by the DialogueUI boot —
canvas and DOM both see it once loaded. The onInteract dispatch already
existed (§18.12): E near a non-pickable Hitbox reaches the NPC script.

### 18.82 Possession, autopilot, and the pilotable the companion character (2026-08-30)

Austin's seamless character switching. ENGINE: (1) `(autopilot true)` on
a motion-matching character † turns it into a simple NPC — synthetic world-space
intent through the same matcher (same databases, physics, wall
collision): wander goals near home, vetted BOTH WAYS ("can I path back"),
idle pauses, stuck detection; an in-flight action (the dialogue-fired
mocap clip) freezes the wander like an attack does. (2) The camera's
_target() prefers the character NOT on autopilot; parked bodies are
scenery. (3) The controlled character's E also reaches parked
characters by radius (they carry no Hitbox volume). SWITCHING: a dialogue
option with (action "possess") — the parked speaker wakes, the
interactor parks, camera and controls follow automatically.

the companion character's body: <asset> cleaned (no DLC/serious-face/broken-coat dupes; the
clean coat is es0200.001/.003/.004 — the tatters are separate Broken*
meshes) and TRANSPLANTED onto the canonical MM skeleton (uniform 1.156
height scale, per-chain minimal-twist rest alignment T-pose -> A-pose,
vgroups pl->manny via the retarget script's bone-map composition; unmapped
physics/twist bones merge into their mapped ANCESTOR, geometric
nearest-mapped fallback for orphans, unweighted verts pinned). His
proportions stretch to the player character's — the cost of sharing her rig; the real fix
is a native-skeleton pack bake, future work.

Traps paid for: AGS files use ";" comments ONLY before the first
function — "//" after (a ";" in the methods section fails the WHOLE
compile and the element silently falls back to AE1Element); runInfo
event names are a fixed whitelist — route custom dialogue events through
onCall(eventName, from); Blender 4.2's glTF exporter ignores
blend_method and ships every material alphaMode BLEND (the commander
disease — body parts ghost/vanish by angle): patch the glb JSON after
export (scratchpad patch_glb_alpha.py). Dialogue cinematography rides
the EXISTING §18.49 camera-curve handover: DialogueUI sets
world._camCurveActive = itself and feeds _ccSample shots (auto-composed
OTS/two-shot/low angles, LOS-checked, slow dolly per cut).

### 18.83 The native the companion character pack pipeline (2026-08-30)

"one NPC's skeleton, one NPC's motion matching, one NPC's animations" — the
transplant experiment is retired. New pieces: (1) the companion character's complete personal
animation archive: <asset> (<pack>) -> 483 native <asset> mots,
triaged by the standalone mot-extractor into a gallery, 393 auto-named
from the community the player character/A2 sheet by SHARED INDEX (the faction androids share the
moveset layout) with per-clip metric validation. (2) The Curator grew
multi-source triage (?src=npc, serve.py TRIAGE_SOURCES) — browse, name,
set, select any character's gallery. (3) tools/bake_npc_native.py: bakes
curator-selected <asset> clips STRAIGHT from the gallery blends into the
standard pack format — no retarget. The reference action game mots root travel on the ARMATURE
OBJECT (action channel "location"), so sampling must be world-space; the
bake synthesizes the canonical root (smoothed hips ground path + yaw-only
quat — built EXPLICITLY about Z, rotation_difference degenerates at yaw
pi because his rest faces -Y), stores pelvis sway/bob as root-frame
rest-relative residuals, and DE-YAWS the hips basis (the root carries
facing; doubled yaw = double-speed turns). (4) The runtime hardcodes
canonical role names (pelvis/foot_l/LEG_RE), so pack bone list AND the
runtime body (npc_native.glb, a pure node-name patch of npc_clean.glb)
wear canonical labels on his untouched native skeleton — renaming, not
retargeting. (5) serve.py /convert?src=npc runs the native bake and pushes
the pack into the level's media as `<pack>_*` — the curator's one button
does gallery -> database -> game media. Verified on idle/walk/dash:
travel 11.37 m, forward vel +0.97 m/s in the fwd slot, pelvis residuals
in centimetres, quats normalized.

## 18.85 FIRST_PERSON on the debug wall (one negative number)

The wall (SS18.56) grew a FIRST_PERSON wired flag: the camera parks ~0.3 m
ahead of the active character's face, looking their own forward. The whole
feature is ONE substitution in the orbit math: the ThirdPersonCamera sets
rotation from _yaw/_pitch INDEPENDENT of position, so distance = -fpAhead
(default 0.3, dat-tunable) moves the eye in front of the face while the
view keeps pointing forward -- head and hair land BEHIND the near plane,
nothing is hidden or clipped, mouse look and character steering are
untouched. Two side rules: shoulder framing zeroes (an offset eye reads
as a broken neck) and the Fox chase-lag snaps every frame (the
cameraman's drag reads as your head swimming loose at 0 m). _target()'s
possession rule (SS18.82) means the flag follows whoever you''re playing:
possess the companion character and the eyes are his. Toggle it mid-frame on the frozen
wall; it applies the instant play resumes.

## 18.86 Hair alpha: an authored MASK beats the hash (the cut value)

SS18.84 hashed every hair material because hard alphaTest chewed soft
strands. The authored-head the player character flipped the trade: her hair textures from the reference action game
sit heavily in the soft mid-alpha band and stack TWO shells, so the hash
dither read as visible static (Austin: "staticy"), while the crisp
cutout looked right in playtest. Revision in conditionGltf: hair that
ARRIVES with alphaTest > 0 (an authored MASK) keeps its cut value --
the asset chose its look, the engine stops overriding; hair that arrives
BLEND still gets hashed exactly as SS18.84 prescribed. Practical split:
the player character ships MASK (cut value 0.4, tunable per ship in the alpha patch);
the companion character/Commander/the operator ship BLEND and keep their hashed look untouched. The
per-frame alphaTest=0 invariant only fires on hashed materials, so a
masked cut value survives it.

## 18.87 The optimization wave (the browser gets fast before the desktop gets native)

The first phase of the break-out-of-the-browser plan (docs/engine/20): make
the existing runtime industry-standard BEFORE abstracting it. Audited by
three deep passes (render pipeline / asset pipeline / frame loop); measured
result in the dev room: p99 frame time 21.5 -> 13.7 ms (spikes erased),
hero.glb 167 -> 24 MB, the shipped build 667 -> 445 MB, heap -300 MB.

RENDER: canvas antialias OFF + 4x MSAA on the postfx scene target (the old
setup paid canvas MSAA to antialias one composite triangle -- the shipped
game had NO real AA); HalfFloat scene target (8-bit LINEAR banded shadows
and clipped emissives pre-bloom); no stencil anywhere; anisotropy 8 at load
(grazing floors were mip mush); frustum culling RESTORED for static meshes
(the blanket frustumCulled=false is now skinned-only -- "cost is nil at
this scale" stopped being true around the third character); near plane
floored at 0.08 (was 0.016 against far 1600 -- z-fighting + DOF precision);
HDR skies upload HalfFloat (-22 MB VRAM); shader precompile + texture
warm-up ride the load screen (compileAsync before loop.start); shader-error
readback only in the editor; grain hashes the CANVAS resolution so
dynamicRes no longer chunks the film.

CPU: the STATIC RAYCAST CACHE -- every ground/wall/foot ray was re-walking
every glb subtree to collect candidates (~12-25 rays/frame); now one flat
cached list, invalidated by build()/sweeps/visibility flips, with per-HIT
ancestor checks for exclusions. sweepBlocked committed the file's own
documented sin (post-filtering skinned meshes = CPU-skinning all five rigs
per sweep) -- fixed via the same cache. applyTransform dirty-guards ten
numbers and spares the whole subtree world-matrix pass (the half the static
freeze could not reach). applyParts identity-guards (was a full traverse +
Set alloc per element per frame; the LOD sweep bumps an epoch when verdicts
change). applyAnimation memoizes on its six driving primitives (was regex +
split + linear clip-name scans per animated element per frame). Input
tokenizes each mapping once (was ~60-100 regex splits/frame). Camera and
Controller lookups cache on the world keyed by scene identity. aimAt is a
persistent live array (a fresh [x,y,z] per frame defeated setComponent's
identity early-out forever).

ASSETS: the exporter TEXTURE DIET (optimize_glb_textures, best-effort like
everything else there): dedup byte-identical embedded images (the
NAME/NAME.dds double-embeds), cap at 2048 (the 5792-square community
upscale cost ~180 MB of VRAM alone), opaque baseColor/emissive PNG->JPEG
q88; normal/MR/AO maps and live-alpha textures stay PNG. Opt out per asset
with a rawTextures flag on the media entry. AUTO animOnly: a glb named only
in animLibs/libs and never worn as model.media is a library BY USAGE --
stripped without the manual flag (spawn media never matches, so lock
markers/bolts/orbs are safe). The boot releases payloads: the b64 source
string AND its DOM script node die once decoded, the Blob URL is revoked
after load; audio/HDR ride data: URLs (native decode, streaming audio).

SERVER: HTTP/1.1 keep-alive; Range/206 (video seeking works in the editor
now); Last-Modified + 304 for live source (three.module.js stopped
re-downloading on every reload); immutable media caching unchanged.

MEASUREMENT DOCTRINE ADDITION: renderer.info was never read anywhere --
which is exactly how 550 MB of character textures went unnoticed. The frame
sampler now pairs with draws/tris/textures/programs from renderer.info.
Two doctrine corrections recorded: DESIGN 18.5's "frustumCulled=false, cost
is nil" is retired, and 18.53's join-experiment verdict ("destroyed
per-mesh frustum culling") rested on a mechanism that was never active --
re-measure before designing around it.

DEFERRED (the decision list, docs/engine/20 + the audit reports): the
tonemapping correctness fix (postfx bypasses AgX + sRGB -- LOOK-AFFECTING,
needs a deliberate re-tune), KTX2/BasisU GPU-compressed textures (the VRAM
half; needs an inlined transcoder), meshopt/quantization for geometry,
int16 mm pose streams (~160 MB, lab-side change), the .aepack sidecar
container (the shared artifact with the native runtime), audio transcode,
InstancedMesh scatter, the motion-matching core † micro-passes (lab-side re-carve),
half-res DOF.

## 18.88 The tonemapping fix and the AEPACK (phase two of the break-out)

TONEMAPPING, finally correct: three forces NoToneMapping + linear output on
render-target passes, so with PostFX live the shipped frame NEVER received
AgX or the sRGB encode -- raw linear light hit the canvas (why FX_OFF looked
like a different game, and why the portal face carried a hand-rolled pow
workaround). The uber-pass now ends with three's own tonemapping_fragment +
colorspace_fragment chunks: the renderer injects its AgX define and binds
toneMappingExposure because the composite material renders to screen, so
the postfx path is finally bit-identical in grading to the plain path.
LOOK-AFFECTING by nature -- the old scenes were tuned against the broken
pipeline (everything ran double-dark). The dev room was re-tuned to the
correct pipeline: sun 1.5/0.35, skyOpacity 0.45, envIntensity 0.3,
grainAmount 0.05. Any future scene resurrected from pre-18.88 dats will
come in over-bright and wants the same pass. (Bloom's threshold also became
honest: it now sees real HDR linear off the HalfFloat target.)

THE AEPACK (the AGP container from docs/engine/20, realized): a 3D export
now writes THREE artifacts -- index.html (unchanged: everything inlined,
double-click file:// play), game.aepack (every asset as RAW BYTES: "AEPK"
magic, u32 version, u32 tocLen, JSON toc {name, bag, offset, length}
8-aligned, then payloads), and play.html (~3.5 MB: the same page minus the
inline payload blocks). Served over http, the boot fetches the pack and
hands Uint8Array views straight to the loaders -- no base64, no string
copies, no 400 MB through the HTML parser. Measured on the dev room:
play.html boots in a fraction of index.html's time and the session heap
dropped ~1.5 GB -> ~0.9 GB. game3d accepts raw-bytes entries everywhere a
b64 string was accepted (glbs, hdr/audio, mm-pack bins). The pack is the
contract artifact for the native runtime: a C++ player mmaps the same file
and reads the same toc. Trap reminder: server.py imports exporter.py at
boot -- RESTART the ae1 server after exporter edits or builds run stale code.

Deferred still: KTX2 (needs the basisu encoder tool on PATH -- wire it the
day it is installed), int16 pose streams (lab-side re-carve), meshopt
geometry, half-res DOF, InstancedMesh scatter.

## 18.89 KTX2 — textures stay compressed on the GPU

The VRAM half of the 18.87 texture problem, closed. The old premise
("Draco/KTX2 need a decoder fetch, which breaks file://") was wrong twice
over: the export already inlines binaries, and WebAssembly instantiates
from bytes. The pipeline:

ENCODE (exporter, best-effort): tools/ktx/toktx.exe (Khronos KTX-Software
4.4.2, extracted -- never installed -- into the repo; also honors PATH).
optimize_glb_textures now tries KTX2 FIRST for every embedded image:
ETC1S (clevel 2, qlevel 160) for color and data maps, UASTC (quality 2,
zstd) for normal maps -- block artifacts on normals shade wrong; UASTC is
the data-safe tier. sRGB/linear assigned by slot. Mipmaps baked by the
encoder. Textures gain KHR_texture_basisu; the extension goes in
extensionsUsed AND extensionsRequired. JPEG/PNG remains the no-encoder
fallback, rawTextures the per-asset opt-out. THE DIET CACHE
(exports/.dietcache, keyed by source digest + settings tag): the first
encode of a character costs minutes; every rebuild after is a file read --
measured full devroom export after warm cache: 7.6 s.

DECODE (runtime): KTX2Loader + deps vendored from three r0.180 (addons/
loaders, utils/WorkerPool, libs/ktx-parse + zstddec, math/ColorSpaces),
with ONE LOCAL PATCH (marked AE1 LOCAL PATCH, re-apply if re-vendored):
setTranscoderPath accepts {js, wasm} full URLs, because a shipped game
hands out blob:/data: URLs where prefix-plus-filename can never resolve.
The exporter embeds basis_transcoder.js/.wasm (~570 KB) in the payload bag
under __-reserved names; game3d wires KTX2Loader into GLTFLoader with
detectSupport(renderer) after the renderer exists. Works identically over
http (play.html/aepack) and file:// (inline b64) and on any web host.

MEASURED: all 64 embedded textures across the dev-room cast ship KTX2;
the player character's 19 material textures verified live as format 36492 = BC7 -- compressed
IN VRAM, ~550 MB -> ~20 MB for her set (2048 cap x 4-8x block compression).
Zero console errors, image indistinguishable at play distance. The editor
viewport is untouched (project media stays PNG; KTX2 exists only in
builds). Deferred kin: meshopt geometry via the same
vendor-and-inline pattern when wanted.

## 18.90 int16 pose streams â€” and a re-carve near-miss (the lab regressed)

The motion-matching packs shipped float32 quaternion streams â€” 4x more precision
than any animation needs. quantize_pack.py (motion-matching/tools) writes int16
with PER-COLUMN adaptive scales in motions.json (`quant: {poses:{scales
[FF]}, features:{scales[FD]}}`): each stride position gets its own max-abs
scale, so quaternion components keep ~3e-5 while root-translation columns
spanning metres keep sub-mm. Runtimes dequantize at load into the identical
Float32Array layout â€” every consumer downstream is untouched, and a float32
pack (no `quant` key) still loads verbatim. Measured on devroom's six packs:
<pack> poses 136.7 MB -> 68.4 MB, features 28.4 -> 14.2; whole shipped
build 531 MB (from 445). Max dequant error ~4e-3 on a unit quaternion â€”
below animation-visible. Reconstruction error is per-column-bounded, so the
matcher's feature distances are preserved and search results are unchanged.

THE NEAR-MISS, recorded so it never recurs: the doctrine was "fix in the
lab (play.js), re-carve engine/the motion-matching core † via <pack>." I followed
it â€” and <pack> produced a 4261-line matcher that BOOTED FINE but had
lost ~1150 lines: the entire action/weapon/ladder/combat API
(playAction, setWeaponTag, setWeaponDashes, stopAction, inAction,
actionAge, inLadder, setLadderMode, clipRise, reqDebug). The reason: the
lab's play.js and <pack>'s TAIL template had SINCE REGRESSED to
locomotion-only; the working engine matcher (5409 lines) had been carved
from a richer lab state that no longer exists on disk. The re-carve
silently overwrote it. No git, no staging backup â€” recovered from a
pre-recarve EXPORT BUNDLE Austin still had (the inlined
`<script id="ae1-modules">` pack holds every module's source; scratchpad
recover_mm.py pulls it out). The recovered file is now the SOURCE OF TRUTH
for the matcher; the int16 patch was applied to it BY HAND (it is small and
self-contained). DO NOT run <pack> against the current lab â€” it will
destroy the action layer again. Before any future re-carve, the lab
play.js must first be brought back to parity (or <pack> retired). Every
3D export is now also a full engine backup by construction â€” keep one.

## 18.93 Instanced scatter · 18.94 half-res DOF (the last two of the five)

SCATTER (§18.93): applyScatter now builds ONE InstancedMesh per non-skinned
archetype mesh instead of N full Object3D clones — a thousand trees is a
handful of draw calls. Each instance matrix = rootTRS_row · (mesh-relative-
to-archetype), so multi-part archetypes (trunk + fronds) instance correctly;
snap/foot, mid-build null-ground parking (zero-scale matrix), and live
archetype rotation/scale all carry over. A SKINNED archetype falls back to
the clone path (InstancedMesh has no per-instance skeleton). Verified: a
25-prop grid rendered through a single InstancedMesh.

HALF-RES DOF (§18.94): the 12-tap CoC gather (26 texture fetches/blurred
pixel) moved OUT of the full-res composite into a dedicated half-res pass
(dofRT, HalfFloat) — quarter the fragments. The composite now just samples
that field (bilinear upsample) and mixes it in by CoC — one cheap depth
fetch per pixel. Bonus: chromatic aberration and DOF are no longer mutually
exclusive (CA rides the sharp sample always; the old code skipped CA on any
blurred pixel). The pass only runs when DOF is on with an aperture, so an
all-in-focus room pays nothing. Verified by forcing aperture 0.6 /
sharpRange 0: far field blurs smoothly, subject stays crisp, no blocking.

TWO PROCESS NOTES worth their own line:
- The near-loss of the matcher (§18.90) is why every engine change since is
  git-committed on `main` — one commit per optimization, an export bundle
  kept as a second backup.
- `node --check foo.js` checks in SCRIPT mode on a .js file and PASSED a
  postfx.js that the browser rejected as a module: a backtick inside a GLSL
  `//` comment in a template literal closed the literal early. ALWAYS
  `node --check --input-type=module` for engine files, and never put a
  backtick (or ${) inside a shader template-literal comment.

FULL PHASE TALLY (§18.87–§18.94), dev-room build 667 MB → 362 MB, p99
frame 21.5 ms → ~13.7 ms, VRAM ~800 MB → ~120 MB: renderer AA/colour/
culling pass; the AEPACK container + slim play.html; tonemapping fix; KTX2
GPU textures; int16 pose streams; meshopt geometry; audio transcode;
instanced scatter; half-res DOF. Deferred/none-remaining from the original
list. Encoders live in tools/ (toktx, gltfpack) + ffmpeg; runtime decoders
vendored + inlined so every target (file://, http/aepack, future native)
decodes with no external fetch.

## 18.95–18.97 Hair, finally settled: ALPHA BLEND

Three rounds this session chasing the player character's hair, ending at the right answer.
§18.95: KTX2 ETC1S alpha too lossy for the hair cutout -> UASTC for alpha
(helped, not enough). §18.96: a hard cutout can't survive ANY block-
compression alpha error, so hair/lash CUTOUT baseColor textures skip KTX2
entirely (kept PNG, downscale-capped; detected by material name ->
baseColorTexture source). §18.97 THE FIX: the holes were never really about
compression — this authored head's soft feathered hair alpha punches
holes at ANY hard alphaTest threshold, even on uncompressed PNG (the
original §18.84 complaint). Both prior treatments were wrong for it:
§18.84's alphaHash read as "static", §18.86's cutout as "spotty, holes".
ALPHA BLENDING is the answer neither used: `transparent:true` renders the
soft edges smoothly (no holes, no dither), while `depthWrite:true` + a low
`alphaTest 0.05` keep the solid core sorting correctly (the sort trouble
that drove §18.84 to hashing was pure blend with depthWrite OFF). Set in
TWO places that must agree — render3d.conditionGltf AND the matcher's
characterRoot conditioning (which runs LAST for a motion-matching character † and
had been forcing a 0.35 cutout back); the surgery script template kept in sync.
Keep hair PNG (§18.96): a blend uses the full alpha ramp, so a compressed
ramp would band — PNG matters MORE under blending than under a cutout.
Verified on the shipped build (not a live tweak): clean smooth bob, materials
ship transparent/alphaTest 0.05/depthWrite by default.

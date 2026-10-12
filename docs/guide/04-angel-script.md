# 4. Angel Script

**Angel Script is not an interpreted language.** It's a preprocessor that compiles to a
JavaScript class on your element's prototype chain.

That single sentence explains everything about it. `super.use()` works because it *is*
`super`. Debugging works because devtools sees real classes. It will still be correct in ten
years because it's mostly just JavaScript.

The cost: AGS can never drift far from JavaScript syntax. Fair trade.

Files are `SOMENAME.ags.txt` — the type is text, the full suffix is what identifies it. Open
one in any editor.

## The shape of a file

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
(runInfo tidy onUnload)
; helpers need no runInfo

function use(actor) {
  if (this.locked && !actor.has(this.key)) return this.say("It's locked.");
  this.setLocked(false);
  return super.use(actor);
}
function look() { return this.say("A heavy oak door."); }
function tidy() { /* release audio, timers, handles */ }
ags?>
```

Three sections. Both `<?dat` and `<?def` are optional; you need at least one.

> ## ⚠ Every declaration goes above the first function
>
> The reader **stops at the first token that isn't `(`**. Everything after that is
> JavaScript. So this looks reasonable and does not work:
>
> ```
> (runInfo use onClick)
> function use() { … }
>
> (runInfo look onHover)      ← this is now JAVASCRIPT. Syntax error.
> function look() { … }
> ```
>
> Grouping each `runInfo` beside its method is the natural way to want to write this, and
> it's wrong. **All of them first, then all the functions:**
>
> ```
> (runInfo use  onClick)
> (runInfo look onHover)
>
> function use()  { … }
> function look() { … }
> ```
>
> The compiler catches it and says so by name. It cost me two scripts to learn.

## Why the first two sections are LISP

`dat` declares what an element *is*; `def` declares how it *behaves*. Both are declarative, so
both are data — and in LISP, data and declarations are the same notation.

That means **one reader parses both**. Adding a new declaration form later costs nothing at
the parser level, because every form is already just a list.

It also means the third section needs **no delimiter**. The reader consumes s-expressions
greedily; the first token that isn't `(` begins the JavaScript. The format parses itself.

## `dat` — what it is

```
(health 100)              → 100
(locked true)             → true
(key "brass_key")         → "brass_key"
(inventory ())            → []
(colors (red green blue)) → ["red", "green", "blue"]
(ratio -2.5e3)            → -2500
(model 3d-model)          → "3d-model"   ← a symbol, not the number 3
(nothing nil)             → null
; this is a comment
```

One value → the value. Many → an array. Empty → `[]`.

**Every `dat` entry becomes a real property on the element**, with accessors. So:

- `this.locked` in a method,
- `(locked true)` in the file,
- the `locked` field in the **Properties** panel,
- and `"locked": false` in the saved scene

are **one value in one place**. There is no bridge to keep in sync and no way for the editor
and the runtime to disagree.

`dat` values are **live state**. A door unlocked during play saves as unlocked. The declared
value is a *default*, and the saved scene wins.

> **dat cannot set a built-in element property.** `(visible false)`, `(x 100)`, `(width 200)`
> have **no effect** — the scene file always carries a value for those, and the scene wins.
> Set them in the Properties panel, or from a method (`this.visible = false`). The compiler
> warns; it's a silent no-op otherwise, and you'd be left wondering why your element is on
> screen.

**`dat` inherits.** A `Door` that `(extends Openable)` gets Openable's `dat` merged under its
own, without redeclaring it.

## `def` — how it behaves

### `(extends Name)`

The prototype chain. Names another script, or a built-in:

| Built-in | Gives you |
|---|---|
| `Element` | the base. The default if you omit `extends` |
| `Text` | wrapped, aligned text — see [Standard Library](05-standard-library.md#text) |
| `Button` | a Text with a background, hover state, and `press()` |
| `Video` | a video drawn into the element, with `onEnded` |
| `Sprite` | plays a spritesheet — clips, `fps`, `play`/`stop`, `onFinished` |
| `Model` | a 3D character — plays glTF animation clips, `play("idle")`, idle-on-load (3D projects) |
| `DialogueDelegate` | a character with a conversation — see [Dialogue](10-dialogue.md) |
| `DialogueBox` | where lines and choices appear. One per project, in the HUD. |
| `HudElement` | drawn above everything, hit-tested first |
| `Inventory` | a HudElement with items, `add`/`remove`/`has`, and slot rendering |
| `SaveHandler` | decides what this project saves — see [Standard Library](05-standard-library.md#the-save-handler--deciding-what-gets-saved) |

> **`HudElement` does not make a thing persist.** Persistence comes from *which layer an
> element lives in* — `hud.json` vs a scene — never from its class. So `(extends Text)` works
> perfectly well on a HUD element. `this.isHud` asks the world rather than trusting a flag.

A script of your own with the same name wins — you're more specific than the engine.

**A script can't extend itself.** `(name "Inventory") (extends Inventory)` means the built-in,
and resolves correctly.

### `(name "…")`

The class's display name. Shows in devtools and `toString()`, and is what other scripts can
`(extends …)`.

### `(runInfo method mode)`

**When a method runs.** This is the heart of the format.

```
(runInfo use  (onClick onCall))   ; two modes
(runInfo look onHover)            ; one
```

| Mode | Fires |
|---|---|
| `onLoad` | once, when the element's scene loads |
| `onUnload` | when its scene unloads — **release everything here** |
| `onTick` | every frame while its scene is live. Receives `dt` in seconds |
| `onCall` | only when another script calls it. **The default** |
| `onClick` | the player clicks it. Receives `actor` |
| `onHover` | the pointer *enters* it. Receives `actor` |
| `onExit` | the pointer *leaves* it |
| `onDrag` | dragged. Receives `(x, y)` in scene space |
| `onEnded` | media reached its end. Dispatched by `Video`; never fires while looping |
| `onFinished` | a `(loop false)` clip reached its last frame. Dispatched by `Sprite` |
| `onDialogueStart` | a conversation began. Receives `(delegate)` |
| `onNode` | a dialogue node opened. Receives `(nodeId, delegate)` |
| `onChoice` | the player answered. Receives `(label, goto, delegate)` |
| `onDialogueEnd` | the conversation ended. Receives `(lastNodeId, delegate)` |
| `void` | reserved/experimental — treated as `onLoad` |

This table **is** the vocabulary. A mode that isn't here doesn't exist, and the compiler will
say so by name rather than let a method quietly never run.

**The array form matters.** `(runInfo use (onClick onCall))` means *the player clicks the
door* and *a cutscene opens the door* run the same code, written once. That's the most common
authoring pattern in the genre, and it's free.

> **`void` is a trap.** In every mainstream language it means "returns nothing." Here it means
> "runs on load." Don't put it on a helper expecting the former.

**`runInfo` inherits.** A subclass that defines no methods still gets its parent's scheduling —
otherwise inheriting behaviour wouldn't inherit *when it runs*, and clicking the subclass
would silently do nothing.

**The compiler validates it.** A `runInfo` naming a method that doesn't exist — on this class
or anything it extends — is an error in the Console. That's the declaration table's one
weakness (drift on rename), and catching it is the whole reason to validate.

## Methods — plain JavaScript

Top-level `function` declarations become class methods. Everything else at the top level
(consts, helpers) becomes a closure around the class.

```
<?def
const GREETING = "hello";        // closure — shared by all instances

function greet() {               // a method
  return this.say(GREETING);
}
ags?>
```

`async` and generator methods work. Nested functions stay nested — only top-level
declarations become methods.

### `super` works

```js
function use(actor) {
  return "door -> " + super.use(actor);   // calls Openable.use
}
```

Multi-level chains work. This is real `super`, not an emulation.

### The template method pattern

The natural way to write a cast of characters:

```
; kid.ags.txt — the base
<?def
(extends Element)
(name "Kid")
(runInfo talk (onClick onCall))

function talk(actor) {
  this.spoken = true;
  this.playSound(this.sound);
  return this.say(this.speech(actor));
}
function speech(actor) { return this.line; }
ags?>
```

```
; cartman.ags.txt — four lines
<?dat
(sound "cartman.mp3")
(line "Ay! Screw you guys.")
?>
<?def
(extends Kid)
(name "Cartman")
ags?>
```

```
; butters.ags.txt — overrides one method
<?def
(extends Kid)
(name "Butters")

function speech(actor) {
  if (!this.everyoneSpoken()) { return this.line; }
  this.give({ id: "brass_key", name: "Brass Key", icon: "key.png" });
  return "Aw, okay. Here's the key.";
}
function everyoneSpoken() {
  var c = this.find("Cartman");
  var k = this.find("Kyle");
  return c && k && c.spoken && k.spoken;
}
ags?>
```

Cartman is *four lines* and fully wired. Butters overrides one method and inherits the sound,
the click wiring, and the hover.

### `draw(ctx, api)` — owning your rendering

Any element with a `draw` method takes over its own rendering. The context arrives translated
to the element's top-left and unrotated, so you work in local coordinates from `(0,0)` to
`(width, height)`.

This is how health bars and custom HUDs are made. See
[HUD & Inventory](08-hud-and-inventory.md#custom-hud-elements).

A thrown `draw` costs that element, never the frame.

## Gotchas

> **Two comment syntaxes in one file.** `;` in `dat`/`def` (LISP). `//` in the methods
> (JavaScript). It is the single easiest mistake to make in AGS — I made it three times writing
> the built-in templates, *knowing the rule*. The compiler now names it directly.

**Regex literals with unbalanced braces** (`/\{/`) can confuse the method scanner. The failure
is loud — a compile error in the Console — never silent corruption.

**A broken script never destroys your data.** If a script fails to compile, its element keeps
its class and its `dat`. A typo means "I can't build a better class right now", not "throw
away this element's state."

## What happens at compile

1. `dat` and `def` are read as s-expressions; the rest is JavaScript.
2. Top-level `function`s are rewritten into a class body.
3. The chain is resolved (`extends` → another script, or a built-in).
4. `dat` and `runInfo` merge down the chain.
5. Scheduler tables are built — flat arrays per mode, once, at load.
6. Elements are **rehydrated** onto their compiled classes: `dat` becomes properties, methods
   land on the prototype, the UUID stays the id, the name stays the name.

That last step is the abstraction landing: the moment a plain element *becomes* a Door.

**The compiler ships inside the exported game**, and `.ags.txt` files ship as loose text. A
modder edits the same surface you authored on. See [Build & Ship](09-build-and-ship.md).

# 5. Standard Library

Every call available inside an Angel Script method. All of these are methods on `this`.

Off-world — in a unit test, or before Play starts — they **degrade to no-ops rather than
throwing**. A script must never explode just because nothing is running yet.

---

## Talking

### `this.say(text) → text`

A line of dialogue. In the editor it appears in the Console; in a shipped game it appears in
the dialogue box at the bottom of the screen, timed to the length of the text.

```js
return this.say("It's locked.");
```

The most-used call in the library — point-and-click is mostly looking at things and being told
about them.

---

## Finding things

### `this.find(name) → element | null`

Another element by name, case-insensitive. Searches the current scene first, then the HUD.

```js
var kyle = this.find("Kyle");
if (kyle && kyle.spoken) { … }
```

Scene wins over HUD, because `find("Door")` means the door in the room you're standing in.

### `this.inventory → Inventory | null`

The project's inventory, if the HUD has one.

---

## Scenes

### `this.goToScene(nameOrFile) → boolean`

Leave for another scene. Takes the scene's **name** ("Main Menu") or its file
("scene-2.json").

```js
return this.goToScene("Scene 2");
```

The outgoing scene's elements get `onUnload` and are dropped. The incoming scene's get
`onLoad`. **HUD elements are untouched** — they never learn it happened.

Returns `false` and warns in the Console if no such scene exists. The build also warns at
export time.

---

## Audio

### `this.playSound(name, opts?) → Audio | null`

A one-shot. Overlapping calls layer rather than cut each other off.

```js
this.playSound("cartman-hey.mp3");
this.playSound("footstep.wav", { volume: 0.4, rate: 1.2 });
```

| Option | Default |
|---|---|
| `volume` | `1` |
| `rate` | `1` |

### `this.playMusic(name, opts?) → Audio | null`

Looping music, one channel, crossfaded.

```js
this.playMusic("room-theme.mp3");
this.playMusic("tense.mp3", { volume: 0.4, fade: 800 });
```

| Option | Default |
|---|---|
| `volume` | `0.6` |
| `loop` | `true` |
| `fade` | `400` (ms) |

**Re-requesting the same track is a no-op, not a restart** — an `onLoad` that starts the room's
theme won't stutter it when the player re-enters. That's what lets you keep one continuous track
across many scenes: call `playMusic("theme.mp3")` in every scene's `onLoad` and it stays alive.

### `this.stopMusic()`

### `this.setMusicLevel(level, opts?) → number`

How loud the music is **here**, `0`–`1`, multiplied onto the player's own volume setting. For a
scene that should be quieter or louder than the rest — a hushed bedroom, a loud workshop —
without touching the player's preference.

```js
this.setMusicLevel(0.35);            // this area is hushed
this.setMusicLevel(1, { fade: 200 }); // and this one is full, quicker fade
```

It fades the playing track smoothly and the level sticks, so it also shapes the next track.
Perfect paired with the "one track across scenes" pattern above: start the music once, then set
a level per scene.

---

**Media is addressed by NAME**, not hash — `"cartman-hey.mp3"` is what the Media Collection
shows you. The extension is optional: `playSound("cartman-hey")` also works.

**Browsers block audio until the player interacts with the page.** Music started in `onLoad`
would therefore fail on your very first scene — exactly where a game wants its theme. AE1
holds the intent and fires it on the first click or keypress. You don't have to think about
it.

(A blocked one-shot is *not* queued — by the time the player interacts, the moment it belonged
to has passed.)

---

## Inventory

### `this.give(item) → item | null`

Grant an item.

```js
this.give("brass_key");
this.give({ id: "brass_key", name: "Brass Key", icon: "keyicon.png" });
```

The `icon` is a media **name**; it's resolved to a hash on the way in, so the item keeps
working if you rename the asset later.

**Idempotent by `id`** — talking to the same NPC twice won't duplicate the key.

### `this.take(id) → item | null`

Remove it.

### `this.has(id) → boolean`

Does the player hold it?

Defined on **every** element, not just the player, so `actor.has("brass_key")` reads naturally
in a door's script while still consulting the one inventory.

```js
function use(actor) {
  if (!actor.has(this.key)) return this.say("It's locked.");
  …
}
```

---

## Appearance

### `this.setSprite(nameOrHash) → boolean`

Swap this element's picture.

```js
this.setSprite("door-open.png");
```

Returns `false` if that asset isn't imported — the rest of your method still runs. That means
you can write the script *before* the art arrives and it degrades gracefully.

### `this.setComponent(slot, key, value) → boolean`

Write one field of a component and have the engine notice. Bags are plain data, so
`this.components.sprite.frame = 3` changes the picture and is **never saved**; this is the door
that journals.

```js
this.setComponent("sprite", "frame", 3);   // show frame 3 of the sheet
```

Returns `false` if the value was already that — a no-op doesn't repaint or save.

---

## Sprites — `(extends Sprite)` only

See [Elements](03-elements.md#animating-a-sheet). The sheet and its frame size live in the
sprite component; these move it.

### `this.play(name) → this`

Switch to a clip and restart it. `this.play()` with no argument resumes the current clip.
Calling it repeatedly with the **same** clip does not restart, so `play("walk")` every frame
while a key is held keeps the cycle running.

```js
this.play("walk");
```

### `this.stop() → this`

Hold the current frame.

### `this.gotoFrame(i) → this`

Jump to a frame **within the current clip** — `gotoFrame(0)` is the clip's first frame, not the
sheet's.

### `this.frame` → number

The frame showing now, as a sheet-wide index. Assignable.

### `this.frameCount` → number

Frames in the sheet. **0 until the image has decoded**, so don't divide by it without checking.

### `this.finished` → boolean

Did a `(loop false)` clip reach its end? Always `false` while looping. `onFinished` fires once
at the same moment.

### Every property

All base properties (see [Elements](03-elements.md)) and every `dat` entry, as direct fields
and as accessor pairs:

```js
this.x = 400;
this.setX(400);
this.setVisible(false).setOpacity(0.5);   // setters chain
```

---

## Lifecycle

Declared with `runInfo`, not called directly:

```
(runInfo begin  onLoad)
(runInfo think  onTick)
(runInfo tidy   onUnload)
```

```js
function begin()   { this.playMusic("theme.mp3"); }
function think(dt) { this.t = this.t + dt; }        // dt in seconds
function tidy()    { /* release audio, timers, handles */ }
```

**`dt` is clamped to 100ms.** A background tab stops `requestAnimationFrame`, so the first
frame back would otherwise report the whole time you were away and teleport everything. The
game runs slow instead of exploding.

---

## The `actor`

`onClick` and `onHover` receive the acting element — whatever is tagged `player`.

```js
function use(actor) {
  if (actor.has(this.key)) { … }
  actor.say("I'll try the key.");
}
```

No tagged player? A stub actor still answers `has()` from the inventory.

---

## Inventory API

On an element that `(extends Inventory)`:

| | |
|---|---|
| `add(item)` | idempotent by id |
| `remove(id)` | → the item, or null |
| `has(id)` | → boolean |
| `get(id)` | → the item, or null |
| `count` | how many |
| `clear()` | empty it |
| `items` | the raw array |

Items are `{ id, name, icon?, ext? }` — **plain data, not elements**. See
[HUD & Inventory](08-hud-and-inventory.md#items-are-data).

Slot rendering reads these `dat` values, all overridable:

| | Default |
|---|---|
| `slots` | 6 |
| `padding` | 6 |
| `slotSize` | fills the height |
| `background` | `rgba(12,12,14,0.78)` |
| `border` | `rgba(255,255,255,0.16)` |

---

## Text

`(extends Text)` — wrapped, aligned text. Everything is `dat`, so everything is yours:

```
<?dat
(text "Click anywhere to continue")
(size 28)
(color "#ffffff")
(align "center")
(valign "middle")
(shadow true)
?>
<?def
(extends Text)
(name "Prompt")
ags?>
```

| Property | Default | |
|---|---|---|
| `text` | `''` | `\n` starts a new line; a blank line is a deliberate gap |
| `size` | `24` | px |
| `font` | system stack | any installed family |
| `weight` | `'400'` | |
| `color` | `'#ffffff'` | |
| `align` | `'left'` | `left` · `center` · `right` |
| `valign` | `'top'` | `top` · `middle` · `bottom` |
| `lineHeight` | `1.4` | multiple of `size` |
| `padding` | `0` | px, inside the element's bounds |
| `wrap` | `true` | `false` honours only explicit newlines |
| `shadow` | `false` | the difference between readable and not, over art or video |
| `shadowColor` | `rgba(0,0,0,0.75)` | |
| `shadowOffset` | `2` | px |
| `background` | none | fills the element's bounds |

Text wraps to the element's `width`. Resize the element and it reflows. A word wider than the
box is broken rather than allowed to bleed out of bounds.

`measureHeight(ctx)` returns the wrapped height, for sizing to content.

**Fonts are system stacks only.** A webfont would mean a CDN or a payload, and AE1 ships
neither. Install the face and name it.

**Text is not privileged.** `AE1Text` is an ordinary element that implements `draw()` — the
same hook you have. Override `draw()` in your own script and you own every pixel.

---

## Button

`(extends Button)` — a Text with a background, a hover state, and a click. **The commonest
button needs no code at all:**

```
<?dat
(label "New Game")
(target "Chapter One")
?>
<?def
(extends Button)
ags?>
```

Override `press(actor)` for anything else:

```
function press(actor) {
  if (!this.has("save_file")) return this.say("No save to load.");
  return this.goToScene("Chapter One");
}
```

| Property | Default | |
|---|---|---|
| `label` | `''` | the text. (`text` also works) |
| `target` | `''` | scene to go to — the default `press()` |
| `disabled` | `false` | no hover, no click, drawn in `disabledColor` |
| `background` / `hoverBackground` | dark / lighter | |
| `border` / `hoverBorder` / `borderWidth` | | |
| `color` / `hoverColor` / `disabledColor` | | |
| `radius` | `4` | corner rounding |
| `hoverSound` / `clickSound` | `''` | media names |

Plus everything from [Text](#text) — `size`, `font`, `align`, `shadow`, and the rest.

| | |
|---|---|
| `press(actor)` | **override this.** Defaults to `goToScene(this.target)` |
| `hovered` | is the pointer over it |
| `whenHovered(actor)` / `whenUnhovered(actor)` | optional hooks |

`draw()` is overridable like any element — that's how a hamburger draws three bars with no
image. See [HUD & Inventory](08-hud-and-inventory.md#custom-hud-elements).

---

## Video

`(extends Video)` — a video drawn into the element's bounds. Size it to the frame
(1280×720 at 0,0) for a full-screen movie.

```
<?dat
(video "intro.mp4")
(loop false)
(muted false)
(autoplay true)
(fit "fill")
?>
<?def
(extends Video)
(name "Intro")

(runInfo finish onEnded)
function finish() { this.goToScene("Main Menu"); }
ags?>
```

| Property | Default | |
|---|---|---|
| `video` | `''` | media **name** |
| `loop` | `false` | |
| `muted` | `false` | muted video autoplays without a gesture |
| `autoplay` | `true` | starts on its scene's `onLoad` |
| `fit` | `'fill'` | `fill` stretches to the element; `contain` letterboxes inside it |
| `background` | `'#000'` | behind `contain`, and while loading |

| Method | |
|---|---|
| `play()` / `pause()` / `rewind()` | |
| `duration` · `currentTime` | seconds; `currentTime` is settable |
| `ended` | reached the end. Always false while looping |

**`onEnded`** is a real runInfo mode — `(runInfo finish onEnded)`. Never fires while looping.

**Video is drawn into the canvas**, not overlaid on it. So text and buttons layer on top of it
like any other element, and the camera applies to both.

**Autoplay is blocked until the player interacts.** *Unmuted* video started in `onLoad` fails
on the very first scene. AE1 holds the intent and fires it on the first gesture, so it
recovers — but this is exactly why a splash screen with "click anywhere to continue" *before*
your intro movie is good design rather than just convention. `(muted true)` autoplays
unconditionally.

**Videos are paused and released on scene exit.** A video left playing behind a scene nobody
is looking at keeps a decoder busy forever.

> Two Video elements naming the **same file** share one underlying `<video>` and will fight
> over playback position. One video per file is the normal case.

---

## Saves

A save is JSON, and it's meant to be opened. Yours to edit.

### `this.saveData`

The open bag. Anything you put here goes into the save file, and the engine never looks inside
it:

```js
this.saveData.chapter = 2;
this.saveData.metCartman = true;
if (this.saveData.chapter > 1) { … }
```

### `this.saveGame(extra?) → Promise`

```js
function press(actor) {
  this.saveData.chapter = 1;
  this.saveGame();
  return this.goToScene("Chapter One");
}
```

**Where it lands depends on where the game is running**, and you don't have to care:

| | |
|---|---|
| In the editor | written to `/projects/<slug>/saves/` silently |
| In a shipped game | **downloaded** — the player keeps the file |

Both also mirror to the browser as a "Continue" slot.

Returns `{ ok, name, downloaded }`.

### `this.loadGame() → Promise`

Asks the player to pick a save file, validates it, loads it. The whole "Load Game" button:

```js
function press(actor) {
  return this.loadGame();
}
```

**Loading is always a file picker**, in both hosts. A page in a browser cannot go looking
through your disk — you have to hand it the file. That's why saving hands you one back.

Returns `{ ok, error?, warning? }`. A save from another game loads with a `warning`; a save
from a newer engine, a corrupt file, or one naming a scene your game lacks is refused with an
`error` you can `say()`.

### `this.continueGame()` · `this.hasSavedGame()`

The most recent save is kept in the browser too, so you can offer **Continue** with no file:

```
<?def
(extends Button)
(runInfo check onLoad)

function check() { this.disabled = !this.hasSavedGame(); }
function press(actor) { return this.continueGame(); }
ags?>
```

**The browser copy is a convenience, not the save.** Clearing browser data clears it. The file
is the copy that lasts.

### The save handler — deciding what gets saved

**The engine can't know what matters in your game.** Whether a door being open is worth
remembering, whether an NPC's mood is state or scenery — that's yours. So the engine owns the
envelope, the moment, and the ordering, and asks you for the contents.

**Outliner → HUD section → `+Save`.** One per project. It lives in the HUD layer because it has
to outlive every scene, and it draws nothing.

```
<?dat
(trackProps ("locked" "opened" "spoken" "gaveKey"))
?>
<?def
(extends SaveHandler)
(name "SaveHandler")

// Called while a save is being written. Put anything you like on `save`.
function capture(save) {
  save.inventory = this.captureInventory();
  save.elements  = this.captureScene(this.trackProps);
  save.hud       = this.captureHud(this.trackProps);
}

// Called while one is being loaded — AFTER the scene has loaded, so the
// elements you're restoring exist.
function restore(save) {
  this.restoreInventory(save.inventory);
  this.restoreElements(save.elements);
  this.restoreElements(save.hud);
}
ags?>
```

**No handler? Nothing changes.** You still get the timestamp, the scene, and `saveData`. Adding
one is additive.

| Helper | |
|---|---|
| `captureInventory()` / `restoreInventory(items)` | |
| `captureScene(keys)` | every element in this scene **carrying** one of those properties |
| `captureHud(keys)` | same, for the persistent layer |
| `captureElement(nameOrEl, keys)` / `captureElements(names, keys)` | |
| `restoreElements(entries)` | applies them back |

`captureScene` records only elements that *have* the properties — so adding `locked` to one
door needs no list anywhere.

**State for a scene the player isn't in is parked, not lost.** A save can describe a door in
Chapter Three; that door doesn't exist until Chapter Three loads. `restoreElements` holds it
and the engine applies it the moment that scene loads — **before its `onLoad`**, so a script's
`onLoad` sees the world it was saved in.

`capture()` and `restore()` are ordinary Angel Script. Do anything: compute a summary, write a
screenshot name, save only what changed. It's your file.

### What's in a save

```jsonc
{
  "ae1":  { "engine": "Angel's Egg", "saveFormat": 1 },
  "game": { "id": "…", "title": "Front End", "version": "0.1.0" },
  "saved": "2026-07-17T00:44:53.483Z",
  "scene": "chapter-one.json",
  "sceneName": "Chapter One",
  "data": { "chapter": 2 }          // ← your saveData
}
```

Today: a timestamp, the scene, and your bag. **The format is designed to grow** — unknown
fields survive a load/save round trip, so a save written by a newer build isn't stripped by an
older one.

*The inventory and per-scene state are not saved yet.*

---

## Settings

How this player likes their games. **Not part of a save** — loading a six-month-old save must
not reset someone's volume.

```js
this.settings.musicVolume          // read
this.setSetting("musicVolume", 0.4)  // set + apply + persist, in one call
this.resetSettings()
```

The engine reads three:

| | Default | |
|---|---|---|
| `musicVolume` | `0.6` | 0–1 |
| `soundVolume` | `1` | 0–1 |
| `muted` | `false` | |

**Everything else is yours.** `this.setSetting("subtitles", true)` works and persists, and the
engine never touches it.

Settings live in the browser, keyed per game. They survive across playthroughs and across
saves. They do *not* survive clearing browser data — which is fine, because they're a
preference, not your progress. That's precisely why they can live where a save can't.

A settings row that reads itself:

```
<?dat
(text "")
(key "musicVolume")
(caption "Music")
?>
<?def
(extends Text)
(runInfo refresh (onLoad onCall))

function refresh() {
  this.text = this.caption + ":  " + Math.round(this.settings[this.key] * 100) + "%";
}
ags?>
```

And a button that changes it:

```
function press(actor) {
  var v = Math.max(0, Math.min(1, this.settings[this.key] + this.step));
  this.setSetting(this.key, Math.round(v * 100) / 100);   // round: 0.1 steps drift
  this.find(this.row).refresh();
}
```

---

## `java.lang.Object`-style

| | |
|---|---|
| `toString()` | `Door("Kitchen Door" 8f14e45f)` |
| `equals(other)` | identity — same element or not |
| `clone()` | a copy with a **new** id |
| `getBounds()` | `{x, y, w, h}` in scene space |
| `containsPoint(x, y)` | hit test |

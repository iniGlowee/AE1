# 3. Elements

Everything in a scene is an element: backgrounds, characters, doors, trigger volumes,
inventories, health bars. They differ by what's attached, not by what they are.

An element is a JavaScript object. A scene is a JavaScript object holding elements. Angel
Script is how you configure them without writing engine plumbing.

## What every element has

Drawn from `java.lang.Object` (identity), a commercial engine's `AActor` (transform, lifecycle, tags), and
Blender's 2D plane (dimensions, parent, visibility) — because those three converged, over
decades, on what an object in a scene needs to be.

| Group | Properties |
|---|---|
| Identity | `id` (UUID, immutable), `name`, `type`, `tags[]` |
| Transform | `x`, `y`, `layer`, `rotation`, `scaleX`, `scaleY` |
| Dimensions | `width`, `height` |
| Render | `visible`, `opacity`, `flipH`, `flipV` |
| Hierarchy | `parent` |
| Lifecycle | `onLoad`, `onUnload`, `onTick` |
| Object | `toString()`, `equals(other)`, `clone()` |

Every property has an accessor pair, and setters chain:

```js
this.x = 400;                    // same thing
this.setX(400);                  // as this
this.setVisible(false).setOpacity(0.5);
```

Both routes go through the same accessor, so **both are observable**. That matters: your
script writing `this.locked = false` is what the engine sees and saves.

`layer` is paint order — higher draws later, on top. Hit-testing runs the reverse: you grab
what you can see.

## Types

`element` · `background` · `character` · `object` · `region` · `audio`

Type is a label. It picks the placeholder colour in the viewport and the dot in the Outliner,
and it's yours to read in scripts (`if (this.type === "character")`). It grants no behaviour —
behaviour comes from what a thing `extends`.

## `extends` vs `parent`

**Two different axes. Never conflate them.**

- **`extends`** — the prototype chain. *Behaviour.* A `Door` extends `Openable` and inherits
  its methods and its `dat`.
- **`parent`** — scene hierarchy. *Position and grouping.* A door can parent a trigger volume.

A single element commonly has both.

Hierarchy is stored as a `parent` id **on the child only** — never as a `children` array on
the parent. One direction means one thing to keep true. Deleting an element removes its
descendants too; orphans that render but can't be selected are a miserable thing to debug.

Reparenting refuses to build a cycle.

## Components

Optional data bags for things an element *may* have:

```jsonc
"components": {
  "sprite":   { "media": "a3f9c2…", "ext": "png" },
  "collider": { "shape": "rect" }
}
```

> **Base properties are what every element HAS. Components are what an element MAY have.**

A transform isn't optional — there is no element without a position — so `x`/`y` are base
properties, not a component. A sprite is optional, so it's a component.

Right now `sprite` is the component the engine reads. Others are yours to invent and read
from scripts.

## Sprites

An element with a `sprite` component draws that image, stretched to its `width`/`height`.
Without one it draws as a flat block in its type colour — which is a placeholder while you
work, and a deliberate coloured region (a backdrop, a trigger) if you leave it.

**An element with `opacity: 0` still hit-tests.** That's how you make an invisible click
region over something painted into a background — the most common trick in point-and-click.

Swap a sprite from a script:

```js
this.setSprite("door-open.png");   // by media NAME
```

## Spritesheets

A spritesheet is one image holding many frames. Tell the sprite how big a frame is, and it
draws one frame instead of the whole picture — everything else about the element is unchanged.

In **Properties → Sprite**:

| | |
|---|---|
| **Image** | the media name — type `walk.png`, not a hash |
| **Frame W / Frame H** | the size of ONE frame. This is what makes it a sheet. |
| **Columns** | leave at 0 and AE1 works it out from the image width |
| **Frame** | which frame to show, counting from 0, left to right then down |

The panel tells you what it worked out — *"8 frames (4×2)"* — and says so if your frame size
doesn't divide the image evenly, which is the easy mistake and otherwise a silent one.

**Frame W/H of 0 means "an ordinary picture".** That's the only difference between a sheet and
an image; there's no checkbox to get out of sync with.

Any element can show a frame this way. Nothing has to be animated to use a sheet — an atlas of
icons is just an element per icon, each on a different frame.

## Animating a sheet

**+ Sprite** in the toolbar adds an element that moves. Give it a sheet in Properties, and it
plays.

```
<?dat
(animations (idle 0 3) (walk 4 7))
(animation "walk")
(fps 12)
(playing true)
(loop true)
?>
<?def
(extends Sprite)
(name "Hero")
ags?>
```

Clips are `(name firstFrame lastFrame)`, counting from 0. `(animation "")` plays the whole
sheet. From a script:

```js
this.play("walk");      // switch clip, restart it
this.play();            // resume the current clip
this.stop();            // hold this frame
this.gotoFrame(0);      // first frame of the current clip
```

`play("walk")` only restarts if the clip actually **changes**, so calling it every frame while
a key is held keeps the cycle running instead of freezing it on frame 0.

`(loop false)` holds the last frame and calls `onFinished`:

```
(runInfo hitTheGround onFinished)
```

**Rotation and flip work on a sprite**, because an animated sprite renders through the same
path as every other element. A walk cycle facing left is `flipH` on the same sheet.

## HUD elements

Elements that live in the project rather than in a scene, so they survive scene changes. Same
schema, same accessors, same Angel Script — they just render above everything and are
hit-tested first.

See [HUD & Inventory](08-hud-and-inventory.md).

## What an element looks like on disk

```jsonc
{
  "id": "8f14e45f-…",            // UUID, immutable, forever
  "name": "Kitchen Door",
  "type": "object",
  "tags": [],
  "extends": null,               // set by the script's (extends …), not here
  "parent": null,
  "x": 880, "y": 220,
  "width": 120, "height": 260,
  "layer": 1,
  "rotation": 0, "scaleX": 1, "scaleY": 1,
  "visible": true, "opacity": 1,
  "flipH": false, "flipV": false,
  "components": { "sprite": { "media": "a3f9c2…", "ext": "png" } },
  "script": "door.ags.txt",
  "locked": true                 // ← a dat property from the script
}
```

That last line matters: **`dat` values are live state, not just declarations.** A door
unlocked during play persists as unlocked. The saved value wins over the declared default —
`dat` is a *default*, not a constant.

## Tags

Free-form strings. One is special:

**`player`** — the element tagged `player` becomes the `actor` passed to every `onClick`. That
makes `actor.has("brass_key")` read naturally in a door's script.

No tagged player? The actor falls back to a stub that still answers `has()` from the
inventory. **The inventory is the source of truth**, not the element carrying it — so a game
with no player character still works.

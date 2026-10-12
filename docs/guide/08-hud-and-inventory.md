# 8. HUD & Inventory

## The one thing to understand

> **HUD elements live in the PROJECT, not in a scene.**

They're in `hud.json`, beside `scenes/`. That is the entire reason they survive a scene
change.

If the inventory lived inside a scene, scene 1 and scene 2 would each hold their **own copy**,
and walking through a door would silently reset it. One place, one instance, loaded once,
never unloaded.

Everything else about HUD elements follows from that:

- Their `onLoad` fires **once**, when the game starts. Never again.
- They never receive `onUnload` on a scene change. They don't learn it happened.
- They render **above** every scene element and are hit-tested **first** — unconditionally,
  not by layer. An inventory hidden behind a background would be an unpleasant surprise.
- The Outliner shows them in a separate **HUD** section, because "why did my inventory reset?"
  should never be an unanswerable question.

## Adding one

**Outliner → + HUD** for a blank persistent element, or **+ Inventory** for a working
inventory.

Or from the Media Collection, drag an asset in and then move it to the HUD — *not built yet;
use + HUD and set its sprite.*

## The Inventory

**+ Inventory** creates a HUD element with this script:

```
<?dat
(slots 6)
(padding 8)
(slotSize 52)
?>
<?def
(extends Inventory)
(name "Inventory")

; Extending Inventory gives you items, add/remove/has, and slot rendering.
; Override draw() here to make it look like anything you want.
ags?>
```

That's it. `(extends Inventory)` resolves to a built-in base through the **same** chain
resolution as `(extends Openable)` — you can't tell which bases the engine ships and which you
wrote, and you shouldn't have to.

### Using it

From any element's script:

```js
this.give({ id: "brass_key", name: "Brass Key", icon: "keyicon.png" });
this.has("brass_key");     // → true
this.take("brass_key");
```

And in a door:

```js
function use(actor) {
  if (!actor.has(this.key)) return this.say("It's locked.");
  return this.goToScene("Hallway");
}
```

`actor.has()` consults the same one inventory. **The inventory is the source of truth**, not
whichever element happens to be the player.

### Items are data

An item is `{ id, name, icon?, ext? }` — **plain data, never an element reference.**

That distinction is load-bearing. Picking up a key *cannot* move the key element into the
inventory, because that element is destroyed when its scene unloads. Items are data, so they
survive scene changes, serialize cleanly, and can be granted by a script with no element to
hand.

`add()` is **idempotent by `id`** — talking to the same NPC twice won't give you two keys.

`icon` is a media **name**; it resolves to a hash on the way in, so renaming the asset later
doesn't break it. Items with no icon render their initial.

### Configuring it

Everything is `dat`, so it's yours:

| | Default |
|---|---|
| `slots` | 6 |
| `padding` | 6 |
| `slotSize` | fills the height |
| `background` | `rgba(12,12,14,0.78)` |
| `border` | `rgba(255,255,255,0.16)` |

Position and size come from the element's `x`/`y`/`width`/`height` like anything else.

## Custom HUD elements

> **Any element with a `draw(ctx, api)` method owns its own rendering.**

That single hook is how health bars, custom inventories, and arbitrary HUD chrome are made.
The context arrives **translated to your element's top-left** and unrotated, so you work in
local coordinates from `(0,0)` to `(width, height)`.

### A health bar

```
<?dat
(hp 72)
(maxHp 100)
(barColor "#c0524f")
?>
<?def
(extends HudElement)
(name "Health Bar")

(runInfo drain onTick)

function draw(ctx, api) {
  var pct = Math.max(0, Math.min(1, this.hp / this.maxHp));

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, this.width, this.height);

  ctx.fillStyle = this.barColor;
  ctx.fillRect(2, 2, (this.width - 4) * pct, this.height - 4);

  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(0.5, 0.5, this.width - 1, this.height - 1);

  ctx.fillStyle = "#fff";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(Math.round(this.hp) + " / " + this.maxHp, 6, this.height - 6);
}

function drain(dt) {
  this.hp = Math.max(0, this.hp - dt * 2);
}
ags?>
```

Attach that to a **+ HUD** element, size it, and it follows the player through every scene,
draining as it goes. Any script anywhere can reach it:

```js
var bar = this.find("Health Bar");
bar.hp = bar.hp - 10;
```

### The `api` argument

| | |
|---|---|
| `api.width`, `api.height` | your element's drawn size |
| `api.mediaBase` | URL prefix for assets |
| `api.getImage(base, hash, ext, onReady)` | the media cache |
| `api.redraw` | call when an image finishes loading |
| `api.element` | you |

A thrown `draw` costs that element, never the frame — one bad HUD script must not blank the
game every frame forever.

## Built-in bases

| | |
|---|---|
| `Element` | the base of everything |
| `Text` | wrapped, aligned text |
| `HudElement` | drawn above everything; hit-tested first |
| `Inventory` | a HudElement with items and slot rendering |

> **`HudElement` does not make a thing persist.** Persistence comes from *which layer it lives
> in* — `hud.json` vs a scene — never from its class. `HudElement` only affects draw and pick
> order. So `(extends Text)` or `(extends Inventory)` both persist fine in the HUD, and
> `this.isHud` asks the world rather than trusting a flag that could disagree.

An **unscripted** HUD element still defaults to `HudElement`, so it won't lose its draw order
on reload.

## What isn't built

- **Hiding the HUD.** You asked for inventories that aren't always visible. Today you can set
  `visible = false` from a script, which works — but there's no toggle-on-key affordance yet.
- **Drag items out of the inventory.** `slotAt(x, y)` exists on `Inventory` for exactly this;
  nothing calls it.
- **Save/load** of HUD state per playthrough.

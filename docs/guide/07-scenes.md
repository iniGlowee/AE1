# 7. Scenes

A scene is a room. It holds elements, and it is a JSON file in `projects/<slug>/scenes/`.

## Editing scenes

The **scene dropdown** in the top bar switches which one you're editing. **+ New scene…**
makes another.

**Switching scenes in the editor is not a scene change in the game sense.** No `onLoad`, no
`onUnload`, no HUD reset. You're opening a different file; the player is walking through a
door. Undo resets on a switch — undoing into a room you aren't looking at would be a trap.

Deleting a scene is refused if it's the last one, or if it's the entry scene. Make another
scene the entry first.

## The entry scene

Where the game starts. It's `entryScene` in the `.ae1proj` file, set to the first scene when
a project is created.

*Changing it from the UI isn't built yet* — edit the `.ae1proj` file.

## Moving between scenes

From a script:

```js
this.goToScene("Scene 2");        // by name
this.goToScene("scene-2.json");   // or by file
```

The contract, exactly:

1. The outgoing scene's elements get `onUnload`, then are dropped.
2. The incoming scene's elements get `onLoad`.
3. **The HUD is untouched.** It never learns a scene change happened.

A doorway is therefore about six lines:

```
<?dat
(key "brass_key")
(nextScene "Hallway")
?>
<?def
(extends Element)
(name "Door")
(runInfo use (onClick onCall))

function use(actor) {
  if (!actor.has(this.key)) return this.say("It's locked.");
  return this.goToScene(this.nextScene);
}
ags?>
```

`goToScene` returns `false` and warns in the Console if the scene doesn't exist. The build
warns at export too — a `goToScene` naming nothing is a dead end the player walks into.

### Letting the door be seen

A scene change is instant. If you want the player to *see* the door open, hold it:

```
<?dat
(opened false)
(timer 0)
(delay 0.8)
?>
<?def
(runInfo use   (onClick onCall))
(runInfo linger onTick)

function use(actor) {
  if (!actor.has(this.key)) return this.say("It's locked.");
  this.opened = true;
  this.timer = 0;
  this.setSprite("door-open.png");
  return this.say("The door swings open.");
}

function linger(dt) {
  if (!this.opened) { return; }
  this.timer = this.timer + dt;
  if (this.timer >= this.delay) {
    this.opened = false;
    this.goToScene(this.nextScene);
  }
}
ags?>
```

## Lifecycle

| | When |
|---|---|
| `onLoad` | this element's scene became current |
| `onUnload` | this element's scene is being dropped |
| `onTick` | every frame while its scene is current |

**HUD elements are different**: their `onLoad` fires *once*, when the game starts, and never
again. That asymmetry is the whole point of a HUD — see
[HUD & Inventory](08-hud-and-inventory.md).

**Release things in `onUnload`.** Audio, timers, handles. It's the hook that makes memory
management real rather than aspirational.

## Music per room

```
<?dat
(music "room-theme.mp3")
?>
<?def
(extends Element)
(name "Room")
(runInfo begin onLoad)

function begin() {
  this.playMusic(this.music);
}
ags?>
```

Attach that to the background. Re-entering the room won't restart the track; moving to a room
with different music crossfades.

## State across scenes

Scene elements are **destroyed** on exit. Their state goes with them — a door you opened in
scene 1 is closed again when you come back, because it's a new instance from the file.

Anything that must persist belongs in the **HUD** (the inventory, flags, progress). That's the
layer that survives.

*Per-playthrough save/load isn't built yet.*

## On disk

```jsonc
{
  "id": "24266513-…",
  "name": "Scene 1",
  "elements": {
    "8f14e45f-…": { … },
    "b26ea56d-…": { … }
  }
}
```

Elements are a map keyed by id, not an array — order comes from `layer`, not from position in
a file. Written atomically, so a crash mid-save can't corrupt the room you were working in.

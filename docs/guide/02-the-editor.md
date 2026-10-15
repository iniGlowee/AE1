# 2. The Editor

The workspace is Blender's model: a tree of areas you can split, join, and rearrange into
anything. It is worth ten minutes.

## Areas

Every pane can become any editor. The dropdown in a pane's top-left changes what it is.

| Control | Does |
|---|---|
| `▤` | split left / right |
| `▥` | split top / bottom |
| `⤢` | maximize this pane |
| `✕` | close it; its sibling takes the space |

Pane controls appear on hover, so a six-pane workspace isn't a wall of buttons.

**Drag any divider** to resize. **Double-click a divider** to reset it to even.

**Maximize** is the important one: `Ctrl+Space`, or **double-click a pane's header**. Use it
on the Angel Script pane when you're writing real code, then drop back.

> Windows binds `Ctrl+Space` to IME layout switching, so it may not reach the page. The
> header double-click always works and can't be intercepted.

**Your layout is saved** to `settings.json` on the server — not in the browser, which
incognito would wipe every launch. Arrange it once. **Reset Layout** restores the default.

Maximize is deliberately *not* saved: it's a momentary view, and reopening into a full-screen
pane with the rest of your workspace apparently gone would read as data loss.

## The panes

### Viewport

Your scene. The frame border marks what ships — inside it is the game, outside is workspace.

| | |
|---|---|
| Left-click | select |
| Left-drag | move the selected element |
| Middle-drag | pan |
| Wheel | zoom (toward the cursor, not the centre) |
| Drop a file | import it and place it where you dropped it |
| Drag from Media | place that asset there |

Selection draws with corner ticks **on top of everything**, so it's visible even when
something covers the element you picked.

**In play mode the viewport is a game, not an editor.** Clicks fire `onClick` instead of
selecting. Nudging an element mid-play would edit state that Stop is about to throw away.

### Outliner

Everything in the scene, and everything in the HUD, as two sections.

That split is real, not cosmetic: **SCENE** elements are this room; **HUD** elements outlive
every room. See [HUD & Inventory](08-hud-and-inventory.md).

- Click a row to select. `●` toggles visibility — a hidden element keeps its eye showing so
  you can find it again. `✕` deletes.
- **+ Element** adds to the scene. **+ HUD** adds to the persistent layer.

### Properties

Every property of the selected element, generated from the element schema — plus an **Angel
Script** section listing that element's `dat` properties, editable live.

Those dat fields are the same values your script reads. Change `locked` here and
`this.locked` in the script sees it. One value, one place.

### Media Collection

Drag files in, or **+ Import**. See [Media](06-media.md).

Tiles show usage counts (`3×`). **In a 2D point-and-click project**, drag a tile to the viewport to make it an element;
double-click adds it at the frame centre. **In a 3D project** (the Starter) the viewport shows a scene, so dropping an
image does nothing yet; see the note under [Media](06-media.md#using-an-asset).

### Angel Script

The script attached to the selected element. Compiles as you type; the header shows
`compiled` or an error count. **Tab indents** rather than escaping to the next pane.

**▶ Test** fires that element's `onCall` methods immediately — the cheapest "does this do
anything" without running the game.

### Console

Compiler diagnostics and runtime output. Errors are red and name the file and line. `say()`
lines appear in italic. This is where a script that throws lands — one bad script costs that
element, never the game.

## The top bar

| | |
|---|---|
| Scene dropdown | switch scenes, or **+ New scene…** |
| `↺` `↻` | undo / redo |
| **Build & Ship** | export |
| **▶ Play** / `F5` | run it |
| Save indicator | *Saved* / *Saving…* / *Not saving* |

## Saving

**There is no save step.** Every edit journals to disk within ~350ms. Close the window
whenever you like.

The indicator is honest — if it says *Saved*, it's on disk. During play it says **Not
saving**, because the journal is suspended and claiming otherwise would be a lie exactly when
it matters.

**Save-as-a-version** (snapshots) is the intended meaning of an explicit save. *Not built
yet.*

## Undo

`Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`).

- **A drag is one step**, not two hundred. Edits coalesce for ~450ms.
- Covers the scene *and* the HUD.
- **Does not cross scenes.** Switching scenes resets the stack — undoing into a room you
  aren't looking at would be a trap.
- **Disabled during play.** Play has its own snapshot/restore.
- **Never steals typing.** `Ctrl+Z` in the script editor undoes text.

Depth is 60 steps.

## Play mode

**▶ Play** builds a real game — the same `AE1World` the exported build boots. Scene changes,
the HUD, audio, and the inventory behave exactly as they will in the shipped game.

**Play never edits your project.** The scene and HUD are snapshotted on Play and restored on
Stop. A door that unlocks, a counter that ticks, an NPC that walks — all discarded.

Play mode is signalled hard: a green rail around the workspace, a green frame, an amber *Not
saving*, and a HUD reading `▶ PLAYING · 241f · 3.2s · changes discarded on stop`.

**Editing a script during play takes effect immediately**, carrying current state across.
That's live-coding a running game, and it's genuinely useful for tuning dialogue.

## Keyboard

| | |
|---|---|
| `F5` | play / stop |
| `Ctrl+Space` | maximize the pane under the cursor |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Tab` (script pane) | indent |
| `Esc` | close a modal |

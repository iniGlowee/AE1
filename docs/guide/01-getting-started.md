# 1. Getting Started

## Run it

```powershell
.\server.ps1
```

That resolves Python, builds an isolated `.venv` on first run, starts the server on
`http://localhost:8000`, and opens Brave in incognito.

| Flag | Does |
|---|---|
| `-Port 8080` | use another port |
| `-NoBrowser` | server only |
| `-Rebuild` | discard and rebuild the venv |

**Requires Python 3.9+.** If the launcher says it can't find one: a `python` that opens the
Microsoft Store is a stub, not an install. Get it from python.org. The launcher already
filters that stub out — it uses the `py` launcher.

**Incognito is deliberate.** Everything real lives on disk; the browser holds nothing you'd
miss. Close the window whenever you like — see [The Editor](02-the-editor.md#saving).

## Make a project

**New Project** → name it, add a description → **Next** → pick *Point & Click Adventure Game*
→ **Create Project**.

That scaffolds:

```
projects/
  my-game.ae1proj          name, metadata, engine version
  my-game/
    scenes/scene-1.json    your first room
    hud.json               things that outlive a room
    media/                 art and audio, named by content hash
    scripts/               your Angel Scripts
    snapshots/             named versions
```

The folder name is a slug of your project name. **Renaming a project never moves the folder** —
the name is what you see, the slug is an internal address.

## Make something happen

A five-minute tour of the whole engine.

### 1. Import a picture

Drop a PNG into the **Media Collection** pane (bottom right). Then drag it into the
**Viewport** — it becomes an element wherever you dropped it.

### 2. Give it a script

Select it. In the **Angel Script** pane, click **+ Attach Angel Script**. You get a working
template:

```
<?dat
(clicked 0)
?>
<?def
(name "Barrel")

(runInfo touch (onClick onCall))
(runInfo look onHover)

function touch(actor) {
  this.clicked = this.clicked + 1;
  return this.say("You touch the " + this.name + ". (" + this.clicked + ")");
}

function look() {
  return this.say("It is a " + this.type + ".");
}
ags?>
```

Three sections:

- **`dat`** — what this thing *is*. S-expressions. These become real properties: `clicked` in
  the file, `this.clicked` in the code, and the field in the **Properties** panel are all the
  same value.
- **`def`** — what it *inherits* and *when its methods run*.
- **methods** — plain JavaScript.

It compiles as you type. Watch the pane header: `compiled`, or an error count.

### 3. Play it

Press **▶ Play** (or `F5`). Click your element. It talks back, and the Console shows the line.

**Playing never edits your project.** Everything a script changes is discarded on **Stop** —
the workspace turns green and says *Not saving* so you always know which mode you're in.

### 4. Ship it

**Build & Ship** → **Build & Ship**. You get `exports/my-game/` — a folder you can drop on
any web host, or **open by double-clicking `index.html`**. No server, no install, no build
step.

---

## The mental model

Four ideas, and the rest follows:

**A scene is a JavaScript object holding elements, which are JavaScript objects.** Nothing
more exotic. Angel Script is a way of configuring those objects without writing engine
plumbing.

**Everything is an element.** Backgrounds, characters, doors, trigger volumes, the inventory,
your health bar. They differ by what's attached, not by what they are.

**Elements inherit.** A `Door` can `(extends Openable)` and get its behaviour, then override
one method. `super.use()` works, because AGS compiles to real JavaScript classes.

**The filesystem is the truth.** The browser is a disposable window onto it. There is no Save
button in the usual sense — your work is on disk within a moment of you doing it. **Save**
means *mark a version*, not *persist*.

## Where next

- [The Editor](02-the-editor.md) — the workspace is Blender-style; it rewards ten minutes.
- [Angel Script](04-angel-script.md) — the language, properly.
- [HUD & Inventory](08-hud-and-inventory.md) — the first thing most games need next.

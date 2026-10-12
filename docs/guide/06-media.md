# 6. Media

## Importing

Drag files onto the **Media Collection** pane, or **+ Import**. Drop them straight onto the
**Viewport** to import *and* place in one gesture.

Each file uploads independently, so **one bad file won't sink a batch of forty**.

| Kind | Extensions |
|---|---|
| image | png jpg jpeg gif webp bmp avif svg |
| audio | wav mp3 ogg m4a flac opus |
| video | mp4 webm ogv mov |
| model | gltf glb obj fbx stl |

Images render — as whole pictures, or as [spritesheets](03-elements.md#spritesheets). Audio
plays. Video plays: add one with **+ Video**, or drop a video file onto the viewport. **model**
is recognised and stored, but nothing draws it yet.

### Video in the editor

The editor draws when something changes, not on a clock — so a video sits on **one frame** while
you lay things out, and frame 0 of an intro is usually black.

Select a video and a transport appears under the viewport:

| | |
|---|---|
| **▶ / ⏸** | preview it playing, right there in the viewport |
| **scrubber** | drag to any moment |
| **Set poster** | pin the current frame as what the editor shows from now on |

**Set poster** writes `(poster <seconds>)` into the video's dat — so it's yours, it's in the
file, it shows in Properties, and it undoes. Scrub to the moment your title has to sit over,
pin it, and lay out against the real thing.

**The poster is authoring only.** Play always starts the video from 0, in the editor and in the
shipped game. Stopping Play puts you back on your poster.

## Content addressing

Assets are stored by the **hash of their contents**: `projects/my-game/media/<hash>.png`. The
friendly name lives in `manifest.json`.

That one decision buys four things:

**Duplicates cost nothing.** The same footstep used in forty scenes exists once on disk and
once in your build. Re-importing identical bytes is a no-op — drop the same folder twice and
nothing changes.

**Renaming is free.** It touches one line in the manifest. No file moves, no reference breaks.

**References can't dangle from a rename**, because scenes point at content, not at labels.

**Assets cache forever.** The filename *is* the hash, so the bytes can never change — media is
served `immutable` while everything else is `no-store`. A scene with 200 sprites doesn't
refetch them on reload.

## Naming matters

**Scripts address media by name:**

```js
this.playSound("cartman-hey.mp3");
this.setSprite("door-open.png");
this.give({ id: "key", name: "Key", icon: "keyicon.png" });
```

So the name you give a file is the name you type in scripts. The extension is optional
(`playSound("cartman-hey")` works). Rename freely afterwards — anything already resolved
stores the hash.

## Using an asset

| | |
|---|---|
| Drag a tile → Viewport | becomes an element there, at natural size |
| Double-click a tile | adds it at the frame centre |
| `this.setSprite("name.png")` | swaps an existing element's picture |
| `icon: "name.png"` in `give()` | an inventory item's picture |
| `this.playSound("name.mp3")` | audio |

Tiles show a usage count (`3×`) — how many elements point at that asset, across **every**
scene and the HUD.

## Deleting

**Refused while anything uses it.** The dialog names what. Content addressing stops a
reference dangling on *rename*, but nothing stops a *delete*, and a scene of invisible broken
sprites is a miserable thing to debug.

Remove the elements first, or point them elsewhere.

## What ships

The build ships **only what your game can reach**:

- element sprites, in every scene and the HUD
- inventory item icons
- **anything named in a script**

That last one is subtle and important. A sound reached only via
`playSound("boing.mp3")` has no element pointing at it. A sprite-only sweep would prune it,
and your game would **fall silent in the build but not in the editor** — the worst kind of
bug. The exporter scans script text for asset names.

It's deliberately crude — you can build a filename at runtime, so no static analysis can be
complete. Over-keeping costs bytes; wrongly pruning silently breaks a shipped game. The trade
isn't close.

The build reports what it pruned, by name. Silence would read as "everything shipped."

## Optimization

If **Pillow** is installed, images are recompressed at export (and skipped if that would make
them *bigger*).

If it isn't, the build says so plainly: *"The game is correct, just larger."* A missing
dependency changes the **size** of a build, never its correctness, and never blocks one.

```powershell
.venv\Scripts\python -m pip install Pillow
```

## Transparency

Use **PNG** for anything that isn't a full-frame background. A JPG has no alpha channel, so it
renders as an opaque rectangle — a photo of a door on a white background will appear as a
white box over your scene.

For a thing painted into a background you want clickable, you don't need art at all: place an
element with **`opacity: 0`** over it. It still hit-tests. That's the most common trick in the
genre.

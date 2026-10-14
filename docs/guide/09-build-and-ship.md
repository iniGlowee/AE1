# 9. Build & Ship

**Build & Ship** → **Build & Ship**. That's it.

You get `exports/<slug>/`:

```
index.html      the whole game: engine, scenes, and scripts inlined
media/          assets, by content hash
source/         readable copies of the scenes and scripts
README.txt      how to play it, how to mod it
```

## Two ways to play it

**Double-click `index.html`.** No server, no install, no build step.

**Drop the folder on any web host.** Static files. Nothing to configure.

That first one shapes the entire design. A `file://` page can't `fetch()` its own scenes and
can't load ES modules — both are blocked by origin rules. So the export **inlines** the
engine, the scenes, and the scripts into `index.html` as one classic script, and leaves media
as loose files, because `<img src>` is one of the few things `file://` still permits.

A built game makes exactly two kinds of network request: the page, and its images.

## What the build does

1. **Collects** every scene, every script, and the HUD.
2. **Warns** about things that will break: an element pointing at a script that doesn't exist,
   a `goToScene` naming a scene that doesn't exist. A build is the moment to say "this will not
   work", not the moment to ship it quietly.
3. **Prunes** unreferenced media, and says what it dropped, by name.
4. **Optimizes** images, if Pillow is installed.
5. **Bundles** the engine and inlines everything.
6. Writes `source/` and a README.

## Your game is readable on purpose

No minification. No name mangling. Scenes stay JSON, scripts stay text.

Gzip on the host recovers most of what minification would have, and it's the host's job
anyway. What you get instead is a game that can be understood, changed, and learned from.

## Modding

The shipped game is meant to be opened.

Everything lives in the `<script id="ae1-data">` block in `index.html`: scenes as JSON, Angel
Scripts as text. **Edit them and reload** — the compiler ships *inside* the game, so scripts
recompile at boot and your changes take effect immediately.

`source/` holds the same scenes and scripts as separate files, for reading and diffing.
Editing those does **not** affect the game — `index.html` is what runs.

Open devtools and use `AE1`:

```js
AE1.world              // the live world
AE1.scene              // the current scene
AE1.inventory          // the inventory
AE1.goToScene("Hallway")
AE1.world.find("Door").locked = false

AE1Element             // the engine's classes are all global, on purpose
compileAGS(source)
```

**Modding and authoring are the same surface.** That's not a nice-to-have — it's *why* the
engine has one code path. The editor and the shipped game run the same scene loader, the same
compiler, the same scheduler, the same renderer. "Works in the editor, breaks in the export"
has nowhere to hide, because there is no second implementation to disagree.

## Rebuilding

Safe. Builds go to a staging folder and swap in only on success.

If something is holding the output folder open — a browser tab playing the game, an Explorer
window — the swap fails, **your previous build survives untouched**, and the error tells you
what to close. A build is never allowed to be destructive before it has something to swap in.

## Sizes

An engine bundle is ~87KB of readable JavaScript. Everything else is your art.

If your build is large, it's images — install Pillow, or export them smaller. The engine is
never the problem.

## What isn't built

- **Audio transcoding** at export (ffmpeg is detected but unused).
- **Zip download** from the editor. The server writes the folder; grab it from disk.
- **Multi-resolution** builds. The frame is 1280×720, letterboxed to the window.

## Keeping your work on the hosted demo

The hosted demo (ae1.ausa.dev) is a shared, temporary workspace. Read this before you build something you care about.

- **It is private to you, tied to your network address.** Nobody else sees your projects. People who share one connection
  (a mobile carrier, an office, a campus) share one workspace.
- **It is not backed up and can be lost without warning**, for example when the server is updated.
- **The editable project cannot be downloaded from the hosted demo.** Build & Ship writes the finished game into your
  workspace on the server and gives you a link to it; there is no zip or project download yet. Keep your own copies of the
  images, models and scripts you put in.
- **A 3D game can be kept as one file.** A browser build is a single self-contained `index.html`: the engine, scenes,
  scripts and every `.glb` model are inside it. To keep one:
  1. Build & Ship, then open the link it gives you.
  2. Save that page. In the save dialog choose **"Webpage, HTML only"** (the wording varies by browser), **not**
     "Webpage, Complete".
  3. Double-click the saved file. It runs from your disk, with no server.
  This was tested with the Starter project saved as the raw HTML and opened from disk. It has **not** been tested with
  "Webpage, Complete" (which rewrites the page as it saves and may break it), and it does **not** apply to 2D point-and-click
  projects, whose pictures stay as separate files next to the page.
- **Or run AE1 yourself** from [github.com/iniGlowee/AE1](https://github.com/iniGlowee/AE1): there your projects are plain
  files on your own disk.


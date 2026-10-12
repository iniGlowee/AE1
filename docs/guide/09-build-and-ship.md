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

# AE1 — Angel's Egg 1  (public alpha)

**A lightweight, browser-based game engine and editor that builds games for the web
and for native Windows — from one codebase, with one scripting language.**

AE1 exists to remove the barrier between having an idea for a game and having a game.
The editor runs in your browser against a tiny local Python server; your project is
plain files on disk; your game logic is **Angel Script** — ordinary JavaScript on
ordinary objects — and **Build & Ship** turns the project into a self-contained web
build, a target-neutral **AE1 Game Package (AGP)**, or a native Windows executable.

> **Alpha.** The core loop is closed and verified (project → author → script → play →
> build), the 3D stack is in daily use, and the native Windows player runs the same
> engine JavaScript unmodified under QuickJS. Expect rough edges, and expect things
> to move. Contributions are welcome at any pace — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What's in the box

- **Editor** (`editor/`) — projects list, a wizard, a Blender-style tiling workspace
  (outliner, viewport, properties, script editor, media collection, console), Play
  mode, undo/redo, continuous journaling. Zero build step: open it and go.
- **Engine** (`engine/`) — the element/scene model, the Angel Script compiler and
  scheduler, HUD + inventory, dialogue, audio buses, save/load, and a **three.js 3D
  stack**: third-person camera (orbit, zoom, fog, occluder fade), characters, NPCs,
  enemies and attack archetypes, projectiles, hitboxes, trigger boxes, ladders,
  lights, skyboxes, particles, instanced scatter, post-FX, a point-and-click
  interaction kit (element graph, right-click option menu, click-to-move), RPG
  stats + HUD, and more — each an opt-in **base element** you `(extends …)` in a
  script.
- **Build & Ship** (`exporter.py`) — single-file web builds with texture diet
  (KTX2) and mesh compression, the AGP package format, and the Windows target.
- **Native Windows player** (`native/`) — a C++ runtime (D3D11 renderer, miniaudio,
  QuickJS host) that consumes an AGP and runs the engine's own JavaScript. The
  browser↔native **translation layer** is documented so the same features map
  across targets: `docs/engine/native-translation-layer.html`.
- **The forges** — generate *original* placeholder assets from English without
  leaving the project: `meshforge.py` (props), `clipforge.py` (mechanical
  animation), `audioforge.py` (speech).
- **Documentation** — a user guide (`docs/guide/`), engine docs for people working on
  AE1 itself (`docs/engine/`), the decision record with the *why* and the mistakes
  that shaped it (`DESIGN.md`), and a cold-start file for fresh sessions — human or
  AI (`respawn.md`). The editor renders all of it in-app (**Docs**).

## Quick start

Requirements: **Python 3.10+** (standard library is enough; `pip install -r
requirements.txt` adds better image recompression at export) and a modern browser.

```powershell
# Windows — resolves Python, makes a venv, starts the server, opens the browser
.\server.ps1
```

```bash
# any platform
python server.py --port 8001
# then open http://localhost:8001/editor/
```

Open the **Starter** project (a minimal original 3D scene) and press **▶ Play**, or click
**New Project**, pick a type (point-and-click adventure or 3D game), and you're in the
workspace. Read `docs/guide/01-getting-started.md` for the ten-minute tour.

### Optional: export-quality tools

Build & Ship works out of the box. For smaller web builds, drop these official
binaries into `tools/` (they are deliberately **not** committed):
- `tools/ktx/` ← [KTX-Software](https://github.com/KhronosGroup/KTX-Software) (`toktx`, `ktx`)
- `tools/meshopt/` ← [meshoptimizer](https://github.com/zeux/meshoptimizer) (`gltfpack`)
- `ffmpeg` on your PATH for audio transcoding.

### Optional: the native Windows player

`native/build.bat` builds the player with MSVC + the Windows SDK and the vendored
sources in `native/third_party/` (QuickJS-ng, meshoptimizer decoder, Basis
transcoder, stb, miniaudio — see `native/third_party/VENDORING.md`). Then Build & Ship
→ **Windows** produces a folder you double-click.

## Built for people *and* AI coding assistants

AE1 is deliberately legible: plain files, one scripting language, opt-in base
elements, exhaustive docs, and a decision record that explains *why*. That makes it
unusually easy to extend with an AI coding chat (Claude, or others): point it at
`respawn.md` and `docs/engine/`, and it can be useful within minutes. The goal is a
shared, hierarchical vocabulary of game features and techniques — and a translation
layer — that lets what you learn in one engine, library, or target carry over to
the next.

## No game assets — on purpose

This repository ships **no game assets** and no content extracted from any
commercial game. Everything here is original engine code and documentation. Bring
your own assets, or generate original ones with the forges. See the asset rule in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
editor/      the browser editor (static files)
engine/      the engine — elements, Angel Script, 3D stack (three.js vendored, MIT)
native/      the Windows player (C++) + vendored permissive libraries
docs/        guide/ (make games) · engine/ (work on AE1) · ROADMAP.md
examples/    reference Angel Scripts for engine features (bring your own media)
projects/    your projects live here — `starter/` is an original minimal 3D scene to begin from
server.py    the local server · exporter.py  Build & Ship · *forge.py  asset generators
DESIGN.md    the decision record · respawn.md  pick AE1 up cold
```

## License

MIT — see [LICENSE](LICENSE). Vendored third-party code keeps its own permissive
licenses (three.js MIT; QuickJS-ng MIT; meshoptimizer MIT; Basis Universal
Apache-2.0; stb and miniaudio public domain).

# AE1 — Angel's Egg 1 · v0.3.0-alpha

**The first release shaped by an outside user.** The first person to try AE1 without being shown how changed the Starter,
broke the player with two keystrokes in the script pane, could not get back, and was told by the guide to do something
that cannot work in a 3D project. This release is the answer, and the engine's version string moves to `0.3.0-alpha`
with it — features, so the minor number moves.

- **Restore default script.** A script that came with a sample project gets **↺ Restore default** in the script pane:
  the text the sample shipped with, back in one click. Script edits are outside the undo history, so this is the way
  back from a cleared or broken script. The shipped copies live in the new read-only `samples/` folder.
- **Save as…** copies the whole project under a new name and continues in the copy; the original is left as it is.
- **Restore sample…** (in the Starter itself) puts a sample back the way it shipped — after listing exactly what would
  be lost (edited scripts, added media by name, scene objects by name) and offering **Save a copy, then restore**.
  Cancel changes nothing.
- **Images in 3D scenes.** Drop an image onto a 3D viewport and it stands up as an **Image Plane**: a flat card on the
  ground where you dropped it, facing the camera, at the picture's own shape, transparent background cut out. Size,
  sides, lighting and picture are editable in Properties.
- **Media preview.** Click a tile in the Media Collection to see it — picture, sound or video — without placing it.
- **Fixed: exported games drew images and particle sheets white.** The shipped game only resolved assets it inlined;
  it now finds images the export ships as files.
- **Fixed: the hosted demo's banner could take the editor's whole height.** Every part of the editor layout is now
  placed by name, so an optional banner can never push the workspace out of the window.
- **The guide** says which drag-and-drop flows belong to 2D and which to 3D projects, documents everything above, and
  adds "Keeping your work on the hosted demo" (private to you, not backed up — use Build & Ship to keep it).
- **Housekeeping.** A scrub of names from the commercial games used while AE1 was being built, throughout the docs,
  comments and example scripts; `CONTRIBUTING.md` gains "Cutting a release" (version change first, tag second);
  `PUBLIC-ONLY.md` lists what exists only in this repository.

---

# AE1 — Angel's Egg 1 · v0.2.1-alpha

**The alpha as hosted at ae1.ausa.dev.** Tag `v0.2.1-alpha` is the release the hosted demo pins. It carries two commits over v0.2.0-alpha:

- **The engine's version string follows the tag line.** `ENGINE_VERSION` is `0.2.0-alpha`, so `/api/status`, the `Server` header and the `engineVersion` stamped into project files agree with the tags. `1.0.0-alpha` was the project's name from its first commit, never a claim that this alpha is a 1.0 candidate; projects already on disk keep their old stamp, and nothing reads it.
- **A hosted-demo banner.** The editor asks `GET /api/hosted` once at boot. A multi-tenant host answers with a notice and the visitor's sandbox usage, and the editor shows one line under the top bar: the notice, then the sandbox's used and total megabytes and the upload limit — usage only, never the sandbox id. A plain local server has no such route and shows nothing.

One deliberate oddity a reader will meet: the tag is `v0.2.1-alpha` while the engine constant inside it reads `0.2.0-alpha`. The constant names the version family; the patch tag names the release. They agree on the family, and that is the agreement the previous entry promised.

---

# AE1 — Angel's Egg 1 · v0.2.0-alpha

**The published head of 2026-10-13.** Tag `v0.2.0-alpha` marks commit `4bb5bd1`: the v0.1.0-alpha release below plus a documentation prose pass, a portable MSVC locator in `native/build.bat`, and this changelog. The engine inside it still announces `1.0.0-alpha`; the version string moves in the commit after the tag (see v0.2.1-alpha above, which the hosted demo pins instead). This tag stays where it is.

---

# AE1 — Angel's Egg 1 · v0.1.0-alpha

**The first public release of AE1: a lightweight, browser-based game engine and editor that builds games for the web and for native Windows — from one codebase, with one scripting language.**

AE1 exists to remove the barrier between having an idea for a game and having a game. The editor runs in your browser against a tiny local Python server; your project is plain files on disk; your game logic is **Angel Script** (ordinary JavaScript on ordinary objects); and **Build & Ship** turns a project into a self-contained web build, a target-neutral **AE1 Game Package (AGP)**, or a native Windows executable. It is deliberately legible — plain files, opt-in base elements, a decision record that explains *why* — so it is unusually easy to extend with an AI coding assistant.

> **Alpha.** The core loop is closed and verified — project → author → script → play → build — but expect rough edges and expect things to move. Contributions at any pace are welcome: see `CONTRIBUTING.md`.

## What's in this release

- **Editor** — projects list, a wizard, a Blender-style tiling workspace (outliner, viewport, properties, script editor, media collection, console), Play mode, undo/redo, continuous journaling. No build step.
- **Engine** — the element/scene model, the Angel Script compiler and scheduler, HUD + inventory, dialogue, audio buses, save/load, and a **three.js 3D stack**: third-person camera (orbit, zoom, fog, occluder fade), characters, NPCs, enemies and attack archetypes, projectiles, hitboxes, trigger boxes, ladders, lights, skyboxes, particles, instanced scatter, post-FX, a point-and-click interaction kit (element graph, right-click option menu, click-to-move, action text), RPG stats + HUD — each an opt-in base element you `(extends …)`.
- **Build & Ship** — single-file web builds with KTX2 texture diet and mesh compression, the AGP package format, and the Windows target.
- **Native Windows player** — a C++ runtime (D3D11, miniaudio, QuickJS host) that consumes an AGP and runs the engine's own JavaScript unmodified. The browser↔native **translation layer** is documented (`docs/engine/native-translation-layer.html`) so features map across targets.
- **The forges** — `meshforge.py`, `clipforge.py`, `audioforge.py`: generate original props, mechanical animation, and speech from English without leaving the project.
- **A Starter project** — a minimal, fully original 3D scene (floor, third-person player body, controller, sun, a spinning crate; every asset generated by meshforge) to press ▶ Play on first.
- **Documentation** — a user guide, engine docs for working on AE1 itself, the decision record (`DESIGN.md`), and a cold-start file for fresh sessions, human or AI (`respawn.md`). All rendered in-app under **Docs**.

**Verified for this tag:** Projects → Docs viewer → Wizard scaffold → Play (zero engine errors) → Build & Ship (single-file web build) → the shipped build boots standalone. Every JavaScript/Python file syntax-checked.

## What is deliberately *not* here

- **No game assets.** This repository ships no content extracted from any commercial game — only original engine code, documentation, and the generated Starter assets. Bring your own assets or generate them with the forges. The asset rule is in `CONTRIBUTING.md`.
- **No motion-matching driver.** The private build's motion matching was built on a non-free clip library and is not included. The base `ThirdPersonCharacter` is the player character here.
- **No encoder binaries.** Build & Ship works out of the box; for smaller builds, drop the official KTX-Software and meshoptimizer binaries into `tools/` (see the README).

## Research & white papers released from this effort

AE1 was built alongside a run of reverse-engineering and graphics research. The parts of that research that are ours to share were distilled into standalone, dependency-light, **asset-free** repositories (MIT), each verified against real engine code. They are published in this GitHub account and announced on X (formerly Twitter):

- **threejs-game-optimization** — https://github.com/iniGlowee/threejs-game-optimization
  Six measured browser three.js performance techniques from a real game engine (KTX2 texture diet, specular-strip material reduction, static-matrix freeze + BVH raycasting, near-plane fade, and more), as a white paper plus three dependency-free snippets.
- **occluder-dither-fade** — https://github.com/iniGlowee/occluder-dither-fade
  Hide geometry between the camera and your subject with a per-fragment Bayer screen-door fade — no transparency sorting. three.js + GLSL.
- **alpha-bleed** — https://github.com/iniGlowee/alpha-bleed
  Dilate opaque colour into transparent texels ("edge padding") so cut-out textures don't fringe or darken under mipmaps and KTX2. Python CLI + dependency-free JS core.
- **gltf-axis-bake** — https://github.com/iniGlowee/gltf-axis-bake
  Bake a model's orientation into the glTF vertex data so it stays upright for loaders that grab a named mesh and drop node transforms, plus a bounds inspector to verify it.
- **gltf-audit** — https://github.com/iniGlowee/gltf-audit
  A static glTF/GLB performance audit: flags heavy materials, uncompressed or oversized textures, missing KTX2/meshopt, cut-outs without alpha-bleed — with a `--strict` CI gate.
- **headless-asset-re** — https://github.com/iniGlowee/headless-asset-re
  A *method*, not a tool: how to reverse-engineer game assets headlessly without the original SDK — find the maintained reference, judge with ground-truth renders, keep IP out of git. No assets.

Earlier community tools from the same pipeline: **nier-mot-extractor** (https://github.com/iniGlowee/nier-mot-extractor) and **nier-enemy-glb-baker** (https://github.com/iniGlowee/nier-enemy-glb-baker) — code-only modding tools; you supply your own legally-owned game files.

Follow new releases at **https://github.com/iniGlowee** and on X: **https://x.com/iniGlowee**

## Getting started

```
git clone https://github.com/iniGlowee/AE1.git
cd AE1
.\server.ps1            # Windows: venv + server + browser
# or:  python server.py --port 8001   → open http://localhost:8001/editor/
```

Open the **Starter** project and press **▶ Play**, or **New Project** to scaffold your own. Read `docs/guide/01-getting-started.md` for the ten-minute tour; `respawn.md` if you (or your AI assistant) are picking AE1 up cold.

## Known rough edges

- Prose in `DESIGN.md` / `respawn.md` was generalized away from the private build's specific assets; a few sentences read awkwardly and some history sections describe systems not in this build.
- The native Windows player is built from `native/build.bat` (MSVC + Windows SDK, vendored permissive libs); confirm it on your machine — it was not rebuilt from this tree for the tag.
- `RSStats` / `GameHUD` ship with RPG-flavoured defaults (a 23-skill list and a public XP curve); generalize to taste.

## Thanks

To everyone who reads the decision record before changing anything. The goal is a shared, hierarchical vocabulary of game features and techniques — and a translation layer between targets — so what you learn in one engine carries to the next.

*Tag `v0.1.0-alpha` = commit `05bdea5`. License: MIT.*

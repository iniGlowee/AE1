# 1. Architecture

## Topology

```
server.ps1          resolves Python (via the `py` launcher — NOT bare `python`,
                    which is a Store stub on Windows), bootstraps .venv,
                    starts server.py, opens Brave incognito

server.py           stdlib http.server. Owns every read and write.
                    REST over /projects, /exports, /settings.
exporter.py         build & ship. Imported by server.py.

browser             thin, disposable client.
  /engine           SHARED — editor and shipped game both run this
  /editor           editor only
```

## The load-bearing split

> **`/engine` is shared. `/editor` is not.**

The exported game runs the *same* element class, scene, AGS compiler, scheduler, loop,
renderer, world, and media cache as the editor. Not a copy — the same files.

This is [Principle 2](03-principles.md), and it's the most important structural fact about
AE1. If the editor had its own idea of what an element is, or its own renderer, or its own
scene switching, then "works in the editor, breaks in the export" becomes possible — the worst
failure mode a game engine can have, because it's discovered by *players*.

**What belongs in `/engine`:** anything a shipped game does.
**What belongs in `/editor`:** selection, undo, journaling, panes, the wizard. A shipped game
has none of these, and `/engine` must not carry weight the runtime never uses.

When in doubt, ask: *does a player's browser need this?*

## Data flow

```
disk ──► server.py ──► api.js ──► scene-store.js ──► editors
                                        │
                                        └─ AE1World / GameLoop  (play mode)
```

**The store is a star, not a graph.** Editors read from it and subscribe to it; they never
talk to each other. Six panes that all know about each other is a graph, and only the star
still makes sense when the seventh pane arrives.

Events: `scene` · `selection` · `element` · `dirty` · `diagnostics` · `log` · `scripts` ·
`play` · `media` · `scenes` · `history`.

## The engine's object model

```
AE1World ─── hud:   AE1Scene ─── AE1HudElement / AE1Inventory   (persistent)
         ├── scene: AE1Scene ─── AE1Element                     (swappable)
         ├── audio: AE1Audio
         └── loop:  GameLoop
```

`AE1World` owns everything that outlives a scene. Scene changes happen there, and *only*
there — implementing them twice would put "the door works in the editor but not the build" one
refactor away.

`GameLoop` takes a **scene or a world**, normalising through `orderedElements()`. So the loop
doesn't care which it got, and the editor could drive a bare scene while the game drives a
whole world with no second loop.

## Rendering

`renderer.js` draws an **ordered element list** in scene space. The caller owns the camera:

- The editor applies pan/zoom, and adds grid, frame, and selection chrome.
- The game applies a letterboxed fit-to-window, and adds nothing.

Keeping `draw` *out* of `GameLoop` is what lets one loop serve both.

Order is composed by the world: scene elements by layer, then HUD by layer — HUD
unconditionally on top.

**The 3D side** (`game-3d` projects, DESIGN.md §18): `three3d/render3d.js` is the shared 3D
renderer — the editor viewport (`viewport3d.js`) calls it and the shipped game (`game3d.js`)
wraps it with the loop, same Principle 2 shape. Elements carry `model`/`light`/`mount`/`debug`
components; the renderer binds them to glTF objects through a **load-time nodeMap** (never a
live scene search — mounts reparent objects). Geometry questions flow the other way through
`world.env3d` (`groundAt`, `boundsOf`) and input through `world.input3d` — so the pure-math
engine classes (thirdperson, hitbox, npc) never import three.js and ship in the classic bundle.

## Storage

| Layer | Holds | Lost on close? |
|---|---|---|
| Filesystem | Everything real. Plus `settings.json` (layout, theme). | No |
| localStorage | Throwaway session state (last-opened project). | Yes, harmless |
| Browser HTTP cache | Media, `immutable` — the filename *is* the hash. | Doesn't matter |
| JS heap | Active scene + referenced media only. | By design |

**Incognito is a feature.** It wipes localStorage on close, which makes it structurally
impossible to build something that depends on the browser durably holding state.

*But layout went to the server*, because a layout you spent time arranging is **work**, not a
preference. Rule of thumb: **if the user would be annoyed to redo it, it goes to the server.**

There's no IndexedDB layer. AE1 serves from localhost and content-addressed files are
`immutable`, so the browser's HTTP cache already *is* that layer. Another would be a cache in
front of a cache.

## Persistence

**Continuous journaling.** `beforeunload` cannot await a fetch, so save-on-close isn't
implementable. Instead every edit lands within ~350ms and disk is never meaningfully stale.

Invariants that took bugs to learn:

- **Writes are atomic** (temp file + rename). A crash mid-write would corrupt exactly the work
  the journal exists to protect.
- **Saves never overlap.** Two in flight can land out of order and write an older state last.
- **The journal is silent during play.** One guard makes Play a rehearsal instead of an edit.
- **The unload beacon saves the pre-play snapshot**, never live game state.

## Angel Script pipeline

```
.ags.txt
   │  reader.js      s-expressions; stops at the first non-'(' token
   │  compiler.js    scan top-level functions → emit `class extends __Base`
   │  runtime.js     resolve chain, merge dat + runInfo, build scheduler tables
   ▼
compiled class ──► rehydrate ──► the element BECOMES a Door
```

The compiler emits a **real class body**, because only class methods get a `[[HomeObject]]` —
which is what makes `super` work. That one decision buys the entire inheritance story from the
language instead of from engine machinery.

`compileAll()` compiles every script together, because `extends` can name any of them and a
chain can't be resolved one file at a time.

## Export

The double-click requirement drives everything: `file://` blocks `fetch` and ES modules, so
the export inlines everything into `index.html`.

**2D**: `bundle_engine()` concatenates `/engine` into one classic script. It is a concatenator
**for a known input** — it works only because AE1 owns every module and keeps them to
single-line named imports. It refuses on a name collision rather than shipping a silent shadow.
Never point it at third-party code. `ENGINE_MODULES` in `exporter.py` is the dependency order,
hand-maintained, because it *is* the dependency graph and a sort would hide it.

**3D**: three.js is real third-party ESM and cannot be concatenated, so `bundle_modules_3d()`
walks the import graph from `game3d.js`, topo-sorts it, and inlines every module's SOURCE; the
page rebuilds the graph as `blob:` URLs at boot (`file://` runs inline modules and imports
blobs, it just can't fetch module files). glbs inline as base64 → Blob URLs, decoded lazily
through the browser's native path; `animOnly` libraries are **stripped to node graph + clips**
(`strip_glb_to_clips`) — V8 caps a string near 1 GiB and a build past it dies before boot.
DESIGN.md §18.8, §18.10.

## Why no framework

No React, no bundler, no dependencies in the browser — with ONE deliberate exception:
**three.js, vendored** (`engine/vendor/three/`, pinned 0.180.0, MIT, resolved through an import
map, never a CDN). It is the entire 3D renderer and rewriting it would be the project; vendoring
keeps the no-expiry-date property — the files are ours, no registry or network can break them.

The cost is `h()` in `ui.js` and some manual repainting. The benefit is that this codebase has
no expiry date.

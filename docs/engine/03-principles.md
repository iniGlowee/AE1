# 3. Principles

Five rules. They're tiebreakers — when a decision is close, the higher one wins.

A principle is only useful if it **forbids** something. Each of these does.

---

## 1. The filesystem is the only source of truth

The browser is a disposable view.

**Forbids:** any feature that depends on the browser durably holding state. AE1 runs in
incognito, so it *can't* — which makes the memory model correct by construction rather than by
discipline.

**But:** "the browser holds nothing you'd miss" is about *data*, not about *work*. Panel layout
went to the server precisely because losing it every launch would be losing work. The
principle was right; the filing was wrong.

> **Rule of thumb: if the user would be annoyed to redo it, it goes to the server.**

---

## 2. One code path

The editor and the exported game run the same engine, the same AGS compiler, the same scene
loader, the same renderer, the same loop.

**Forbids:** a second implementation of anything a shipped game does. No "editor version" of
the renderer. No "editor version" of scene switching. No "editor version" of rehydration.

**Why it's first among equals:** "works in the editor, breaks in the export" is the worst
failure a game engine can have, because it's discovered by *players*, after shipping, in code
the author can't see. Structural impossibility beats testing.

This principle has already been *enforced* twice retroactively — the viewport was drawing
elements itself, and rehydration lived in the editor. Both were extracted the moment export
made the risk real.

**The test:** *does a player's browser need this?* If yes, `/engine`. If no, `/editor`.

---

## 3. The export is readable

Mods and authorship use the same surface. Structured JS, JSON scenes, loose `.ags.txt`.

**Forbids:** minification, name mangling, compiling AGS away at export, wrapping the bundle in
an IIFE.

**The surprise:** this made the architecture *simpler*, not more complex. Shipping the compiler
inside the runtime removed the export-time compile path entirely — one compiler, one code
path. A throwaway line about modding turned out to be load-bearing.

Gzip on the host recovers most of what minification would have. It's the host's job anyway.

---

## 4. Simple to the novice, unbounded to the expert

Every feature has an obvious default and a scriptable escape hatch.

**Forbids:** features that can only be used one way.

- The inventory works out of the box **and** `draw()` lets you replace every pixel of it.
- `+ Element` gives you a working script template **and** it's just text you can rewrite.
- Media has a drag-and-drop path **and** a `playSound("name.mp3")` path.

**The corollary:** when something is hard for an expert, that's a bug, not a boundary.

---

## 5. Built to last

Prefer stdlib and vendored dependencies over anything that rots. No CDN, ever.

**Forbids:** framework dependencies in the browser, load-bearing pip packages, anything with a
major version that can break you.

- The editor is dependency-free — with ONE deliberate exception: **three.js, vendored**
  (`engine/vendor/three/`, pinned 0.180.0, import-map resolved). The files are ours; no
  registry, network, or release can break them. It is the entire 3D renderer — the one thing
  not worth rewriting.
- Pillow is optional: a missing dependency changes the **size** of a build, never its
  correctness, and never blocks one.
- AGS compiles to plain JS classes rather than being interpreted — ~300 lines instead of an
  interpreter, and still correct in ten years.

---

## Applying them

When these conflict, the lower number wins. In practice they rarely do, because they're
mostly the same instinct: **put the truth in one place, and make the wrong thing impossible
rather than merely discouraged.**

Two habits that follow from all five:

**Say what you dropped.** Pruned assets, skipped optimizations, capped results — silence reads
as "everything was included." The build logs what it pruned, by name.

**An honest indicator beats a reassuring one.** "Saved" must mean saved. During play the
indicator says *Not saving*, because the alternative is lying at exactly the moment it matters.

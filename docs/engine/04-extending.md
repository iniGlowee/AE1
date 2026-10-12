# 4. Extending AE1

Most extensions are one line, because the machinery reads declarations. That's deliberate —
see [Principles](03-principles.md).

---

## Add a property to every element

**One line**, in `ELEMENT_SCHEMA` (`engine/element.js`):

```js
anchor: { group: 'Transform', label: 'Anchor', type: 'enum',
          options: ['topLeft', 'center'], default: 'topLeft' },
```

That generates the accessor, `getAnchor()`/`setAnchor()`, **the Properties panel row**,
the default, and serialization. Nothing else learns about it.

| `type` | Control |
|---|---|
| `string` | text |
| `number` | number (`step`, `min`, `max`) |
| `bool` | checkbox |
| `enum` | select (`options`) |
| `tags` | comma-separated list |

> **Watch defaults.** `name` defaults to `''` because a truthy default silently shadows the
> generated fallback name. If a property has constructor logic, make sure the default doesn't
> beat it.

New group? Add it to `SCHEMA_GROUPS` for panel ordering.

---

## Add a built-in base class

Scripts can `(extends YourThing)`.

1. Write the class in `/engine`, extending `AE1Element` (or `AE1HudElement`).
2. Register it in `BUILTINS` (`engine/ags/runtime.js`):

```js
export const BUILTINS = {
  Element: AE1Element,
  HudElement: AE1HudElement,
  Inventory: AE1Inventory,
  DialogueTree: AE1DialogueTree,   // ← yours
};
```

3. Add its module to `ENGINE_MODULES` in `exporter.py`, **in dependency order**.

That's it — chain resolution, dat merging, and rehydration already handle it. This is how the
whole HUD layer was added without new machinery — and later `Model`, `Controller`,
`ThirdPersonCamera`, `ThirdPersonCharacter`, `Hitbox`, and `NPC` (the whole 3D cast).

Three lessons those additions paid for:

- **A hand-built built-in's `agsDef.runInfo` does NOT merge up the chain** the way compiled
  defs do — repeat the ancestors' hooks you need (`AE1ThirdPersonCharacter` lists Model's
  `_modelBegin` explicitly, or the idle silently never plays).
- **The 2D bundle concatenates into ONE scope** — a top-level `const DEG` in two engine files
  is a build-refusing collision (by design). Prefix or rename.
- **A dat key must never shadow a base schema field or a `getX`/`setX` pair** (a `height` dat
  key reads the BASE height, a custom getter blocks the generated setter). See lessons.

Give a 3D built-in geometry through `world.env3d` (injected by the renderer hosts), never by
importing three.js — pure-math classes ship in the classic bundle.

---

## Add a `runInfo` mode

1. Add it to `RUN_INFO` (`engine/ags/compiler.js`).
2. Dispatch it from `GameLoop` (or wherever it fires).

```js
export const RUN_INFO = {
  …,
  onEnterRegion: 'input',
};
```

`buildSchedule` builds a table for every key in `RUN_INFO` automatically.

---

## Add an editor pane

An editor is `{ label, mount(el, context) -> dispose? }`. That's the entire contract.

```js
// editor/js/workspace/editors.js
function mountTimeline(el, context) {
  const list = h('div', { class: 'timeline' });
  el.append(list);

  const offs = [store.on('scene', paint), store.on('selection', paint)];
  function paint() { /* … */ }
  paint();

  return () => offs.forEach((off) => off());   // MANDATORY if you subscribe
}

export const EDITORS = {
  …,
  timeline: { label: 'Timeline', mount: mountTimeline },
};
```

The area system never learns its name. It's immediately available in every pane's dropdown.

> **Return a disposer** for anything holding a subscription, a `ResizeObserver`, a rAF loop,
> or a listener. The pane calls it on teardown. Leaks here outlive the pane.

**Read from the store; never from another pane.**

To put it in the default layout, edit `editor/js/workspace/layouts.js`.

---

## Add an API route

```python
@route("GET", r"/api/projects/([\w-]+)/thing")
def api_thing(_body, slug):
    return {"thing": …}

@route("POST", r"/api/projects/([\w-]+)/thing", raw=True)
def api_thing_upload(req, slug):
    req.data      # bytes
    req.headers   # for X-Filename etc.
```

Regex groups become handler arguments. `raw=True` gives you a `RawBody` instead of parsed
JSON.

Then add a method to `editor/js/api.js` — **the single doorway to the server.** A view that
`fetch`es directly is the architecture breaking.

**If `sendBeacon` needs to hit it, accept POST too** — beacons can only POST, and that's the
unload backstop.

---

## Add a project type

1. Register it in `PROJECT_TYPES` (`server.py`) with `available: true`.
2. Add a default layout in `editor/js/workspace/layouts.js`.
3. Scaffold whatever it needs in `scaffold_project()`.

The wizard is a registry — it needs no changes.

---

## Add a wizard step

Steps are **data**, in `STEPS` (`editor/js/views/wizard.js`):

```js
{
  id: 'resolution',
  label: 'Display',
  render(state, ctx) { return h('div', {}, …); },
  valid: (state) => Boolean(state.width),
}
```

The shell handles navigation, validation, and the footer. It doesn't know what your step
contains.

---

## Add a media kind

`KINDS` in `server.py`. Then teach `renderer.js` (or a new pane) to do something with it.

---

## Style

**Every colour, size, and duration is in `editor/css/theme.css`.** A hardcoded hex anywhere
else is a bug — theming and any future light mode both depend on that staying true.

---

## Before you commit

**Drive it.** Not the tests — the actual app.

Every significant bug in AE1's history was found by *using* it, and several were invisible to
inspection:

- A pane's Close button silently doing nothing (the exception was swallowed by event dispatch,
  so the console was *clean*).
- Elements all named "Element" (a truthy default shadowing the generator).
- A selection outline that existed but was painted over.
- Clicking a character doing nothing (runInfo didn't inherit — compile was clean).

The failure mode to fear isn't a crash. It's **silence**. Load the page, click the thing, watch
what happens.

`docs/engine/05-lessons.md` is the list of what silence has cost so far.

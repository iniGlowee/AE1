# 17 — The Debug Menu (§18.56)

The reference-game-style debug flag wall. Hold **SELECT+START** on a pad — or hit
**` / ~** on the keyboard — and the game freezes at that exact frame; a
wall of white monospace flags drops over it. **WASD / d-pad** walks the
wall, **SPACE / A** toggles the flag under the cursor, and the same combo
that opened it closes it — flags apply the instant the loop resumes.

## The element: `DebugMenu`

`engine/debugmenu.js`, builtin `DebugMenu`:

```
<?dat
(openKeys "Backquote")
(flags "POD_TRAILS MENU_PROTO")   ; project flags — inert but queryable
?>
<?def
(extends DebugMenu)
(name "DebugWall")
ags?>
```

One element per scene. It is wired into flight1, pod1, and tower1.

## The freeze is a HARD pause

Two halves, both new engine surface:

- `loop.paused` — onTick dispatch stops **entirely** (not dt=0 ticks; a
  held key cannot queue an action through the freeze). `onFrame` still
  runs, so the frozen frame keeps presenting and input edges keep
  clearing — nothing leaks into the resume frame.
- `env3d.setPaused(on)` — the renderer's own clocks stop: mixers,
  per-instance timelines, procedural motion, particles. The clock delta
  is still consumed per frame so resume never sees a dt spike.

While paused the menu runs on its **own** rAF and listeners (the paused
loop cannot tick it), polling the gamepad directly. Open/close arming
requires the combo to fully release between uses.

## Wired flags

| flag | effect |
| --- | --- |
| `AI_FREEZE` | enemy ticks halt (guard at the top of `_enemyTick`) |
| `INVINCIBLE` | player `takeDamage` becomes a no-op (patched once; the wrapper reads the live flag) |
| `NOCLIP` | free-fly: camera-relative WASD/stick, SPACE up, CTRL down, SHIFT 3× — no gravity, no collision; the body rides `mm.teleport` with a neutral matcher update, and the §18.30 external-moves mirror is kept honest |
| `SLOW_MO` | `loop.timeScale = 0.3` |
| `FX_OFF` | the whole shader stack off (`env3d.setPostFxOff`) — no DOF, grain, vignette, CA, bloom, renderScale; the plain render path, for perf isolation while debugging |
| `LOD_FAR` | force the decimated map — §18.53's flight LOD |
| `WIREFRAME` | every material's wireframe bit |
| `SHOW_FPS` | live frame meter overlay (persists after the menu closes) |
| `POD_HIDE` | follower pod hidden |
| `POD_NO_CD` | pod special cooldown zeroed every tick |

## Project flags

Names in the `flags` dat join the wall but the engine ignores them — any
script branches on `this.world.debugFlag("NAME")`. The cheap way to gate
an experiment behind the wall before it earns real dats.

Script events: `onDebugOpen` (the frame froze), `onDebugClose` (flags
applied, loop resumed).

## A verification trap worth knowing

Chrome throttles `requestAnimationFrame` to ~1 Hz when the window is
occluded — even while `document.visibilityState` still says `visible`.
A synthetic 120 ms key press then falls between 1 Hz ticks and "nothing
happens". The menu itself is immune (its input is event-driven), but the
open-combo detection rides the loop: when testing through automation on
a covered window, hold the key across a full second.

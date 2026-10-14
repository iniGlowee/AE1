# 18 — Dialogue, possession, and NPCs (§18.79–§18.83)

> † The motion-matching system (its core, driver, and character) is described here as history. It is not part of the public build — it depended on a non-free clip library — and references to it are kept because the techniques and lessons still apply.

The bunker-level era (Aug 30–31) gave the engine its character layer: talkable
NPCs, a playable cast you can swap between, and native animation packs for
characters that are not the player character. Everything here ships in `projects/devroom`.

## Live material access — `env3d.materialsOf` (§18.79)

`world.env3d.materialsOf(elementOrName)` returns the live three.js materials
of an element's bound object; `objectFor` returns the Object3D. This is the
door every scripted material effect walks through (screen glows, hair tweaks,
debug tinting). Materials are shared per-glb: what you change on one element
shows on every element wearing the same media.

## Dialogue v1 (§18.81) — `dialogue.ags.txt`

- **`world.uiLock`** (engine, the motion-matching driver †): while truthy the
  player updates on neutral input — idles in place, no locomotion, interact,
  or combat. The same pattern the piloting and death branches use.
- **The DialogueUI element renders a DOM overlay.** 3D projects have no 2D
  HUD canvas; DOM is the pattern (the debug wall and console set the
  precedent). Speaker header from the NPC's `(displayName)` dat, line text,
  FF-style options with a white ▸ cursor. Nav: arrows/WASD/dpad; confirm:
  E/Enter/Space/pad-A.
- **Trees are plain JS objects** — `{start: {text, options: [{label, next,
  event, action}]}}` — passed from the NPC's own `onInteract`. An option
  without `next` closes; closing carries a **two-tick unlock tail** so the
  confirming E cannot re-open through the player.
- **Custom events route through `onCall(name, from)`** — runInfo events are
  whitelisted, so dialogue `event:` strings dispatch onCall and the handler
  switches on the name (see player.ags.txt's `lucky` TAKES table).
- The font: Austin's PS2 Helvetica ships as project media
  (`ps2_helvetica.ttf`, kind "other"); DialogueUI registers the FontFace at
  boot.

## Possession and autopilot (§18.82)

`(autopilot true)` on a motion-matching character † turns it into a simple wander
NPC: synthetic `{wx,wz,amount}` intent fed into the same `mm.update`, with
both-ways `blocked()` vetting so it never paths somewhere it can't return
from. The rules that make swapping work:

- The ThirdPersonCamera's `_target()` prefers the character **not** on
  autopilot; parked bodies are scenery.
- E reaches parked characters by radius; a dialogue option with
  `(action "possess")` swaps which body is player-controlled.
- **Pivot assist** (`(pivotAssist true)`): a pack with no standing-turn
  clips cannot rotate at rest — the dat eases driver yaw directly during a
  stationary large heading error. Foot slide is the accepted cost.
- Scripted long clips (dialogue performances): set `_mmAction='attack'`,
  `_mmActionT=-100000` to park the 6-second combat timeout, and note both
  the uiLock AND autopilot branches carry an `_mmAction` guard so the
  matcher's neutral update never fights the mixer mid-clip.

## The native the companion character pipeline (§18.83)

Retargeting the player character's motion onto the companion character was rejected (her stances on his body). The
doctrine is **rename, never retarget**:

1. His own <asset> mots (483 of them) are triaged in the motion-matching curator
   (`serve.py` port 8010, `?src=npc`).
2. The **Native bake** button → `/convert?src=npc` → `bake_npc_native.py`: no
   retarget; the bake synthesizes a canonical root (smoothed hip ground path
   + yaw-only quat built explicitly about Z — `rotation_difference`
   degenerates at yaw π), stores pelvis sway as root-frame residuals, and
   de-yaws the hips basis (else turns double).
3. The runtime hardcodes canonical role names, so the pack AND the runtime
   body (`npc_native.glb`, a pure node-name patch) wear canonical labels on
   his untouched native skeleton.
4. Packs auto-push into project media as `<pack>_*`.

**THE CANONICAL COMPASS IS BACKWARD** — measured on the original locomotion
database: runs travel vz NEGATIVE and L-named dashes are +x. Pack-forward is
the character's BACK. Every new bake must use the +Y (back-facing) yaw
reference or all left/right clips mirror in game ("the sticks are switched").

Pack hygiene learned on his idle pool: transitions get their own set (labeled
transitions in the Idle set make the matcher twitch at rest), and the pool
needs one LONG idle cycle. The reference action game pl characters have **no standing-turn mots**
(the game steers in engine) — clips that score like turns are knockdowns;
check the thumbnails, then use pivotAssist instead.

## The RingStabilizer (§18.80)

Bunker-specific but doctrinally important: gravity direction can be a
script's opinion. The stabilizer kept characters on a rotating ring corridor
by quaternion-slerping an up-vector per rider, with a possession-aware rider
list, an `armDelay` so boarding doesn't snap, and yaw bleed so the world spin
doesn't accumulate into the camera. If a future map needs local gravity,
start from its pattern (it is preserved in the chronicle and bunker-level's
excavation record).

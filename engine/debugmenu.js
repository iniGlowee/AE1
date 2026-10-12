/**
 * AE1 — DebugMenu (§18.56): the the reference action game-style debug flag wall.
 *
 * Hold SELECT+START on a pad — or hit ` / ~ on the keyboard — and the game
 * freezes AT THAT FRAME: the loop stops dispatching ticks (a hard pause,
 * not dt=0 — held keys cannot queue actions through the freeze), the
 * renderer's clocks stop (mixers, particles, procedural motion), and a
 * wall of white monospace flags drops over the frozen frame. WASD or the
 * d-pad walks the wall; SPACE or the A button toggles the flag under the
 * cursor; the same combo that opened it closes it — flags apply the
 * instant the loop starts again.
 *
 * Two kinds of flags share the wall:
 *
 *  - WIRED flags the engine acts on: AI_FREEZE (enemy ticks halt),
 *    INVINCIBLE (the player's takeDamage is a no-op), SLOW_MO (timeScale
 *    0.3), LOD_FAR (the whole map drops to its decimated twins — §18.53's
 *    flight LOD, forced), WIREFRAME (every material's wireframe bit),
 *    SHOW_FPS (a live frame meter that stays after closing), POD_HIDE and
 *    POD_NO_CD (the follower pod vanishes / special cooldown off).
 *  - PROJECT flags from the `flags` dat (space-separated names): inert to
 *    the engine, but any script can branch on `this.world.debugFlag("X")`
 *    — the cheap way to gate experiments behind the wall.
 *
 * The menu runs on its OWN rAF + listeners while the world is paused (the
 * paused loop cannot tick it), polling the gamepad directly. Open/close
 * arming requires the combo to fully release between uses, so holding
 * SELECT+START never machine-guns the menu.
 */

import { AE1Element, defineDatAccessors } from './element.js';

const WIRED = [
  ['AI_FREEZE', 'enemy ticks halt'],
  ['INVINCIBLE', 'player takes no damage'],
  ['NOCLIP', 'free-fly, no collision/gravity'],
  ['FIRST_PERSON', 'camera at the active character\'s eyes'],
  ['SLOW_MO', 'timeScale 0.3'],
  ['FX_OFF', 'shader stack disabled'],
  ['LOD_FAR', 'force decimated map'],
  ['WIREFRAME', 'wireframe materials'],
  ['SHOW_FPS', 'frame meter overlay'],
  ['POD_HIDE', 'follower pod hidden'],
  ['POD_NO_CD', 'pod special cooldown off'],
];

export class AE1DebugMenu extends AE1Element {
  _dbgOpen = false;
  _dbgArm = true; // combo must fully release between open/close
  _dbgCursor = 0;
  _dbgDom = null;
  _dbgRaf = 0;
  _dbgPad = {}; // per-button previous state + repeat clocks
  _dbgKeys = null;
  _dbgFps = null;

  /* -- lifecycle ----------------------------------------------------------- */

  _dbgLoad() {
    const w = this.world;
    if (!w) return;
    w.debugFlags = w.debugFlags ?? {};
    w.debugFlag = (n) => !!w.debugFlags?.[String(n)];
  }

  _dbgNames() {
    const extra = String(this.flags || '').split(/\s+/).filter(Boolean);
    return [...WIRED.map(([n]) => n), ...extra];
  }

  /* -- open/close combo, during play --------------------------------------- */

  _dbgTick() {
    const input = this.world?.input3d;
    if (!input || this._dbgOpen) return;
    const combo = input.down?.(String(this.openKeys || 'Backquote'))
      || (input.down?.('PadSelect') && input.down?.('PadStart'));
    if (combo && this._dbgArm) {
      this._dbgArm = false;
      this._dbgShow();
    } else if (!combo) {
      this._dbgArm = true;
    }
  }

  _dbgShow() {
    const w = this.world;
    if (!w?.loop) return;
    this._dbgOpen = true;
    w.loop.paused = true;
    w.env3d?.setPaused?.(true);
    this._dbgBuildDom();
    this._dbgKeys = (e) => {
      // the game's input listeners still hear these; the paused loop clears
      // their edges every frame, so nothing leaks into the resume
      const c = e.code;
      if (c === 'KeyW' || c === 'ArrowUp') this._dbgMove(0, -1);
      else if (c === 'KeyS' || c === 'ArrowDown') this._dbgMove(0, 1);
      else if (c === 'KeyA' || c === 'ArrowLeft') this._dbgMove(-1, 0);
      else if (c === 'KeyD' || c === 'ArrowRight') this._dbgMove(1, 0);
      else if (c === 'Space' && !e.repeat) this._dbgToggle();
      else if (c === String(this.openKeys || 'Backquote') && !e.repeat && this._dbgArm) this._dbgHide();
      if (!e.repeat && c !== String(this.openKeys || 'Backquote')) this._dbgArm = true;
      e.preventDefault();
    };
    window.addEventListener('keydown', this._dbgKeys, true);
    this._dbgPad = {};
    const menuTick = () => {
      if (!this._dbgOpen) return;
      this._dbgPadPoll();
      this._dbgRaf = requestAnimationFrame(menuTick);
    };
    this._dbgRaf = requestAnimationFrame(menuTick);
    w.loop.dispatchTo?.(this, 'onDebugOpen');
  }

  _dbgHide() {
    const w = this.world;
    this._dbgOpen = false;
    this._dbgArm = false; // the closing press must release before reopening
    cancelAnimationFrame(this._dbgRaf);
    window.removeEventListener('keydown', this._dbgKeys, true);
    this._dbgKeys = null;
    this._dbgDom?.remove();
    this._dbgDom = null;
    this._dbgApply();
    if (w?.loop) w.loop.paused = false;
    w?.env3d?.setPaused?.(false);
    w?.loop?.dispatchTo?.(this, 'onDebugClose');
  }

  /* -- gamepad polling while paused (the loop cannot do it for us) --------- */

  _dbgPadPoll() {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) return;
    const now = performance.now();
    const b = (i) => !!gp.buttons[i]?.pressed;
    // dpad 12/13/14/15 = up/down/left/right with hold-repeat
    const nav = [[12, 0, -1], [13, 0, 1], [14, -1, 0], [15, 1, 0]];
    for (const [i, dx, dy] of nav) {
      const st = this._dbgPad[i] ?? (this._dbgPad[i] = { down: false, next: 0 });
      if (b(i)) {
        if (!st.down || now >= st.next) {
          this._dbgMove(dx, dy);
          st.next = now + (st.down ? 120 : 350);
        }
        st.down = true;
      } else st.down = false;
    }
    // A toggles — edge only
    const a = this._dbgPad[0] ?? (this._dbgPad[0] = { down: false });
    if (b(0) && !a.down) this._dbgToggle();
    a.down = b(0);
    // SELECT+START closes, armed only after both released once
    const both = b(8) && b(9);
    if (!b(8) && !b(9)) this._dbgArm = true;
    if (both && this._dbgArm) this._dbgHide();
  }

  /* -- the wall ------------------------------------------------------------- */

  _dbgBuildDom() {
    const names = this._dbgNames();
    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.82);' +
      'font-family:Consolas,Menlo,monospace;color:#fff;user-select:none;' +
      'display:flex;flex-direction:column;align-items:center;padding-top:6vh;';
    const title = document.createElement('div');
    title.textContent = '==== DEBUG MENU ====';
    title.style.cssText = 'font-size:18px;letter-spacing:4px;margin-bottom:6px;';
    const hint = document.createElement('div');
    hint.textContent = 'WASD/DPAD move · SPACE/A toggle · ~ / SELECT+START resume';
    hint.style.cssText = 'font-size:11px;color:#9aa;margin-bottom:22px;letter-spacing:1px;';
    const grid = document.createElement('div');
    const cols = Math.min(3, Math.max(1, Math.ceil(names.length / 10)));
    grid.style.cssText =
      `display:grid;grid-auto-flow:column;grid-template-rows:repeat(${Math.ceil(names.length / cols)},auto);` +
      'gap:2px 48px;font-size:14px;line-height:1.7;';
    root.append(title, hint, grid);
    this._dbgRows = names.map((n) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:0 10px;white-space:pre;';
      grid.appendChild(row);
      return { name: n, el: row };
    });
    document.body.appendChild(root);
    this._dbgDom = root;
    this._dbgCursor = Math.min(this._dbgCursor, names.length - 1);
    this._dbgPaint();
  }

  _dbgPaint() {
    const flags = this.world?.debugFlags ?? {};
    this._dbgRows?.forEach((r, i) => {
      const on = !!flags[r.name];
      r.el.textContent = `${r.name.padEnd(16)} ${on ? '[ ON  ]' : '[ OFF ]'}`;
      r.el.style.background = i === this._dbgCursor ? '#fff' : 'transparent';
      r.el.style.color = i === this._dbgCursor ? '#000' : (on ? '#fff' : '#889');
    });
  }

  _dbgMove(dx, dy) {
    const n = this._dbgRows?.length ?? 0;
    if (!n) return;
    const rows = Math.ceil(n / Math.min(3, Math.max(1, Math.ceil(n / 10))));
    let c = this._dbgCursor + dy + dx * rows;
    c = Math.max(0, Math.min(n - 1, c));
    this._dbgCursor = c;
    this._dbgPaint();
  }

  _dbgToggle() {
    const r = this._dbgRows?.[this._dbgCursor];
    if (!r) return;
    const w = this.world;
    w.debugFlags[r.name] = !w.debugFlags[r.name];
    this._dbgPaint();
  }

  /* -- wiring the flags into the engine on resume --------------------------- */

  _dbgApply() {
    const w = this.world;
    const f = w?.debugFlags ?? {};
    if (!w) return;
    if (w.loop) w.loop.timeScale = f.SLOW_MO ? 0.3 : 1;
    w.env3d?.setLodFar?.(!!f.LOD_FAR);
    w.env3d?.setPostFxOff?.(!!f.FX_OFF); // the plain render path — no DOF/grain/bloom
    // NOCLIP is read live by the character tick (the motion-matching driver (not in the public build))
    // INVINCIBLE: patch the player's takeDamage ONCE; the wrapper reads the
    // live flag, so later toggles are free
    const p = w.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (p && typeof p.takeDamage === 'function' && !p._dbgGuarded) {
      const orig = p.takeDamage.bind(p);
      p.takeDamage = (amt, src) => (w.debugFlags?.INVINCIBLE ? undefined : orig(amt, src));
      p._dbgGuarded = true;
    }
    // WIREFRAME: walk up from any bound element to the three scene root
    const anyBound = w.scene?.all().find((e) => w.env3d?.objectFor?.(e));
    let root = anyBound ? w.env3d.objectFor(anyBound) : null;
    while (root?.parent) root = root.parent;
    root?.traverse?.((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.wireframe = !!f.WIREFRAME;
    });
    // SHOW_FPS: a live meter on its own rAF — survives the menu closing
    if (f.SHOW_FPS && !this._dbgFps) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;top:8px;right:12px;z-index:99998;color:#fff;' +
        'font-family:Consolas,Menlo,monospace;font-size:13px;' +
        'background:rgba(0,0,0,.55);padding:2px 8px;';
      document.body.appendChild(el);
      const st = { el, frames: 0, t: performance.now(), raf: 0 };
      const meter = () => {
        st.frames++;
        const now = performance.now();
        if (now - st.t >= 500) {
          el.textContent = `${Math.round((st.frames * 1000) / (now - st.t))} FPS`;
          st.frames = 0;
          st.t = now;
        }
        st.raf = requestAnimationFrame(meter);
      };
      st.raf = requestAnimationFrame(meter);
      this._dbgFps = st;
    } else if (!f.SHOW_FPS && this._dbgFps) {
      cancelAnimationFrame(this._dbgFps.raf);
      this._dbgFps.el.remove();
      this._dbgFps = null;
    }
    // AI_FREEZE / POD_HIDE / POD_NO_CD are read live by their own ticks
  }
}

AE1DebugMenu.agsDef = {
  name: 'DebugMenu',
  extends: null,
  runInfo: { _dbgTick: ['onTick'], _dbgLoad: ['onLoad'] },
};

AE1DebugMenu.agsDat = {
  openKeys: 'Backquote', // keyboard open/close; the pad combo is SELECT+START
  flags: '', // extra project flags, space-separated — inert but queryable
};

defineDatAccessors(AE1DebugMenu);

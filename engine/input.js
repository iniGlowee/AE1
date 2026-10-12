/**
 * AE1 - play-mode input capture.
 *
 * One small class that turns DOM events into a queryable state: which codes are
 * down, which went down THIS frame (edges), and how far the mouse moved under
 * pointer lock. It knows nothing about what the codes MEAN — the mappings live
 * on the Controller element (`engine/thirdperson.js`), editable in Properties,
 * and the character/camera ask "is the code the controller maps to `jump`
 * down?" (DESIGN.md §18.9).
 *
 * Mouse buttons are named like key codes: `Mouse0` (left), `Mouse1` (middle),
 * `Mouse2` (right) — so a mapping is always one string, whatever the device.
 *
 * Pointer lock: clicking the attached canvas requests it; Esc releases it
 * (the browser owns that, deliberately). Look deltas only accumulate while
 * locked — an unlocked mouse is pointing, not looking.
 *
 * No three.js, no element imports — this file is plain DOM, so it ships in the
 * classic 2D bundle unchanged and works anywhere.
 */

/**
 * GAMEPAD button codes, standard-mapping order (the browser's Gamepad API):
 * a mapping stays "one string per input", pads included. Triggers count as
 * held past 40% — the lab's measured threshold for a comfortable run-hold.
 */
const PAD_CODES = [
  'PadA', 'PadB', 'PadX', 'PadY', 'PadLB', 'PadRB', 'PadLT', 'PadRT',
  'PadSelect', 'PadStart', 'PadLS', 'PadRS',
  'PadUp', 'PadDown', 'PadLeft', 'PadRight',
];
const TRIGGER_ON = 0.4;

export class AE1Input {
  constructor() {
    this._down = new Set(); // codes currently held
    this._pressed = new Set(); // codes that went down since last endFrame()
    this._tokenCache = new Map(); // §18.87 — mapping string -> parsed tokens
    this._lookX = 0; // accumulated look deltas, consumed by the camera
    this._lookY = 0;
    this._target = null;
    this._offs = [];
    this._lockDenied = false; // this document refuses pointer lock → free-look only
    this._wheel = 0; // accumulated scroll steps, consumed per frame

    // -- cursor mode (§click-to-move) -------------------------------------- //
    // Point-and-click games (the reference MMO-style) keep the cursor VISIBLE and read where
    // it clicks; they must NOT pointer-lock. Opt-in: a TileMover sets
    // `input.cursorMode = true` on load. While on, canvas clicks skip the lock
    // request and land in `_clicks` as NDC (-1..1, y up) for the mover to drain;
    // `ptrX/ptrY` track the live cursor NDC. Default false ⇒ existing free-look
    // projects are untouched.
    this.cursorMode = false;
    this.canvas = null;
    this.ptrX = 0;
    this.ptrY = 0;
    this._clicks = []; // {nx, ny, button} since last drain
    this._rclicks = []; // right-clicks {nx, ny, sx, sy} since last drain (§element-graph)

    // -- gamepad (ported from the motion-matching lab) ------------------------- //
    // Polled, not evented: the Gamepad API hands back snapshots. One poll per
    // frame, lazily on first query, re-armed by endFrame(). The CONSUMERS
    // gate it: the Controller element's (gamepad …) dat sets `gamepadEnabled`
    // each tick, so a settings menu can flip keyboard/controller live.
    this.gamepadEnabled = true;
    this._padPolled = false;
    this._padDown = new Set(); // pad codes held last poll (edge detection)
    this._stickLive = false; // deadzone hysteresis state (see stick())
    this._pad = { name: null, lx: 0, ly: 0, rx: 0, ry: 0 };
  }

  /**
   * Poll the first connected pad into the shared code sets. STICK DEAD ZONE
   * WITH HYSTERESIS (the lab's lesson): a single threshold chatters — a
   * thumb resting at a gentle walk straddles it and every flip is a change
   * of intent, which forces a re-match and oscillates Walk_Start/Walk_Stop
   * forever. Engage at 0.20, release at 0.12; the band between is stable.
   */
  _pollPads() {
    if (this._padPolled) return;
    this._padPolled = true;
    const pad = this.gamepadEnabled
      ? navigator.getGamepads?.().find((p) => p && p.connected)
      : null;
    const held = new Set();
    if (pad) {
      this._pad.name = pad.id.slice(0, 28);
      const mag = Math.hypot(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      this._stickLive = mag > (this._stickLive ? 0.12 : 0.2);
      this._pad.lx = this._stickLive ? pad.axes[0] ?? 0 : 0;
      this._pad.ly = this._stickLive ? pad.axes[1] ?? 0 : 0;
      this._pad.rx = Math.abs(pad.axes[2] ?? 0) > 0.12 ? pad.axes[2] : 0;
      this._pad.ry = Math.abs(pad.axes[3] ?? 0) > 0.12 ? pad.axes[3] : 0;
      for (let i = 0; i < PAD_CODES.length; i++) {
        const b = pad.buttons[i];
        if (b && (b.pressed || b.value > TRIGGER_ON)) held.add(PAD_CODES[i]);
      }
    } else {
      this._pad = { name: null, lx: 0, ly: 0, rx: 0, ry: 0 };
      this._stickLive = false;
    }
    for (const code of held) {
      if (!this._padDown.has(code)) this._pressed.add(code);
      this._down.add(code);
    }
    for (const code of this._padDown) {
      if (!held.has(code)) this._down.delete(code);
    }
    this._padDown = held;
  }

  /** RUMBLE (§18.41): dual-rumble force feedback through the Gamepad API.
   *  `strong` drives the low-frequency motor (the thud), `weak` the
   *  high-frequency one (the buzz); ms is the pulse length. Chrome replaces
   *  a playing effect with the new one, which is exactly right for combat —
   *  a kill pulse overrides the light tap it landed on. No pad, no vibration
   *  actuator, or gamepad disabled = silent no-op; never throws. */
  rumble(strong = 0.6, weak = 0.4, ms = 120) {
    if (!this.gamepadEnabled) return;
    try {
      const pad = navigator.getGamepads?.().find((p) => p && p.connected);
      pad?.vibrationActuator
        ?.playEffect?.('dual-rumble', {
          duration: Math.max(1, ms),
          strongMagnitude: Math.max(0, Math.min(1, strong)),
          weakMagnitude: Math.max(0, Math.min(1, weak)),
        })
        ?.catch?.(() => {});
    } catch {
      /* rumble is garnish — never let it throw */
    }
  }

  /** The LEFT stick, deadzoned: {x, y, amount}. x right+, y forward+ (the
   *  pad's -Y is pushed-away = forward). Zero vector without a pad. */
  stick() {
    this._pollPads();
    const { lx, ly } = this._pad;
    return { x: lx, y: -ly, amount: Math.min(1, Math.hypot(lx, ly)) };
  }

  /** The RIGHT stick (camera orbit): {x, y}, deadzoned, raw sign. */
  lookStick() {
    this._pollPads();
    return { x: this._pad.rx, y: this._pad.ry };
  }

  /** The connected pad's name, or null — HUD/diagnostic use. */
  get padName() {
    this._pollPads();
    return this._pad.name;
  }

  /** Scroll steps since last asked (±N, wheel-down positive), and reset. */
  consumeWheel() {
    const w = this._wheel;
    this._wheel = 0;
    return w;
  }

  /** Cursor-mode clicks since last asked (each `{nx, ny, button}` in NDC), and
   *  reset. A TileMover drains this each tick to turn clicks into destinations. */
  takeClicks() {
    if (!this._clicks.length) return [];
    const c = this._clicks;
    this._clicks = [];
    return c;
  }

  /** Cursor-mode RIGHT-clicks since last asked (each `{nx, ny, sx, sy}` — NDC for
   *  picking, canvas-relative pixels for DOM menu placement), and reset. The
   *  ElementGraph drains this each tick to raise its right-click context menu. */
  takeRightClicks() {
    if (!this._rclicks.length) return [];
    const c = this._rclicks;
    this._rclicks = [];
    return c;
  }

  /** Inject a synthetic left-click at NDC (nx,ny) — the ElementGraph's "Walk
   *  here" menu option routes the mover exactly as a real ground click would. */
  queueClick(nx, ny) { this._clicks.push({ nx, ny, button: 0 }); }

  /** Listen on `canvas` (buttons, lock) + window (keys). Idempotent per attach. */
  attach(canvas) {
    if (this._target) this.detach();
    this._target = canvas;
    this.canvas = canvas;

    const ndc = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        nx: ((e.clientX - r.left) / r.width) * 2 - 1,
        ny: -(((e.clientY - r.top) / r.height) * 2 - 1),
      };
    };

    const on = (obj, type, fn, opts) => {
      obj.addEventListener(type, fn, opts);
      this._offs.push(() => obj.removeEventListener(type, fn, opts));
    };

    on(window, 'keydown', (e) => {
      // Keys the page would act on (scroll, tab-focus) belong to the game now.
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      // OS KEY-REPEAT is never a fresh press: a held key fires repeat
      // keydowns ~30/s, and a focus blip (blur clears _down) between two
      // repeats re-registered each one as a new edge — a held Z toggled
      // lock-on ~16 times a second (§18.52's phantom-toggle hunt).
      if (e.repeat) return;
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
    });
    on(window, 'keyup', (e) => this._down.delete(e.code));

    on(canvas, 'mousedown', (e) => {
      const code = `Mouse${e.button}`;
      if (!this._down.has(code)) this._pressed.add(code);
      this._down.add(code);
      // CURSOR MODE: point-and-click — never lock (the player must see the
      // cursor). LEFT clicks are "walk here" (recorded as NDC); MIDDLE (Mouse1)
      // is camera-orbit drag, so it only registers as held (above) — and we eat
      // its default (browsers autoscroll on middle-down).
      if (this.cursorMode) {
        if (e.button === 0) { const p = ndc(e); this._clicks.push({ nx: p.nx, ny: p.ny, button: 0 }); }
        else if (e.button === 1) e.preventDefault();
        else if (e.button === 2) {
          // RIGHT click raises the classic RS options menu — record NDC (to pick
          // the node under the cursor) and VIEWPORT pixels (clientX/Y) to place
          // the DOM box, which is position:fixed. Canvas-relative would be wrong:
          // in the editor the canvas is inside a panel, offset from the viewport.
          const p = ndc(e);
          this._rclicks.push({ nx: p.nx, ny: p.ny, sx: e.clientX, sy: e.clientY });
          e.preventDefault();
        }
        return;
      }
      // First click captures the mouse; further clicks are game input. The
      // request can be REFUSED — an embedded preview iframe without the
      // pointer-lock permission rejects with "root document not valid" — and
      // the rejection is silent unless caught. Denied once, we say so and
      // fall back to DRAG-LOOK: hold the left button and drag.
      if (document.pointerLockElement !== canvas && !this._lockDenied) {
        try {
          const r = canvas.requestPointerLock?.();
          r?.catch?.((err) => {
            this._lockDenied = true;
            console.warn(
              `[input] Pointer lock refused (${err?.message ?? err}). ` +
                `Free-look still works over the game canvas; capture needs a ` +
                `normal browser tab.`,
            );
          });
        } catch (err) {
          this._lockDenied = true;
          console.warn(`[input] Pointer lock unavailable (${err?.message ?? err}); free-look over the canvas.`);
        }
      }
    });
    on(window, 'mouseup', (e) => this._down.delete(`Mouse${e.button}`));
    on(canvas, 'contextmenu', (e) => e.preventDefault()); // Mouse2 is the game's
    // FREE-LOOK: the mouse steers the camera with no button held. Captured,
    // deltas arrive on the window (the cursor is gone); uncaptured, only
    // movement OVER THE CANVAS counts — in the editor the mouse must be able
    // to cross other panes without swinging the game camera. (A shipped game's
    // canvas is the whole window, so uncaptured free-look is total there.)
    on(window, 'mousemove', (e) => {
      if (!this.locked) return;
      this._lookX += e.movementX ?? 0;
      this._lookY += e.movementY ?? 0;
    });
    on(canvas, 'mousemove', (e) => {
      if (this.cursorMode) {
        const p = ndc(e); this.ptrX = p.nx; this.ptrY = p.ny;
        // MIDDLE-DRAG orbits the camera: while Mouse1 is held, feed the same
        // look accumulator free-look uses, so the camera turns with no change.
        if (this._down.has('Mouse1')) { this._lookX += e.movementX ?? 0; this._lookY += e.movementY ?? 0; }
        return;
      }
      if (this.locked) return; // the window listener already has it
      this._lookX += e.movementX ?? 0;
      this._lookY += e.movementY ?? 0;
    });

    // The scroll wheel, as discrete steps (inventory cycling). The page must
    // not scroll while the game owns the wheel.
    on(canvas, 'wheel', (e) => {
      e.preventDefault();
      this._wheel += Math.sign(e.deltaY);
    }, { passive: false });

    // Alt-tab must not leave keys stuck down — a held W across a focus loss
    // walks the character forever with nothing pressed.
    on(window, 'blur', () => { this._down.clear(); this._pressed.clear(); this._padDown.clear(); });
  }

  detach() {
    for (const off of this._offs) off();
    this._offs = [];
    this._target = null;
    this._down.clear();
    this._pressed.clear();
    this._lookX = this._lookY = 0;
    this._wheel = 0;
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  /** Is the mouse captured? */
  get locked() {
    return !!this._target && document.pointerLockElement === this._target;
  }

  /** May the camera consume look right now? Free-look means: whenever input
   *  is attached (play mode). The accumulation rules above decide WHICH
   *  movements count (captured = all; uncaptured = over the canvas only). */
  get looking() {
    return !!this._target;
  }

  /** Held right now. A mapping may name ALTERNATIVES, space-separated —
   *  `(jump "Space PadA")` — and any held one answers. Pad codes poll lazily
   *  so the first asker each frame pays the (tiny) snapshot cost. */
  /** §18.87: mappings are queried 60-100 times a frame and are almost all
   *  multi-token ("Space PadA") — the regex split allocated an array of
   *  strings plus a closure PER QUERY. Tokenize each distinct mapping once;
   *  the cache lives for the session (mappings are dats, a small fixed set). */
  _tokens(s) {
    let t = this._tokenCache.get(s);
    if (!t) {
      t = { pad: s.includes('Pad'), list: s.includes(' ') ? s.split(/\s+/).filter(Boolean) : null };
      this._tokenCache.set(s, t);
    }
    return t;
  }

  down(code) {
    const s = String(code);
    const t = this._tokens(s);
    if (t.pad) this._pollPads();
    if (!t.list) return this._down.has(s);
    for (const c of t.list) if (this._down.has(c)) return true;
    return false;
  }

  /** Went down since the last endFrame() — a one-frame edge, for jump/actions.
   *  Space-separated alternatives, like down(). */
  pressed(code) {
    const s = String(code);
    const t = this._tokens(s);
    if (t.pad) this._pollPads();
    if (!t.list) return this._pressed.has(s);
    for (const c of t.list) if (this._pressed.has(c)) return true;
    return false;
  }

  /** The mouse movement since last asked, and zero the accumulator. One
   *  consumer per frame — the camera. */
  consumeLook() {
    const dx = this._lookX;
    const dy = this._lookY;
    this._lookX = this._lookY = 0;
    return { dx, dy };
  }

  /** Close the frame: edges are one frame wide, and the next frame's first
   *  query re-polls the pad. The HOST calls this once per frame, after every
   *  element has ticked. */
  endFrame() {
    this._pressed.clear();
    this._padPolled = false;
  }
}

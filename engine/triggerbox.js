/**
 * AE1 - TriggerBox (§18.50): a VOLUME that notices the character — the
 * audio-region idea (§18.34) generalized into a scriptable base element.
 *
 * A box of `(sizeX/sizeY/sizeZ)` centered on the element. Each tick it asks
 * "is the player inside?"; on the ENTER edge it dispatches **`onStart`** to
 * its own script, on the LEAVE edge **`onEnd`** — the same two modes the
 * camera curves use, so an author learns them once. `(triggerOnce true)`
 * fires a single visit; `reset()` re-arms it. `occupied` is readable any
 * tick for polling scripts.
 *
 * `(extends TriggerBox)` + your own onStart/onEnd IS the feature: the
 * fishing trigger (walk to the pier's end and she just starts), cutscene
 * volumes, ambush closets, checkpoint plates. No mesh required — the
 * volume is its own geometry (the editor can ink it later like the audio
 * regions).
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Controller } from './thirdperson.js';

export class AE1TriggerBox extends AE1Element {
  _tbInside = false;
  _tbSpent = false;

  /** Re-arm a (triggerOnce) box. */
  reset() {
    this._tbSpent = false;
  }

  get occupied() {
    return this._tbInside;
  }

  _tbPlayer() {
    return this.world?.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function') ?? null;
  }

  _tbTick(_dt) {
    const p = this._tbPlayer();
    if (!p) return;
    const hx = Math.abs(Number(this.sizeX) || 4) / 2;
    const hy = Math.abs(Number(this.sizeY) || 3) / 2;
    const hz = Math.abs(Number(this.sizeZ) || 4) / 2;
    const dx = (p.x ?? 0) - (this.x ?? 0);
    const dy = (p.y ?? 0) + 0.9 - (this.y ?? 0); // her middle, not her heels
    const dz = (p.z ?? 0) - (this.z ?? 0);
    const inside = Math.abs(dx) <= hx && Math.abs(dy) <= hy && Math.abs(dz) <= hz;
    const interactive = this.interactive === true || this.interactive === 'true';

    // INTERACTIVE mode (§18.50): the volume ARMS the interact key instead of
    // auto-firing — only while the character stands inside does E dispatch
    // `onInteract` to this box's script (a toggle is the script's business).
    // The edge still dispatches `onEnd` on LEAVE as a safety net, so a
    // session can always clean up if the character somehow slips out.
    if (interactive && inside) {
      const input = this.world?.input3d;
      const ctl = AE1Controller.mappingsIn?.(this.world);
      if (input && ctl?.interact && input.pressed(ctl.interact)) {
        this.world?.loop?.dispatchTo(this, 'onInteract', p);
      }
    }

    if (inside === this._tbInside) return;
    this._tbInside = inside;
    if (inside) {
      if (interactive) return; // armed, not fired — E does the firing
      if (this._tbSpent) return;
      if (this.triggerOnce === true || this.triggerOnce === 'true') this._tbSpent = true;
      this.world?.loop?.dispatchTo(this, 'onStart', p);
    } else {
      this.world?.loop?.dispatchTo(this, 'onEnd', p);
    }
  }
}

AE1TriggerBox.agsDef = {
  name: 'TriggerBox',
  extends: null,
  runInfo: { _tbTick: ['onTick'] },
};

AE1TriggerBox.agsDat = {
  sizeX: 4,
  sizeY: 3,
  sizeZ: 4,
  triggerOnce: false,
  // true: no auto-fire on entry — E inside the volume dispatches onInteract
  // instead (onEnd still fires on leave, the safety net)
  interactive: false,
};

defineDatAccessors(AE1TriggerBox);

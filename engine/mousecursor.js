/**
 * AE1 — MouseCursor: a custom mouse pointer shown the whole time the player is
 * hovering the game window (the the reference MMO gold pointer, say).
 *
 * `(extends MouseCursor)` swaps the OS arrow for a custom image over the game
 * canvas — drawn by the browser itself via the CSS `cursor` property, so it
 * follows the mouse with zero per-frame work and vanishes the moment the pointer
 * leaves the canvas. The image is set in Properties: `(image "pointer.png")`
 * names a project media file, or pass a URL / data-URI; omitted, a built-in gold
 * arrow is used. `hotspotX`/`hotspotY` place the click point within the image
 * (0,0 = top-left tip).
 *
 * Play mode normally hides the pointer (viewport sets `cursor:none`); this
 * re-asserts the custom cursor each tick so it stays visible for point-and-click.
 */
import { AE1Element, defineDatAccessors } from './element.js';

// Built-in default: a the reference MMO-style gold arrow pointer whose TIP sits at image
// pixel (2,2) — the default hotspot below matches it, so the tip is exactly where
// clicks register. (A custom `image` sets its own hotspotX/Y.)
const DEFAULT_CURSOR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
      '<path d="M2 2 L2 21 L7.5 15.5 L11 23 L14.5 21.3 L11 14 L18 14 Z" ' +
      'fill="#ffd23b" stroke="#5a3d00" stroke-width="1.6" stroke-linejoin="round"/>' +
      '</svg>',
  );
const DEFAULT_HOTSPOT = 2; // the built-in arrow's tip pixel

export class AE1MouseCursor extends AE1Element {
  _mcBegin() {
    this._css = this._cursorCss();
  }

  _mcTick() {
    // Re-assert every tick: the canvas may not exist at onLoad (input attaches in
    // Play's enterPlay, which also sets cursor:none), and setting a CSS cursor is
    // free. Only touches the canvas, so the pointer is custom over the game and
    // normal everywhere else.
    const c = this.world?.input3d?.canvas;
    if (!c) return;
    if (!this._css) this._css = this._cursorCss();
    if (c.style.cursor !== this._css) c.style.cursor = this._css;
  }

  _cursorCss() {
    let url = DEFAULT_CURSOR;
    const v = this.image;
    if (v && typeof v === 'string') {
      if (/^(https?:|data:|\/)/.test(v)) url = v;
      else {
        const m = this.world?.resolveMedia?.(v);
        url = m ? `${this.world.mediaBase ?? 'media'}/${m.hash}.${m.ext}` : v;
      }
    }
    const hx = Number(this.hotspotX) || 0;
    const hy = Number(this.hotspotY) || 0;
    return `url("${url}") ${hx} ${hy}, auto`;
  }

  onRemove() {
    const c = this.world?.input3d?.canvas;
    if (c) c.style.cursor = '';
    super.onRemove?.();
  }
}

AE1MouseCursor.agsDef = {
  name: 'MouseCursor',
  extends: 'Element',
  runInfo: { _mcBegin: ['onLoad'], _mcTick: ['onTick'] },
};

AE1MouseCursor.agsDat = {
  ...AE1Element.agsDat,
  image: '',                  // media name, URL, or data-URI; empty ⇒ built-in gold arrow
  hotspotX: DEFAULT_HOTSPOT,  // click point within the image (px from left) — built-in arrow tip
  hotspotY: DEFAULT_HOTSPOT,  // click point within the image (px from top)
};

defineDatAccessors(AE1MouseCursor);

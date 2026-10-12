/**
 * AE1 - buttons.
 *
 * `AE1Button` is a built-in base: `(extends Button)`. It extends Text rather than
 * Element, because a button IS text with a background and a hover state -- and
 * reimplementing glyph painting to add a rectangle behind it would be two text
 * renderers to keep agreeing.
 *
 * The simple case is zero methods:
 *
 *   <?dat
 *   (label "New Game")
 *   (target "Game")
 *   ?>
 *   <?def
 *   (extends Button)
 *   ags?>
 *
 * The expert case overrides press() and gets everything else free. That is
 * Principle 4 in one class.
 */

import { defineDatAccessors } from './element.js';
import { AE1Text } from './text.js';

export class AE1Button extends AE1Text {
  /* -- state ------------------------------------------------------------- */

  get hovered() {
    return Boolean(this._hovered);
  }

  /**
   * Buttons render `label`, not `text`.
   *
   * Text's own dat key is `text`; a button author writes `label`. Rather than
   * make them learn which, `label` wins when present and `text` still works —
   * Text.draw() reads `this.text`, so this getter is what feeds it.
   */
  get text() {
    return this.label ?? this._props.text ?? '';
  }

  set text(v) {
    this.label = v;
  }

  /* -- input ------------------------------------------------------------- */
  //
  // Wired by the static agsDef below, so a Button works with no script attached.

  _btnEnter(actor) {
    if (this.disabled) return;
    this._hovered = true;
    if (this.hoverSound) this.playSound(this.hoverSound);
    return this.whenHovered?.(actor);
  }

  _btnExit(actor) {
    this._hovered = false;
    return this.whenUnhovered?.(actor);
  }

  _btnClick(actor) {
    if (this.disabled) return null;
    if (this.clickSound) this.playSound(this.clickSound);
    return this.press(actor);
  }

  /**
   * What this button does. Override me.
   *
   * The default honours `(target "Scene Name")`, so the commonest button in a
   * menu — "go there" — needs no code at all.
   */
  press(_actor) {
    if (this.target) return this.goToScene(this.target);
    return null;
  }

  /* -- rendering --------------------------------------------------------- */

  draw(ctx, api) {
    const hot = this._hovered && !this.disabled;
    const radius = this.radius ?? 4;

    const bg = hot ? (this.hoverBackground ?? this.background) : this.background;
    if (bg) {
      ctx.fillStyle = bg;
      btnRoundRect(ctx, 0, 0, api.width, api.height, radius);
      ctx.fill();
    }

    const border = hot ? (this.hoverBorder ?? this.border) : this.border;
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = this.borderWidth ?? 1;
      btnRoundRect(ctx, 0.5, 0.5, api.width - 1, api.height - 1, radius);
      ctx.stroke();
    }

    // Swap the colour, let Text draw the glyphs, then put it back. Mutating dat
    // would journal an edit every time the pointer crossed a button.
    const restore = this._props.color;
    if (hot && this.hoverColor) this._props.color = this.hoverColor;
    if (this.disabled && this.disabledColor) this._props.color = this.disabledColor;

    super.draw(ctx, api);

    this._props.color = restore;
  }
}

AE1Button.agsDef = {
  name: 'Button',
  extends: null,
  runInfo: {
    _btnClick: ['onClick'],
    _btnEnter: ['onHover'],
    _btnExit: ['onExit'],
  },
};

AE1Button.agsDat = {
  label: '',
  target: '',
  disabled: false,

  // text
  padding: 10,
  size: 20,
  color: '#e8e8e8',
  hoverColor: '#ffffff',
  disabledColor: '#6b6b6b',
  align: 'center',
  valign: 'middle',
  shadow: true,

  // box
  background: 'rgba(12,12,14,0.72)',
  hoverBackground: 'rgba(60,68,86,0.92)',
  border: 'rgba(255,255,255,0.18)',
  hoverBorder: 'rgba(255,255,255,0.45)',
  borderWidth: 1,
  radius: 4,

  // audio
  hoverSound: '',
  clickSound: '',
};

defineDatAccessors(AE1Button);

/** Prefixed: the export concatenates every module into one scope (DESIGN.md §8.2). */
function btnRoundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

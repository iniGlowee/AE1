/**
 * AE1 - text.
 *
 * `AE1Text` is a built-in base: `(extends Text)`. It draws wrapped, aligned text
 * inside its own bounds using the `draw()` hook -- the same hook an author has,
 * proving the hook is enough to build real things with. There is no privileged
 * text pipeline; Text is just an element that knows how to paint glyphs.
 *
 * Works in a scene or in the HUD. Persistence comes from which scene an element
 * lives in, never from its class, so nothing here needs a HUD variant.
 *
 * Fonts are system stacks only. A webfont would mean either a CDN or a payload,
 * and AE1 ships neither (DESIGN.md, Principle 5). An author who wants a specific
 * face installs it and names it.
 */

import { AE1Element } from './element.js';

/** Cache of wrapped lines. Wrapping measures every word; text changes rarely. */
const wrapCache = new Map();
const CACHE_MAX = 200;

export class AE1Text extends AE1Element {
  /**
   * @param {CanvasRenderingContext2D} ctx  translated to this element's top-left
   * @param {object} api  { width, height }
   */
  draw(ctx, api) {
    const text = String(this.text ?? '');
    const pad = this.padding ?? 0;
    const size = this.size ?? 24;
    const family = this.font ?? 'system-ui, -apple-system, "Segoe UI", sans-serif';
    const weight = this.weight ?? '400';
    const lineHeight = (this.lineHeight ?? 1.4) * size;

    ctx.font = `${weight} ${size}px ${family}`;
    ctx.textBaseline = 'alphabetic';

    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, api.width, api.height);
    }

    if (!text) return;

    const maxWidth = api.width - pad * 2;
    const lines = this.wrap === false ? text.split('\n') : wrapText(ctx, text, maxWidth);

    const align = this.align ?? 'left';
    const valign = this.valign ?? 'top';

    const blockHeight = lines.length * lineHeight;
    let y =
      valign === 'middle'
        ? (api.height - blockHeight) / 2 + size
        : valign === 'bottom'
          ? api.height - pad - blockHeight + size
          : pad + size;

    ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    const x = align === 'center' ? api.width / 2 : align === 'right' ? api.width - pad : pad;

    for (const line of lines) {
      // A shadow is the difference between readable and not over video or busy
      // art -- which is most of what full-frame text sits on.
      if (this.shadow) {
        ctx.fillStyle = this.shadowColor ?? 'rgba(0,0,0,0.75)';
        ctx.fillText(line, x + (this.shadowOffset ?? 2), y + (this.shadowOffset ?? 2));
      }
      ctx.fillStyle = this.color ?? '#ffffff';
      ctx.fillText(line, x, y);
      y += lineHeight;
    }

    // Leave the context as we found it: the renderer restores the transform, not
    // these. A stray textAlign would silently corrupt whatever draws next.
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** How tall this text actually is, wrapped. Useful for sizing to content. */
  measureHeight(ctx) {
    const size = this.size ?? 24;
    const lines = wrapText(
      ctx,
      String(this.text ?? ''),
      this.width - (this.padding ?? 0) * 2,
    );
    return lines.length * (this.lineHeight ?? 1.4) * size + (this.padding ?? 0) * 2;
  }
}

/**
 * Greedy word wrap, honouring explicit newlines.
 *
 * Greedy rather than balanced (Knuth-Plass): a paragraph of credits does not
 * need optimal line breaking, and greedy is what every browser does anyway, so
 * it matches what an author expects from having typed text anywhere else.
 */
export function wrapText(ctx, text, maxWidth) {
  if (maxWidth <= 0) return [text];

  const key = `${ctx.font}|${maxWidth}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const out = [];

  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      out.push(''); // a blank line is a deliberate gap, not nothing
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const attempt = line ? `${line} ${word}` : word;

      if (ctx.measureText(attempt).width <= maxWidth) {
        line = attempt;
        continue;
      }

      if (line) out.push(line);

      // A single word wider than the box: break it, rather than let it bleed
      // out of the element's bounds and over whatever is beside it.
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    out.push(line);
  }

  if (wrapCache.size > CACHE_MAX) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

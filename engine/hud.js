/**
 * AE1 - HUD elements.
 *
 * HUD elements live in the PROJECT (hud.json), never inside a scene. That is the
 * whole reason they survive a scene change: if the inventory lived in scene-1 and
 * scene-2, each would hold its own copy and walking through a door would silently
 * reset it. One place, one instance, loaded once (DESIGN.md §12).
 *
 * They are ordinary elements otherwise -- same schema, same accessors, same AGS.
 * They render above every scene element and are hit-tested first.
 *
 * `HudElement` and `Inventory` are registered as BUILT-IN bases (see
 * ags/runtime.js), so an author writes `(extends Inventory)` and gets all of this
 * with the machinery that already existed. This is the "hidden elements that act
 * like interfaces" idea from the original spec, doing real work.
 */

import { AE1Element } from './element.js';
import { getImage } from './media.js';

export class AE1HudElement extends AE1Element {
  /**
   * HUD elements are drawn in frame space, same as everything else.
   *
   * A point-and-click ships a fixed 1280x720 frame, so "screen space" and "frame
   * space" are the same space. When a project type ever has a camera that moves
   * within a larger world, this is the method that learns the difference.
   */
  screenBounds() {
    return this.getBounds();
  }
}

/**
 * An inventory. Holds ITEMS, not elements.
 *
 * That distinction is load-bearing: picking up a key cannot move the key ELEMENT
 * into the inventory, because that element is destroyed when its scene unloads.
 * An item is plain data -- `{ id, name, icon, ext }` -- so it survives scene
 * changes, serializes cleanly, and can be granted by a script that has no element
 * to hand.
 */
export class AE1Inventory extends AE1HudElement {
  constructor(data = {}, opts) {
    super(data, opts);
    /** @type {Array<{id: string, name: string, icon?: string, ext?: string}>} */
    this.items = Array.isArray(data.items) ? data.items.map((i) => ({ ...i })) : [];
  }

  /* -- contents ---------------------------------------------------------- */

  /** Add an item. Idempotent by id -- talking to the same NPC twice must not duplicate the key. */
  add(item) {
    const entry = typeof item === 'string' ? { id: item, name: item } : { ...item };
    if (!entry.id) return null;
    if (this.has(entry.id)) return this.get(entry.id);

    this.items.push(entry);
    this._notify('@items', this.items, null);
    return entry;
  }

  remove(id) {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return null;
    const [gone] = this.items.splice(i, 1);
    this._notify('@items', this.items, null);
    return gone;
  }

  has(id) {
    return this.items.some((it) => it.id === id);
  }

  get(id) {
    return this.items.find((it) => it.id === id) ?? null;
  }

  get count() {
    return this.items.length;
  }

  clear() {
    this.items = [];
    this._notify('@items', this.items, null);
  }

  serialize() {
    return { ...super.serialize(), items: this.items.map((i) => ({ ...i })) };
  }

  /* -- rendering ---------------------------------------------------------- */

  /**
   * Custom draw.
   *
   * Any element with a `draw` method takes over its own rendering (see
   * renderer.js). That one hook is what makes health bars, custom inventories,
   * and arbitrary HUD chrome possible from Angel Script alone -- an author writes
   * `function draw(ctx, api) {…}` and owns every pixel of their element.
   *
   * @param {CanvasRenderingContext2D} ctx  translated to this element's top-left
   * @param {object} api  { mediaBase, width, height, element }
   */
  draw(ctx, api) {
    const slots = Math.max(this.slots ?? 6, this.items.length);
    const pad = this.padding ?? 6;
    const size = this.slotSize ?? Math.max(16, this.height - pad * 2);

    ctx.fillStyle = this.background ?? 'rgba(12,12,14,0.78)';
    roundRect(ctx, 0, 0, this.width, this.height, 6);
    ctx.fill();

    ctx.strokeStyle = this.border ?? 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, this.width - 1, this.height - 1, 6);
    ctx.stroke();

    for (let i = 0; i < slots; i++) {
      const x = pad + i * (size + pad);
      if (x + size > this.width) break; // never spill past our own bounds

      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, x + 0.5, pad + 0.5, size - 1, size - 1, 3);
      ctx.stroke();

      const item = this.items[i];
      if (!item) continue;

      if (item.icon) {
        // Resolve again here, by name OR hash. give() already resolves, but an
        // item authored straight into hud.json carries whatever the author typed
        // — and both paths must render. Falling back to treating the icon as a
        // hash keeps this working with no world attached (tests, editor preview).
        const m = this.world?.resolveMedia(item.icon) ?? { hash: item.icon, ext: item.ext ?? 'png' };
        const img = getImage(api.mediaBase, m.hash, m.ext ?? 'png', api.redraw);
        if (img?.complete && img.naturalWidth) {
          // Fit, don't stretch. A squashed key reads as a bug.
          const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
          const w = img.naturalWidth * scale;
          const h = img.naturalHeight * scale;
          ctx.drawImage(img, x + (size - w) / 2, pad + (size - h) / 2, w, h);
          continue;
        }
      }

      // No icon, or not decoded yet: the item's initial beats an empty slot.
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = `${Math.round(size * 0.42)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((item.name ?? item.id).slice(0, 1).toUpperCase(), x + size / 2, pad + size / 2);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /** Which item slot is under a point, in element-local coordinates. */
  slotAt(localX, localY) {
    const pad = this.padding ?? 6;
    const size = this.slotSize ?? Math.max(16, this.height - pad * 2);
    if (localY < pad || localY > pad + size) return -1;
    const i = Math.floor((localX - pad) / (size + pad));
    return i >= 0 && i < this.items.length ? i : -1;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

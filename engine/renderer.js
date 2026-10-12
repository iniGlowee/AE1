/**
 * AE1 - element renderer.
 *
 * Draws elements in SCENE space. The caller owns the camera and the ordering:
 * the editor applies pan/zoom and adds grid, frame, and selection chrome; the
 * exported game applies a fit-to-window transform and adds nothing. Both call
 * this.
 *
 * That split is the point. If the export had its own renderer, a sprite could
 * draw differently in the editor than in the shipped game -- exactly the
 * "works in the editor, breaks in export" failure Principle 2 exists to forbid.
 */

import { getImage } from './media.js';

/**
 * How a sheet is cut up: frame size, columns, rows, total. Null if this sprite
 * is an ordinary image rather than a sheet.
 *
 * A spritesheet is nothing more than "draw region R of image I", so it lives
 * HERE -- in the one path the editor and the shipped game already share -- and
 * not in a class that owns draw(). Any element can show a frame; AE1Sprite
 * (engine/sprite.js) adds only the motion on top.
 *
 * That is the data/behaviour split this feature turns on. It is why an animated
 * element keeps rotation, flip, opacity and the still-decoding placeholder for
 * free: it never leaves the path every ordinary element already takes.
 */
export function frameGrid(img, sprite) {
  const fw = Math.floor(sprite?.frameWidth ?? 0);
  const fh = Math.floor(sprite?.frameHeight ?? 0);

  // No frame size means an ordinary image. Deriving "is a sheet" from the frame
  // size rather than a separate flag keeps the component honest: there is no
  // state where a sheet has no frame size, so there is no pair to disagree.
  if (!(fw > 0) || !(fh > 0)) return null;
  if (!img?.naturalWidth) return null; // still decoding; ask again next frame

  const cols = Math.max(1, Math.floor(sprite.columns) || Math.floor(img.naturalWidth / fw) || 1);
  const rows = Math.max(1, Math.floor(img.naturalHeight / fh) || 1);

  return { fw, fh, cols, rows, count: cols * rows };
}

/**
 * The source rectangle for a sprite's current frame, or null if it is an
 * ordinary image. Shares frameGrid with sprite.js so the two can never disagree
 * about how many frames a sheet has -- an animation that wraps at a different
 * count than the renderer draws would be maddening to diagnose.
 */
export function frameRect(img, sprite) {
  const grid = frameGrid(img, sprite);
  if (!grid) return null;

  const { fw, fh, cols, count } = grid;

  // Wrap, never clamp, and never trust the index.
  //
  // An animation that runs past its last frame should start over, and a number
  // typed into Properties must never address pixels outside the sheet: drawImage
  // with an out-of-bounds source rect draws NOTHING and throws nothing, so the
  // element would simply vanish with a clean console.
  const raw = Math.floor(Number(sprite.frame) || 0);
  const i = ((raw % count) + count) % count;

  return { sx: (i % cols) * fw, sy: Math.floor(i / cols) * fh, sw: fw, sh: fh };
}

/**
 * Draw an ordered list of elements.
 *
 * Takes a LIST rather than a scene, because the world composes scene elements and
 * persistent HUD elements into one ordered pass (HUD always above). The renderer
 * has no business knowing which is which.
 *
 * @param {CanvasRenderingContext2D} ctx  transform already set to scene space
 * @param {Array} elements                already in paint order
 * @param {object} opts
 * @param {string} opts.mediaBase
 * @param {(type: string) => string} [opts.colorFor]  fill for spriteless elements
 * @param {() => void} [opts.onImageLoad]  redraw hook, fired when an asset decodes
 * @param {number} [opts.zoom]  keeps placeholder strokes hairline
 */
export function drawElements(ctx, elements, { mediaBase, colorFor, onImageLoad, zoom = 1 } = {}) {
  for (const element of elements) {
    if (!element.visible) continue;

    const b = element.getBounds();

    ctx.save();
    ctx.globalAlpha = element.opacity;

    // ONE transform, both paths.
    //
    // The draw() path used to get a bare translate, so `rotation`, `flipH` and
    // `flipV` were silently ignored on every Text, Video and Button in AE1: set
    // rotation to 45 and nothing happened, with no error, because the browser had
    // nothing to complain about. Confirmed by reading back the matrix a real Text
    // element receives -- identity, where the default path had the rotation.
    //
    // The author's contract is unchanged: local coordinates still run (0,0) to
    // (width,height). They are simply honoured inside a rotated, flipped frame
    // now, which is what those properties always claimed to do.
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.rotate((element.rotation * Math.PI) / 180);
    // Flip mirrors around the element's own centre, so it never moves the
    // element. Doing this by negating scaleX would.
    ctx.scale(element.flipH ? -1 : 1, element.flipV ? -1 : 1);

    /**
     * An element with a `draw` method owns its own rendering.
     *
     * This single hook is what makes health bars, custom inventories, and
     * arbitrary HUD chrome possible from Angel Script alone: an author writes
     * `function draw(ctx, api) {…}` and owns every pixel. The context arrives
     * translated to the element's top-left, so the author works in simple local
     * coordinates from (0,0) to (width,height).
     */
    if (typeof element.draw === 'function') {
      // Back to the top-left, from the centre the shared transform leaves us at.
      ctx.translate(-b.w / 2, -b.h / 2);
      try {
        element.draw(ctx, {
          mediaBase,
          width: b.w,
          height: b.h,
          element,
          redraw: onImageLoad,
          getImage,
        });
      } catch (err) {
        // A thrown draw must cost that element, never the frame. Otherwise one
        // bad HUD script blanks the whole game, every frame, forever.
        console.error(`[ags] ${element.name}.draw() threw:`, err);
      }
      ctx.restore();
      continue;
    }

    const sprite = element.components?.sprite;
    const img = sprite?.media ? getImage(mediaBase, sprite.media, sprite.ext ?? 'png', onImageLoad) : null;

    if (img?.complete && img.naturalWidth) {
      const f = frameRect(img, sprite);
      if (f) ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, -b.w / 2, -b.h / 2, b.w, b.h);
      else ctx.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h);
    } else if (sprite?.media) {
      // Still decoding, or broken. A hollow outline says "an asset belongs here"
      // without pretending to be one.
      ctx.strokeStyle = colorFor?.(element.type) ?? '#6b7f9e';
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.setLineDash([]);
    } else if (colorFor) {
      ctx.fillStyle = colorFor(element.type);
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    }

    ctx.restore();
  }
}

/** Convenience for a lone scene. Keeps single-scene callers honest. */
export function drawScene(ctx, scene, opts) {
  if (!scene) return;
  drawElements(ctx, scene.sorted(scene.all()), opts);
}

/**
 * AE1 - media cache.
 *
 * Lives in /engine because the exported game resolves media the same way the
 * editor does (Principle 2): hash -> URL -> decoded image.
 *
 * This is the "pull when needed" half of the memory model (DESIGN.md 3): a scene
 * manifest is small, and the assets it names load lazily and evict under budget.
 * A 400-asset project never holds 400 assets in memory.
 *
 * No IndexedDB layer. DESIGN.md 3 reserved one for decoded media, but AE1 serves
 * from localhost and content-addressed files carry `immutable` cache headers, so
 * the browser's own HTTP cache already IS that layer. Building a second one would
 * be a cache in front of a cache. Revisit only if profiling ever says otherwise.
 */

/**
 * How many decoded images to keep. Deliberately a count, not a byte budget:
 * decoded size is width*height*4 and knowable, but the honest limit is "how many
 * can be on screen and recently used", and a count is a limit an author can
 * reason about. Revisit if 4K backgrounds make this the wrong axis.
 */
const MAX_ENTRIES = 120;

/** hash.ext -> HTMLImageElement. Insertion order IS the LRU order. */
const cache = new Map();

const keyOf = (hash, ext) => `${hash}.${ext}`;

/**
 * Resolve an asset URL from a base.
 *
 * The base is a parameter rather than a hardcoded /projects path because the
 * editor and the exported game store media at different places -- but must
 * resolve it with the same code (Principle 2).
 *   editor: `/projects/<slug>/media`
 *   export: `media`
 */
export function mediaURL(base, hash, ext) {
  return `${base}/${hash}.${ext}`;
}

/**
 * Get a decoded image, loading it if absent.
 *
 * Returns the element immediately -- possibly still loading. Callers draw only
 * when `.complete` is true, which keeps rendering synchronous and lets the loop
 * never await anything.
 *
 * @param {() => void} [onReady] called once, when it finishes decoding
 */
export function getImage(base, hash, ext, onReady) {
  const key = keyOf(hash, ext);
  const hit = cache.get(key);

  if (hit) {
    // Re-insert to mark as recently used.
    cache.delete(key);
    cache.set(key, hit);
    if (!hit.complete && onReady) hit.addEventListener('load', onReady, { once: true });
    return hit;
  }

  const img = new Image();
  img.decoding = 'async';
  if (onReady) img.addEventListener('load', onReady, { once: true });
  img.addEventListener('error', () => cache.delete(key), { once: true });
  img.src = mediaURL(base, hash, ext);

  cache.set(key, img);
  evict();
  return img;
}

function evict() {
  while (cache.size > MAX_ENTRIES) {
    // Map iteration is insertion-ordered, so the first key is the coldest.
    const oldest = cache.keys().next().value;
    const img = cache.get(oldest);
    cache.delete(oldest);
    // Dropping the reference is what frees the decoded bitmap; clearing src
    // additionally cancels a load still in flight.
    if (img && !img.complete) img.src = '';
  }
}

/** Drop everything. Called when a project closes -- another project's media is not ours. */
export function clearCache() {
  for (const img of cache.values()) if (!img.complete) img.src = '';
  cache.clear();
}

export const cacheSize = () => cache.size;

/**
 * Resolve a media NAME (or hash) against a manifest table to `{hash, ext}`.
 *
 * Standalone rather than a method on AE1World, because the EDITOR needs it too —
 * outside play there is no world, and an element that cannot resolve a name
 * cannot render its video or run setSprite(). Both surfaces must resolve names
 * the same way or the editor and the game disagree about what "key.png" means.
 *
 * @param {Record<string, {name: string, ext: string}>} table  hash -> entry
 */
export function resolveMedia(table, nameOrHash) {
  if (!nameOrHash || !table) return null;

  const direct = table[nameOrHash];
  if (direct) return { hash: nameOrHash, ext: direct.ext };

  const wanted = String(nameOrHash).toLowerCase();
  for (const [hash, entry] of Object.entries(table)) {
    if (entry.name?.toLowerCase() === wanted) return { hash, ext: entry.ext };
    // Also match without the extension: playSound("bram-hey") should work.
    if (entry.name?.toLowerCase().replace(/\.[^.]+$/, '') === wanted) {
      return { hash, ext: entry.ext };
    }
  }
  return null;
}

/** Read an image's natural size without adding it to the cache. */
export function measure(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve({ width: img.naturalWidth, height: img.naturalHeight }), {
      once: true,
    });
    img.addEventListener('error', () => resolve({ width: 128, height: 128 }), { once: true });
    img.src = url;
  });
}

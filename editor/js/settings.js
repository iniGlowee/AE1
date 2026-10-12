/**
 * AE1 - durable UI settings.
 *
 * Panel layouts and theme. These live on the SERVER, not in localStorage.
 *
 * The distinction matters and is easy to get wrong (I did, first pass). AE1 runs
 * in incognito, so localStorage dies on every window close. A layout the user
 * spent ten minutes arranging is work, and work does not go somewhere that gets
 * wiped. See prefs.js for the things that genuinely are disposable.
 *
 * Rule of thumb: if the user would be annoyed to redo it, it belongs here.
 */

import { api } from './api.js';

let cache = { theme: 'dark', layouts: {} };
let loaded = false;

/** Coalesce bursts of writes -- dragging a divider fires continuously. */
let pending = null;
let timer = null;
const FLUSH_MS = 400;

export const settings = {
  async load() {
    try {
      cache = await api.getSettings();
    } catch {
      // Cosmetic. Fall through to defaults rather than blocking boot.
    }
    loaded = true;
    return cache;
  },

  get(key) {
    return cache[key];
  },

  /** Write-through: update the cache now, persist shortly. */
  set(key, value) {
    cache[key] = value;
    pending = { ...(pending ?? {}), [key]: value };
    clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_MS);
  },

  getLayout(projectType) {
    return cache.layouts?.[projectType] ?? null;
  },

  setLayout(projectType, tree) {
    const layouts = { ...(cache.layouts ?? {}), [projectType]: tree };
    settings.set('layouts', layouts);
  },

  /** Force any queued write out now. Used before navigating away. */
  flush,

  get isLoaded() {
    return loaded;
  },
};

async function flush() {
  clearTimeout(timer);
  if (!pending) return;
  const patch = pending;
  pending = null;
  try {
    await api.patchSettings(patch);
  } catch {
    /* Layout persistence is best-effort. Never interrupt the user for it. */
  }
}

/**
 * AE1 - user preferences.
 *
 * localStorage holds UI preferences and NOTHING ELSE (DESIGN.md 3). Panel sizes,
 * theme, last-open project. Kilobytes, and harmless to lose.
 *
 * AE1 launches in incognito, so this is wiped on every close. That is the design
 * working, not a bug to route around: if project data ever ends up here, it
 * silently disappears when the window shuts. Anything you would be upset to lose
 * belongs on the server.
 *
 * No cookies. No sessions.
 */

const KEY = 'ae1.prefs.v1';

const DEFAULTS = {
  lastProject: null,
  theme: 'dark',
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    // Private modes and storage-blocking extensions can throw on access. Prefs
    // are cosmetic, so degrade to defaults instead of taking the editor down.
    return { ...DEFAULTS };
  }
}

let cache = load();

export const prefs = {
  get(key) {
    return cache[key];
  },

  set(key, value) {
    cache[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* Cosmetic only. Never surface this. */
    }
  },

  all() {
    return { ...cache };
  },

  clear() {
    cache = { ...DEFAULTS };
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

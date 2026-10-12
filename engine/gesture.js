/**
 * AE1 - first-gesture unlock.
 *
 * Browsers refuse to play audio, and unmuted video, until the user has
 * interacted with the page. Media started in `onLoad` therefore fails on the
 * very first scene -- exactly where a game wants its theme and its intro movie.
 *
 * Rather than swallow that, hold the intent and fire it on the first gesture.
 *
 * Shared by audio.js and video.js. It was already implemented privately inside
 * AE1Audio; video needed the identical eight lines, and two copies of a rule
 * this subtle is two chances to fix only one of them.
 */

/** @type {Set<() => void>} */
const waiting = new Set();
let gestured = false;

/** Has the user interacted yet? Media can start immediately if so. */
export function hasGestured() {
  return gestured;
}

/**
 * Run `fn` now if the user has already interacted, or on the first gesture.
 * @returns {() => void} cancel — for intents that stop mattering (a scene left)
 */
export function onFirstGesture(fn) {
  if (gestured) {
    fn();
    return () => {};
  }
  waiting.add(fn);
  return () => waiting.delete(fn);
}

function fire() {
  gestured = true;
  for (const fn of waiting) {
    try {
      fn();
    } catch (err) {
      // One queued intent failing must not strand the others.
      console.error('[gesture] queued intent threw:', err);
    }
  }
  waiting.clear();
}

if (typeof window !== 'undefined') {
  // Capture phase: a game's own click handler may stopPropagation, and the
  // unlock must not depend on the page letting the event bubble.
  for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(evt, fire, { once: true, capture: true });
  }
}

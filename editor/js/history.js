/**
 * AE1 - undo / redo.
 *
 * Snapshot-based, not inverse-operation-based.
 *
 * DESIGN.md §11 wondered whether the journal could BE the undo stack. It cannot,
 * quite: the journal records the state AFTER each change, with no inverse and no
 * notion of where one user action ends. But its instinct was right -- undo works
 * off the same serialize() the journal writes, so there is exactly one
 * representation of a project state, and undo cannot drift from what is saved.
 *
 * Snapshots are whole-project (scene + HUD) and a point-and-click project is a
 * few KB of JSON, so 60 of them is well under a megabyte. Inverse operations
 * would be smaller and would need a correct undo for every mutation AE1 will ever
 * grow -- a bug farm, forever, in exchange for memory nobody is short of.
 */

const MAX = 60;

/** How long edits keep coalescing into one undo step. */
const COALESCE_MS = 450;

export class History {
  /**
   * @param {object} opts
   * @param {() => object} opts.capture   snapshot the current state
   * @param {(state: object) => void} opts.restore
   * @param {() => void} [opts.onChange]  fired when undo/redo availability changes
   */
  constructor({ capture, restore, onChange }) {
    this._capture = capture;
    this._restore = restore;
    this._onChange = onChange ?? null;

    /** @type {object[]} states, oldest first. The last is the present. */
    this._stack = [];
    this._index = -1;

    this._pending = null;
    this._timer = null;
    this._muted = false;
  }

  /** Seed with the loaded state. Nothing to undo back past this. */
  reset() {
    clearTimeout(this._timer);
    this._stack = [this._capture()];
    this._index = 0;
    this._pending = null;
    this._notify();
  }

  /**
   * Record that something changed.
   *
   * The BEFORE state is captured on the first change of a burst, and committed
   * once the burst ends. That is what makes a 200-pixel drag one undo step
   * instead of two hundred -- undo has to match what the user thinks they did,
   * not what the mouse did.
   */
  touch() {
    if (this._muted) return;

    if (!this._pending) {
      // The present is the state before this burst started.
      this._pending = this._stack[this._index];
    }

    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.commit(), COALESCE_MS);
  }

  commit() {
    clearTimeout(this._timer);
    if (!this._pending || this._muted) return;
    this._pending = null;

    const now = this._capture();
    const prev = this._stack[this._index];
    if (JSON.stringify(prev) === JSON.stringify(now)) return; // nothing actually moved

    // A new edit after undoing discards the redo branch. Keeping it would mean
    // two futures and no way to show which is which.
    this._stack.length = this._index + 1;
    this._stack.push(now);

    if (this._stack.length > MAX) this._stack.shift();
    this._index = this._stack.length - 1;
    this._notify();
  }

  get canUndo() {
    return this._index > 0;
  }

  get canRedo() {
    return this._index < this._stack.length - 1;
  }

  undo() {
    this.commit(); // an in-flight burst is a step; land it before stepping back
    if (!this.canUndo) return false;
    this._index--;
    this._apply();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._index++;
    this._apply();
    return true;
  }

  _apply() {
    // Restoring fires the same change events an edit does, which would push the
    // restored state back onto the stack as a new step. Mute while applying.
    this._muted = true;
    try {
      this._restore(structuredClone(this._stack[this._index]));
    } finally {
      this._muted = false;
      this._pending = null;
      clearTimeout(this._timer);
    }
    this._notify();
  }

  /** Run a block without recording it — used by play mode's own snapshot. */
  silence(fn) {
    this._muted = true;
    try {
      return fn();
    } finally {
      this._muted = false;
    }
  }

  _notify() {
    this._onChange?.({ canUndo: this.canUndo, canRedo: this.canRedo, depth: this._stack.length });
  }
}

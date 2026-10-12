/**
 * AE1 - save files.
 *
 * A save is JSON, and it is meant to be opened. Same instinct as readable
 * exports and loose .ags.txt: a modder editing their save in a text editor is
 * doing the encouraged thing (DESIGN.md, Principle 3).
 *
 * The format is an ENVELOPE, deliberately. Today it carries a timestamp and the
 * current scene; tomorrow it carries the inventory, per-scene state, or whatever
 * else. So the rules that matter are the ones that let it GROW:
 *
 *   - A version number, checked on load.
 *   - Unknown keys are preserved through a load/save round trip, so a save
 *     written by a newer build survives being loaded by an older one instead of
 *     being quietly stripped. Same reason AE1Element keeps `_extra`.
 *   - Every field except the envelope is optional. A loader must never require
 *     something a past version did not write.
 *
 * Where a save GOES is the host's business, not the engine's:
 *   editor  -> POSTs to the server, which writes /projects/<slug>/saves/
 *   shipped -> offers a download; the player keeps it beside the game
 * Both also mirror to localStorage as the convenience "continue" slot. A shipped
 * game has no server, so the file IS the durable copy. That is a real constraint
 * of a browser game, and leaning into it is what makes saves moddable.
 */

/** Bumped only when the shape changes in a way a loader must know about. */
export const SAVE_FORMAT = 1;

/** `SOMENAME.ae1save.json` — the type is JSON, the full suffix identifies it. Same idea as .ags.txt. */
export const SAVE_EXT = '.ae1save.json';

export class AE1Save {
  /**
   * @param {import('./world.js').AE1World} world
   * @param {object} [opts]
   * @param {object} [opts.game]   { id, title, version, engine }
   * @param {(data: object, name: string) => Promise<any>} [opts.write]
   *   Host-specific durable write. The editor POSTs to the server; a shipped
   *   game passes nothing and relies on download() instead.
   */
  constructor(world, { game = {}, write = null } = {}) {
    this.world = world;
    this.game = game;
    this._write = write;
  }

  /** Per-game, so two games on one origin never overwrite each other's slot. */
  get storageKey() {
    return `ae1.save.${this.game.id ?? this.game.title ?? 'game'}`;
  }

  /* -- capture ------------------------------------------------------------ */

  /**
   * Snapshot the world.
   *
   * @param {object} [extra] merged in — an author's own top-level fields
   */
  capture(extra = {}) {
    const data = {
      ae1: {
        engine: this.game.engine ?? "Angel's Egg",
        engineVersion: this.game.engineVersion ?? null,
        saveFormat: SAVE_FORMAT,
      },
      game: {
        id: this.game.id ?? null,
        title: this.game.title ?? null,
        version: this.game.version ?? null,
      },
      saved: new Date().toISOString(),

      // What actually restores the game. Everything else is future.
      scene: this.world?.sceneFile ?? null,
      sceneName: this.world?.scene?.name ?? null,

      // The author's open bag: `this.saveData.chapter = 2` in any script.
      // Open-ended by design — the engine never looks inside it.
      data: safeClone(this.world?.saveData ?? {}),

      ...extra,
    };

    // Hand it to the project's save handler, if it has one.
    //
    // The engine owns the envelope, the moment, and the ordering. The handler
    // owns the CONTENTS -- because the engine cannot know whether a door being
    // open matters in this game. A project with no handler saves exactly what it
    // saved before, so adding one is additive and never a migration.
    //
    // It mutates `data` directly rather than returning: an author writing
    // `save.doors = …` should not also have to remember to return the object.
    const handler = this.world?.saveHandler;
    if (handler?.capture) {
      try {
        handler.capture(data);
      } catch (err) {
        // A broken handler must not prevent saving. A save missing the doors is
        // recoverable; a save button that throws is not.
        console.error('[ags] SaveHandler.capture() threw:', err);
        data.captureError = String(err.message ?? err);
      }
    }

    return data;
  }

  /* -- validate ----------------------------------------------------------- */

  /**
   * Check a save before touching the world.
   *
   * Saves are meant to be hand-edited, so a malformed one is an ordinary event,
   * not an attack. Say what is wrong in terms the person editing it can act on.
   *
   * @returns {{ok: boolean, error?: string, warning?: string}}
   */
  validate(data) {
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'That file is not an AE1 save (expected a JSON object).' };
    }
    if (!data.ae1 || typeof data.ae1.saveFormat !== 'number') {
      return { ok: false, error: 'That file is not an AE1 save — no "ae1.saveFormat" field.' };
    }
    if (data.ae1.saveFormat > SAVE_FORMAT) {
      return {
        ok: false,
        error: `This save was written by a newer version of the engine (format ${data.ae1.saveFormat}, this build reads ${SAVE_FORMAT}).`,
      };
    }
    if (!data.scene) {
      return { ok: false, error: 'That save does not name a scene.' };
    }

    const result = { ok: true };

    // A different game's save is a warning, not a refusal: an author renaming or
    // re-creating a project should not be told their own save is invalid.
    if (this.game.id && data.game?.id && data.game.id !== this.game.id) {
      result.warning = `This save is from "${data.game.title ?? 'another game'}". Loading it anyway.`;
    }
    if (this.world && !this.world.resolveScene(data.scene)) {
      return { ok: false, error: `That save points at a scene this game does not have ("${data.scene}").` };
    }
    return result;
  }

  /* -- apply -------------------------------------------------------------- */

  /**
   * Restore a save into the world. Validate first.
   *
   * Unknown top-level keys are kept on `world.saveMeta` so a round trip through
   * an older build does not silently strip a newer build's fields.
   */
  apply(data) {
    const check = this.validate(data);
    if (!check.ok) return check;

    this.world.saveData = safeClone(data.data ?? {});
    this.world.pendingSceneState = {}; // a load supersedes any parked state

    const known = new Set(['ae1', 'game', 'saved', 'scene', 'sceneName', 'data']);
    this.world.saveMeta = Object.fromEntries(
      Object.entries(data).filter(([k]) => !known.has(k)),
    );

    // ORDER MATTERS, and this is the whole design:
    //
    //   1. goToScene FIRST — restore() wants to write to elements, and the
    //      elements of the saved scene do not exist until it loads.
    //   2. restore() SECOND — now there is something to write to.
    //
    // Reversed, a handler would restore a door in the scene the player was
    // leaving, and then that scene would be thrown away.
    this.world.goToScene(data.scene);

    const handler = this.world.saveHandler;
    if (handler?.restore) {
      try {
        handler.restore(data);
      } catch (err) {
        // The scene has already changed. Half a load beats a load that throws
        // and strands the player in the menu.
        console.error('[ags] SaveHandler.restore() threw:', err);
        return { ok: true, warning: `The save handler failed: ${err.message}` };
      }
    }

    return check;
  }

  /* -- localStorage -------------------------------------------------------- */
  //
  // The convenience slot: "Continue". Never the durable copy — a shipped game on
  // file:// shares an origin with every other local page, and incognito wipes it.
  // The file is the real save.

  toLocal(data) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
      return true;
    } catch {
      return false; // private mode, quota, blocked. Not worth surfacing.
    }
  }

  fromLocal() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  hasLocal() {
    return Boolean(this.fromLocal());
  }

  clearLocal() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }

  /* -- files --------------------------------------------------------------- */

  suggestName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (this.game.title ?? 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `${slug}-${stamp}${SAVE_EXT}`;
  }

  /** Hand the player a file. The durable copy in a shipped game. */
  download(data, name = this.suggestName()) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  /**
   * Ask the player for a save file.
   *
   * A file picker, not a fetch: a shipped game runs from file:// where fetch is
   * blocked, and the player's saves live wherever they put them. This is the only
   * way in, and it is the same way in both hosts.
   *
   * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
   */
  pick() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';

      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve({ ok: false, error: 'No file chosen.' });

        try {
          const data = JSON.parse(await file.text());
          resolve({ ok: true, data });
        } catch (err) {
          resolve({ ok: false, error: `That file is not valid JSON: ${err.message}` });
        }
      });

      // A cancelled picker fires no event in most browsers, so this promise would
      // hang forever. Nothing depends on the resolution, but a leaked <input> and
      // a pending promise per cancel is not free.
      window.addEventListener(
        'focus',
        () => setTimeout(() => {
          if (!input.files?.length) {
            input.remove();
            resolve({ ok: false, error: null }); // cancelled: not an error
          }
        }, 500),
        { once: true },
      );

      document.body.append(input);
      input.click();
    });
  }

  /** Pick a file, validate it, and apply it. The whole "Load Game" flow. */
  async loadFromFile() {
    const picked = await this.pick();
    if (!picked.ok) return picked;

    const result = this.apply(picked.data);
    // Uploading a save overwrites the continue slot: the player's explicit choice
    // beats whatever was there.
    if (result.ok) this.toLocal(picked.data);
    return result;
  }
}

/** structuredClone, but never throw on a function or a DOM node an author stashed. */
function safeClone(value) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return {};
    }
  }
}

/**
 * AE1 - the save handler.
 *
 * `(extends SaveHandler)`. A world-level element, living in the HUD layer, that
 * decides WHAT a save contains. The engine owns the envelope, the moment, and
 * the ordering; the handler owns the contents.
 *
 * That split is the whole point. The engine cannot know what matters in your
 * game -- whether a door being open is worth remembering, whether an NPC's mood
 * is state or scenery. So it stops guessing and asks:
 *
 *   capture(save)   -> called while a save is being written. Put things in.
 *   restore(save)   -> called while one is being loaded. Take them out.
 *
 * Both are plain Angel Script. A project with no handler saves exactly what it
 * saves today (timestamp, scene, saveData) -- adding one is additive, never a
 * migration.
 *
 * It lives in the HUD layer because it must outlive every scene: a handler
 * destroyed and rebuilt on each scene change could not restore the scene it was
 * rebuilt for. Same reasoning as the inventory (DESIGN.md §12).
 */

import { AE1HudElement } from './hud.js';
import { defineDatAccessors } from './element.js';

export class AE1SaveHandler extends AE1HudElement {
  /* -- the two hooks an author overrides ---------------------------------- */

  /**
   * Add to the save. Override me.
   * @param {object} _save the save being written — mutate it freely
   */
  capture(_save) {}

  /**
   * Read from the save. Override me.
   *
   * Runs AFTER the scene has loaded, so the elements you want to restore exist.
   * Anything for a scene the player is not currently in is deferred until they
   * walk into it — see restoreElements().
   *
   * @param {object} _save
   */
  restore(_save) {}

  /* -- helpers ------------------------------------------------------------ */
  //
  // The obvious things an author would otherwise write badly. Every one is
  // optional; capture(save) can do anything at all.

  /** The inventory's items, or null if the project has none. */
  captureInventory() {
    const inv = this.world?.inventory;
    return inv ? inv.items.map((i) => ({ ...i })) : null;
  }

  restoreInventory(items) {
    const inv = this.world?.inventory;
    if (!inv || !Array.isArray(items)) return false;
    inv.clear();
    for (const item of items) inv.add(item);
    return true;
  }

  /**
   * Capture named properties of one element.
   *
   * Records which scene it came from, because a name alone is ambiguous across
   * scenes and a restore has to know where to put it back.
   */
  captureElement(nameOrElement, keys) {
    const el = typeof nameOrElement === 'string' ? this.find(nameOrElement) : nameOrElement;
    if (!el) return null;

    const props = {};
    for (const key of keys ?? []) {
      if (el[key] !== undefined) props[key] = el[key];
    }
    return {
      scene: this.world?.hud?.get(el.id) ? '@hud' : this.world?.sceneFile,
      name: el.name,
      props,
    };
  }

  captureElements(namesOrElements, keys) {
    return (namesOrElements ?? [])
      .map((n) => this.captureElement(n, keys))
      .filter(Boolean);
  }

  /**
   * Capture every element in the current scene that has any of these properties.
   *
   * A sensible default: it records only what exists, so adding a `locked` to one
   * door does not require listing it anywhere. Nothing is captured from elements
   * that never had the property.
   */
  captureScene(keys) {
    const out = [];
    for (const el of this.world?.scene?.all() ?? []) {
      const entry = this.captureElement(el, keys);
      if (entry && Object.keys(entry.props).length) out.push(entry);
    }
    return out;
  }

  /** Same, for the persistent layer. */
  captureHud(keys) {
    const out = [];
    for (const el of this.world?.hud?.all() ?? []) {
      if (el === this) continue; // a handler saving itself is a fine way to go mad
      const entry = this.captureElement(el, keys);
      if (entry && Object.keys(entry.props).length) out.push(entry);
    }
    return out;
  }

  /**
   * Put captured properties back.
   *
   * Entries for the CURRENT scene (or the HUD) apply now. Entries for other
   * scenes are handed to the world, which applies them when the player walks
   * into that scene -- because those elements do not exist yet, and inventing
   * them would be worse than waiting.
   */
  restoreElements(entries) {
    if (!Array.isArray(entries)) return 0;
    let applied = 0;

    for (const entry of entries) {
      if (!entry?.name || !entry.props) continue;

      const here =
        entry.scene === '@hud' ||
        entry.scene === this.world?.sceneFile ||
        !entry.scene;

      if (here) {
        const el =
          entry.scene === '@hud'
            ? this.world?.hud?.findByName(entry.name)
            : this.world?.scene?.findByName(entry.name);
        if (el) {
          Object.assign(el, entry.props);
          applied++;
        }
        continue;
      }

      this.world?.deferSceneState(entry.scene, entry.name, entry.props);
    }
    return applied;
  }
}

AE1SaveHandler.agsDef = {
  name: 'SaveHandler',
  extends: null,
  runInfo: {},
};

AE1SaveHandler.agsDat = {};

defineDatAccessors(AE1SaveHandler);

/**
 * Draw nothing, ever.
 *
 * A save handler is machinery, not scenery. Without this it would fall through
 * to the renderer's coloured-block placeholder and paint a rectangle over the
 * game. Select it from the Outliner; it has no business on screen.
 */
AE1SaveHandler.prototype.draw = function draw() {};

/**
 * AE1 - AE1Scene.
 *
 * A scene is a JavaScript object holding elements, which are JavaScript objects.
 * Nothing more exotic than that (DESIGN.md 5).
 *
 * Shared by the editor and the exported game (Principle 2). Anything editor-only
 * -- selection, undo, journaling -- lives in the editor's store, not here.
 */

import { AE1Element, uuid } from './element.js';

export class AE1Scene {
  /**
   * @param {object} data  parsed scene JSON
   * @param {object} [opts]
   * @param {(el, key, value, old) => void} [opts.onChange]  fires on any element mutation
   */
  constructor(data = {}, { onChange, world = null } = {}) {
    this.id = data.id ?? uuid();
    this.name = data.name ?? 'Scene';
    this._onChange = onChange ?? null;

    /** The AE1World this scene belongs to. Handed down to every element. */
    this.world = world;

    /** @type {Map<string, AE1Element>} */
    this.elements = new Map();

    for (const raw of Object.values(data.elements ?? {})) {
      const el = new AE1Element(raw, { onChange: this._notify });
      el._world = world;
      this.elements.set(el.id, el);
    }
  }

  /**
   * Point this scene and everything in it at a world.
   *
   * Elements reach the engine's services (audio, inventory, scene changes)
   * through `this.world`, so an element without one has a standard library of
   * no-ops. Assigning here rather than in the element constructor means the world
   * can be attached after load, which is what rehydration needs.
   */
  setWorld(world) {
    this.world = world;
    for (const el of this.elements.values()) el._world = world;
    return this;
  }

  // Bound so it can be handed to every element without per-element closures.
  _notify = (el, key, value, old) => {
    this._onChange?.(el, key, value, old);
  };

  /* -- access -------------------------------------------------------------- */

  get(id) {
    return this.elements.get(id) ?? null;
  }

  get size() {
    return this.elements.size;
  }

  all() {
    return [...this.elements.values()];
  }

  /** Root-level elements, sorted for stable display. */
  roots() {
    return this.sorted(this.all().filter((e) => !e.parent));
  }

  childrenOf(id) {
    return this.sorted(this.all().filter((e) => e.parent === id));
  }

  /**
   * Hierarchy is stored as a `parent` id on the child, never as a `children`
   * array on the parent. One direction only -- two directions means two things
   * that can disagree, and reparenting would have to update both atomically.
   */
  sorted(list) {
    return list.sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
  }

  /* -- mutation ------------------------------------------------------------ */

  add(element) {
    const el = element instanceof AE1Element ? element : new AE1Element(element, { onChange: this._notify });
    el._onChange = this._notify;
    el._world = this.world;
    this.elements.set(el.id, el);
    this._notify(el, '@add', el, null);
    return el;
  }

  /** Find by name, case-insensitively. What `this.find("Bram")` calls. */
  findByName(name) {
    const wanted = String(name).toLowerCase();
    return this.all().find((e) => e.name?.toLowerCase() === wanted) ?? null;
  }

  /**
   * Remove an element and everything under it.
   *
   * Descendants are removed too. Orphaning children by leaving a dangling
   * `parent` id would make them invisible in the Outliner (nothing lists them)
   * while still rendering in the viewport -- a ghost the user cannot select or
   * delete.
   */
  remove(id) {
    const el = this.get(id);
    if (!el) return false;

    for (const child of this.childrenOf(id)) this.remove(child.id);

    el.onUnload?.();
    this.elements.delete(id);
    this._notify(el, '@remove', null, el);
    return true;
  }

  /**
   * Swap an element for a new instance with the same id.
   *
   * Used when a script compiles and an element must be rebuilt on its compiled
   * class -- the moment a plain AE1Element becomes a Door. Identity is preserved,
   * so selection, hierarchy, and every `parent` reference survive intact.
   */
  replace(element) {
    element._onChange = this._notify;
    element._world = this.world;
    this.elements.set(element.id, element);
    return element;
  }

  /** Reparent, refusing to build a cycle. */
  reparent(id, parentId) {
    const el = this.get(id);
    if (!el || id === parentId) return false;

    // Walking up from the prospective parent must never reach the moved element,
    // or the tree becomes a ring and every traversal hangs forever.
    let walk = parentId;
    while (walk) {
      if (walk === id) return false;
      walk = this.get(walk)?.parent ?? null;
    }

    el.parent = parentId ?? null;
    this._notify(el, 'parent', parentId, null);
    return true;
  }

  /* -- lifecycle ----------------------------------------------------------- */

  /**
   * Fire onLoad on every element.
   *
   * For driving a bare scene with no world. A world does NOT use this — it
   * dispatches through the scheduler tables (runInfo), which is what lets an
   * author name the method whatever they like. This calls a method literally
   * named `onLoad`, which only the base class defines.
   */
  load() {
    for (const el of this.all()) el.onLoad?.();
  }

  unload() {
    for (const el of this.all()) el.onUnload?.();
  }

  /* -- serialization ------------------------------------------------------- */

  serialize() {
    const elements = {};
    for (const [id, el] of this.elements) elements[id] = el.serialize();
    return { id: this.id, name: this.name, elements };
  }
}

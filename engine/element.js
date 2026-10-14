/**
 * AE1 - AE1Element, the base of everything in a scene.
 *
 * This file lives in /engine, not /editor, because the editor and the exported
 * game must use the SAME element class (DESIGN.md, Principle 2). If the editor
 * had its own idea of what an element is, "works in the editor, breaks in export"
 * becomes possible again -- the worst failure mode a game engine can have.
 *
 * The property set is drawn from java.lang.Object (identity), a commercial engine's AActor
 * (transform, lifecycle, tags), and Blender's 2D plane object (dimensions,
 * parent, visibility). Those three converged over decades on what an object in a
 * scene needs to be; there is no value in disagreeing with them.
 */

/**
 * The schema is the single source of truth for the element's shape.
 *
 * It generates, from this one declaration:
 *   - the properties themselves, as real accessors
 *   - getX()/setX() pairs
 *   - the Properties panel UI
 *   - defaults
 *   - serialization
 *
 * Adding a property to an element means adding one line here. Nothing else in
 * AE1 has to learn about it. This is the same instinct as `runInfo` living in the
 * def block: declare it once, let the machinery read the declaration.
 */
export const ELEMENT_SCHEMA = {
  // Empty on purpose. A non-empty default would be truthy and silently shadow the
  // generated name in the constructor, so every element would arrive called
  // "Element" -- an Outliner of identical rows, which is no Outliner at all.
  name: { group: 'Identity', label: 'Name', type: 'string', default: '' },
  type: {
    group: 'Identity',
    label: 'Type',
    type: 'enum',
    options: ['element', 'background', 'character', 'object', 'region', 'audio'],
    default: 'element',
  },
  tags: { group: 'Identity', label: 'Tags', type: 'tags', default: () => [] },

  // Transform. The base carries a full 3D transform; 2D is the z=0 / xy-plane
  // subset (DESIGN.md §18). `dim` marks a field's world: '2d'/'3d' fields are
  // hidden in the other project type, unmarked ones show in both. `rotation` is
  // the Z rotation in both worlds — 2D's only axis, and one of three in 3D.
  x: { group: 'Transform', label: 'X', type: 'number', default: 0, step: 1 },
  y: { group: 'Transform', label: 'Y', type: 'number', default: 0, step: 1 },
  z: { group: 'Transform', label: 'Z', type: 'number', default: 0, step: 0.1, dim: '3d' },
  layer: { group: 'Transform', label: 'Layer', type: 'number', default: 0, step: 1, dim: '2d' },
  rotation: { group: 'Transform', label: 'Rotation', type: 'number', default: 0, step: 1, unit: '°' },
  rotationX: { group: 'Transform', label: 'Rotation X', type: 'number', default: 0, step: 1, unit: '°', dim: '3d' },
  rotationY: { group: 'Transform', label: 'Rotation Y', type: 'number', default: 0, step: 1, unit: '°', dim: '3d' },
  scaleX: { group: 'Transform', label: 'Scale X', type: 'number', default: 1, step: 0.01 },
  scaleY: { group: 'Transform', label: 'Scale Y', type: 'number', default: 1, step: 0.01 },
  scaleZ: { group: 'Transform', label: 'Scale Z', type: 'number', default: 1, step: 0.01, dim: '3d' },

  width: { group: 'Dimensions', label: 'Width', type: 'number', default: 128, step: 1, min: 0, dim: '2d' },
  height: { group: 'Dimensions', label: 'Height', type: 'number', default: 128, step: 1, min: 0, dim: '2d' },

  visible: { group: 'Render', label: 'Visible', type: 'bool', default: true },
  // §18.53 distance culling / LOD pairs: hide the bound object when the
  // camera is farther than `cullDistance` (0 = never) or closer than
  // `cullDistanceMin` (0 = never). A full-detail tile (cullDistance D) and
  // its decimated twin (cullDistanceMin D) are exact complements — the
  // renderer's 1 Hz sweep flips visibility, both stay resident, no rebuild.
  cullDistance: { group: 'Render', label: 'Cull Beyond', type: 'number', default: 0, step: 10, min: 0, dim: '3d' },
  cullDistanceMin: { group: 'Render', label: 'Cull Within', type: 'number', default: 0, step: 10, min: 0, dim: '3d' },
  opacity: { group: 'Render', label: 'Opacity', type: 'number', default: 1, min: 0, max: 1, step: 0.01, dim: '2d' },
  flipH: { group: 'Render', label: 'Flip H', type: 'bool', default: false, dim: '2d' },
  flipV: { group: 'Render', label: 'Flip V', type: 'bool', default: false, dim: '2d' },
};

/** Ordered so the Properties panel is stable and predictable. */
export const SCHEMA_GROUPS = ['Identity', 'Transform', 'Dimensions', 'Render'];

/**
 * The shape of the optional component bags.
 *
 * The same instinct as ELEMENT_SCHEMA, applied to the half of an element that
 * was invisible: components had no declaration anywhere, so the Properties panel
 * could not show them. A sprite could be set ONLY by dropping media onto the
 * viewport, and nothing could edit it afterwards.
 *
 * Base properties are what every element HAS; components are what an element MAY
 * have (see the note at the foot of this file). A component is absent until
 * something gives it a value -- an element with no sprite has no sprite bag, not
 * an empty one, because "absent" and "blank" must not be the same state.
 *
 * `frameWidth`/`frameHeight` are what make an image a spritesheet: zero means an
 * ordinary picture. The renderer reads these directly (engine/renderer.js:
 * frameRect); AE1Sprite (engine/sprite.js) only drives `frame` on a clock.
 */
export const COMPONENT_SCHEMA = {
  sprite: {
    label: 'Sprite',
    dim: '2d',
    fields: {
      // A media NAME, resolved at draw time -- never a hash typed by hand.
      media: { label: 'Image', type: 'media', default: '' },
      frameWidth: { label: 'Frame W', type: 'number', default: 0, step: 1, min: 0 },
      frameHeight: { label: 'Frame H', type: 'number', default: 0, step: 1, min: 0 },
      // 0 derives the column count from the image width. An author who cuts a
      // sheet into 64px frames should not also have to do the division.
      columns: { label: 'Columns', type: 'number', default: 0, step: 1, min: 0 },
      frame: { label: 'Frame', type: 'number', default: 0, step: 1, min: 0 },
    },
  },

  // A piece of glTF geometry. `media` is the .glb NAME; `node` is which node
  // inside it this element draws -- so one imported scene .glb backs many
  // elements, each pointing at its own object (DESIGN.md §18). Parallel to the
  // sprite component: the media is shared, the element picks its part of it.
  model: {
    label: 'Model',
    dim: '3d',
    fields: {
      media: { label: 'File', type: 'media', default: '' },
      node: { label: 'Node', type: 'string', default: '' },
      // Animation STATE, the way Sprite's `frame` is state: the element says which
      // clip it wants, the 3D renderer's AnimationMixer plays it. Empty `clip`
      // means "the first clip in the file" — so a decomposed character idles with
      // no config. A script drives it with this.playAnimation(name) (DESIGN.md §18).
      clip: { label: 'Animation', type: 'string', default: '' },
      loop: { label: 'Loop', type: 'bool', default: true },
      speed: { label: 'Speed', type: 'number', default: 1, step: 0.1 },
      // Where playback begins, in SECONDS into the clip (a "custom frame":
      // frame / fps). Applied when the clip (re)starts, ignored mid-play.
      start: { label: 'Start (s)', type: 'number', default: 0, step: 0.05 },
    },
  },

  // A light. Kind decides which fields matter (cone angle is spot-only, etc.);
  // the union lives here and the renderer reads what the kind uses. Intensity is
  // AE1's own friendly scale, NOT glTF candela -- decomposition converts.
  light: {
    label: 'Light',
    dim: '3d',
    fields: {
      kind: { label: 'Kind', type: 'enum', options: ['point', 'spot', 'directional', 'ambient', 'hemisphere'], default: 'point' },
      color: { label: 'Color', type: 'string', default: '#ffffff' },
      intensity: { label: 'Intensity', type: 'number', default: 1, step: 0.1, min: 0 },
      angle: { label: 'Cone °', type: 'number', default: 30, step: 1, min: 0, max: 90 },
      penumbra: { label: 'Penumbra', type: 'number', default: 0, step: 0.05, min: 0, max: 1 },
      distance: { label: 'Range', type: 'number', default: 0, step: 0.5, min: 0 },
    },
  },

  // A particle EFFECT (§18.22). The kind picks a preset the 3D renderer owns
  // (textures are generated on a canvas at boot — soft radial gradients, no
  // media files). Anchoring: host element + a node/socket inside it, plus a
  // node-frame offset; empty host = the element's own transform.
  fx: {
    label: 'Particles',
    dim: '3d',
    fields: {
      kind: { label: 'Effect', type: 'enum', options: ['flame', 'smoke', 'splash', 'explosion'], default: 'smoke' },
      loop: { label: 'Loop', type: 'bool', default: true },
      host: { label: 'Host element', type: 'string', default: '' },
      node: { label: 'Socket/bone', type: 'string', default: '' },
      ox: { label: 'Offset X', type: 'number', default: 0, step: 0.05 },
      oy: { label: 'Offset Y', type: 'number', default: 0, step: 0.05 },
      oz: { label: 'Offset Z', type: 'number', default: 0, step: 0.05 },
      scale: { label: 'Scale', type: 'number', default: 1, step: 0.1, min: 0 },
    },
  },
};

/**
 * A UUID, from the best source available.
 *
 * `crypto.randomUUID` is gated behind a secure context. An exported AE1 game is
 * meant to run by double-clicking index.html, and while file:// is specified as
 * potentially trustworthy, that is not something to bet a shipped game on: if it
 * were ever unavailable, the game would die the moment a script spawned an
 * element. getRandomValues is not gated, and Math.random is a last resort — for
 * element ids, unpredictability is not a requirement, uniqueness is.
 */
export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Structural keys the element owns explicitly; never treated as unknown data. */
const RESERVED = new Set(['id', 'extends', 'parent', 'script', 'components']);

const defaultFor = (def) => (typeof def.default === 'function' ? def.default() : def.default);

/**
 * Value equality for dat.
 *
 * JSON comparison is exactly right here and nowhere else: dat values come from
 * the s-expression reader, so they are only ever numbers, strings, booleans,
 * null, and arrays of those. There is no cycle, no Date, and no key order to
 * disagree about.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export class AE1Element {
  /**
   * @param {object} data  plain JSON from a scene file
   * @param {object} [opts]
   * @param {(el: AE1Element, key: string, value: any, old: any) => void} [opts.onChange]
   */
  constructor(data = {}, { onChange } = {}) {
    // Values live here, behind the accessors defined below. Never touched
    // directly outside this class.
    this._props = {};
    this._onChange = onChange ?? null;

    /** Immutable. An element's id is its identity for the life of the project. */
    Object.defineProperty(this, 'id', {
      value: data.id ?? uuid(),
      enumerable: true,
      writable: false,
    });

    /** Prototype-chain parent, by element id. Resolved by the scene. */
    this.extends = data.extends ?? null;

    /** Hierarchy parent, by element id. Distinct from `extends`. */
    this.parent = data.parent ?? null;

    /** Optional data bags: sprite, collider, audio. See the note below. */
    this.components = data.components ?? {};

    /** Attached Angel Script filename, if any. */
    this.script = data.script ?? null;

    for (const [key, def] of Object.entries(ELEMENT_SCHEMA)) {
      this._props[key] = data[key] !== undefined ? data[key] : defaultFor(def);
    }

    // Seed Angel Script `dat` properties.
    //
    // `new.target` is the class actually being constructed, so a compiled AGS
    // subclass carries its own (and its ancestors') dat here without AE1Element
    // needing to know AGS exists. The saved scene wins over the declared default,
    // which is what makes dat a DEFAULT rather than a constant.
    const agsDat = new.target?.agsDat ?? null;
    this._agsKeys = agsDat ? Object.keys(agsDat) : [];
    for (const key of this._agsKeys) {
      if (key in ELEMENT_SCHEMA) continue;
      this._props[key] =
        data[key] !== undefined ? data[key] : structuredClone(agsDat[key]);
    }

    // Preserve any key we don't recognise.
    //
    // Defense in depth against silent data loss. If an element is constructed
    // without its compiled class -- a broken script, a class that hasn't loaded
    // yet, a scene written by a newer AE1 -- its dat values would otherwise be
    // dropped on the next serialize. An element must never delete data merely
    // because it does not currently understand it.
    this._extra = {};
    for (const [key, value] of Object.entries(data)) {
      if (key in ELEMENT_SCHEMA || RESERVED.has(key)) continue;
      if (this._agsKeys.includes(key)) continue;
      this._extra[key] = value;
    }

    // A generated name beats an empty one -- an unnamed row in the Outliner is
    // useless, and the spec calls for a random name when none is given.
    if (!this._props.name) {
      this._props.name = `${cap(this._props.type)} ${this.id.slice(0, 4)}`;
    }
  }

  /* -- lifecycle (overridden by AGS methods) ----------------------------- */

  onLoad() {}
  onUnload() {}
  onTick(_dt) {}

  /* -- java.lang.Object ---------------------------------------------------- */

  toString() {
    return `${this.constructor.name}("${this.name}" ${this.id.slice(0, 8)})`;
  }

  /** Identity comparison. Two elements are equal iff they are the same element. */
  equals(other) {
    return other instanceof AE1Element && other.id === this.id;
  }

  clone() {
    const data = this.serialize();
    delete data.id; // a clone is a new identity, not a copy of one
    data.name = `${this.name} copy`;
    return new AE1Element(data, { onChange: this._onChange });
  }

  /* -- serialization ------------------------------------------------------- */

  serialize() {
    const out = {
      // Unknown keys first, so nothing here can shadow a real property.
      ...(this._extra ?? {}),
      id: this.id,
      extends: this.extends,
      parent: this.parent,
      script: this.script,
    };
    for (const key of Object.keys(ELEMENT_SCHEMA)) out[key] = this._props[key];

    // dat values are live state, not just declarations -- but persist ONLY what
    // differs from the script's declared default.
    //
    // Writing every dat key made a script's declaration decorative: the moment an
    // element was saved, its values were baked into the scene file, and editing
    // `(trackProps …)` in the script changed nothing forever after. The author
    // edits the design and sees no effect, with nothing to explain why.
    //
    // Persisting only differences gives the semantics you actually want:
    //   never touched -> absent -> follows the script, including later edits
    //   customised    -> present -> your value survives a script edit
    // and it makes scene files smaller besides.
    const declared = this.constructor?.agsDat ?? {};
    for (const key of this._agsKeys ?? []) {
      if (key in ELEMENT_SCHEMA) continue;
      const value = this._props[key];
      if (sameValue(value, declared[key])) continue;
      out[key] = value;
    }

    if (Object.keys(this.components).length) out.components = this.components;
    return out;
  }

  /* -- the Angel Script standard library ---------------------------------- */
  //
  // Everything below is what an author actually writes: `this.say(...)`,
  // `this.playSound(...)`, `this.goToScene(...)`. They delegate to the world,
  // which the scene assigns.
  //
  // Every call guards the METHOD, not just the world: `world?.goToScene?.(…)`.
  //
  // That is not belt-and-braces. The editor provides a deliberately partial world
  // — media resolution and the two layers, but no goToScene and no audio, because
  // a script must not change scenes or start music while the author is arranging
  // furniture. Guarding only `world?.` assumed the world is all-or-nothing, and
  // threw a TypeError the moment a partial one appeared. A script must never
  // explode because a capability is absent; absent means no-op.

  /** The AE1World this element belongs to, if any. */
  get world() {
    return this._world ?? null;
  }

  /**
   * Am I on the persistent layer?
   *
   * Asked of the world, not stored as a flag. Persistence comes from WHICH SCENE
   * an element lives in (hud.json vs scenes/), never from its class -- so a flag
   * set by AE1HudElement's constructor was decorative at best and a lie at worst:
   * `(extends Text)` on a HUD element would have reported false while persisting
   * perfectly well. This getter cannot drift from the truth because it asks.
   */
  get isHud() {
    return Boolean(this.world?.hud?.get(this.id));
  }

  /**
   * Say a line. Point-and-click is mostly looking at things and being told about
   * them, so this is the most-used call in the library.
   */
  say(text) {
    // Route through the project's DialogueBox when it has one, so a line is drawn
    // on the canvas -- letterboxed, layered, and identical in the editor and the
    // export. Without a box this is exactly what it always was.
    //
    // The notify fires either way: the editor's Console is a debug view of
    // everything said, and a shipped game's DOM fallback listens here. game.js
    // suppresses that fallback when a box exists, or every line would show twice.
    this.world?.dialogueBox?.say?.(text, this);
    this._notify('@say', text, null);
    return text;
  }

  /** Another element in this scene (or the HUD), by name. Case-insensitive. */
  find(name) {
    return (
      this.world?.find?.(name) ??
      this.world?.scene?.findByName?.(name) ??
      this.world?.hud?.findByName?.(name) ??
      null
    );
  }

  /** Leave for another scene. Accepts a scene name or its file. */
  goToScene(nameOrFile) {
    return this.world?.goToScene?.(nameOrFile) ?? false;
  }

  /** INSTANCING (§18.46) — spawn a live copy of a prototype element with
   *  overrides: `this.spawnInstance("RuntProto", {x: 4, z: -2, health: 30})`.
   *  Returns the new element (or null). `instancesOf(name)` queries every
   *  live instance spawned from that prototype. `setTint("#40ff90")` colors
   *  THIS element's textures without touching any other instance's. */
  spawnInstance(protoNameOrEl, overrides) {
    return this.world?.spawnInstance?.(protoNameOrEl, overrides) ?? null;
  }

  instancesOf(protoName) {
    return this.world?.instancesOf?.(protoName) ?? [];
  }

  setTint(hex) {
    this.setComponent('model', 'tint', hex ? String(hex) : null);
  }

  /** TIME EFFECTS (§18.41) — scripts get the same impact toys the engine
   *  uses: `this.hitStop()` on a landed blow, `this.slowMo()` for a finisher.
   *  Both no-op cleanly outside play (no loop, no effect). */
  hitStop(hold, scale) {
    this.world?.loop?.hitStop?.(hold, scale);
  }

  slowMo(hold, scale, ease) {
    this.world?.loop?.slowMo?.(hold, scale, ease);
  }

  /**
   * Play a one-shot. Takes a media NAME ("bram-hey.mp3") because that is what
   * an author sees in the Media Collection; hashes are an implementation detail
   * they should never have to type.
   */
  playSound(nameOrHash, opts) {
    return this.world?.playSound?.(nameOrHash, opts) ?? null;
  }

  /**
   * A VOICE line from THIS element (§18.29): registered and tagged in
   * `world.voices` so voice-aware systems can see it — and ONE per element:
   * speaking again CUTS this element's previous line first. A dying goober
   * must not keep growling under its own death cry, and a door's creak must
   * count as the door talking. Effects that should layer stay on playSound.
   */
  voiceLine(nameOrHash, { volume = 1 } = {}) {
    const world = this.world;
    const audio = world?.playSound?.(nameOrHash, { volume });
    if (!audio) return null;
    world.voices ??= new Set();
    for (const v of [...world.voices]) {
      if (v.el === this) {
        v.audio.pause();
        v.audio.src = '';
        world.voices.delete(v);
      }
    }
    const voice = { el: this, audio, base: volume, name: String(nameOrHash) };
    world.voices.add(voice);
    const drop = () => world.voices.delete(voice);
    audio.addEventListener('ended', drop, { once: true });
    audio.addEventListener('error', drop, { once: true });
    return voice;
  }

  /** Play looping music. Re-requesting the same track does not restart it. */
  playMusic(nameOrHash, opts) {
    return this.world?.playMusic?.(nameOrHash, opts) ?? null;
  }

  stopMusic() {
    this.world?.audio?.stopMusic?.();
  }

  /**
   * Set how loud the music is HERE, 0..1, multiplied onto the player's volume.
   *
   * For a scene that should be quieter or louder than the rest — a hushed room, a
   * loud one — without touching the player's own volume preference. Fades the
   * playing track smoothly; the level persists, so it also shapes the next track.
   */
  setMusicLevel(level, opts) {
    return this.world?.audio?.setSceneLevel?.(level, opts) ?? level;
  }

  /** The project's inventory, if one exists in the HUD. */
  get inventory() {
    return this.world?.inventory ?? null;
  }

  /**
   * Grant an item. `give("brass_key")` or `give({id, name, icon: "key.png"})`.
   *
   * The icon is resolved from a media NAME here, so what an author writes in dat
   * is what they see in the Media Collection. Storing the resolved hash means the
   * item keeps working after the asset is renamed -- content addressing earning
   * its keep again.
   */
  give(item) {
    if (!this.inventory) return null;
    if (typeof item === 'string') return this.inventory.add(item);

    const entry = { ...item };
    if (entry.icon) {
      const resolved = this.world?.resolveMedia(entry.icon);
      if (resolved) {
        entry.icon = resolved.hash;
        entry.ext = resolved.ext;
      }
      // Unresolved icons are left as-is rather than dropped: the inventory
      // resolves again at draw time, and an item with a bad icon should still
      // appear (as its initial) rather than vanish.
    }
    return this.inventory.add(entry);
  }

  /** Remove an item from the inventory. */
  take(id) {
    return this.inventory?.remove(id) ?? null;
  }

  /**
   * Does the player hold this item?
   *
   * Defined on every element, not just the player, so `actor.has("brass_key")`
   * reads naturally in a door's script while still consulting the one inventory.
   */
  has(id) {
    return this.inventory?.has(id) ?? false;
  }

  /* -- saving ------------------------------------------------------------- */

  /**
   * The game's open save bag. Anything you put here goes into the save file.
   *
   *   this.saveData.chapter = 2;
   *   if (this.saveData.metBram) { … }
   *
   * The engine never looks inside it. That is the point: what a save MEANS is the
   * author's business, and the format is an envelope around this.
   */
  get saveData() {
    return this.world?.saveData ?? {};
  }

  /**
   * Save the game.
   *
   * In the editor it lands in /saves silently. In a shipped game the player is
   * handed a file — a browser game has no server to write to, and the file is
   * what makes saves moddable.
   */
  saveGame(extra) {
    return this.world?.saveGame?.(extra) ?? Promise.resolve({ ok: false, error: 'No world.' });
  }

  /** Ask the player for a save file and load it. The "Load Game" button. */
  loadGame() {
    return this.world?.loadGame?.() ?? Promise.resolve({ ok: false, error: 'No world.' });
  }

  /** Resume from the localStorage slot. The "Continue" button. */
  continueGame() {
    return this.world?.continueGame?.() ?? { ok: false, error: 'No world.' };
  }

  /** Is there anything to continue from? Grey out "Continue" with this. */
  hasSavedGame() {
    return this.world?.hasSavedGame?.() ?? false;
  }

  /* -- settings ----------------------------------------------------------- */

  /**
   * How this player likes their games. NOT part of a save.
   *
   * A save is a moment in a playthrough; settings are a preference. Loading a
   * six-month-old save must not reset someone's volume.
   *
   *   this.settings.musicVolume        // read
   *   this.setSetting("musicVolume", 0.4)   // set + apply + persist
   *
   * The engine reads musicVolume, soundVolume, and muted. Everything else in
   * here is yours.
   */
  get settings() {
    return this.world?.settings ?? {};
  }

  setSetting(key, value) {
    return this.world?.setSetting?.(key, value) ?? value;
  }

  resetSettings() {
    return this.world?.resetSettings?.() ?? {};
  }

  /**
   * Play a clip on this model's skeleton. `play("idle")`, `play("walk")`.
   *
   * The state machine is the SCRIPT: onLoad plays idle, onClick plays wave, and
   * so on. This only records the intent on the `model` component; the 3D renderer
   * (the editor viewport now, the shipped game later) reads it and cross-fades its
   * AnimationMixer — the same split as Sprite, where the element sets `frame` and
   * the renderer draws it. A clip name the file does not have is a no-op with a
   * warning, never a throw.
   */
  playAnimation(name, { loop = true, speed = 1, start = 0, end = 0, fade = 0.3 } = {}) {
    if (!this.components?.model) return false;
    this.setComponent('model', 'loop', loop !== false);
    this.setComponent('model', 'speed', Number(speed) || 1);
    // Seconds into the clip to begin at — a "custom frame" is frame / fps.
    this.setComponent('model', 'start', Math.max(0, Number(start) || 0));
    // Trimmed tail (§18.35): 0 = the clip's real end.
    this.setComponent('model', 'end', Math.max(0, Number(end) || 0));
    // Crossfade seconds into this clip. 0 = HARD CUT — required when the swap
    // must be exact (a turn clip handing its root rotation to the heading).
    this.setComponent('model', 'fade', Math.max(0, Number(fade) || 0));
    this.setComponent('model', 'clip', String(name ?? '')); // last: the change the renderer keys on
    return true;
  }

  /** Freeze on the current pose. */
  stopAnimation() {
    return this.setComponent('model', 'clip', '');
  }

  /**
   * Swap this element's sprite by media name or hash. The door-opens-and-changes-
   * picture case, which is most of what a point-and-click sprite ever does.
   */
  setSprite(nameOrHash) {
    const resolved = this.world?.resolveMedia?.(nameOrHash);
    if (!resolved) return false;

    this.components = {
      ...this.components,
      sprite: { ...(this.components.sprite ?? {}), media: resolved.hash, ext: resolved.ext },
    };
    this._notify('components', this.components, null);
    return true;
  }

  /**
   * Write one field of one component, and let the engine see it.
   *
   * Components are plain bags, not accessors, so a write to one is invisible to
   * the journal unless it says so -- `el.components.sprite.frame = 3` changes the
   * picture and is never saved. This is the one door: it REPLACES the bag rather
   * than mutating it (a snapshot taken before the write must not change under the
   * caller -- that is what makes play-mode restore trustworthy) and notifies once.
   *
   * This is also how AE1Sprite advances a frame 12 times a second, which sounds
   * alarming and is not: the journal is silent during play (DESIGN.md §3.1), and
   * an animation only ever ticks during play. If the editor ever previews
   * animation live, THAT is when this needs a transient sibling -- not before.
   */
  setComponent(slot, key, value) {
    const bag = { ...(this.components[slot] ?? {}) };
    if (bag[key] === value) return false; // no-op writes must not journal or repaint

    bag[key] = value;
    this.components = { ...this.components, [slot]: bag };
    this._notify('components', this.components, null);
    return true;
  }

  /** Bulk-apply without firing a notification per key. */
  applyData(data) {
    for (const key of Object.keys(ELEMENT_SCHEMA)) {
      if (data[key] !== undefined) this._props[key] = data[key];
    }
  }

  /* -- geometry ------------------------------------------------------------ */

  /** Axis-aligned bounds in scene space. Used for hit-testing and gizmos. */
  getBounds() {
    const w = this.width * this.scaleX;
    const h = this.height * this.scaleY;
    return { x: this.x, y: this.y, w, h };
  }

  containsPoint(px, py) {
    const b = this.getBounds();
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  _notify(key, value, old) {
    this._onChange?.(this, key, value, old);
  }
}

/**
 * Define real accessors on the prototype.
 *
 * `this.x = 5` and `el.setX(5)` both route through the same setter, so BOTH are
 * observable. That matters more than it looks: Angel Script methods will write
 * `this.locked = false` directly, and continuous journaling (DESIGN.md 3.1) only
 * works if the engine sees that write. Storing values in plain fields would make
 * the accessors decorative and let script mutations vanish unsaved.
 */
for (const key of Object.keys(ELEMENT_SCHEMA)) {
  Object.defineProperty(AE1Element.prototype, key, {
    get() {
      return this._props[key];
    },
    set(value) {
      const old = this._props[key];
      if (old === value) return; // no-op writes must not journal or repaint
      this._props[key] = value;
      this._notify(key, value, old);
    },
    enumerable: true,
    configurable: true,
  });

  // Java-style pairs, for authors who prefer them and for subclasses that want
  // to override behaviour (e.g. setVisible() that also fades audio).
  const C = cap(key);
  AE1Element.prototype[`get${C}`] = function () {
    return this[key];
  };
  AE1Element.prototype[`set${C}`] = function (value) {
    this[key] = value;
    return this; // chainable
  };
}

/**
 * Does anything in this prototype chain already define `key`?
 *
 * Stops at Object.prototype deliberately: a plain `key in proto` would answer
 * true for a dat key an author named `toString` or `valueOf`, and that element
 * would silently get no accessor at all.
 */
function definedInChain(proto, key) {
  for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, key)) return true;
  }
  return false;
}

/**
 * Give a dat key a real accessor on a prototype.
 *
 * Lives here, not in ags/runtime.js, for two reasons: it is about elements, not
 * about compiling; and built-in classes with static `agsDat` (Video) need it
 * without importing the compiler, which would be circular.
 *
 * This is what makes `this.locked = false` inside an AGS method observable, and
 * therefore journalable. Plain fields would make the whole dat section invisible
 * to the engine and let script mutations vanish unsaved.
 */
export function defineDatAccessor(proto, key) {
  if (key in ELEMENT_SCHEMA) return; // the base schema owns it; identical behaviour

  // Never regenerate an accessor an ANCESTOR defines.
  //
  // This checked only the class's own prototype, which meant every compiled
  // subclass rebuilt a plain accessor for every inherited dat key -- silently
  // shadowing any custom one a built-in had written. AE1Video's `poster` setter,
  // which seeks the video when you change it, simply never ran: `(extends Video)`
  // regenerated `poster` on the subclass, the generated setter stored the value,
  // and the picture never moved. Class correct, property present, setter written,
  // never called -- the same shape as the runInfo bug.
  //
  // Skipping is safe because a generated accessor and an inherited one do the same
  // thing to `_props`; the only difference is the behaviour a base deliberately
  // added.
  if (definedInChain(proto, key)) return;

  Object.defineProperty(proto, key, {
    get() {
      return this._props[key];
    },
    set(value) {
      const old = this._props[key];
      if (old === value) return;
      this._props[key] = value;
      this._notify(key, value, old);
    },
    enumerable: true,
    configurable: true,
  });

  // Generate the getX/setX pair only if NEITHER already exists in the chain.
  //
  // Checking `get${C}` alone let a dat key clobber a hand-written std-lib setter
  // that has no matching getter: a dat key `musicLevel` overwrote setMusicLevel()
  // (which sets audio loudness) with a generated setter that just stored the dat
  // value. A `setMusicLevel` function still existed, so it looked wired -- it was
  // simply the wrong one. `sprite` -> setSprite and `component` -> setComponent
  // would break the same way. When a method already carries that name, it wins.
  const C = key[0].toUpperCase() + key.slice(1);
  if (!(`get${C}` in proto) && !(`set${C}` in proto)) {
    proto[`get${C}`] = function () {
      return this[key];
    };
    proto[`set${C}`] = function (v) {
      this[key] = v;
      return this;
    };
  }
}

/** Define accessors for every key in a class's static agsDat. For built-ins. */
export function defineDatAccessors(cls) {
  for (const key of Object.keys(cls.agsDat ?? {})) defineDatAccessor(cls.prototype, key);
  return cls;
}

/* Note on components vs. base properties.
 *
 * DESIGN.md 5.2 originally showed `transform` inside `components`, while 5.1 put
 * x/y on the base element. Those contradict. Resolved in favour of the base:
 *
 *   Base properties are what every element HAS.
 *   Components are what an element MAY have.
 *
 * A transform is not optional -- there is no element without a position -- so it
 * is not a component. A sprite or a collider is optional, so it is. This also
 * keeps `this.x` working in AGS without a components lookup.
 */

/**
 * AE1 - the world.
 *
 * Owns everything that outlives a single scene: the persistent HUD layer, audio,
 * the media name table, and the current scene. Scene changes happen here.
 *
 * Shared by the editor's play mode and the exported game (Principle 2). If scene
 * switching were implemented twice, "the door works in the editor but not in the
 * build" would be a bug waiting to happen -- and it is the single most important
 * thing in a point-and-click that must not break.
 */

import { AE1Scene } from './scene.js';
import { AE1HudElement, AE1Inventory } from './hud.js';
import { AE1SaveHandler } from './savehandler.js';
import { AE1DialogueBox } from './dialogue.js';
import { AE1Audio } from './audio.js';
import { AE1MusicBus } from './musicbus.js';
import { AE1Save } from './save.js';
import { AE1Settings } from './settings.js';
import { resolveMedia } from './media.js';
import { rehydrate, buildSchedule, dispatch } from './ags/runtime.js';

export class AE1World {
  /**
   * @param {object} opts
   * @param {Record<string, object>} opts.scenes   file -> scene JSON
   * @param {object} opts.hud                      hud.json
   * @param {Map<string, Function>} opts.classes   compiled AGS classes
   * @param {Record<string, object>} opts.media    hash -> manifest entry
   * @param {string} opts.mediaBase
   * @param {(el, key, value) => void} [opts.onChange]
   */
  /**
   * @param {object} [opts.game]   { id, title, version } — identity for saves
   * @param {(data, name) => Promise} [opts.writeSave]  host-specific durable write
   */
  constructor({ scenes, hud, classes, media, mediaBase, onChange, game, writeSave } = {}) {
    this.sceneData = scenes ?? {};
    this.classes = classes ?? new Map();
    this.media = media ?? {};
    this.mediaBase = mediaBase ?? 'media';
    this._onChange = onChange ?? null;

    this.audio = new AE1Audio(this.mediaBase);

    /**
     * The author's open save bag: `this.saveData.chapter = 2` in any script.
     * The engine never looks inside it.
     */
    this.saveData = {};
    /** Unknown top-level save fields, preserved through a round trip. */
    this.saveMeta = {};
    /** file -> { elementName: props } waiting for its scene to load. */
    this.pendingSceneState = {};

    this.save = new AE1Save(this, { game: game ?? {}, write: writeSave ?? null });

    // Settings load and apply immediately: a player who muted the game last time
    // must not hear one second of music before their choice takes effect.
    this.settingsStore = new AE1Settings(this, { game: game ?? {} });

    /**
     * The persistent layer. Built ONCE and never rebuilt on a scene change --
     * that is the entire reason HUD elements live in the project rather than in
     * scenes (DESIGN.md §12). Rebuilding it here would reset the inventory every
     * time the player walked through a door.
     */
    this.hud = new AE1Scene(hud ?? { name: 'HUD', elements: {} }, {
      onChange: (el, key, value) => this._change(el, key, value),
    });
    this.hud.setWorld(this);

    /**
     * Picked-up items travelling BETWEEN scenes (§18.32) — the element
     * instances themselves, stashed by goToScene and handed to the next
     * scene's character. Rendered and ticked alongside the scene (see
     * orderedElements) so the wielded one keeps riding the hand.
     */
    this.carried = [];
    this._carryEquip = -1;
    /** Projectile templates travelling with carried weapons (§18.38). */
    this.carriedAux = [];

    /**
     * The background MUSIC layer (§18.34) — Web Audio, driven by
     * AudioBackgroundMusicVolume / AudioFXVolume boxes. Deliberately separate
     * from the ambience bed and from voices; all three may sound at once.
     */
    this.musicBus = new AE1MusicBus(this);
    rehydrate(this.hud, this.classes, AE1HudElement);
    this.hud.setWorld(this); // rehydrate replaced instances; re-attach

    /** @type {AE1Scene|null} */
    this.scene = null;
    this.sceneFile = null;

    /** @type {import('./loop.js').GameLoop|null} — assigned by the owner. */
    this.loop = null;
  }

  _change(el, key, value) {
    // Adding or removing an element changes WHO the loop should dispatch to, and
    // the schedule is built once (see GameLoop.rescan). Without this, a script
    // that spawns anything gets an element that draws and never responds.
    //
    // Rebuilt immediately rather than marked dirty: a click can arrive between
    // frames, so "next tick" would be a real window in which the new element is
    // visible and dead. The tables are small and this is not per-frame.
    if (key === '@add' || key === '@remove') this.loop?.rescan();

    this._onChange?.(el, key, value);
  }

  /* -- lookup -------------------------------------------------------------- */

  /** The first Inventory in the HUD, if the project has one. */
  get inventory() {
    return this.hud.all().find((e) => e instanceof AE1Inventory) ?? null;
  }

  /**
   * The project's save handler, if it has one.
   *
   * Lives in the HUD layer because it must outlive every scene: a handler rebuilt
   * on each scene change could not restore the scene it was rebuilt for.
   */
  get saveHandler() {
    return this.hud.all().find((e) => e instanceof AE1SaveHandler) ?? null;
  }

  /**
   * The project's dialogue box, if it has one.
   *
   * In the HUD layer for the same reason as the inventory: a conversation must be
   * able to survive `goToScene`, and a box rebuilt on every scene change could not
   * finish a sentence that moved the player through a door.
   *
   * Its ABSENCE is meaningful, not an error. A project with no box still gets
   * say() through the host's fallback (a DOM line in a shipped game, the Console
   * in the editor), which is what every project did before this existed.
   */
  get dialogueBox() {
    return this.hud.all().find((e) => e instanceof AE1DialogueBox) ?? null;
  }

  /** The conversation currently running, if any. At most one — see dialogue.js. */
  get dialogue() {
    return this._dialogue ?? null;
  }

  /**
   * Hold state for a scene the player is not in yet.
   *
   * A save can describe a door in Chapter Three. That door does not exist until
   * Chapter Three loads, so there is nothing to write to — and inventing an
   * element to hold the value would be worse than waiting. The state is parked
   * here and applied the moment its scene loads.
   */
  deferSceneState(file, name, props) {
    const resolved = this.resolveScene(file) ?? file;
    this.pendingSceneState[resolved] ??= {};
    this.pendingSceneState[resolved][name] = {
      ...(this.pendingSceneState[resolved][name] ?? {}),
      ...props,
    };
  }

  /** Apply anything parked for this scene, then forget it. */
  _applyPendingSceneState(file) {
    const pending = this.pendingSceneState[file];
    if (!pending) return 0;

    let applied = 0;
    for (const [name, props] of Object.entries(pending)) {
      const el = this.scene?.findByName(name);
      if (el) {
        Object.assign(el, props);
        applied++;
      }
    }

    // Consumed either way. A name that no longer matches an element is a save
    // describing a game that has since changed -- keeping it forever would mean
    // re-applying stale state on every future visit.
    delete this.pendingSceneState[file];
    return applied;
  }

  /**
   * Find an element by name: current scene first, then HUD.
   *
   * Scene wins because a script saying find("Door") means the door in the room
   * it is standing in, not a HUD element that happens to share a name.
   */
  find(name) {
    return (
      this.scene?.findByName(name) ??
      this.carried?.find((e) => e.name === name) ??
      this.carriedAux?.find((e) => e.name === name) ??
      this.hud.findByName(name)
    );
  }

  /**
   * Resolve a media NAME (or hash) to `{hash, ext}`.
   *
   * Authors write `playSound("bram-hey.mp3")` because that is what the Media
   * Collection shows them. Hashes are an implementation detail they should never
   * have to type.
   *
   * Delegates to media.js so the editor — which has no world — resolves names
   * identically. Two implementations would let the editor and the game disagree
   * about what a name means.
   */
  resolveMedia(nameOrHash) {
    return resolveMedia(this.media, nameOrHash);
  }

  playSound(nameOrHash, opts) {
    const m = this.resolveMedia(nameOrHash);
    if (!m) {
      console.warn(`[ags] playSound("${nameOrHash}") — no such media.`);
      return null;
    }
    return this.audio.play(m.hash, m.ext, opts);
  }

  playMusic(nameOrHash, opts) {
    const m = this.resolveMedia(nameOrHash);
    if (!m) {
      console.warn(`[ags] playMusic("${nameOrHash}") — no such media.`);
      return null;
    }
    return this.audio.playMusic(m.hash, m.ext, opts);
  }

  /** A looping effect with a caller-owned stop (`handle.stopLoop()`) —
   *  footsteps, hums. Not the music channel; overlaps allowed (§18.20). */
  loopSound(nameOrHash, opts) {
    const m = this.resolveMedia(nameOrHash);
    if (!m) {
      console.warn(`[ags] loopSound("${nameOrHash}") — no such media.`);
      return null;
    }
    return this.audio.loop(m.hash, m.ext, opts);
  }

  /* -- scenes -------------------------------------------------------------- */

  /** Resolve a scene name or filename to a filename. */
  resolveScene(nameOrFile) {
    if (this.sceneData[nameOrFile]) return nameOrFile;

    const wanted = String(nameOrFile).toLowerCase();
    for (const [file, data] of Object.entries(this.sceneData)) {
      if (data.name?.toLowerCase() === wanted) return file;
      if (file.toLowerCase().replace(/\.json$/, '') === wanted) return file;
    }
    return null;
  }

  /**
   * Load a scene, replacing the current one.
   *
   * The contract, exactly as specified:
   *   - HUD elements are NOT unloaded, reset, or rebuilt. They never learn a
   *     scene change happened.
   *   - The outgoing scene's elements get onUnload, then are dropped.
   *   - The incoming scene's elements get onLoad.
   *
   * Note the asymmetry: onLoad and onUnload fire per SCENE, not per world. A HUD
   * element's onLoad fires exactly once, when the world starts.
   */
  goToScene(nameOrFile) {
    const file = this.resolveScene(nameOrFile);
    if (!file) {
      console.warn(`[ags] goToScene("${nameOrFile}") — no such scene.`);
      return false;
    }
    if (file === this.sceneFile) return true;

    // -- the pockets outlive the scene (§18.32) ---------------------------- //
    // A picked-up item is the PLAYER's, not the scene's: stash the outgoing
    // character's whole inventory (the element instances themselves — hidden,
    // ticking, renderable via `carried`) and hand it to the next scene's
    // character below. `(keepAcrossScenes false)` on an item opts out. A scene
    // with no character (a menu) leaves the stash untouched — pockets survive
    // a detour through the pause screen.
    const outgoing = this.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (outgoing) {
      const eq = outgoing.equipped;
      this.carried = outgoing._inv.filter(
        (i) => !(i.keepAcrossScenes === false || i.keepAcrossScenes === 'false'),
      );
      this._carryEquip = eq ? this.carried.indexOf(eq) : -1;

      // TEMPLATES TRAVEL WITH THEIR WEAPONS (§18.38): ammunition is a scene
      // element (§18.15), so a carried bazooka in a scene without its MIssile
      // fired nothing. Stash every template a carried weapon names — hidden,
      // ticking, findable — so new scenes need no hand-copies.
      const aux = [];
      const have = new Set();
      const pool = [...(this.scene?.all() ?? []), ...(this.carriedAux ?? [])];
      for (const item of this.carried) {
        const pname = item.projectile && String(item.projectile);
        if (!pname || have.has(pname)) continue;
        const tpl = pool.find((e) => e.name === pname && typeof e.launch === 'function');
        if (tpl) {
          aux.push(tpl);
          have.add(pname);
        }
      }
      // COMPANIONS TRAVEL WITH THEIR WEAPONS TOO (§18.14's pair): the type-3
      // fist's LEFT arm is a scene element its script mounts BY NAME — walk
      // through a door without carrying it and equipping in the new scene
      // showed one bracer and the weapon state never engaged (worn() bailed
      // at the missing pair before claiming combat). Same doctrine as the
      // ammunition above: whatever a carried weapon names, travels.
      for (const item of this.carried) {
        const cname = item.fistPair && String(item.fistPair);
        if (!cname || have.has(cname)) continue;
        const el = pool.find((e) => e.name === cname);
        if (el) {
          aux.push(el);
          have.add(cname);
        }
      }
      this.carriedAux = aux;
    }

    // Unload the outgoing scene only. Scripts release audio, timers, and handles
    // here; skipping it leaks exactly what the hook exists to prevent.
    if (this.scene) {
      dispatch(buildSchedule(this.scene.all()), 'onUnload');
    }

    // The music bus dies with the scene (§18.36) — its claiming boxes just
    // unloaded, and an unclaimed track (with its crush) would follow the
    // player through the door forever. New-scene boxes re-claim next tick.
    this.musicBus?.sceneChange();

    const data = this.sceneData[file];
    this.scene = new AE1Scene(data, {
      onChange: (el, key, value) => this._change(el, key, value),
    });
    this.scene.setWorld(this);
    rehydrate(this.scene, this.classes);
    this.scene.setWorld(this); // rehydrate replaced instances; re-attach
    this.sceneFile = file;

    // Tables cover BOTH layers: HUD elements tick and receive clicks in every
    // scene, which is what makes a HUD a HUD.
    if (this.loop) {
      this.loop.tables = buildSchedule(this.orderedElements());
      this.loop._hover = null; // the thing under the cursor is gone
    }

    // Before onLoad, not after: a script's onLoad should see the world it was
    // saved in. A door whose onLoad reads `this.locked` must read the RESTORED
    // value, not the file's default and then be corrected a frame later.
    this._applyPendingSceneState(file);

    // -- hand the pockets to the incoming character (§18.32) ---------------- //
    // Same items, new hands: re-issuing equipIndex snapshots the mount against
    // THIS scene's character (host name, bone, grip), so the wielded mesh rides
    // the new armature instead of haunting the old one.
    // A scene that carries its OWN copy of a travelling template wins — drop
    // the stashed twin so the name resolves to exactly one mold.
    if (this.carriedAux?.length) {
      // ...for TEMPLATES and COMPANIONS alike: any same-named scene element
      // takes over from the travelling twin (returning to the fists' home
      // scene must hand the pair back to the authored left arm, or two
      // FistPairLefts answer one name). The takeover COPIES the twin's
      // mount + visibility (§18.42): the authored element is a fresh spawn
      // at its rack transform, and without the twin's state a worn
      // companion re-entered its home scene lying on the floor.
      this.carriedAux = this.carriedAux.filter((t) => {
        const own = this.scene.all().find((e) => e.name === t.name);
        if (!own) return true;
        const mount = t.components?.model?.mount;
        if (mount && typeof own.setComponent === 'function') {
          own.setComponent('model', 'mount', { ...mount });
          own.visible = t.visible;
        }
        return false;
      });
    }

    // -- ONE OF EACH THING (§18.42, Austin's rule) -------------------------- //
    // A scene's authored copy of an item the player already CARRIES never
    // spawns on the ground: the carried instance is the one true copy, in
    // every scene, in every direction. Before this, the pickup-time dup
    // guard refused the second pickup but left the authored twin VISIBLE on
    // its rack — returning to the fists' home scene showed a bracer lying
    // at its spawn point while its double rode the player's hand. Stackables
    // opt out here exactly as they do from the pickup guard.
    if (this.carried?.length) {
      const names = new Set(
        this.carried
          .filter((c) => !(c.stackable === true || c.stackable === 'true'))
          .map((c) => String(c.name)),
      );
      let removed = false;
      for (const el of [...this.scene.all()]) {
        if (names.has(String(el.name))) removed = this.scene.remove(el.id) || removed;
      }
      if (removed) this.loop?.rescan();
    }

    const incoming = this.scene.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (incoming && this.carried?.length) {
      incoming._inv = [...this.carried];
      incoming._invIndex = -1;
      for (const item of incoming._inv) {
        item.visible = false;
        item.setComponent?.('model', 'mount', null);
      }
      if ((this._carryEquip ?? -1) >= 0) incoming.equipIndex(this._carryEquip);
    }

    dispatch(buildSchedule(this.scene.all()), 'onLoad');
    this._onChange?.(null, '@scene', file);
    return true;
  }

  /**
   * Every live element in paint order: scene first, HUD above.
   *
   * HUD is unconditionally on top rather than sorted by layer with everything
   * else -- an inventory hidden behind a background would be an unpleasant
   * surprise, and there is no case where a scene element should occlude the HUD.
   */
  orderedElements() {
    const scene = this.scene ? this.scene.sorted(this.scene.all()) : [];
    // Carried items (§18.32) live in no scene but must tick (an equipped
    // weapon hears onPrimary) and render (it rides the hand). Hidden ones
    // paint nothing; the filter is only same-instance safety. Travelling
    // templates (§18.38) ride along the same way.
    const carried = (this.carried ?? []).filter((c) => !scene.includes(c));
    const aux = (this.carriedAux ?? []).filter((c) => !scene.includes(c));
    return [...scene, ...carried, ...aux, ...this.hud.sorted(this.hud.all())];
  }


  /* -- settings ------------------------------------------------------------ */

  /** The live settings values. Read freely; write via setSetting so it persists. */
  get settings() {
    return this.settingsStore.values;
  }

  setSetting(key, value) {
    return this.settingsStore.set(key, value);
  }

  resetSettings() {
    return this.settingsStore.reset();
  }

  /* -- saving -------------------------------------------------------------- */

  /**
   * Save the game.
   *
   * The host decides where it lands. The editor writes to /saves silently; a
   * shipped game hands the player a file. Both mirror to localStorage as the
   * "continue" slot.
   *
   * @returns {Promise<{ok, name?, downloaded?, error?}>}
   */
  async saveGame(extra = {}) {
    const data = this.save.capture(extra);
    const name = this.save.suggestName();

    this.save.toLocal(data);

    if (this.save._write) {
      try {
        await this.save._write(data, name);
        return { ok: true, name, downloaded: false };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // No host writer — a shipped game. The file IS the save.
    this.save.download(data, name);
    return { ok: true, name, downloaded: true };
  }

  /** Ask the player for a save file, then load it. */
  loadGame() {
    return this.save.loadFromFile();
  }

  /** Load the localStorage slot, if there is one. "Continue". */
  continueGame() {
    const data = this.save.fromLocal();
    if (!data) return { ok: false, error: 'No save to continue from.' };
    return this.save.apply(data);
  }

  hasSavedGame() {
    return this.save.hasLocal();
  }

  /* -- lifecycle ----------------------------------------------------------- */

  /** Start the world: HUD onLoad once, then the entry scene. */
  /**
   * SPAWN AN INSTANCE (§18.46): a new element built from a PROTOTYPE element
   * — same class (script), same dats — with `overrides` applied on top
   * (position, health, tint, any dat), added live to the scene. This is the
   * programmatic half of AE1's instancing story; the declarative half has
   * existed all along (scripts declare defaults, elements persist only their
   * overrides — the prefab-override model). The renderer gives each spawn
   * its own clone AND its own animation timeline over the one shared glb.
   */
  spawnInstance(protoNameOrEl, overrides = {}) {
    const proto =
      typeof protoNameOrEl === 'string' ? this.find(protoNameOrEl) : protoNameOrEl;
    if (!proto || !this.scene) return null;
    const data = proto.serialize();
    delete data.id; // a new identity, never a copy of one
    // components must be PRIVATE — a shared model bag would make every
    // instance's clip write fight every other's
    data.components = structuredClone(data.components ?? {});
    this._instSeq = (this._instSeq ?? 0) + 1;
    const Cls = proto.constructor;
    const el = new Cls(
      { ...data, visible: true, name: `${proto.name}#${this._instSeq}`, ...overrides },
      {},
    );
    el._protoName = proto.name;
    this.scene.add(el);
    this.loop?.rescan?.();
    this.loop?.dispatchTo?.(el, 'onLoad'); // its begin hooks run like anyone's
    return el;
  }

  /** Every live instance spawned from the named prototype (§18.46). */
  instancesOf(protoName) {
    return this.scene?.all().filter((e) => e._protoName === protoName) ?? [];
  }

  /**
   * FULL RESTART (§18.45): back to a scene as if the run never happened —
   * the player-death contract. Pockets emptied (the outgoing character's
   * too, or goToScene would faithfully stash and re-issue them), aux
   * templates dropped, and `sceneFile` cleared so the reload happens even
   * when the death was IN the target scene (goToScene early-outs on same
   * file). Everything else — health, enemies, items on racks — comes back
   * fresh from the scene data through rehydrate.
   */
  restart(nameOrFile = null) {
    const target = nameOrFile ?? this.sceneFile;
    const chr = this.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (chr) {
      chr._inv = [];
      chr._invIndex = -1;
    }
    this.carried = [];
    this._carryEquip = -1;
    this.carriedAux = [];
    this.sceneFile = null;
    return this.goToScene(target);
  }

  start(entryScene) {
    dispatch(buildSchedule(this.hud.all()), 'onLoad');
    this.goToScene(entryScene);
  }

  stop() {
    if (this.scene) dispatch(buildSchedule(this.scene.all()), 'onUnload');
    dispatch(buildSchedule(this.hud.all()), 'onUnload');
    this.audio.stopAll();
    this.musicBus?.dispose();
    this.carried = [];
    this._carryEquip = -1;
    this.carriedAux = [];
  }
}

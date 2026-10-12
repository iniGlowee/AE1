/**
 * AE1 - game settings.
 *
 * Deliberately NOT part of a save file.
 *
 * A save is a moment in a playthrough; settings are how this player likes their
 * games. Putting volume in a save means loading a six-month-old game silently
 * resets your audio — the player changed nothing, and something changed. They are
 * different lifetimes, so they get different storage.
 *
 *   save     -> a file, per playthrough, portable, moddable
 *   settings -> localStorage, per player + per game, per machine
 *
 * That also means settings are legitimately allowed to be lost. Clearing browser
 * data resets your volume, which is a shrug — losing a save would not be. Nothing
 * here is worth a download prompt.
 *
 * The engine knows about audio; everything else is the author's. `settings` is an
 * open bag exactly like `saveData`.
 */

export const SETTINGS_FORMAT = 1;

/** What the engine itself reads. Authors may add anything alongside. */
export const DEFAULT_SETTINGS = {
  musicVolume: 0.6,
  soundVolume: 1,
  muted: false,
};

export class AE1Settings {
  /**
   * @param {import('./world.js').AE1World} world
   * @param {object} [opts]
   * @param {object} [opts.game]      { id, title }
   * @param {object} [opts.defaults]  merged under DEFAULT_SETTINGS
   */
  constructor(world, { game = {}, defaults = {} } = {}) {
    this.world = world;
    this.game = game;
    this.defaults = { ...DEFAULT_SETTINGS, ...defaults };
    this.values = { ...this.defaults };
    this.load();
  }

  /** Per game: two games on one origin must not share a volume. */
  get storageKey() {
    return `ae1.settings.${this.game.id ?? this.game.title ?? 'game'}`;
  }

  /* -- persistence -------------------------------------------------------- */

  load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const stored = JSON.parse(raw);
        // Defaults UNDER stored, so a setting added in a later build appears for
        // a player who already has a settings blob -- rather than being undefined
        // forever because their storage predates it.
        this.values = { ...this.defaults, ...(stored.values ?? stored) };
      }
    } catch {
      this.values = { ...this.defaults }; // blocked, private mode, corrupt
    }
    this.apply();
    return this.values;
  }

  save() {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ settingsFormat: SETTINGS_FORMAT, values: this.values }),
      );
      return true;
    } catch {
      return false; // cosmetic; never surface
    }
  }

  /* -- mutation ----------------------------------------------------------- */

  get(key) {
    return this.values[key];
  }

  /** Set, apply to the engine, and persist. The whole flow for a settings screen. */
  set(key, value) {
    this.values[key] = value;
    this.apply();
    this.save();
    return value;
  }

  reset() {
    this.values = { ...this.defaults };
    this.apply();
    this.save();
    return this.values;
  }

  /**
   * Push the settings the engine knows about into the engine.
   *
   * Only audio today. An author's own keys are never touched — they read them
   * from their own scripts.
   */
  apply() {
    const audio = this.world?.audio;
    if (!audio) return;

    audio.musicVolume = clamp01(this.values.musicVolume ?? DEFAULT_SETTINGS.musicVolume);
    audio.soundVolume = clamp01(this.values.soundVolume ?? DEFAULT_SETTINGS.soundVolume);
    audio.setMuted(Boolean(this.values.muted));

    // Music already playing must follow the new volume, or a slider does nothing
    // until the next track — which reads as broken. Through the target, not the raw
    // setting, so a per-area level (audio.js sceneLevel) survives a slider move
    // instead of being flattened back to full whenever the player touches volume.
    if (audio._music && !this.values.muted) {
      audio._music.volume = audio._musicTarget();
    }
  }
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

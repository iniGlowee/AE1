/**
 * AE1 - the editor's store.
 *
 * Owns the loaded project: its scenes, its persistent HUD layer, its scripts, its
 * media, the selection, the journal, and undo. Editors read from it and subscribe
 * to it; they never talk to each other. Six panes that all know about each other
 * is a graph -- one store they all observe is a star, and only the star stays
 * comprehensible when the seventh pane arrives.
 *
 * Editor-only concerns live here, NOT in /engine. The exported game has no
 * selection, no journal, and no undo (DESIGN.md, Principle 2).
 */

import { AE1Scene } from '/engine/scene.js';
import { AE1Element } from '/engine/element.js';
import { AE1HudElement, AE1Inventory } from '/engine/hud.js';
import { compileAll, buildSchedule, rehydrate } from '/engine/ags/runtime.js';
import { AE1World } from '/engine/world.js';
import { AE1Controller, AE1ThirdPersonCamera, AE1ThirdPersonCharacter } from '/engine/thirdperson.js';
import { GameLoop } from '/engine/loop.js';
import { clearCache, resolveMedia } from '/engine/media.js';
import { clearVideoCache } from '/engine/video.js';
import { History } from './history.js';
import { api } from './api.js';

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Coalesce writes. Dragging a slider fires a mutation per pixel. */
const JOURNAL_MS = 350;

const EVENTS = [
  'scene',
  'selection',
  'element',
  'dirty',
  'diagnostics',
  'log',
  'scripts',
  'play',
  'media',
  'scenes',
  'history',
  'saves',
];

class SceneStore {
  constructor() {
    this.project = null;
    this.file = null;

    /** @type {AE1Scene|null} the scene being edited (or played) */
    this.scene = null;
    /** @type {AE1Scene|null} the persistent layer — outlives every scene change */
    this.hud = null;

    /** file -> scene JSON. Every scene, because play needs to reach them all. */
    this.sceneData = {};
    /** [{file, name}] */
    this.sceneList = [];

    this.selectedId = null;

    this.scripts = {};
    this.media = {};
    this.classes = new Map();
    this.diagnostics = [];
    this.logs = [];

    /** @type {AE1World|null} @type {GameLoop|null} — play mode only */
    this.world = null;
    this.loop = null;
    this.playing = false;
    this._snapshot = null;

    this.history = new History({
      capture: () => this._captureState(),
      restore: (state) => this._restoreState(state),
      onChange: (info) => this.emit('history', info),
    });

    this._listeners = new Map(EVENTS.map((e) => [e, new Set()]));
    this._timer = null;
    this._saving = false;
    this._again = false;
    this._scriptTimers = new Map();
  }

  /* -- events -------------------------------------------------------------- */

  on(event, fn) {
    this._listeners.get(event)?.add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        // One broken pane must not stop the others from updating.
        console.error(`[scene-store] listener for "${event}" threw:`, err);
      }
    }
  }

  /* -- loading ------------------------------------------------------------- */

  async open(project) {
    this.project = project;
    this.file = project.entryScene ?? 'scene-1.json';

    const [list, scripts, media, hud, sample] = await Promise.all([
      api.listScenes(project.slug),
      api.listScripts(project.slug).catch(() => ({ scripts: {} })),
      api.listMedia(project.slug).catch(() => ({ entries: {} })),
      api.getHud(project.slug).catch(() => ({ name: 'HUD', elements: {} })),
      // which shipped sample this project came from (restore default script,
      // restore the sample); an older server without the route answers 404
      api.getSample(project.slug).catch(() => null),
    ]);
    this.sample = sample && sample.sample ? sample : null;

    this.sceneList = list.scenes ?? [];
    if (!this.sceneList.some((s) => s.file === this.file)) {
      this.file = this.sceneList[0]?.file ?? this.file;
    }

    // Every scene, up front. A point-and-click's scenes are a few KB each, and
    // goToScene during play must not have to await a fetch mid-frame.
    this.sceneData = {};
    await Promise.all(
      this.sceneList.map(async (s) => {
        this.sceneData[s.file] = await api.getScene(project.slug, s.file);
      }),
    );

    this.scripts = scripts.scripts ?? {};
    this.media = Object.fromEntries(
      Object.entries(media.entries ?? {}).map(([hash, entry]) => [hash, { ...entry, hash }]),
    );

    this._editorWorld = null; // a new project means a new media table and base
    this.hud = new AE1Scene(hud, {
      onChange: (el, key, value) => this._onChange(el, key, value, 'hud'),
    });
    this.hud.setWorld(this.editorWorld);

    this._loadScene(this.file);
    this.logs = [];
    this.selectedId = null;

    this.compileScripts();
    this.history.reset();

    this.emit('scenes', this.sceneList);
    this.emit('scene', this.scene);
    this.emit('selection', null);
    return this.scene;
  }

  _loadScene(file) {
    this.file = file;
    this.scene = new AE1Scene(this.sceneData[file] ?? { name: file, elements: {} }, {
      onChange: (el, key, value) => this._onChange(el, key, value, 'scene'),
    });
    this.scene.setWorld(this.editorWorld);
  }

  /**
   * A world-shaped object for editing.
   *
   * Outside play there is no AE1World, so `this.world` on every element was null —
   * and an element with no world cannot resolve a media NAME. That silently broke
   * anything naming an asset from a script: a Video element built a URL of
   * `intro.mp4.mp4` (treating the name as a hash), and `setSprite("door.png")`
   * via ▶ Test just returned false and did nothing.
   *
   * This provides only what EDITING needs: media resolution, the media base, and
   * the two layers. Deliberately no goToScene, no audio, no loop — a script must
   * not be able to change scenes or start music while the author is arranging
   * furniture. Those live on the real world, which only Play builds.
   */
  get editorWorld() {
    if (!this.project) return null;
    this._editorWorld ??= {
      mediaBase: `/projects/${this.project.slug}/media`,
      media: this.media,
      resolveMedia: (n) => resolveMedia(this.media, n),
      get hud() {
        return store.hud;
      },
      get scene() {
        return store.scene;
      },
    };
    // `media` is replaced wholesale on import, so re-point it rather than leaving
    // the world holding the table as it was when the project opened.
    this._editorWorld.media = this.media;
    this._editorWorld.mediaBase = `/projects/${this.project.slug}/media`;
    return this._editorWorld;
  }

  /**
   * Switch which scene is being edited.
   *
   * Not a scene CHANGE in the game sense: no onUnload, no onLoad, no HUD reset.
   * The author is opening a different file, not walking through a door.
   */
  async switchScene(file) {
    if (this.playing) this.stop();
    if (file === this.file || !this.sceneData[file]) return false;

    await this.flush();
    this._loadScene(file);
    this.selectedId = null;

    this._rehydrate();
    this.history.reset(); // undo does not reach across scenes; that would be a trap
    this.emit('scene', this.scene);
    this.emit('selection', null);
    return true;
  }

  async createScene(name) {
    const { file } = await api.createScene(this.project.slug, name);
    this.sceneData[file] = await api.getScene(this.project.slug, file);
    this.sceneList = (await api.listScenes(this.project.slug)).scenes;
    this.emit('scenes', this.sceneList);
    return file;
  }

  async deleteScene(file) {
    await api.deleteScene(this.project.slug, file);
    delete this.sceneData[file];
    this.sceneList = (await api.listScenes(this.project.slug)).scenes;
    if (this.file === file) await this.switchScene(this.sceneList[0].file);
    this.emit('scenes', this.sceneList);
  }

  close() {
    if (this.playing) this.stop();
    this.flush();

    // Another project's decoded media is not ours to hold. Videos especially —
    // each one pins a decoder, not just pixels.
    clearCache();
    clearVideoCache();

    this.scene = null;
    this.hud = null;
    this.project = null;
    this.selectedId = null;
    this.media = {};
    this.sceneData = {};
    this.sceneList = [];
    this._editorWorld = null;
  }

  /* -- Angel Script -------------------------------------------------------- */

  compileScripts() {
    const { classes, diagnostics } = compileAll(this.scripts);
    this.classes = classes;
    this.diagnostics = diagnostics;
    this._rehydrate();
    this.emit('diagnostics', diagnostics);
  }

  _rehydrate() {
    let changed = false;
    if (this.scene) changed = rehydrate(this.scene, this.classes, AE1Element) || changed;
    // The HUD's default base is AE1HudElement: an unscripted HUD element is still
    // a HUD element, and must not silently demote to a scene element on reload.
    if (this.hud) changed = rehydrate(this.hud, this.classes, AE1HudElement) || changed;
    if (!changed) return;

    if (this.playing && this.loop) {
      // The tables hold {element, method} pairs pointing at the OLD instances.
      // Rebuild, or the loop dispatches to orphans and ignores every edit.
      this.loop.tables = buildSchedule(this.loop.orderedElements());
    }

    this.emit('scene', this.scene);
    if (this.selectedId) this.emit('selection', this.selected);
  }

  /** Replace a script with the shipped sample's version of the same file
   *  (MANAGER-PROJECT-01 W3b): the way back from a cleared script pane, which
   *  the undo history does not cover. Saved at once, not after the journal
   *  delay, so a reload a second later cannot bring the empty text back. */
  async restoreScriptDefault(file) {
    if (!this.project) return false;
    const shipped = await api.getSampleScript(this.project.slug, file);
    this.setScript(file, shipped.content);
    clearTimeout(this._scriptTimers.get(file));
    await api.putScript(this.project.slug, file, shipped.content);
    this.emit('dirty', false);
    return true;
  }

  setScript(file, content) {
    this.scripts[file] = content;
    this.compileScripts();
    this.emit('scripts', this.scripts);

    clearTimeout(this._scriptTimers.get(file));
    this._scriptTimers.set(
      file,
      setTimeout(async () => {
        try {
          await api.putScript(this.project.slug, file, content);
          this.emit('dirty', false);
        } catch (err) {
          this.emit('dirty', 'error');
          console.error('[scene-store] script save failed:', err);
        }
      }, JOURNAL_MS),
    );
    this.emit('dirty', true);
  }

  async attachScript(element, template) {
    const base =
      element.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'element';
    let file = `${base}.ags.txt`;
    let n = 2;
    while (this.scripts[file]) file = `${base}-${n++}.ags.txt`;

    const src =
      template ??
      `<?dat
(clicked 0)
?>
<?def
(name "${element.name}")

(runInfo touch (onClick onCall))
(runInfo look onHover)

function touch(actor) {
  this.clicked = this.clicked + 1;
  return this.say("You touch the " + this.name + ". (" + this.clicked + ")");
}

function look() {
  return this.say("It is a " + this.type + ".");
}
ags?>
`;

    this.scripts[file] = src;
    element.script = file;
    this.compileScripts();
    this.emit('scripts', this.scripts);
    this.journal();

    try {
      await api.putScript(this.project.slug, file, src);
    } catch (err) {
      console.error('[scene-store] script create failed:', err);
    }

    // A third-person character comes with its camera (DESIGN.md §18.9). After
    // the compile above, the live instance's class chain tells us what the
    // script became. Guarded against recursion: the camera's own attach re-runs
    // this, finds a camera existing, and stops.
    if (this.live(element) instanceof AE1ThirdPersonCharacter) {
      await this._ensureThirdPersonCamera();
    }

    return file;
  }

  /* -- selection ----------------------------------------------------------- */

  get selected() {
    if (!this.selectedId) return null;
    return this.scene?.get(this.selectedId) ?? this.hud?.get(this.selectedId) ?? null;
  }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('selection', this.selected);
  }

  /** Which layer an element belongs to. The Outliner and the journal both care. */
  layerOf(element) {
    return this.hud?.get(element?.id) ? 'hud' : 'scene';
  }

  /**
   * The LIVE instance for an id.
   *
   * Anything that compiles a script replaces the element it belongs to:
   * rehydration builds a new instance on the compiled class and swaps it into the
   * scene by id. So an element reference held across `attachScript()` or
   * `compileScripts()` is **stale**, and every write to it silently vanishes —
   * the object is real, it just isn't in the scene any more.
   *
   * Identity is the id, never the object. Re-fetch after anything that compiles.
   */
  live(idOrElement) {
    const id = typeof idOrElement === 'string' ? idOrElement : idOrElement?.id;
    if (!id) return null;
    return this.scene?.get(id) ?? this.hud?.get(id) ?? null;
  }

  /**
   * Every element in paint order: scene first, HUD above.
   *
   * The editor composes the same order the world does, so the viewport shows the
   * HUD sitting over the scene exactly where the player will see it — you cannot
   * place a health bar you cannot see.
   */
  orderedElements() {
    if (this.playing && this.world) return this.world.orderedElements();
    const scene = this.scene ? this.scene.sorted(this.scene.all()) : [];
    const hud = this.hud ? this.hud.sorted(this.hud.all()) : [];
    return [...scene, ...hud];
  }

  /* -- mutation ------------------------------------------------------------ */

  addElement(data = {}, layer = 'scene') {
    const target = layer === 'hud' ? this.hud : this.scene;
    const Cls = layer === 'hud' ? AE1HudElement : AE1Element;
    const el = target.add(new Cls(data));
    this.emit('scene', this.scene);
    this.select(el.id);
    return el;
  }

  /**
   * Add a Text element, scripted so the author can immediately edit it.
   *
   * Scripted rather than a bare element with a `text` property, because every
   * knob (font, colour, alignment, shadow) is dat -- so the thing you get is
   * fully yours from the first second, and `draw()` is right there to override.
   */
  async addText(layer = 'scene') {
    const el = this.addElement(
      {
        type: 'element',
        name: 'Text',
        x: 340,
        y: 300,
        width: 600,
        height: 120,
        layer: layer === 'hud' ? 100 : 10,
      },
      layer,
    );

    await this.attachScript(
      el,
      `<?dat
(text "Click anywhere to continue")
(size 28)
(color "#ffffff")
(align "center")
(valign "middle")
(font "system-ui, -apple-system, sans-serif")
(weight "400")
(lineHeight 1.4)
(padding 8)
(wrap true)
(shadow true)
?>
<?def
(extends Text)
(name "Text")

; Everything above is yours to change, live.
; Override draw(ctx, api) below to take over rendering completely.
ags?>
`,
    );
    // attachScript compiled, which rehydrated: `el` is stale. Return the live one.
    return this.live(el) ?? el;
  }

  /**
   * Add an animated Sprite, scripted so the clips are the author's from the start.
   *
   * The sheet itself is deliberately NOT set here: it goes in the sprite
   * component, which the Properties panel edits and which dropping art onto the
   * viewport already writes. This adds the MOTION -- which is the only thing
   * `(extends Sprite)` contributes -- and leaves the picture where pictures live.
   *
   * It arrives with `(animation "")`, meaning "the whole sheet", so an author who
   * sets a frame size sees it move immediately and can name clips later.
   */
  async addSprite(layer = 'scene') {
    const el = this.addElement(
      {
        type: 'character',
        name: 'Sprite',
        x: 560,
        y: 280,
        width: 128,
        height: 128,
        layer: layer === 'hud' ? 100 : 10,
        components: { sprite: { media: '' } },
      },
      layer,
    );

    await this.attachScript(
      el,
      `<?dat
(animations (idle 0 3) (walk 4 7))
(animation "")
(fps 12)
(playing true)
(loop true)
?>
<?def
(extends Sprite)
(name "Sprite")

; Pick the sheet, and its frame size, in Properties -> Sprite.
; (animation "") plays the whole sheet; (animation "walk") plays that clip.
; Clips are (name firstFrame lastFrame), counting from 0, left to right.
;
; this.play("walk") switches clip; this.stop() holds the frame.
; (loop false) fires onFinished when the clip ends.
ags?>
`,
    );
    // attachScript compiled, which rehydrated: `el` is stale. Return the live one.
    return this.live(el) ?? el;
  }

  /** Add a Button. `target` is the scene it goes to — the commonest case, no code. */
  async addButton({ label = 'Button', target = '', x = 540, y = 320, layer = 20 } = {}) {
    const el = this.addElement(
      { type: 'element', name: label, x, y, width: 220, height: 46, layer },
      'scene',
    );

    await this.attachScript(
      el,
      `<?dat
(label "${label}")
(target "${target}")
?>
<?def
(extends Button)
(name "${label}")

; With (target …) set, this button already works — no code needed.
; For anything else, override press():
;
; function press(actor) {
;   this.say("Not yet.");
; }
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Add a hamburger that shows and hides a set of buttons.
   *
   * Draws its own icon, because `draw()` is the hook — an author should never
   * need an image for three lines.
   */
  async addHamburger(items = ['New Game', 'Load Game', 'Settings', 'Credits']) {
    const el = this.addElement(
      { type: 'element', name: 'Menu', x: 48, y: 44, width: 52, height: 44, layer: 30 },
      'scene',
    );

    await this.attachScript(
      el,
      `<?dat
(open false)
(items (${items.map((i) => `"${i}"`).join(' ')}))
(barColor "#ffffff")
(background "rgba(12,12,14,0.72)")
(hoverBackground "rgba(60,68,86,0.92)")
(border "rgba(255,255,255,0.18)")
?>
<?def
(extends Button)
(name "Menu")

; EVERY declaration goes above the first function. The reader stops at the first
; token that isn't "(" — anything after that is JavaScript.
(runInfo apply onLoad)

; Toggle every element named in (items …). They are ordinary Buttons — this only
; shows and hides them.
function press(actor) {
  this.open = !this.open;
  this.apply();
  return this.open;
}

function apply() {
  var i = 0;
  while (i < this.items.length) {
    var el = this.find(this.items[i]);
    if (el) { el.visible = this.open; }
    i = i + 1;
  }
}

// Three bars, or an X when open. No image needed.
function draw(ctx, api) {
  var hot = this.hovered;
  ctx.fillStyle = hot ? this.hoverBackground : this.background;
  ctx.fillRect(0, 0, api.width, api.height);
  ctx.strokeStyle = this.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, api.width - 1, api.height - 1);

  var w = api.width * 0.46;
  var x = (api.width - w) / 2;
  var cy = api.height / 2;
  var gap = api.height * 0.18;

  ctx.strokeStyle = this.barColor;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  if (this.open) {
    ctx.moveTo(x, cy - gap); ctx.lineTo(x + w, cy + gap);
    ctx.moveTo(x + w, cy - gap); ctx.lineTo(x, cy + gap);
  } else {
    ctx.moveTo(x, cy - gap); ctx.lineTo(x + w, cy - gap);
    ctx.moveTo(x, cy);       ctx.lineTo(x + w, cy);
    ctx.moveTo(x, cy + gap); ctx.lineTo(x + w, cy + gap);
  }
  ctx.stroke();
}
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Add a Video element filling the frame, scripted so it's immediately editable.
   * @param {string} [mediaName] pre-fill the source
   */
  async addVideo(mediaName = '') {
    const el = this.addElement(
      { type: 'object', name: 'Video', x: 0, y: 0, width: 1280, height: 720, layer: 0 },
      'scene',
    );

    await this.attachScript(
      el,
      `<?dat
(video "${mediaName}")
(loop false)
(muted false)
(autoplay true)
(fit "fill")
(background "#000000")
?>
<?def
(extends Video)
(name "Video")

; Fires when the video reaches its end. Never fires while (loop true).
(runInfo finish onEnded)

function finish() {
  // this.goToScene("Main Menu");
}
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Add the project's save handler.
   *
   * One per project, in the HUD layer so it outlives every scene. The template
   * is a WORKING handler, not a stub: it saves the inventory and any element
   * carrying the listed properties, so an author sees a real save file
   * immediately and edits from there.
   */
  async addSaveHandler() {
    const existing = this.hud?.all().find((e) => e.script?.includes('save-handler'));
    if (existing) return existing;

    const el = this.addElement(
      { type: 'element', name: 'SaveHandler', x: 0, y: 0, width: 1, height: 1, layer: 0 },
      'hud',
    );
    el.visible = false; // machinery, not scenery

    await this.attachScript(
      el,
      `<?dat
; Which element properties are worth remembering. Any element carrying one of
; these gets captured; everything else is scenery.
(trackProps ("locked" "opened" "opens" "spoken" "gaveKey" "clicked"))
?>
<?def
(extends SaveHandler)
(name "SaveHandler")

; The engine owns the envelope, the moment, and the ordering.
; THIS decides the contents. It is the only thing that knows what matters here.
;
; Note the comment syntax changes below: ";" up here in dat/def, "//" down there
; in the methods, because down there it is plain JavaScript.

// Called while a save is being written. Put anything you like on \`save\`.
function capture(save) {
  save.inventory = this.captureInventory();
  save.elements  = this.captureScene(this.trackProps);
  save.hud       = this.captureHud(this.trackProps);
}

// Called while a save is being loaded — AFTER the scene has loaded, so the
// elements you are restoring exist. Anything belonging to a scene the player is
// not in yet is parked and applied when they walk into it.
function restore(save) {
  this.restoreInventory(save.inventory);
  this.restoreElements(save.elements);
  this.restoreElements(save.hud);
}
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /** Add an Inventory to the HUD, scripted so the author can immediately edit it. */
  /**
   * Add the dialogue box. HUD, because a conversation must survive goToScene.
   *
   * One per project: two boxes would both answer `world.dialogueBox` and the
   * delegate would present into whichever the HUD happened to list first.
   */
  async addDialogueBox() {
    const existing = this.hud?.all().find((e) => e.script?.includes('dialogue-box'));
    if (existing) return existing;

    const el = this.addElement(
      { type: 'element', name: 'DialogueBox', x: 190, y: 470, width: 900, height: 170, layer: 90 },
      'hud',
    );

    await this.attachScript(
      el,
      `<?dat
(text "This is where a line of dialogue appears.")
(size 22)
(color "#f0f0f0")
(background "rgba(10,10,12,0.86)")
(padding 18)
(align "left")
(valign "top")

; Choices are real Buttons, spawned above this box while someone is talking.
(choicesAbove true)
(choiceHeight 36)
(choiceGap 6)
(choiceSize 18)
?>
<?def
(extends DialogueBox)
(name "DialogueBox")

; Position and style this like any other element -- it IS an element.
; Override draw(ctx, api) to take over the box completely; the choices are
; separate elements and keep working either way.
;
; With this in the HUD, say() draws here instead of the fallback line.
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Add the input controller (3D projects). One per scene: it is the mapping
   * table a third-person character reads, and two tables would race. The dat IS
   * the interface — every binding sits in Properties, editable (DESIGN.md §18.9).
   */
  async addController() {
    const existing = this.scene?.all().find((e) => e instanceof AE1Controller);
    if (existing) return existing;

    const el = this.addElement(
      { type: 'element', name: 'Controller', x: 0, y: 0, z: 0, width: 1, height: 1 },
      'scene',
    );

    await this.attachScript(
      el,
      `<?dat
; One code per action. Key names are KeyboardEvent.code ("KeyW", "Space",
; "ShiftLeft"); mouse buttons are Mouse0 (left) and Mouse2 (right).
(forward "KeyW")
(back "KeyS")
(left "KeyA")
(right "KeyD")
(jump "Space")
(primary "Mouse0")
(secondary "Mouse2")

; Mouse look: degrees per pixel, and whether up on the mouse looks down.
(sensitivity 0.15)
(invertY false)
?>
<?def
(extends Controller)
(name "Controller")

; Pure data -- the character asks this element which codes to watch. Extend it
; if a game mode needs to swap bindings on the fly.
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Every third-person character comes with a camera (DESIGN.md §18.9). Called
   * after a script attach: if the scene gained a ThirdPersonCharacter and has
   * no ThirdPersonCamera, add one — visible in the Outliner, its feel editable
   * in Properties. Play uses it as the view; the editor viewport never does.
   */
  async _ensureThirdPersonCamera() {
    const all = this.scene?.all() ?? [];
    if (!all.some((e) => e instanceof AE1ThirdPersonCharacter)) return null;
    const existing = all.find((e) => e instanceof AE1ThirdPersonCamera);
    if (existing) return existing;

    const el = this.addElement(
      { type: 'element', name: 'Camera', x: 0, y: 2, z: 4, width: 1, height: 1 },
      'scene',
    );

    await this.attachScript(
      el,
      `<?dat
; The orbit's feel. distance is how far behind, lookHeight is where on the
; character it looks (metres up from their feet).
(distance 3.5)
(lookHeight 1.6)
(minPitch -60)
(maxPitch 75)
?>
<?def
(extends ThirdPersonCamera)
(name "Camera")

; The play-mode view. Mouse look orbits it around the character; idling lets
; you look at your own character without moving them. The editor viewport is
; never this camera -- only Play is.
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  /**
   * Add a character with a conversation.
   *
   * The tree is dat, so it is data an author edits -- and a modder can read in a
   * shipped game, because the .ags.txt ships loose.
   */
  async addDialogue(layer = 'scene') {
    const el = this.addElement(
      { type: 'character', name: 'Talker', x: 520, y: 240, width: 180, height: 260, layer: 10 },
      layer,
    );

    await this.attachScript(
      el,
      `<?dat
; A tree is nodes. Each node has a line, and choices that name the next node.
; A choice with no node ends the conversation.
(dialogue
  (start
    (text "Hey. You look lost.")
    (choice "Who are you?" who)
    (choice "Do you have a key?" key)
    (choice "Never mind."))
  (who
    (text "Nobody important. I just stand here.")
    (choice "Fair enough." start))
  (key
    (text "Maybe I do. What's it worth to you?")
    (does offerTrade)
    (choice "Here, take this." paid)
    (choice "Forget it." start))
  (paid
    (text "Pleasure doing business.")
    (does giveKey))
  )

(startNode "start")
(continueLabel "▸")
?>
<?def
(extends DialogueDelegate)
(name "Talker")

; Clicking this element starts the conversation. That is inherited -- you do not
; need onClick unless you want something else to start it.
;
; (does someMethod) on a node calls that method as the node opens, and needs no
; runInfo -- the tree names it. runInfo is for the whole conversation:
;   onDialogueStart  onNode  onChoice  onDialogueEnd
(runInfo whenNode onNode)

; EVERY declaration must be above the first function. Below here is JavaScript,
; and comments become // instead of ;.

// Called by (does offerTrade) when the "key" node opens.
function offerTrade() {
  // this.find("Door"), this.give(...), this.playSound(...) -- the whole library
  // is here, which is how a conversation changes the rest of the game.
}

// Called by (does giveKey) when the "paid" node opens.
function giveKey() {
  this.give({ id: "brass_key", name: "Brass Key" });
}

// Scheduled by (runInfo whenNode onNode) above: fires every time a node opens.
function whenNode(id) {
  // console.log("now at", id);
}
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  async addInventory() {
    const el = this.addElement(
      {
        type: 'element',
        name: 'Inventory',
        x: 24,
        y: 620,
        width: 320,
        height: 76,
        layer: 100,
      },
      'hud',
    );

    await this.attachScript(
      el,
      `<?dat
(slots 6)
(padding 8)
(slotSize 52)
?>
<?def
(extends Inventory)
(name "Inventory")

; Extending Inventory gives you items, add/remove/has, and slot rendering.
; Override draw() here to make it look like anything you want.
ags?>
`,
    );
    return this.live(el) ?? el;
  }

  removeElement(id) {
    if (this.selectedId === id) this.select(null);
    if (this.scene?.get(id)) this.scene.remove(id);
    else this.hud?.remove(id);
    this.emit('scene', this.scene);
  }

  reparent(id, parentId) {
    const scene = this.scene?.get(id) ? this.scene : this.hud;
    if (!scene?.reparent(id, parentId)) return false;
    this.emit('scene', this.scene);
    return true;
  }

  _onChange(el, key, value, layer) {
    // say() is output, not state. It must not journal -- a character speaking
    // during a test is not an edit to the project.
    if (key === '@say') {
      this.log({ severity: 'say', message: value, from: el?.name });
      return;
    }
    // A video decoding its first frame asks for a repaint. That is not an edit —
    // journaling it would mark the project dirty and save a file because a
    // decoder finished its job.
    if (key === '@redraw') {
      this.emit('element', { element: el, key });
      return;
    }

    if (key === '@scene') {
      // The world moved to another scene during play; follow it so the Outliner
      // and viewport show what the player is actually looking at.
      this.scene = this.world.scene;
      this.file = this.world.sceneFile;
      this.select(null);
      this.emit('scene', this.scene);
      this.log({ severity: 'info', message: `→ Scene: ${this.scene.name}` });
      return;
    }

    if (key === '@add' || key === '@remove' || key === 'parent') this.emit('scene', this.scene);
    this.emit('element', { element: el, key, layer });
    this.journal();
  }

  /* -- history ------------------------------------------------------------- */

  _captureState() {
    return {
      file: this.file,
      scene: this.scene?.serialize() ?? null,
      hud: this.hud?.serialize() ?? null,
    };
  }

  _restoreState(state) {
    if (!state || state.file !== this.file) return;

    if (state.scene) {
      this.scene = new AE1Scene(state.scene, {
        onChange: (el, key, value) => this._onChange(el, key, value, 'scene'),
      });
      this.scene.setWorld(this.editorWorld);
      this.sceneData[this.file] = state.scene;
    }
    if (state.hud) {
      this.hud = new AE1Scene(state.hud, {
        onChange: (el, key, value) => this._onChange(el, key, value, 'hud'),
      });
      this.hud.setWorld(this.editorWorld);
    }

    this._rehydrate();
    if (!this.selected) this.selectedId = null;

    this.emit('scene', this.scene);
    this.emit('selection', this.selected);
    this._write(); // an undone state is the state on disk
  }

  undo() {
    if (this.playing) return false;
    return this.history.undo();
  }

  redo() {
    if (this.playing) return false;
    return this.history.redo();
  }

  /* -- media --------------------------------------------------------------- */

  async importFiles(files) {
    const results = [];
    for (const file of files) {
      try {
        const entry = await api.uploadMedia(this.project.slug, file);
        this.media[entry.hash] = entry;
        results.push(entry);
        this.log({
          severity: 'info',
          message: entry.duplicate
            ? `${entry.name} — identical to an asset already imported; reused.`
            : `Imported ${entry.name} (${formatBytes(entry.size)})`,
        });
      } catch (err) {
        // One failure must not sink the batch: dropping forty assets and losing
        // all of them because one was broken would be infuriating.
        this.log({ severity: 'error', message: `${file.name}: ${err.message}` });
      }
    }
    this.emit('media', this.media);
    return results;
  }

  async renameMedia(hash, name) {
    this.media[hash] = { ...this.media[hash], name };
    this.emit('media', this.media);
    await api.patchMedia(this.project.slug, hash, { name });
  }

  async deleteMedia(hash) {
    const users = this.elementsUsingMedia(hash);
    if (users.length) return { ok: false, users: users.map((e) => e.name) };

    delete this.media[hash];
    this.emit('media', this.media);
    await api.deleteMedia(this.project.slug, hash);
    return { ok: true };
  }

  /** Anything pointing at this asset, across every scene and the HUD. */
  elementsUsingMedia(hash) {
    const users = [];
    for (const [file, data] of Object.entries(this.sceneData)) {
      const live = file === this.file ? this.scene?.serialize() : data;
      for (const el of Object.values(live?.elements ?? {})) {
        if (el.components?.sprite?.media === hash) users.push({ name: `${el.name} (${file})` });
      }
    }
    for (const el of this.hud?.all() ?? []) {
      if (el.components?.sprite?.media === hash) users.push({ name: `${el.name} (HUD)` });
      for (const item of el.items ?? []) {
        if (item.icon === hash) users.push({ name: `${item.name} (inventory item)` });
      }
    }
    return users;
  }

  /**
   * Make an element from an asset. Async, because a video needs a script.
   * @returns {Promise<AE1Element|null>}
   */
  async addElementFromMedia(hash, { x = 0, y = 0, layer = 'scene' } = {}) {
    const entry = this.media[hash];
    if (!entry) return null;

    // A video dropped in must become a Video, not a sprite element pointing at an
    // .mp4 — which would draw nothing and look like the import failed.
    if (entry.kind === 'video') {
      const el = await this.addVideo(entry.name);
      el.name = entry.name.replace(/\.[^.]+$/, '');
      return el;
    }

    return this.addElement(
      {
        type: entry.kind === 'audio' ? 'audio' : 'object',
        name: entry.name.replace(/\.[^.]+$/, ''),
        x: Math.round(x),
        y: Math.round(y),
        width: entry.width ?? 128,
        height: entry.height ?? 128,
        components: { sprite: { media: hash, ext: entry.ext } },
      },
      layer,
    );
  }

  log(entry) {
    this.logs.push({ ...entry, at: Date.now() });
    if (this.logs.length > 500) this.logs.shift(); // a log is not a memory leak
    this.emit('log', this.logs);
  }

  /* -- play ---------------------------------------------------------------- */

  /**
   * Enter play mode.
   *
   * PLAYING MUST NOT EDIT THE PROJECT (DESIGN.md §7.1). A running game mutates
   * elements by design; with continuous journaling those writes would stream
   * straight to disk, so pressing Play would permanently rewrite the author's
   * work into whatever state they happened to stop in.
   *
   * Play builds a real AE1World -- the same class the exported game boots -- so
   * scene changes, the HUD, audio, and the inventory behave in the editor exactly
   * as they will in the build.
   */
  play() {
    if (this.playing || !this.scene) return;

    this.flush();
    this.history.commit();

    // Snapshot everything a script can touch: the scene, the HUD, and which
    // scene we started in. A door that changes scenes must not leave the author
    // in scene 2 with scene 1 unsaved.
    this.sceneData[this.file] = this.scene.serialize();
    this._snapshot = {
      file: this.file,
      scenes: structuredClone(this.sceneData),
      hud: this.hud.serialize(),
    };

    this.playing = true;

    this.world = new AE1World({
      scenes: this.sceneData,
      hud: this.hud.serialize(),
      classes: this.classes,
      media: this.media,
      mediaBase: `/projects/${this.project.slug}/media`,
      game: {
        id: this.project.id,
        title: this.project.name,
        version: this.project.metadata?.version,
      },

      // The editor HAS a server, so saves land in /saves silently — no download
      // dialog every time an author tests a save button. A shipped game passes
      // no writer and hands the player a file instead. Same saveGame() call in
      // the script; the host decides where it goes.
      writeSave: async (data, name) => {
        await api.createSave(this.project.slug, name, data);
        this.log({ severity: 'info', message: `Saved → /saves/${name}` });
        this.emit('saves', null);
      },

      onChange: (el, key, value) => this._onChange(el, key, value, 'play'),
    });

    this.loop = new GameLoop(this.world, {
      onError: (err, el, method, mode) =>
        this.log({
          severity: 'error',
          message: `${el?.name}.${method}() threw during ${mode}: ${err.message}`,
          from: el?.script,
        }),
    });
    this.world.loop = this.loop;

    // Play starts THE GAME, not the open scene: always from the project's
    // entry scene, exactly like the shipped build (game3d boots
    // data.entryScene). Editing Scene 2 and pressing Play must run the real
    // quest from the top — reaching a level mid-game is the job of IN-GAME
    // debug tools (teleports, checkpoints), not the editor's current view.
    // Stop still restores the editor to the scene being edited (_snapshot).
    this.world.start(this.project?.entryScene ?? this.file);

    // The world built its own instances; point the editor at them so the
    // Outliner, Properties, and viewport show what is actually running.
    this.scene = this.world.scene;
    this.hud = this.world.hud;
    this.loop.start();

    this.log({ severity: 'info', message: '▶ Play started. Changes will be discarded on stop.' });
    this.emit('play', true);
    this.emit('scene', this.scene);
  }

  stop() {
    if (!this.playing) return;

    this.loop?.stop();
    this.world?.stop();
    this.loop = null;
    this.world = null;
    this.playing = false;

    const snap = this._snapshot;
    this._snapshot = null;

    // Rebuild from the snapshot rather than undoing mutations: there is no
    // mutation a script can make that we then fail to reverse.
    this.sceneData = snap.scenes;
    this.hud = new AE1Scene(snap.hud, {
      onChange: (el, key, value) => this._onChange(el, key, value, 'hud'),
    });
    this.hud.setWorld(this.editorWorld);
    this._loadScene(snap.file);
    this.selectedId = null;

    this._rehydrate();
    this.emit('scene', this.scene);
    this.emit('selection', null);
    this.log({ severity: 'info', message: '■ Play stopped. Scene restored.' });
    this.emit('play', false);
  }

  togglePlay() {
    this.playing ? this.stop() : this.play();
  }

  /* -- journaling ---------------------------------------------------------- */

  journal() {
    // The journal is silent during play. This single guard is what makes Play a
    // rehearsal instead of an edit.
    if (this.playing) return;

    this.history.touch();
    this.emit('dirty', true);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), JOURNAL_MS);
  }

  async flush() {
    clearTimeout(this._timer);
    if (!this.scene || !this.project || this.playing) return;
    await this._write();
  }

  async _write() {
    // Saves must not overlap. Two in flight can land out of order and write an
    // older state last, silently reverting the newest edit.
    if (this._saving) {
      this._again = true;
      return;
    }

    this._saving = true;
    try {
      this.sceneData[this.file] = this.scene.serialize();
      await Promise.all([
        api.putScene(this.project.slug, this.file, this.sceneData[this.file]),
        api.putHud(this.project.slug, this.hud.serialize()),
      ]);
      this.emit('dirty', false);
    } catch (err) {
      this.emit('dirty', 'error');
      console.error('[scene-store] save failed:', err);
    } finally {
      this._saving = false;
      if (this._again) {
        this._again = false;
        this._write();
      }
    }
  }
}

export const store = new SceneStore();

// Last-ditch flush on window close. A backstop, not the plan.
//
// sendBeacon can only issue POST, never PUT, so the scene and hud routes accept
// POST purely for this. It is also the only request that survives unload.
window.addEventListener('pagehide', () => {
  if (!store.scene || !store.project) return;

  // Mid-play, save the PRE-play snapshot, never the live game state. Otherwise
  // quitting while playing does exactly the damage suspending the journal
  // was meant to prevent.
  const scene = store.playing ? store._snapshot?.scenes?.[store._snapshot.file] : store.scene.serialize();
  const hud = store.playing ? store._snapshot?.hud : store.hud?.serialize();
  const file = store.playing ? store._snapshot?.file : store.file;
  if (!scene || !file) return;

  const post = (url, data) =>
    navigator.sendBeacon?.(url, new Blob([JSON.stringify(data)], { type: 'application/json' }));

  post(`/api/projects/${store.project.slug}/scenes/${file}`, scene);
  if (hud) post(`/api/projects/${store.project.slug}/hud`, hud);
});

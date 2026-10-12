/**
 * AE1 - the exported game runtime.
 *
 * This is what a shipped AE1 game boots into. It uses the SAME scene, element,
 * AGS compiler, scheduler, loop, and renderer as the editor -- nothing here is a
 * second implementation of anything (Principle 2).
 *
 * All data is handed in, never fetched: an exported game must run from file://
 * by double-clicking index.html, and fetch() is blocked on file:// origins. The
 * export inlines scenes and scripts into the page; media loads as <img>, which
 * file:// permits. The canvas gets tainted by those images, which costs nothing
 * because we never read pixels back.
 */

import { AE1World } from './world.js';
import { compileAll } from './ags/runtime.js';
import { GameLoop } from './loop.js';
import { drawElements } from './renderer.js';

const TYPE_COLORS = {
  element: '#6b7f9e',
  background: '#5f8a5f',
  character: '#a06b83',
  object: '#a08a55',
  region: '#5590a0',
  audio: '#8465a5',
};

/**
 * Boot a game.
 *
 * @param {object} data                   the inlined manifest
 * @param {string} data.title
 * @param {number} data.width
 * @param {number} data.height
 * @param {string} data.entryScene
 * @param {Record<string, object>} data.scenes   file -> scene JSON
 * @param {Record<string, string>} data.scripts  file -> .ags.txt source
 * @param {string} [data.mediaBase]
 * @param {HTMLElement} [mount]
 */
function bootGame(data, mount = document.body) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ae1-canvas';
  mount.append(canvas);

  const dialogue = document.createElement('div');
  dialogue.className = 'ae1-dialogue';
  mount.append(dialogue);

  const ctx = canvas.getContext('2d');
  const W = data.width ?? 1280;
  const H = data.height ?? 720;
  const mediaBase = data.mediaBase ?? 'media';

  document.title = data.title ?? 'AE1 Game';

  /* -- compile ----------------------------------------------------------- */

  const { classes, diagnostics } = compileAll(data.scripts ?? {});
  for (const d of diagnostics) {
    // Loud in the console, never fatal. A shipped game with one broken script
    // should still be playable -- and a modder editing a .ags.txt needs to see
    // exactly why their edit did not take.
    const where = `${d.file}${d.line ? `:${d.line}` : ''}`;
    console[d.severity === 'error' ? 'error' : 'warn'](`[ags] ${where} — ${d.message}`);
  }

  if (!data.scenes?.[data.entryScene]) {
    dialogue.textContent = `Missing entry scene "${data.entryScene}".`;
    dialogue.dataset.show = 'true';
    return null;
  }

  const world = new AE1World({
    scenes: data.scenes,
    hud: data.hud,
    classes,
    media: data.media ?? {},
    mediaBase,
    game: {
      id: data.gameId,
      title: data.title,
      version: data.version,
      engine: 'Angel’s Egg',
      engineVersion: data.engine,
    },
    // No `writeSave`. A shipped game has no server, so saveGame() hands the
    // player a file — which is the constraint that makes saves theirs to edit.
    onChange: (el, key, value) => {
      // The DOM line is the FALLBACK, for a project with no DialogueBox element.
      // With one, the line is already drawn on the canvas -- showing it here too
      // would double every sentence in the game.
      if (key === '@say' && !world.dialogueBox) say(value);
    },
  });

  /* -- dialogue ---------------------------------------------------------- */

  let sayTimer = null;
  function say(text) {
    dialogue.textContent = text;
    dialogue.dataset.show = 'true';
    clearTimeout(sayTimer);
    // Long enough to read, short enough not to linger. Scales with length
    // because "It's locked." and a paragraph are not the same read.
    sayTimer = setTimeout(() => delete dialogue.dataset.show, 1800 + String(text).length * 45);
  }

  /* -- camera ------------------------------------------------------------ */

  /** Letterboxed fit: scale to the window, preserve aspect, centre. */
  const cam = { scale: 1, ox: 0, oy: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;

    cam.scale = Math.min(vw / W, vh / H);
    cam.ox = (vw - W * cam.scale) / 2;
    cam.oy = (vh - H * cam.scale) / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /** Client point -> scene point. The inverse of the camera, exactly. */
  function toScene(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - cam.ox) / cam.scale,
      y: (clientY - r.top - cam.oy) / cam.scale,
    };
  }

  function draw() {
    const vw = canvas.width / (window.devicePixelRatio || 1);
    const vh = canvas.height / (window.devicePixelRatio || 1);

    // The letterbox bars. Black, because they are not part of the game.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);

    ctx.save();
    ctx.translate(cam.ox, cam.oy);
    ctx.scale(cam.scale, cam.scale);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip(); // nothing escapes the frame into the bars

    drawElements(ctx, world.orderedElements(), {
      mediaBase,
      colorFor: (t) => TYPE_COLORS[t] ?? TYPE_COLORS.element,
      onImageLoad: draw,
      zoom: cam.scale,
    });

    ctx.restore();
  }

  /* -- loop -------------------------------------------------------------- */

  const loop = new GameLoop(world, {
    onFrame: draw,
    onError: (err, el, method, mode) =>
      console.error(`[ags] ${el?.name}.${method}() threw during ${mode}:`, err),
  });
  world.loop = loop;

  canvas.addEventListener('pointerdown', (e) => {
    const p = toScene(e.clientX, e.clientY);
    loop.pointerDown(p.x, p.y);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toScene(e.clientX, e.clientY);
    const over = loop.pointerMove(p.x, p.y);
    canvas.style.cursor = over ? 'pointer' : 'default';
  });

  window.addEventListener('resize', resize);
  resize();

  // The world starts the entry scene (firing HUD onLoad once, then the scene's),
  // and the loop must already exist so goToScene can rebuild its tables.
  world.start(data.entryScene);
  loop.start();

  // Exposed deliberately. Mods are encouraged (Principle 3), and a modder in the
  // devtools console wants the world, the loop, and the classes in reach.
  const game = {
    world,
    loop,
    classes,
    draw,
    say,
    canvas,
    get scene() {
      return world.scene;
    },
    get inventory() {
      return world.inventory;
    },
    goToScene: (n) => world.goToScene(n),
    saveGame: (extra) => world.saveGame(extra),
    loadGame: () => world.loadGame(),
    continueGame: () => world.continueGame(),
    get settings() {
      return world.settings;
    },
    setSetting: (k, v) => world.setSetting(k, v),
  };
  window.AE1 = game;
  return game;
}

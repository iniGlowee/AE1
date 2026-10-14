/**
 * AE1 - workspace view.
 *
 * Loads the project's scene into the store, then hosts the area tree over it.
 */

import { h, clear, toast, modal } from '../ui.js';
import { settings } from '../settings.js';
import { store } from '../scene-store.js';
import { api } from '../api.js';
import { createWorkspace } from '../workspace/area.js';
import { defaultLayout } from '../workspace/layouts.js';
import { openShip } from './ship.js';

let current = null;
let offDirty = null;
let offPlay = null;
let offScenes = null;
let offHistory = null;
let onKey = null;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount
 * @param {object} opts.project
 * @param {() => void} opts.onBack
 */
export async function renderWorkspace({ mount, project, onBack, onOpen }) {
  destroyWorkspace();
  clear(mount);

  const areas = h('div', { id: 'workspace' });
  const saveState = h('span', { class: 'ws-save' }, 'Loading…');

  const playBtn = h(
    'button',
    { class: 'btn ws-play', title: 'Play the scene (F5)', onClick: () => store.togglePlay() },
    '▶ Play',
  );

  const sceneSelect = h('select', {
    class: 'ws-scene',
    title: 'Switch scene',
    onChange: (e) => {
      if (e.target.value === '__new') {
        e.target.value = store.file;
        return newScene();
      }
      store.switchScene(e.target.value);
    },
  });

  const undoBtn = h(
    'button',
    { class: 'btn btn--ghost ws-hist', title: 'Undo (Ctrl+Z)', onClick: () => store.undo() },
    '↺',
  );
  const redoBtn = h(
    'button',
    { class: 'btn btn--ghost ws-hist', title: 'Redo (Ctrl+Shift+Z)', onClick: () => store.redo() },
    '↻',
  );

  const root = h(
    'div',
    { id: 'workspace-root' },
    h(
      'div',
      { class: 'ws-bar' },
      h('button', { class: 'btn btn--ghost', onClick: onBack }, '←'),
      h('span', { class: 'ws-title' }, project.name),
      // MANAGER-PROJECT-01 W4: move the work out from under the sample
      h(
        'button',
        {
          class: 'btn btn--ghost',
          title: 'Save this project under a new name and keep working in the copy',
          onClick: () => saveAsDialog(project, { onOpen }),
        },
        'Save as…',
      ),
      sceneSelect,
      undoBtn,
      redoBtn,
      h('div', { class: 'ws-spacer' }),
      h(
        'button',
        {
          class: 'btn btn--ghost',
          title: 'Build a self-contained game',
          onClick: () => openShip(project),
        },
        'Build & Ship',
      ),
      playBtn,
      saveState,
      h(
        'button',
        { class: 'btn btn--ghost', title: 'Restore the default layout', onClick: reset },
        'Reset Layout',
      ),
    ),
    areas,
  );

  mount.append(root);

  // The save indicator reports the journal honestly. "Saved" has to mean saved,
  // or it is worse than showing nothing at all (DESIGN.md 3.1).
  offDirty = store.on('dirty', (state) => {
    // play() flushes without awaiting, so that flush resolves and emits
    // dirty:false AFTER the play event -- overwriting "Not saving" with "Saved"
    // while the journal is suspended. The indicator would then be lying at
    // exactly the moment its honesty matters most.
    if (store.playing) return;

    if (state === 'error') {
      saveState.textContent = 'Save failed';
      saveState.dataset.state = 'error';
    } else if (state) {
      saveState.textContent = 'Saving…';
      saveState.dataset.state = 'dirty';
    } else {
      saveState.textContent = 'Saved';
      saveState.dataset.state = 'saved';
    }
  });

  offPlay = store.on('play', (on) => {
    playBtn.textContent = on ? '■ Stop' : '▶ Play';
    playBtn.dataset.playing = String(on);
    root.dataset.playing = String(on);
    // Undo is meaningless during play: play has its own snapshot/restore, and
    // undoing into a state the running game never had would be incoherent.
    undoBtn.disabled = redoBtn.disabled = on;
    sceneSelect.disabled = on;
    // Repaint on BOTH edges: play may run a different scene than the one
    // being edited (it always starts the ENTRY scene now), and stop restores
    // the edited one — a dropdown painted only on start kept showing the
    // PLAYED scene after stop.
    paintScenes();
    // The journal is suspended while playing. Saying "Saved" would be a lie, and
    // an honest indicator is the whole point of having one.
    saveState.textContent = on ? 'Not saving' : 'Saved';
    saveState.dataset.state = on ? 'playing' : 'saved';
  });

  offScenes = store.on('scenes', paintScenes);
  offHistory = store.on('history', ({ canUndo, canRedo }) => {
    undoBtn.disabled = !canUndo || store.playing;
    redoBtn.disabled = !canRedo || store.playing;
  });

  function paintScenes() {
    clear(sceneSelect);
    for (const s of store.sceneList) {
      sceneSelect.append(
        h('option', { value: s.file, selected: s.file === store.file }, s.name ?? s.file),
      );
    }
    sceneSelect.append(h('option', { value: '__new' }, '+ New scene…'));
  }

  async function newScene() {
    const input = h('input', { class: 'input', placeholder: 'Hallway' });
    const m = modal({
      title: 'New Scene',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Scene name'), input),
        h(
          'div',
          { class: 'field-hint' },
          'Scripts reach it with goToScene("Hallway"). HUD elements carry over automatically.',
        ),
      ),
      footRight: [
        h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn--primary', onClick: create }, 'Create'),
      ],
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && create());

    async function create() {
      const name = input.value.trim();
      if (!name) return;
      try {
        const file = await store.createScene(name);
        m.close();
        await store.switchScene(file);
        paintScenes();
        toast(`Created "${name}".`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  onKey = (e) => {
    // F5 is the DCC convention for play. preventDefault, or the browser reloads
    // the page and takes the session with it.
    if (e.key === 'F5' && !e.ctrlKey) {
      e.preventDefault();
      store.togglePlay();
      return;
    }

    // Never steal typing. The AGS editor lives in a pane, and Ctrl+Z in a
    // textarea must undo the TEXT, not the scene.
    if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;

    const z = e.key === 'z' || e.key === 'Z';
    if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if ((e.ctrlKey || e.metaKey) && ((z && e.shiftKey) || e.key === 'y')) {
      e.preventDefault();
      store.redo();
    }
  };
  document.addEventListener('keydown', onKey);

  try {
    await store.open(project);
    paintScenes();
    saveState.textContent = 'Saved';
    saveState.dataset.state = 'saved';
  } catch (err) {
    clear(areas);
    areas.append(
      h(
        'div',
        { class: 'workspace-stub' },
        h('div', {}, h('h2', {}, 'Could not load scene'), h('p', {}, err.message)),
      ),
    );
    return;
  }

  current = createWorkspace({
    mount: areas,
    layout: settings.getLayout(project.type) ?? defaultLayout(project.type),
    context: { project },
    onChange: (tree) => settings.setLayout(project.type, tree),
  });

  function reset() {
    settings.setLayout(project.type, null);
    renderWorkspace({ mount, project, onBack });
    toast('Layout reset.', 'ok');
  }
}

/** Tear down observers, canvases, subscriptions, and key handlers. */
export function destroyWorkspace() {
  current?.destroy();
  current = null;
  offDirty?.();
  offPlay?.();
  offScenes?.();
  offHistory?.();
  offDirty = offPlay = offScenes = offHistory = null;
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  store.close(); // stops play, then flushes, before dropping the scene
}

/* Save as (MANAGER-PROJECT-01 W4) ------------------------------------------- */

/**
 * Copy the open project to a new name and switch to the copy; the original
 * stays exactly as it was. `then` = 'open' (default) switches to the copy;
 * 'stay' keeps the current project open (W5's "save a copy first"). Resolves
 * to the new project, or null when the user cancels.
 */
export function saveAsDialog(project, { onOpen, then = 'open', title = 'Save as a new project' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const input = h('input', {
      class: 'input',
      value: `${project.name} copy`,
      maxLength: 80,
      onKeydown: (e) => { if (e.key === 'Enter') go(); },
    });
    const note = h('p', { class: 'modal-note' },
      then === 'open'
        ? `A new project with everything in “${project.name}” as it is now. You will continue in the copy; “${project.name}” is left unchanged.`
        : `A new project with everything in “${project.name}” as it is now, so nothing is lost by what you do next.`);
    const err = h('p', { class: 'modal-error' });
    const saveBtn = h('button', { class: 'btn btn--primary', onClick: () => go() }, 'Save copy');
    const m = modal({
      title,
      body: h('div', {}, h('label', { class: 'field-label' }, 'Name of the copy'), input, note, err),
      footRight: [
        h('button', { class: 'btn', onClick: () => { m.close(); } }, 'Cancel'),
        saveBtn,
      ],
      onClose: () => settle(null),
    });
    requestAnimationFrame(() => input.select());

    async function go() {
      const name = input.value.trim();
      if (!name) { err.textContent = 'Give the copy a name.'; return; }
      saveBtn.disabled = true;
      err.textContent = '';
      try {
        if (store.playing) store.stop(); // play suspends the journal; the copy is of the edited project
        await store.flushAll();
        const copy = await api.copyProject(project.slug, name);
        settle(copy);
        m.close();
        toast(`Saved as “${copy.name}”.`);
        if (then === 'open' && onOpen) onOpen(copy);
      } catch (e) {
        saveBtn.disabled = false;
        err.textContent = e.message || String(e);
      }
    }
  });
}

/**
 * AE1 - the area system.
 *
 * Blender's model: the workspace is a binary tree. Every node is either a SPLIT
 * (two children, a direction, a ratio) or a LEAF (one editor). Any leaf can split
 * into two; any leaf can close and hand its space back to its sibling.
 *
 *   { t: 'split', dir: 'row'|'col', ratio: 0.5, a: node, b: node }
 *   { t: 'leaf',  id: uuid, editor: 'viewport' }
 *
 * 'row' lays children out side by side (the divider is vertical, drags left/right).
 * 'col' stacks them (the divider is horizontal, drags up/down).
 *
 * Two properties fall out of the tree for free, and they are why it is worth the
 * complexity over a fixed grid:
 *
 *   - MAXIMIZE is just "render this leaf alone for a moment". That is the whole
 *     implementation of the script editor's full-screen mode -- no second code
 *     path, no separate view.
 *   - Any arrangement a user can imagine is expressible, so the layout never has
 *     to be extended to accommodate a new editor.
 *
 * Panes are cached by leaf id and REUSED across re-renders. An editor is mounted
 * once and keeps its DOM, scroll position, and internal state when the tree
 * around it changes. Rebuilding the world on every split would reset the user's
 * viewport pan every time they touched a divider.
 */

import { h, clear } from '../ui.js';
import { EDITORS, DEFAULT_EDITOR } from './editors.js';

/** A pane narrower than this is unusable, so dividers refuse to make one. */
const MIN_RATIO = 0.08;

const uid = () => crypto.randomUUID();

export const isLeaf = (n) => n?.t === 'leaf';

export function leaf(editor = DEFAULT_EDITOR) {
  return { t: 'leaf', id: uid(), editor };
}

export function split(dir, a, b, ratio = 0.5) {
  return { t: 'split', dir, ratio, a, b };
}

/**
 * Validate a tree loaded from settings.
 *
 * Layouts round-trip through a JSON file a user can hand-edit, and an unknown
 * editor id would otherwise throw during render and take the whole workspace
 * down. Repair rather than reject: an unrecognised editor becomes the default,
 * and a malformed node becomes a leaf.
 */
export function sanitize(node) {
  if (!node || typeof node !== 'object') return leaf();

  if (node.t === 'split') {
    const a = sanitize(node.a);
    const b = sanitize(node.b);
    const dir = node.dir === 'col' ? 'col' : 'row';
    const ratio = Number.isFinite(node.ratio)
      ? Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, node.ratio))
      : 0.5;
    return { t: 'split', dir, ratio, a, b };
  }

  return {
    t: 'leaf',
    id: typeof node.id === 'string' ? node.id : uid(),
    editor: EDITORS[node.editor] ? node.editor : DEFAULT_EDITOR,
  };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount
 * @param {object} opts.layout    area tree
 * @param {object} opts.context   passed to every editor's mount()
 * @param {(tree: object) => void} opts.onChange  persist hook
 */
export function createWorkspace({ mount, layout, context, onChange }) {
  let tree = sanitize(layout);
  let maximized = null; // leaf id, or null

  /**
   * The pane the pointer last entered, or that last took focus.
   *
   * Tracked explicitly rather than read via `.pane:hover` at keypress time.
   * `:hover` is empty whenever the pointer is between panes, over a divider, or
   * hasn't moved since load -- so a hover-based lookup silently falls back and
   * maximizes an arbitrary pane instead of the one the user means. Keyboard
   * targeting has to be state, not a CSS query.
   */
  let activeId = null;

  /** leafId -> { pane, body, editorId, dispose } */
  const panes = new Map();

  function commit() {
    onChange?.(tree);
  }

  /* -- pane construction ------------------------------------------------- */

  function getPane(node) {
    let entry = panes.get(node.id);

    if (entry && entry.editorId === node.editor) return entry.pane;

    if (entry) {
      // Editor type changed in place. Tear the old one down properly -- an
      // editor may hold a rAF loop, a canvas, or an observer.
      entry.dispose?.();
      clear(entry.body);
    } else {
      const body = h('div', { class: 'pane-body' });
      const pane = h('div', { class: 'pane' }, buildHeader(node, body), body);

      const markActive = () => {
        activeId = node.id;
      };
      pane.addEventListener('pointerenter', markActive);
      pane.addEventListener('focusin', markActive);

      entry = { pane, body, editorId: null, dispose: null };
      panes.set(node.id, entry);
    }

    const def = EDITORS[node.editor] ?? EDITORS[DEFAULT_EDITOR];
    entry.editorId = node.editor;
    entry.dispose = def.mount?.(entry.body, context) ?? null;

    // The header caches the node, so rebuild it when the editor identity changes.
    entry.pane.replaceChild(buildHeader(node, entry.body), entry.pane.firstChild);

    return entry.pane;
  }

  function buildHeader(node, _body) {
    const select = h(
      'select',
      {
        class: 'pane-select',
        title: 'Editor type',
        onChange: (e) => {
          node.editor = e.target.value;
          getPane(node);
          commit();
        },
      },
      ...Object.entries(EDITORS).map(([id, def]) =>
        h('option', { value: id, selected: id === node.editor }, def.label),
      ),
    );

    const btn = (label, title, onClick) =>
      h('button', { class: 'pane-btn', title, onClick }, label);

    const isMax = maximized === node.id;

    return h(
      'div',
      {
        class: 'pane-head',
        // Ctrl+Space is Blender's maximize, but Windows binds it to IME layout
        // switching, so it can be swallowed before the page ever sees it. A
        // double-click on the header is the discoverable fallback that cannot be
        // intercepted -- the shortcut is a convenience, not the only way in.
        onDblclick: (e) => {
          if (e.target.closest('button, select')) return;
          toggleMax(node.id);
        },
      },
      select,
      h('div', { class: 'pane-head-spacer' }),
      isMax
        ? null
        : btn('▤', 'Split left / right', () => doSplit(node, 'row')),
      isMax
        ? null
        : btn('▥', 'Split top / bottom', () => doSplit(node, 'col')),
      btn(isMax ? '⤡' : '⤢', isMax ? 'Restore (Ctrl+Space)' : 'Maximize (Ctrl+Space)', () =>
        toggleMax(node.id),
      ),
      isMax ? null : btn('✕', 'Close this pane', () => doClose(node)),
    );
  }

  /* -- tree ops ---------------------------------------------------------- */

  function findParent(node, target, parent = null) {
    if (node === target) return parent;
    if (node.t !== 'split') return undefined;
    const viaA = findParent(node.a, target, node);
    if (viaA !== undefined) return viaA;
    return findParent(node.b, target, node);
  }

  function doSplit(node, dir) {
    const parent = findParent(tree, node);
    if (parent === undefined) return; // not in the tree; nothing to split

    // `node` itself becomes child `a` -- NOT a copy of it.
    //
    // Object identity is the tree's addressing scheme: every pane header closes
    // over its node, and findParent() locates nodes with `===`. Putting a clone
    // in the tree orphans the live header's reference, so the pane's own Close
    // button then looks up a node that no longer exists. That threw inside an
    // event listener, which the browser swallows -- so it presented as "Close
    // silently does nothing" with an empty console. Identity must be preserved.
    const replacement = split(dir, node, leaf(node.editor));

    if (parent === null) tree = replacement;
    else if (parent.a === node) parent.a = replacement;
    else parent.b = replacement;

    render();
    commit();
  }

  function doClose(node) {
    const parent = findParent(tree, node);
    if (!parent) return; // root leaf (null) or stale reference (undefined)

    const sibling = parent.a === node ? parent.b : parent.a;
    const grand = findParent(tree, parent);
    if (grand === undefined) return;

    if (grand === null) tree = sibling;
    else if (grand.a === parent) grand.a = sibling;
    else grand.b = sibling;

    disposePane(node.id);
    render();
    commit();
  }

  function disposePane(id) {
    const entry = panes.get(id);
    entry?.dispose?.();
    panes.delete(id);
  }

  function toggleMax(id) {
    maximized = maximized === id ? null : id;
    render();
    // Deliberately NOT committed. Maximize is a momentary view, not a layout --
    // reopening the project into a full-screen pane with the rest of the
    // workspace apparently gone would read as data loss.
  }

  /* -- render ------------------------------------------------------------ */

  function collectLeaves(node, out = []) {
    if (node.t === 'leaf') out.push(node);
    else {
      collectLeaves(node.a, out);
      collectLeaves(node.b, out);
    }
    return out;
  }

  function build(node) {
    if (node.t === 'leaf') return getPane(node);

    const aEl = build(node.a);
    const bEl = build(node.b);

    const container = h('div', { class: 'split', dataset: { dir: node.dir } });
    const divider = h('div', { class: 'divider', dataset: { dir: node.dir } });

    aEl.style.flex = `0 0 ${node.ratio * 100}%`;
    bEl.style.flex = '1 1 0';

    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      divider.dataset.dragging = 'true';
      document.body.dataset.dragging = node.dir;

      const rect = container.getBoundingClientRect();

      const move = (ev) => {
        const ratio =
          node.dir === 'row'
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;

        node.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));

        // Mutate style directly instead of re-rendering. A full rebuild per
        // pointermove would remount every editor 60 times a second.
        aEl.style.flex = `0 0 ${node.ratio * 100}%`;
      };

      const up = (ev) => {
        divider.releasePointerCapture(ev.pointerId);
        delete divider.dataset.dragging;
        delete document.body.dataset.dragging;
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        commit();
      };

      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
    });

    // Double-clicking a divider resets it to even, as in most DCC tools.
    divider.addEventListener('dblclick', () => {
      node.ratio = 0.5;
      aEl.style.flex = '0 0 50%';
      commit();
    });

    container.append(aEl, divider, bEl);
    return container;
  }

  function render() {
    clear(mount);

    if (maximized) {
      const node = collectLeaves(tree).find((n) => n.id === maximized);
      if (node) {
        mount.append(getPane(node));
        return;
      }
      maximized = null; // the maximized pane was closed underneath us
    }

    mount.append(build(tree));
  }

  /* -- keys -------------------------------------------------------------- */

  function onKey(e) {
    if (!(e.ctrlKey && e.code === 'Space')) return;

    // Never steal the key from a text field -- the AGS editor lives in a pane.
    if (e.target.matches?.('input, textarea, [contenteditable]')) return;

    const target = maximized ?? activeId;
    if (!target) return; // pointer has never entered a pane; do nothing rather than guess

    e.preventDefault();
    toggleMax(target);
  }

  document.addEventListener('keydown', onKey);

  render();

  return {
    get tree() {
      return tree;
    },
    render,
    destroy() {
      document.removeEventListener('keydown', onKey);
      for (const id of [...panes.keys()]) disposePane(id);
      clear(mount);
    },
  };
}

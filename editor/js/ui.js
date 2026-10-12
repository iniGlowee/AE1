/**
 * AE1 - shared UI primitives: DOM building, toasts, modals.
 *
 * No framework. AE1 should still build and run in ten years (DESIGN.md,
 * Principle 5), and a dependency-free editor cannot be broken by someone else's
 * major version.
 */

/**
 * Build an element.
 *
 *   h('div', { class: 'card' }, h('span', {}, 'hello'))
 *   h('button', { onClick: fn, disabled: true }, 'Create')
 *
 * Text children are set via textContent, so user-supplied strings (project names,
 * descriptions, server errors) can never be parsed as markup.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key in el && key !== 'list') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/* Toasts ------------------------------------------------------------------ */

const TOAST_MS = 3200;

/**
 * @param {string} message
 * @param {'info'|'ok'|'warn'|'error'} kind
 */
export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: 'toast', dataset: { kind } }, message);
  root.append(el);

  // Errors are the one thing worth reading twice.
  const life = kind === 'error' ? TOAST_MS * 2 : TOAST_MS;

  setTimeout(() => {
    el.dataset.leaving = 'true';
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, life);

  return el;
}

/* Modals ------------------------------------------------------------------ */

/**
 * Open a modal. Returns a handle with `close()`.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node}   opts.body
 * @param {Node[]} [opts.footLeft]   e.g. wizard step pips
 * @param {Node[]} [opts.footRight]  e.g. Cancel / Create
 * @param {boolean} [opts.dismissable=true]
 * @param {() => void} [opts.onClose]
 */
export function modal({ title, body, footLeft = [], footRight = [], dismissable = true, onClose }) {
  const root = document.getElementById('modal-root');

  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'modal-head' },
      h('div', { class: 'modal-title' }, title),
      dismissable
        ? h('button', { class: 'btn btn--ghost', onClick: () => close(), 'aria-label': 'Close' }, '✕')
        : null,
    ),
    h('div', { class: 'modal-body' }, body),
    h(
      'div',
      { class: 'modal-foot' },
      ...footLeft,
      h('div', { class: 'modal-foot-right' }, ...footRight),
    ),
  );

  const scrim = h('div', {
    class: 'modal-scrim',
    onClick: (e) => {
      if (e.target === scrim && dismissable) close();
    },
  }, dialog);

  function onKey(e) {
    if (e.key === 'Escape' && dismissable) {
      e.preventDefault();
      close();
    }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    onClose?.();
  }

  document.addEventListener('keydown', onKey);
  root.append(scrim);

  // Focus the first real control so the modal is keyboard-usable immediately.
  requestAnimationFrame(() => {
    dialog.querySelector('input, select, textarea, button:not(.btn--ghost)')?.focus();
  });

  return { close, dialog, scrim };
}

/**
 * Confirm a destructive action.
 *
 * Continuous journaling means there is no "quit without saving" to undo with
 * (DESIGN.md 3.1), so destructive actions have to ask first and say exactly what
 * they will destroy.
 */
export function confirmDanger({ title, message, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    let decided = false;
    const settle = (value) => {
      if (decided) return;
      decided = true;
      resolve(value);
    };

    const m = modal({
      title,
      body: h('div', {}, message),
      footRight: [
        h('button', { class: 'btn', onClick: () => { settle(false); m.close(); } }, 'Cancel'),
        h(
          'button',
          { class: 'btn btn--danger', onClick: () => { settle(true); m.close(); } },
          confirmLabel,
        ),
      ],
      // Dismissing without choosing is a "no". Resolving on close keeps the
      // promise from dangling forever if the user hits Escape.
      onClose: () => settle(false),
    });
  });
}

/**
 * AE1 - new project wizard.
 *
 * Steps are DATA, not code paths (DESIGN.md 9). Adding a step means adding an
 * entry to STEPS; the shell handles navigation, validation, and the footer
 * without knowing what any step contains. This is the whole reason the wizard can
 * grow to cover new project types and settings without a rewrite.
 */

import { h, modal, toast } from '../ui.js';
import { api } from '../api.js';

/** Mirror of the server's slugify (server.py). Preview only -- the server decides. */
function slugify(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'untitled';
}

function field(label, control, { hint, required } = {}) {
  return h(
    'div',
    { class: 'field' },
    h(
      'label',
      { class: 'field-label' },
      label,
      required ? h('span', { class: 'field-req' }, ' *') : null,
    ),
    control,
    hint ? h('div', { class: 'field-hint' }, hint) : null,
  );
}

/* Steps ------------------------------------------------------------------- */

const STEPS = [
  {
    id: 'identity',
    label: 'Project',

    render(state, { rerenderFooter }) {
      const slugHint = h('div', { class: 'field-hint' });
      const paintSlug = () => {
        slugHint.textContent = '';
        slugHint.append(
          'Folder: ',
          h('span', { class: 'slug-preview' }, `/projects/${slugify(state.name || '')}/`),
        );
      };
      paintSlug();

      const nameInput = h('input', {
        class: 'input',
        value: state.name,
        placeholder: 'The Silent Cathedral',
        maxLength: 80,
        onInput: (e) => {
          state.name = e.target.value;
          paintSlug();
          rerenderFooter();
        },
      });

      return h(
        'div',
        {},
        field('Project name', nameInput, { required: true }),
        h('div', { class: 'field', style: 'margin-top:-8px' }, slugHint),
        field(
          'Author',
          h('input', {
            class: 'input',
            value: state.metadata.author,
            placeholder: 'Your name',
            onInput: (e) => (state.metadata.author = e.target.value),
          }),
        ),
        field(
          'Description',
          h('textarea', {
            class: 'textarea',
            value: state.metadata.description,
            placeholder: 'What is this game?',
            onInput: (e) => (state.metadata.description = e.target.value),
          }),
        ),
        field(
          'Version',
          h('input', {
            class: 'input',
            value: state.metadata.version,
            placeholder: '0.1.0',
            onInput: (e) => (state.metadata.version = e.target.value),
          }),
          { hint: 'Your game\'s version. The engine records its own separately.' },
        ),
      );
    },

    valid: (state) => state.name.trim().length > 0,
  },

  {
    id: 'type',
    label: 'Type',

    render(state, { types, rerenderFooter }) {
      const note = h('div', { class: 'type-note' });
      const paintNote = () => {
        note.textContent = types[state.type]?.description ?? '';
      };

      const select = h(
        'select',
        {
          class: 'select',
          onChange: (e) => {
            state.type = e.target.value;
            paintNote();
            rerenderFooter();
          },
        },
        ...Object.entries(types).map(([id, info]) =>
          h(
            'option',
            {
              value: id,
              selected: id === state.type,
              disabled: !info.available,
            },
            info.available ? info.label : `${info.label} — coming soon`,
          ),
        ),
      );

      paintNote();

      return h(
        'div',
        {},
        field('Project type', select, {
          required: true,
          hint: 'Determines the workspace template AE1 builds for you.',
        }),
        note,
      );
    },

    valid: (state, { types }) => Boolean(types[state.type]?.available),
  },
];

/* Shell ------------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {object} opts.types           registry from GET /api/status
 * @param {(project: object) => void} opts.onCreated
 */
export function openWizard({ types, onCreated }) {
  const firstAvailable = Object.keys(types).find((id) => types[id].available);

  const state = {
    name: '',
    type: firstAvailable ?? 'point-click-adventure',
    metadata: { author: '', description: '', version: '0.1.0' },
  };

  let index = 0;
  let busy = false;

  const body = h('div', {});
  const pips = h('div', { class: 'steps' });
  const backBtn = h('button', { class: 'btn', onClick: back }, 'Back');
  const nextBtn = h('button', { class: 'btn btn--primary', onClick: next });
  const cancelBtn = h('button', { class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel');

  const ctx = {
    types,
    rerenderFooter: () => paintFooter(),
  };

  function paintPips() {
    pips.textContent = '';
    STEPS.forEach((step, i) => {
      if (i > 0) pips.append(h('div', { class: 'step-sep' }));
      pips.append(
        h(
          'div',
          { class: 'step-pip', dataset: { active: String(i === index), done: String(i < index) } },
          h('div', { class: 'step-num' }, i < index ? '✓' : String(i + 1)),
          step.label,
        ),
      );
    });
  }

  function paintFooter() {
    const last = index === STEPS.length - 1;
    const ok = STEPS[index].valid(state, ctx);

    backBtn.style.display = index === 0 ? 'none' : '';
    nextBtn.textContent = busy ? 'Creating…' : last ? 'Create Project' : 'Next';
    nextBtn.disabled = !ok || busy;
    cancelBtn.disabled = busy;
    paintPips();
  }

  function paintBody() {
    body.textContent = '';
    body.append(STEPS[index].render(state, ctx));
    paintFooter();
  }

  function back() {
    if (index === 0 || busy) return;
    index -= 1;
    paintBody();
  }

  async function next() {
    if (busy || !STEPS[index].valid(state, ctx)) return;

    if (index < STEPS.length - 1) {
      index += 1;
      paintBody();
      return;
    }

    busy = true;
    paintFooter();

    try {
      const project = await api.createProject({
        name: state.name.trim(),
        type: state.type,
        metadata: { ...state.metadata },
      });
      m.close();
      toast(`Created "${project.name}".`, 'ok');
      onCreated(project);
    } catch (err) {
      // Stay open on failure. A name collision is the common case, and throwing
      // away everything they typed to make them retype it would be hostile.
      busy = false;
      paintFooter();
      toast(err.message, 'error');
    }
  }

  // Enter advances, so the whole wizard is keyboard-drivable. Textareas keep
  // their newlines.
  function onKey(e) {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      next();
    }
  }

  const m = modal({
    title: 'New Project',
    body,
    footLeft: [pips],
    footRight: [cancelBtn, backBtn, nextBtn],
    onClose: () => body.removeEventListener('keydown', onKey),
  });

  body.addEventListener('keydown', onKey);
  paintBody();

  return m;
}

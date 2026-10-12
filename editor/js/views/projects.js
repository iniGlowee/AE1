/**
 * AE1 - project list. The application's front door.
 *
 * Project List > choose or create > workspace. This view owns the "choose or
 * create" half.
 */

import { h, clear, toast, confirmDanger, modal } from '../ui.js';
import { api } from '../api.js';
import { openWizard } from './wizard.js';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';

  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function typeLabel(types, id) {
  return types[id]?.label ?? id ?? 'unknown';
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount
 * @param {object} opts.types
 * @param {(project: object) => void} opts.onOpen
 */
export async function renderProjects({ mount, types, onOpen }) {
  clear(mount);

  let projects = [];
  try {
    ({ projects } = await api.listProjects());
  } catch (err) {
    mount.append(
      h(
        'div',
        { class: 'projects' },
        h('div', { class: 'empty-note' }, err.message),
      ),
    );
    return;
  }

  const grid = h('div', { class: 'project-grid' });

  const newCard = h(
    'button',
    { class: 'project-card project-card--new', onClick: create },
    h('div', { class: 'new-glyph' }, '+'),
    h('div', {}, 'New Project'),
  );
  grid.append(newCard);

  for (const p of projects) {
    grid.append(p.broken ? brokenCard(p) : projectCard(p));
  }

  const view = h(
    'div',
    { class: 'projects' },
    h(
      'div',
      { class: 'projects-head' },
      h(
        'div',
        {},
        h('div', { class: 'projects-title' }, 'Projects'),
        h(
          'div',
          { class: 'projects-count' },
          projects.length === 0
            ? 'Nothing here yet'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}`,
        ),
      ),
      h(
        'div',
        { style: 'display:flex; gap:8px; align-items:center;' },
        h('button', { class: 'btn btn--primary', onClick: create }, 'New Project'),
      ),
    ),
    grid,
    projects.length === 0
      ? h(
          'div',
          { class: 'empty-note' },
          'Projects live in /projects on disk. Create one to begin.',
        )
      : null,
  );

  mount.append(view);

  /* ---------------------------------------------------------------------- */

  function refresh() {
    renderProjects({ mount, types, onOpen });
  }

  function create() {
    openWizard({ types, onCreated: (project) => onOpen(project) });
  }

  function projectCard(p) {
    const card = h(
      'div',
      {
        class: 'project-card',
        role: 'button',
        tabIndex: 0,
        onClick: () => open(p),
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(p);
          }
        },
      },
      h('div', { class: 'project-type' }, typeLabel(types, p.type)),
      h('div', { class: 'project-name' }, p.name),
      h('div', { class: 'project-desc' }, p.metadata?.description || 'No description.'),
      h(
        'div',
        { class: 'project-foot' },
        h('span', {}, `v${p.metadata?.version ?? '0.1.0'}`),
        h('span', {}, formatDate(p.opened || p.modified)),
      ),
      h(
        'button',
        {
          class: 'card-menu',
          title: 'Project options',
          onClick: (e) => {
            e.stopPropagation();
            openCardMenu(p);
          },
        },
        '⋯',
      ),
    );

    if (p.exists === false) {
      card.append(
        h('div', { class: 'field-error' }, 'Project folder is missing from disk.'),
      );
    }

    return card;
  }

  function brokenCard(p) {
    return h(
      'div',
      { class: 'project-card', dataset: { broken: 'true' } },
      h('div', { class: 'project-type' }, 'unreadable'),
      h('div', { class: 'project-name' }, p.slug),
      h('div', { class: 'project-desc' }, p.error ?? 'This project file could not be read.'),
      h(
        'div',
        { class: 'project-foot' },
        h('span', {}, `${p.slug}.ae1proj`),
        h(
          'button',
          { class: 'btn btn--ghost btn--danger', onClick: () => remove(p) },
          'Delete',
        ),
      ),
    );
  }

  async function open(p) {
    try {
      await api.touchProject(p.slug);
    } catch {
      // Ordering metadata only. Never block opening a project over it.
    }
    onOpen(p);
  }

  function openCardMenu(p) {
    const m = modal({
      title: p.name,
      body: h(
        'div',
        {},
        h('div', { class: 'field-hint', style: 'margin-bottom:12px' }, `/projects/${p.slug}/`),
        h(
          'div',
          { style: 'display:flex; flex-direction:column; gap:6px' },
          h('button', { class: 'btn', onClick: () => { m.close(); open(p); } }, 'Open'),
          h('button', { class: 'btn', onClick: () => { m.close(); rename(p); } }, 'Rename'),
          h(
            'button',
            { class: 'btn btn--danger', onClick: () => { m.close(); remove(p); } },
            'Delete',
          ),
        ),
      ),
      footRight: [h('button', { class: 'btn btn--ghost', onClick: () => m.close() }, 'Close')],
    });
  }

  function rename(p) {
    const input = h('input', { class: 'input', value: p.name, maxLength: 80 });

    async function commit() {
      const name = input.value.trim();
      if (!name || name === p.name) return m.close();
      try {
        await api.updateProject(p.slug, { name });
        m.close();
        toast('Renamed.', 'ok');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const m = modal({
      title: 'Rename Project',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Project name'), input),
        h(
          'div',
          { class: 'field-hint' },
          `The folder stays /projects/${p.slug}/. Renaming changes the display name only, so ` +
            'nothing on disk moves and no references break.',
        ),
      ),
      footRight: [
        h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn--primary', onClick: commit }, 'Rename'),
      ],
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
    });
  }

  async function remove(p) {
    const ok = await confirmDanger({
      title: 'Delete Project',
      message: h(
        'div',
        {},
        h('p', {}, `Permanently delete "${p.name ?? p.slug}" and everything inside it?`),
        h(
          'p',
          { class: 'field-hint', style: 'margin-top:8px' },
          `This removes /projects/${p.slug}/ and its scenes, media, and scripts from disk. ` +
            'It cannot be undone.',
        ),
      ),
      confirmLabel: 'Delete Permanently',
    });

    if (!ok) return;

    try {
      await api.deleteProject(p.slug);
      toast('Project deleted.', 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

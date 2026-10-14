/**
 * AE1 - editor entry point.
 *
 * Owns the top-level view swap and the shared app state that the server told us
 * about at boot.
 */

import { h, clear, toast } from './ui.js';
import { api } from './api.js';
import { prefs } from './prefs.js';
import { settings } from './settings.js';
import { renderProjects } from './views/projects.js';
import { renderWorkspace, destroyWorkspace } from './views/workspace.js';

const app = {
  types: {},
  version: '—',
  project: null,
};

const view = document.getElementById('view');

/* Views ------------------------------------------------------------------- */

function showProjects() {
  // The workspace holds a ResizeObserver, a canvas, and a keydown listener.
  // Leaving them attached across a view swap is exactly the leak the engine's
  // onUnload contract exists to prevent -- the editor should hold itself to it.
  destroyWorkspace();
  app.project = null;
  prefs.set('lastProject', null);
  setStatus('Projects');
  renderProjects({
    mount: view,
    types: app.types,
    onOpen: showWorkspace,
  });
}

function showWorkspace(project) {
  app.project = project;
  prefs.set('lastProject', project.slug);
  setStatus(`${project.name} — /projects/${project.slug}/`);
  renderWorkspace({
    mount: view,
    project,
    onBack: showProjects,
  });
}

/* Chrome ------------------------------------------------------------------ */

function setStatus(text) {
  document.getElementById('status-context').textContent = text;
}

/**
 * The HOSTED banner (§18.120). A multi-tenant host (ae1.ausa.dev) answers
 * GET /api/hosted with a notice and the visitor's sandbox usage; a plain
 * local server has no such route and answers 404, and then nothing is shown
 * and nothing is logged. Usage only — never the sandbox id, which derives
 * from the network address. Fetched once at boot; the editor is not a meter.
 */
async function mountHostedBanner() {
  let info = null;
  try {
    const res = await fetch('/api/hosted', { cache: 'no-store' });
    if (!res.ok) return;
    info = await res.json();
  } catch {
    return; // no server, no route, no banner
  }
  if (!info || info.hosted !== true) return;
  const parts = [];
  if (Number.isFinite(Number(info.quota_mb))) {
    const used = Number.isFinite(Number(info.used_mb)) ? `${Number(info.used_mb)} of ` : '';
    parts.push(`Sandbox ${used}${Number(info.quota_mb)} MB`);
  }
  if (Number.isFinite(Number(info.max_upload_mb))) parts.push(`uploads up to ${Number(info.max_upload_mb)} MB`);
  const bar = document.getElementById('topbar');
  document.getElementById('hosted-banner')?.remove();
  const banner = h(
    'div',
    { id: 'hosted-banner', class: 'hosted-banner', role: 'status' },
    h('span', { class: 'hosted-banner-text' }, String(info.banner || 'Hosted demo.')),
    parts.length ? h('span', { class: 'hosted-banner-usage' }, parts.join(' · ')) : null,
  );
  bar.insertAdjacentElement('afterend', banner);
}

function buildTopbar() {
  const bar = document.getElementById('topbar');
  clear(bar);

  bar.append(
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark' }, 'AE1'),
      h('span', { class: 'brand-sub' }, "ANGEL'S EGG"),
    ),
    h('button', { class: 'menu-btn', onClick: showProjects }, 'Projects'),
    // The docs viewer (editor/docs.html): guide + engine docs + design/history
    // + the motion-matching manuals, rendered from the repo's markdown. Tools
    // deep-link into it: /editor/docs.html?doc=<key>#<heading-slug>.
    // NEW TAB, ROBUSTLY: a real anchor with target=_blank (browsers make a
    // tab; a window.open features string would make a POPUP) — plus a click
    // handler for EMBEDDED panes that suppress _blank and window.open both
    // (the in-app preview does): there, navigate in place so the click always
    // lands; the viewer has its own "← back" for the same-tab case.
    h('a', { class: 'menu-btn', href: '/editor/docs.html', target: '_blank',
      rel: 'noopener', style: 'text-decoration:none; display:inline-flex; align-items:center;',
      onClick: (e) => {
        e.preventDefault();
        const w = window.open('/editor/docs.html', '_blank');
        if (w) w.opener = null;
        else location.href = '/editor/docs.html';
      } }, 'Docs'),
    h('button', { class: 'menu-btn', onClick: showHelp }, 'Help'),
    h('div', { class: 'topbar-spacer' }),
    h('div', { class: 'topbar-meta' }, app.version),
  );
}

function showHelp() {
  import('./ui.js').then(({ modal }) => {
    const m = modal({
      title: 'About AE1',
      body: h(
        'div',
        { dataset: { selectable: '' } },
        h('p', {}, `Angel's Egg ${app.version}`),
        h(
          'p',
          { class: 'field-hint', style: 'margin-top:12px' },
          'A local game creation engine. Projects live in /projects on disk; the browser ' +
            'holds nothing you would miss. Close the window whenever you like.',
        ),
        h(
          'p',
          { class: 'field-hint', style: 'margin-top:12px' },
          'See DESIGN.md at the project root for the architecture.',
        ),
      ),
      footRight: [h('button', { class: 'btn', onClick: () => m.close() }, 'Close')],
    });
  });
}

/* Boot -------------------------------------------------------------------- */

async function boot() {
  try {
    const status = await api.status();
    app.types = status.projectTypes;
    app.version = `${status.version}`;
    document.getElementById('status-server').dataset.state = 'online';
    await settings.load();
  } catch (err) {
    // The server IS the application (Principle 1). Without it there is no
    // degraded mode worth offering -- say so plainly instead of showing an
    // empty editor that appears to work.
    document.getElementById('status-server').dataset.state = 'offline';
    buildTopbar();
    clear(view);
    view.append(
      h(
        'div',
        { class: 'workspace-stub' },
        h(
          'div',
          {},
          h('h2', {}, 'No server'),
          h('p', { style: 'max-width:420px' }, err.message),
          h(
            'p',
            { style: 'margin-top:16px' },
            'Start it with ',
            h('code', {}, '.\\server.ps1'),
            ' and reload.',
          ),
        ),
      ),
    );
    return;
  }

  buildTopbar();
  mountHostedBanner(); // §18.120 — a hosted demo says so; a local server shows nothing

  // Reopen where the user left off. In incognito this survives reloads but not a
  // window close, which is exactly right: it is a convenience, not a save.
  const last = prefs.get('lastProject');
  if (last) {
    try {
      return showWorkspace(await api.getProject(last));
    } catch {
      prefs.set('lastProject', null);
    }
  }

  showProjects();
}

boot().catch((err) => {
  console.error(err);
  toast(`Boot failed: ${err.message}`, 'error');
});

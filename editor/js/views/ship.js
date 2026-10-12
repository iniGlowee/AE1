/**
 * AE1 - Build & Ship.
 *
 * The last step of the loop: project → a folder anyone can host or double-click.
 */

import { h, modal, toast } from '../ui.js';
import { api } from '../api.js';
import { store, formatBytes } from '../scene-store.js';

export function openShip(project) {
  const body = h('div', {});
  let busy = false;

  const buildBtn = h('button', { class: 'btn btn--primary', onClick: build }, 'Build & Ship');
  const closeBtn = h('button', { class: 'btn', onClick: () => m.close() }, 'Close');

  function intro() {
    const errors = store.diagnostics.filter((d) => d.severity === 'error');

    return h(
      'div',
      {},
      h(
        'div',
        { class: 'ship-summary' },
        row('Project', project.name),
        row('Scene elements', String(store.scene?.size ?? 0)),
        row('Angel Scripts', String(Object.keys(store.scripts ?? {}).length)),
        row('Media assets', String(Object.keys(store.media ?? {}).length)),
        row('Output', `/exports/${project.slug}/`),
      ),
      errors.length
        ? h(
            'div',
            { class: 'ship-warn' },
            h('strong', {}, `${errors.length} script error${errors.length > 1 ? 's' : ''}. `),
            'The build will still run, and the game will still play — but those scripts will do ' +
              'nothing. Check the Console pane first.',
          )
        : null,
      h(
        'div',
        { class: 'type-note', style: 'margin-top:14px' },
        'The build inlines the engine, scenes, and scripts into a single index.html, prunes ' +
          'unreferenced assets, and optimizes images. The result plays by double-clicking, or ' +
          'drop the folder on any host.',
      ),
    );
  }

  function row(label, value) {
    return h('div', { class: 'ship-row' }, h('span', {}, label), h('span', { class: 'ship-val' }, value));
  }

  async function build() {
    if (busy) return;
    busy = true;
    buildBtn.disabled = true;
    buildBtn.textContent = 'Building…';

    // Flush first. Building a scene that differs from the one on disk would ship
    // work the author cannot see and cannot explain.
    await store.flush();

    try {
      const report = await api.exportProject(project.slug);
      body.textContent = '';
      body.append(result(report));
      buildBtn.style.display = 'none';
      closeBtn.textContent = 'Done';
      toast('Build complete.', 'ok');
    } catch (err) {
      buildBtn.disabled = false;
      buildBtn.textContent = 'Build & Ship';
      body.append(h('div', { class: 'ship-error' }, err.message));
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
  }

  function result(report) {
    return h(
      'div',
      {},
      h('div', { class: 'ship-ok' }, '✓ Build complete'),
      h(
        'div',
        { class: 'ship-summary' },
        row('Scenes', String(report.scenes)),
        row('Scripts', String(report.scripts)),
        row('Assets shipped', String(report.assets)),
        report.pruned ? row('Unreferenced pruned', String(report.pruned)) : null,
        row('Images optimized', String(report.optimized)),
        row('Total size', formatBytes(report.bytes)),
        row('Location', report.out),
      ),
      report.warnings?.length
        ? h(
            'div',
            { class: 'ship-warn' },
            ...report.warnings.map((w) => h('div', {}, `• ${w}`)),
          )
        : null,
      h(
        'div',
        { class: 'ship-steps', dataset: { selectable: '' } },
        ...report.steps.map((s) => h('div', {}, s)),
      ),
      h(
        'div',
        { style: 'display:flex; gap:8px; margin-top:14px' },
        h(
          'a',
          { class: 'btn btn--primary', href: report.url, target: '_blank', rel: 'noopener' },
          '▶ Play the build',
        ),
      ),
    );
  }

  body.append(intro());

  const m = modal({
    title: 'Build & Ship',
    body,
    footRight: [closeBtn, buildBtn],
  });

  return m;
}

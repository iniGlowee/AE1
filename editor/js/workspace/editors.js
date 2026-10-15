/**
 * AE1 - editor registry.
 *
 * An editor is `{ label, mount(el, context) -> dispose? }`. That is the entire
 * contract. Any pane can host any editor, so adding one means adding an entry
 * here -- the area system never learns its name.
 *
 * Every editor reads from the scene store and subscribes to it. None of them
 * talk to each other. Returning a disposer is mandatory for anything holding a
 * subscription, an observer, or a loop; the pane calls it on teardown.
 */

import { h, clear, confirmDanger, toast } from '../ui.js';
import { store, formatBytes } from '../scene-store.js';
import { api } from '../api.js';
import { ELEMENT_SCHEMA, SCHEMA_GROUPS, COMPONENT_SCHEMA } from '/engine/element.js';
import { AE1Projectile } from '/engine/projectile.js';
import { mediaURL, measure, getImage } from '/engine/media.js';
import { drawElements, frameGrid } from '/engine/renderer.js';

/** Where this project's assets live, as the media cache and renderer expect it. */
const mediaBase = (slug) => `/projects/${slug}/media`;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const typeColor = (type) => cssVar(`--type-${type}`) || cssVar('--type-element');

function empty(message) {
  return h('div', { class: 'pane-empty' }, message);
}

/* Outliner ---------------------------------------------------------------- */

function mountOutliner(el) {
  const list = h('div', { class: 'outliner' });

  const bar = h(
    'div',
    { class: 'pane-toolbar' },
    h(
      'button',
      {
        class: 'btn btn--ghost',
        title: 'Add an element to this scene',
        onClick: () => store.addElement({ type: 'object' }, 'scene'),
      },
      '+ Element',
    ),
    h(
      'button',
      { class: 'btn btn--ghost', title: 'Add a text element', onClick: () => store.addText('scene') },
      '+ Text',
    ),
    h(
      'button',
      { class: 'btn btn--ghost', title: 'Add a button', onClick: () => store.addButton() },
      '+ Button',
    ),
    h(
      'button',
      {
        class: 'btn btn--ghost',
        title: 'Add a full-frame video element',
        onClick: () => store.addVideo(),
      },
      '+ Video',
    ),
    h(
      'button',
      {
        class: 'btn btn--ghost',
        title: 'Add an animated sprite — pick its sheet in Properties',
        onClick: () => store.addSprite('scene'),
      },
      '+ Sprite',
    ),
    h(
      'button',
      {
        class: 'btn btn--ghost',
        title: 'Add a character with a dialogue tree — clicking it talks',
        onClick: () => store.addDialogue('scene'),
      },
      '+ Talker',
    ),
    h(
      'button',
      {
        class: 'btn btn--ghost',
        title: 'Add a persistent HUD element — survives scene changes',
        onClick: () => store.addElement({ type: 'element', name: 'HUD Element', layer: 100 }, 'hud'),
      },
      '+ HUD',
    ),
    h('div', { class: 'ws-spacer' }),
    // Substring FILTER, nothing more: hides rows whose name doesn't match,
    // an empty box shows everything again. Pure display — no selection,
    // no viewport, no game state is touched.
    h('input', {
      class: 'pane-search',
      type: 'search',
      placeholder: 'Filter…',
      title: 'Hide elements whose name does not contain this text',
      onInput: (e) => {
        outlinerFilter = e.target.value.trim().toLowerCase();
        applyOutlinerFilter();
      },
    }),
    h('span', { class: 'pane-count' }),
  );

  el.append(bar, list);
  const count = bar.querySelector('.pane-count');

  let outlinerFilter = '';
  function applyOutlinerFilter() {
    for (const r of list.querySelectorAll('.outliner-row')) {
      const name = r.querySelector('.outliner-name')?.textContent ?? '';
      r.style.display =
        !outlinerFilter || name.toLowerCase().includes(outlinerFilter) ? '' : 'none';
    }
  }

  function row(element, depth, scope) {
    const selected = store.selectedId === element.id;
    const kids = scope.childrenOf(element.id);

    const node = h(
      'div',
      {
        class: 'outliner-row',
        dataset: { selected: String(selected) },
        style: `padding-left:${8 + depth * 14}px`,
        onClick: () => store.select(element.id),
      },
      h('span', { class: 'outliner-dot', style: `background:${typeColor(element.type)}` }),
      h('span', { class: 'outliner-name' }, element.name),
      h(
        'button',
        {
          class: 'outliner-eye',
          title: element.visible ? 'Hide' : 'Show',
          dataset: { off: String(!element.visible) },
          onClick: (e) => {
            e.stopPropagation(); // the row is a select target; the eye is not
            element.visible = !element.visible;
          },
        },
        element.visible ? '●' : '○',
      ),
      h(
        'button',
        {
          class: 'outliner-del',
          title: 'Delete element',
          onClick: (e) => {
            e.stopPropagation();
            store.removeElement(element.id);
          },
        },
        '✕',
      ),
    );

    return [node, ...kids.flatMap((k) => row(k, depth + 1, scope))];
  }

  function section(title, hint, ...actions) {
    return h(
      'div',
      { class: 'outliner-section', title: hint },
      title,
      hint ? h('span', { class: 'outliner-section-hint' }, hint) : null,
      actions.length ? h('div', { class: 'ws-spacer' }) : null,
      ...actions,
    );
  }

  /** A section-header action. Lives here, not in an empty state, so it doesn't
   *  vanish the moment the section has one thing in it. */
  const action = (label, title, onClick) =>
    h('button', { class: 'outliner-action', title, onClick }, label);

  function paint() {
    clear(list);

    if (!store.scene) return list.append(empty('No scene loaded.'));

    count.textContent = `${store.scene.size + (store.hud?.size ?? 0)}`;

    // Two sections, because the layers are genuinely different things: one is
    // this room, the other outlives every room. Hiding that distinction would
    // make "why did my inventory reset" an unanswerable question.
    list.append(
      section(
        'SCENE',
        store.scene.name,
        // 3D only: the mapping table a third-person character reads (§18.9).
        ...(store.project?.type === 'game-3d'
          ? [
              action('+Ctrl', 'Add the input controller — the key/mouse mappings', () =>
                store.addController(),
              ),
            ]
          : []),
      ),
    );
    // A Projectile template ASSIGNED to a weapon is ammunition, not scenery —
    // it leaves the Outliner while claimed (un-name it in the weapon's dat
    // and it returns; edit its script via scripts/<name>.ags.txt meanwhile).
    const ammo = new Set(
      store.scene.all().map((e) => e.projectile && String(e.projectile)).filter(Boolean),
    );
    const roots = store.scene
      .roots()
      .filter((r) => !(r instanceof AE1Projectile && ammo.has(r.name)));
    if (!roots.length) list.append(empty('Empty scene. Add an element to begin.'));
    for (const r of roots) list.append(...row(r, 0, store.scene));

    list.append(
      section(
        'HUD',
        'persists across scenes',
        action('+Inv', 'Add an inventory that survives scene changes', () => store.addInventory()),
        action('+Save', 'Decide what this project saves', () => store.addSaveHandler()),
        action('+Box', 'Add the dialogue box — where lines and choices appear', () =>
          store.addDialogueBox(),
        ),
      ),
    );
    const hudRoots = store.hud?.roots() ?? [];
    if (!hudRoots.length) list.append(empty('No persistent elements.'));
    for (const r of hudRoots) list.append(...row(r, 0, store.hud));
    applyOutlinerFilter(); // a repaint must not un-filter the list
  }

  // 'scene' covers structure, 'selection' covers highlight, 'element' covers a
  // rename or a visibility flip landing from another pane.
  const offs = [
    store.on('scene', paint),
    store.on('selection', paint),
    store.on('element', ({ key }) => {
      if (['name', 'type', 'visible', 'layer'].includes(key)) paint();
    }),
  ];

  paint();
  return () => offs.forEach((off) => off());
}

/* Properties -------------------------------------------------------------- */

function mountProperties(el) {
  const body = h('div', { class: 'properties' });
  el.append(body);

  /** Which world this project is in — decides which schema fields show. */
  const projectDim = () => (store.project?.type === 'game-3d' ? '3d' : '2d');

  /**
   * Build one control from a schema entry. The schema is the only spec.
   *
   * Takes a read/write PAIR rather than an element and a key, because a component
   * field is not a property: `element[key] = v` is the door for the base schema
   * and for dat, and `setComponent(slot, key, v)` is the door for a component bag.
   * The control does not care which -- it only needs to know how to get and set.
   */
  function control(def, read, commit) {
    if (def.type === 'bool') {
      return h('input', {
        type: 'checkbox',
        class: 'prop-check',
        checked: read(),
        onChange: (e) => commit(e.target.checked),
      });
    }

    if (def.type === 'enum') {
      return h(
        'select',
        { class: 'prop-input', onChange: (e) => commit(e.target.value) },
        ...def.options.map((o) => h('option', { value: o, selected: read() === o }, o)),
      );
    }

    if (def.type === 'tags') {
      return h('input', {
        class: 'prop-input',
        value: (read() ?? []).join(', '),
        placeholder: 'tag, tag',
        onChange: (e) =>
          commit(
            e.target.value
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          ),
      });
    }

    // An author types a NAME, never a hash. Hashes are an implementation detail
    // they should not have to see, let alone type -- the same reasoning that made
    // playSound() and give() resolve names (docs/engine/05-lessons.md).
    if (def.type === 'media') {
      return h('input', {
        class: 'prop-input',
        value: read() ?? '',
        placeholder: 'sheet.png',
        list: 'prop-media-names',
        onChange: (e) => commit(e.target.value),
      });
    }

    if (def.type === 'number') {
      return h('input', {
        type: 'number',
        class: 'prop-input',
        value: read(),
        step: def.step ?? 1,
        min: def.min,
        max: def.max,
        // 'input' rather than 'change' so the viewport tracks as you type. The
        // journal is debounced, so this does not mean a save per keystroke.
        onInput: (e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) commit(n);
        },
      });
    }

    return h('input', {
      class: 'prop-input',
      value: read() ?? '',
      onInput: (e) => commit(e.target.value),
    });
  }

  /** The base schema and dat both write straight through the accessor. */
  const propControl = (element, key, def) =>
    control(
      def,
      () => element[key],
      (v) => {
        element[key] = v; // routes through the accessor -> notify -> journal
      },
    );

  /**
   * The component bags, from COMPONENT_SCHEMA.
   *
   * A component is shown only when the element HAS it, with a button to add it
   * when it does not. Absent and blank are different states: an element with no
   * sprite has no sprite bag at all, and a panel that always showed an empty
   * Sprite group would quietly make every Text element grow one.
   */
  function paintComponents(element) {
    for (const [slot, spec] of Object.entries(COMPONENT_SCHEMA)) {
      if (spec.dim && spec.dim !== projectDim()) continue; // no "+ Sprite" in 3D, no "+ Light" in 2D
      const bag = element.components?.[slot];

      if (!bag) {
        body.append(
          h(
            'div',
            { class: 'prop-group' },
            h(
              'button',
              {
                class: 'prop-add',
                // paint() explicitly. The 'element' subscription below refuses to
                // repaint while focus is inside this pane -- it must not rewrite a
                // field under a typing cursor -- and clicking this button PUTS
                // focus inside this pane. So the one repaint that has to happen is
                // the one that guard swallows: the bag appeared, and the panel sat
                // there showing "+ Sprite" as though the click had missed.
                onClick: () => {
                  element.setComponent(slot, 'media', '');
                  paint();
                },
              },
              `+ ${spec.label}`,
            ),
          ),
        );
        continue;
      }

      const rows = Object.entries(spec.fields).map(([key, def]) => {
        // The animation clip is a DROPDOWN of the glb's actual clips (the viewport
        // records them into model.clips), so nobody has to type a clip name like
        // "Armature|mixamo.com|Layer0". Empty = the file's first clip (the idle).
        if (slot === 'model' && key === 'clip' && Array.isArray(bag.clips) && bag.clips.length) {
          const opts = ['', ...bag.clips];
          return h(
            'div',
            { class: 'prop-row' },
            h('label', { class: 'prop-label' }, def.label),
            h(
              'select',
              { class: 'prop-input', onChange: (e) => element.setComponent('model', 'clip', e.target.value) },
              ...opts.map((o) => h('option', { value: o, selected: (bag.clip ?? '') === o }, o === '' ? '(default / idle)' : o)),
            ),
          );
        }

        const isMedia = def.type === 'media';

        const read = () => {
          const raw = bag[key] ?? def.default;
          // Show the NAME. The bag stores a hash, because content addressing is
          // what keeps a sprite working after the file is renamed.
          if (!isMedia || !raw) return isMedia ? '' : raw;
          return store.media[raw]?.name ?? raw;
        };

        const write = (value) => {
          if (!isMedia) return void element.setComponent(slot, key, value);

          const name = String(value).trim();
          if (!name) return void element.setComponent(slot, key, '');

          const m = store.editorWorld?.resolveMedia(name);
          if (!m) {
            // Refusing beats storing a name that resolves to nothing: the element
            // would render a dashed placeholder forever with no explanation.
            toast(`No media named "${name}".`);
            paint();
            return;
          }
          element.setComponent(slot, key, m.hash);
          element.setComponent(slot, 'ext', m.ext);
        };

        return h(
          'div',
          { class: 'prop-row' },
          h('label', { class: 'prop-label' }, def.label),
          control(def, read, write),
        );
      });

      body.append(
        h(
          'div',
          { class: 'prop-group' },
          h(
            'div',
            { class: 'prop-group-title' },
            spec.label,
            h(
              'button',
              {
                class: 'prop-remove',
                title: `Remove ${spec.label}`,
                onClick: () => {
                  const next = { ...element.components };
                  delete next[slot];
                  element.components = next;
                  element._notify('components', next, null);
                  paint();
                },
              },
              '✕',
            ),
          ),
          ...rows,
          // Slot-specific extras below the fields.
          ...(slot === 'sprite' ? [h('div', { class: 'prop-note' }, sheetNote(element))] : []),
          ...(slot === 'model' ? modelExtras(element, bag) : []),
        ),
      );
    }
  }

  /**
   * The Model component's per-part show/hide list.
   *
   * A character glb ships alternate expressions and duplicate parts overlapping
   * in one node (there is no "priority" in glTF — the author picks). The viewport
   * records the sub-meshes into `model.parts`; unchecking one adds it to
   * `model.hidden`, and the viewport stops drawing it. This is how you keep the
   * "normal" face and drop the "serious" one without a trip back to Blender.
   */
  function modelExtras(element, bag) {
    const parts = bag.parts;
    if (!Array.isArray(parts) || parts.length < 2) return [];
    const hidden = new Set(bag.hidden ?? []);

    const toggle = (name, show) => {
      const next = new Set(element.components.model.hidden ?? []);
      if (show) next.delete(name);
      else next.add(name);
      element.setComponent('model', 'hidden', [...next]);
    };

    return [
      h(
        'div',
        { class: 'prop-parts' },
        h('div', { class: 'prop-parts-title' }, `Parts — ${parts.length - hidden.size}/${parts.length} shown`),
        ...parts.map((name) =>
          h(
            'label',
            { class: 'prop-part' },
            h('input', {
              type: 'checkbox',
              class: 'prop-check',
              checked: !hidden.has(name),
              onChange: (e) => toggle(name, e.target.checked),
            }),
            h('span', { class: 'prop-part-name', title: name }, name),
          ),
        ),
      ),
    ];
  }

  /**
   * "24 frames (6×4)", or why this sheet is not one.
   *
   * Cutting a sheet is arithmetic done wrong easily, and the failure is silent:
   * a frame size that does not divide the image draws a sliver of the next frame
   * and nothing says so. Reporting what the engine ACTUALLY computed is the same
   * instinct as the honest save indicator -- show the truth, not a reassurance.
   */
  function sheetNote(element) {
    const s = element.components?.sprite;
    if (!s?.media) return 'No image.';
    if (!s.frameWidth || !s.frameHeight) return 'A whole image. Set Frame W/H to cut it into frames.';

    const img = getImage(mediaBase(store.project?.slug), s.media, s.ext ?? 'png');
    const grid = frameGrid(img, s);
    if (!grid) return 'Measuring…';

    const ragged =
      img.naturalWidth % grid.fw || img.naturalHeight % grid.fh
        ? ` — ${img.naturalWidth}×${img.naturalHeight} does not divide evenly`
        : '';
    return `${grid.count} frames (${grid.cols}×${grid.rows})${ragged}`;
  }

  function paint() {
    clear(body);
    const element = store.selected;

    if (!element) return body.append(empty('Select an element to edit its properties.'));

    body.append(
      h(
        'div',
        { class: 'prop-head' },
        h('span', { class: 'outliner-dot', style: `background:${typeColor(element.type)}` }),
        h('span', { class: 'prop-title' }, element.name),
      ),
      h('div', { class: 'prop-id', dataset: { selectable: '' } }, element.id),
      // Autocomplete for every media field: an author should be picking from what
      // they imported, not remembering how they spelled it.
      h(
        'datalist',
        { id: 'prop-media-names' },
        ...Object.values(store.media ?? {}).map((m) => h('option', { value: m.name })),
      ),
    );

    for (const group of SCHEMA_GROUPS) {
      // A field marked for the OTHER dimension is hidden: a 2D project never
      // shows Z / Rotation X; a 3D project never shows Layer / Flip. Unmarked
      // fields (x, y, rotation, scale) belong to both.
      const rows = Object.entries(ELEMENT_SCHEMA).filter(
        ([, d]) => d.group === group && (!d.dim || d.dim === projectDim()),
      );
      if (!rows.length) continue;

      body.append(
        h(
          'div',
          { class: 'prop-group' },
          h('div', { class: 'prop-group-title' }, group),
          ...rows.map(([key, def]) =>
            h(
              'div',
              { class: 'prop-row' },
              h('label', { class: 'prop-label' }, def.label + (def.unit ? ` (${def.unit})` : '')),
              propControl(element, key, def),
            ),
          ),
        ),
      );
    }

    paintComponents(element);

    // Angel Script dat properties.
    //
    // These appear here for free, and that is the point: dat lands as REAL
    // properties on the element (DESIGN.md §5), so the value this panel edits,
    // the value `this.locked` reads in a method, and the value the scene file
    // stores are one value in one place. No bridge, no sync step.
    const agsDat = element.constructor?.agsDat ?? {};
    const datKeys = Object.keys(agsDat).filter((k) => !(k in ELEMENT_SCHEMA));

    body.append(
      h(
        'div',
        { class: 'prop-group' },
        h('div', { class: 'prop-group-title' }, 'Angel Script'),
        h('div', { class: 'prop-note' }, element.script ?? 'No script attached.'),
        ...datKeys.map((key) => {
          const value = element[key];
          // The dat section is untyped by design, so infer the control from the
          // live value rather than demanding a type declaration.
          const def =
            typeof value === 'boolean'
              ? { type: 'bool', label: key }
              : typeof value === 'number'
                ? { type: 'number', label: key, step: 1 }
                : Array.isArray(value)
                  ? { type: 'tags', label: key }
                  : { type: 'string', label: key };

          return h(
            'div',
            { class: 'prop-row', style: 'margin-top:6px' },
            h('label', { class: 'prop-label prop-label--dat' }, key),
            propControl(element, key, def),
          );
        }),
      ),
    );
  }

  const offs = [
    store.on('selection', paint),
    // Repaint on external edits (a viewport drag moving x/y), but never while the
    // user is typing in this pane -- rewriting the field under the cursor would
    // fight them for the caret.
    store.on('element', ({ element }) => {
      if (element.id !== store.selectedId) return;
      if (body.contains(document.activeElement)) return;
      paint();
    }),
    store.on('scene', paint),
  ];

  paint();
  return () => offs.forEach((off) => off());
}

/* Viewport ---------------------------------------------------------------- */

function mountViewport(el, context) {
  // A 3D project gets a three.js viewport instead of the 2D canvas. Same pane,
  // same slot — the Viewport just knows what kind of world it is looking at.
  // Loaded lazily so a 2D session never pays for (or parses) three.js.
  if (context?.project?.type === 'game-3d') {
    let dispose = () => {};
    import('./viewport3d.js').then((m) => {
      dispose = m.mountViewport3D(el, context) ?? (() => {});
    });
    return () => dispose();
  }

  const canvas = h('canvas', { class: 'viewport-canvas' });
  el.append(canvas);

  const ctx = canvas.getContext('2d');
  const view = { x: 0, y: 0, zoom: 1, fitted: false };

  const GAME_W = 1280;
  const GAME_H = 720;

  /** Screen (client) -> scene coordinates. */
  function toScene(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - r.width / 2 - view.x) / view.zoom + GAME_W / 2,
      y: (clientY - r.top - r.height / 2 - view.y) / view.zoom + GAME_H / 2,
    };
  }

  function resize() {
    // Canvases are sized in CSS pixels but drawn in device pixels. Skipping DPR
    // is why so many tools look soft on a high-DPI display.
    const dpr = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit the frame on first real layout. Opening onto a viewport zoomed past the
    // edges of your own game reads as broken.
    if (!view.fitted && rect.width > 1) {
      view.zoom = Math.min((rect.width - 32) / GAME_W, (rect.height - 32) / GAME_H, 1);
      view.fitted = true;
    }

    draw();
  }

  function draw() {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1) return;

    ctx.fillStyle = cssVar('--bg-0');
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(rect.width / 2 + view.x, rect.height / 2 + view.y);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(-GAME_W / 2, -GAME_H / 2);

    // The game frame: everything inside ships, everything outside is workspace.
    ctx.fillStyle = cssVar('--bg-1');
    ctx.fillRect(0, 0, GAME_W, GAME_H);

    ctx.strokeStyle = cssVar('--line-soft');
    ctx.lineWidth = 1 / view.zoom;
    ctx.beginPath();
    for (let x = 0; x <= GAME_W; x += 64) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, GAME_H);
    }
    for (let y = 0; y <= GAME_H; y += 64) {
      ctx.moveTo(0, y);
      ctx.lineTo(GAME_W, y);
    }
    ctx.stroke();

    // The SAME renderer the exported game uses, over the SAME composed order:
    // scene first, HUD above. The editor contributes only the camera and the
    // chrome around it.
    drawElements(ctx, store.orderedElements(), {
      mediaBase: mediaBase(context?.project?.slug),
      colorFor: typeColor,
      onImageLoad: draw,
      zoom: view.zoom,
    });

    // Selection is drawn in its OWN pass, after every element.
    //
    // Drawn inline with the selected element, any higher-layer element paints
    // straight over it -- select a door with a trigger volume on top and the
    // outline vanishes, so the viewport disagrees with the Outliner about what is
    // selected. Selection is UI, not scene content; the scene never occludes it.
    //
    // Hidden while playing: selection is an editing affordance, and a game does
    // not have a "selected" object.
    const sel = store.playing ? null : store.selected;
    if (sel && sel.visible) {
      const b = sel.getBounds();
      ctx.strokeStyle = cssVar('--accent-hi');
      ctx.lineWidth = 2 / view.zoom;
      ctx.strokeRect(b.x, b.y, b.w, b.h);

      // Corner ticks read as a selection even against a fill of the same hue.
      const t = 8 / view.zoom;
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [
        [b.x, b.y, 1, 1],
        [b.x + b.w, b.y, -1, 1],
        [b.x, b.y + b.h, 1, -1],
        [b.x + b.w, b.y + b.h, -1, -1],
      ]) {
        ctx.moveTo(cx, cy + sy * t);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * t, cy);
      }
      ctx.lineWidth = 3 / view.zoom;
      ctx.stroke();
    }

    // The frame border turns green while playing: the single clearest signal that
    // this canvas is live and nothing here is being saved.
    ctx.strokeStyle = store.playing ? cssVar('--ok') : cssVar('--accent-dim');
    ctx.lineWidth = 2 / view.zoom;
    ctx.strokeRect(0, 0, GAME_W, GAME_H);
    ctx.restore();

    ctx.fillStyle = store.playing ? cssVar('--ok') : cssVar('--text-2');
    ctx.font = '11px ui-monospace, monospace';
    const hud = store.playing
      ? `▶ PLAYING  ·  ${store.loop?.frames ?? 0}f  ·  ${(store.loop?.elapsed ?? 0).toFixed(1)}s  ·  changes discarded on stop`
      : `${context?.project?.name ?? 'scene'}  ·  ${GAME_W}×${GAME_H}  ·  ${Math.round(view.zoom * 100)}%  ·  ${store.scene?.size ?? 0} elements`;
    ctx.fillText(hud, 10, 18);
  }

  /* -- interaction -------------------------------------------------------- */

  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    // Middle-drag pans in both modes -- inspecting the game while it runs is the
    // whole point of playing inside the editor.
    if (e.button === 1) {
      e.preventDefault();
      drag = { mode: 'pan', ox: e.clientX - view.x, oy: e.clientY - view.y };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 || !store.scene) return;

    const p = toScene(e.clientX, e.clientY);

    // In play mode the canvas is a GAME, not an editor. A click is the player
    // clicking, so it fires onClick rather than selecting or dragging. Selecting
    // and nudging elements mid-play would edit state that Stop is about to throw
    // away -- work the user would watch disappear.
    if (store.playing) {
      store.loop?.pointerDown(p.x, p.y);
      draw();
      return;
    }

    // Topmost first: reverse the paint order so the element drawn on top is the
    // one you grab, not the one buried under it. HUD is last in paint order, so
    // it is picked first — you can always grab your own HUD.
    const hit = [...store.orderedElements()]
      .reverse()
      .find((el2) => el2.visible && el2.containsPoint(p.x, p.y));

    store.select(hit?.id ?? null);

    if (hit) {
      drag = { mode: 'move', el: hit, dx: p.x - hit.x, dy: p.y - hit.y };
      canvas.setPointerCapture(e.pointerId);
    }
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (store.playing && !drag) {
      const p = toScene(e.clientX, e.clientY);
      const over = store.loop?.pointerMove(p.x, p.y);
      canvas.style.cursor = over ? 'pointer' : 'default';
      return;
    }

    if (!drag) return;
    if (drag.mode === 'pan') {
      view.x = e.clientX - drag.ox;
      view.y = e.clientY - drag.oy;
    } else {
      const p = toScene(e.clientX, e.clientY);
      drag.el.x = Math.round(p.x - drag.dx);
      drag.el.y = Math.round(p.y - drag.dy);
    }
    draw();
  });

  canvas.addEventListener('pointerup', (e) => {
    drag = null;
    canvas.releasePointerCapture(e.pointerId);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Zoom toward the cursor, not the centre: zooming to the middle when you
      // are inspecting a corner means chasing your own target.
      const before = toScene(e.clientX, e.clientY);
      view.zoom = Math.min(4, Math.max(0.1, view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const after = toScene(e.clientX, e.clientY);
      view.x += (after.x - before.x) * view.zoom;
      view.y += (after.y - before.y) * view.zoom;
      draw();
    },
    { passive: false },
  );

  // While playing, the viewport drives its own rAF.
  //
  // Rendering deliberately does not live in GameLoop: the editor draws with the
  // viewport's pan/zoom, the exported game draws to fill the window, and both
  // hand the same loop the same scene. Keeping draw out of the loop is what lets
  // one loop serve both (Principle 2).
  let drawRaf = null;
  function playFrame() {
    draw();
    drawRaf = requestAnimationFrame(playFrame);
  }

  /* -- video transport ---------------------------------------------------- */
  //
  // A video at rest shows one frame, because the editor draws on demand rather
  // than on a clock. That frame is the whole problem this solves: an intro's
  // frame 0 is usually black, so laying a title over it means laying it over
  // nothing. Scrub to the moment you are designing for, then pin it with Poster.
  //
  // Chrome, not engine: it drives AE1Video's own play/pause/seek, which is the
  // same code the shipped game runs. Nothing here can make the editor and the
  // export disagree about a frame.

  const scrub = h('input', { class: 'vt-scrub', type: 'range', min: 0, max: 1000, value: 0 });
  const timeLabel = h('span', { class: 'vt-time' }, '0:00');
  const playBtn = h('button', { class: 'vt-btn', title: 'Preview in place (Play runs the whole scene)' }, '▶');
  const posterBtn = h('button', { class: 'vt-btn vt-btn--wide', title: 'Show this frame while authoring' }, 'Set poster');
  const transport = h('div', { class: 'vt' }, playBtn, scrub, timeLabel, posterBtn);
  transport.hidden = true;
  el.append(transport);

  /** The selected element, if it is a Video with an asset. Else null. */
  function selectedVideo() {
    const s = store.selected;
    return s && typeof s.videoEl !== 'undefined' && s.videoEl ? s : null;
  }

  let previewRaf = null;

  function stopPreview() {
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = null;
    playBtn.textContent = '▶';
  }

  function previewFrame() {
    draw();
    syncTransport();
    previewRaf = requestAnimationFrame(previewFrame);
  }

  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /** Reflect the video's real state. It is the source of truth, not the slider. */
  function syncTransport() {
    const el2 = selectedVideo();
    const v = el2?.videoEl;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;

    if (!scrub.matches(':active')) scrub.value = String((v.currentTime / v.duration) * 1000);
    timeLabel.textContent = `${mmss(v.currentTime)} / ${mmss(v.duration)}`;
    playBtn.textContent = v.paused ? '▶' : '⏸';
  }

  function refreshTransport() {
    const el2 = selectedVideo();

    // Hidden during Play: the scene is running, and a transport that scrubbed a
    // playing game would be editing a rehearsal.
    const show = Boolean(el2) && !store.playing;
    transport.hidden = !show;

    if (!show) {
      // Deselecting must silence it. A video left playing behind a pane nobody is
      // looking at keeps a decoder busy and, if it has a track, keeps making noise.
      if (previewRaf) selectedVideo()?.pause?.();
      stopPreview();
      return;
    }
    syncTransport();
  }

  playBtn.addEventListener('click', () => {
    const el2 = selectedVideo();
    const v = el2?.videoEl;
    if (!v) return;

    if (v.paused) {
      el2.play(); // AE1Video.play -- the same call the game makes, gesture-unlock and all
      playBtn.textContent = '⏸';
      if (!previewRaf) previewFrame();
    } else {
      el2.pause();
      stopPreview();
      draw();
    }
  });

  scrub.addEventListener('input', () => {
    const el2 = selectedVideo();
    const v = el2?.videoEl;
    if (!v || !Number.isFinite(v.duration)) return;

    // Through _seekWhenReady, never a raw currentTime write: on a first load the
    // browser reports the file fully buffered while `seekable` is still empty, and
    // the assignment silently does nothing.
    el2._seekWhenReady((Number(scrub.value) / 1000) * v.duration);
    timeLabel.textContent = `${mmss((Number(scrub.value) / 1000) * v.duration)} / ${mmss(v.duration)}`;
    if (!previewRaf) requestAnimationFrame(draw); // one frame, to show the seek
  });

  posterBtn.addEventListener('click', () => {
    const el2 = selectedVideo();
    const v = el2?.videoEl;
    if (!v) return;

    // Writes dat, through the accessor -- so it journals, undoes, and shows up in
    // the Properties panel like anything else an author typed.
    el2.poster = Math.round(v.currentTime * 100) / 100;
    toast(`Poster set to ${mmss(v.currentTime)}.`);
  });

  const offs = [
    store.on('scene', draw),
    store.on('selection', () => {
      // Selecting away from a previewing video must stop it.
      if (previewRaf) stopPreview();
      draw();
      refreshTransport();
    }),
    store.on('element', draw),
    store.on('play', (on) => {
      if (on && !drawRaf) playFrame();
      if (!on) {
        cancelAnimationFrame(drawRaf);
        drawRaf = null;
        canvas.style.cursor = 'default';
        draw();
      }
      stopPreview();
      refreshTransport();
    }),
  ];

  if (store.playing) playFrame(); // a pane opened mid-play must animate too

  offs.push(store.on('media', draw));
  refreshTransport();

  // Drop an asset from the Media pane straight onto the canvas, landing where
  // you dropped it. Dragging to a spot and having it appear at the origin would
  // make the gesture a lie.
  canvas.addEventListener('dragover', (e) => {
    if (store.playing) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  canvas.addEventListener('drop', async (e) => {
    if (store.playing) return;
    e.preventDefault();

    const hash = e.dataTransfer.getData('application/x-ae1-media');
    const p = toScene(e.clientX, e.clientY);

    if (hash) {
      await place(hash, p.x, p.y);
      draw();
      return;
    }

    // Files dropped from the OS straight onto the canvas: import, then place.
    if (e.dataTransfer.files?.length) {
      const imported = await store.importFiles([...e.dataTransfer.files]);
      let offset = 0;
      for (const entry of imported) {
        await place(entry.hash, p.x + offset, p.y + offset);
        offset += 24; // fan them out; a stack of identical rects is unusable
      }
      draw();
    }
  });

  /** Place an asset centred on a point, at its natural size. */
  async function place(hash, x, y) {
    const entry = store.media[hash];
    // A Video is authored full-frame by addVideo; centring it on the cursor would
    // be wrong, so leave its geometry alone.
    if (entry?.kind === 'video') return store.addElementFromMedia(hash);

    const size = await sizeOf(context?.project?.slug, entry);
    const el2 = await store.addElementFromMedia(hash, {
      x: x - size.width / 2,
      y: y - size.height / 2,
    });
    if (el2) {
      el2.width = size.width;
      el2.height = size.height;
    }
    return el2;
  }

  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  return () => {
    cancelAnimationFrame(drawRaf); // a stray rAF outlives the pane otherwise
    // Closing the pane must not leave a video previewing into a canvas that is
    // gone -- the decoder (and its audio track) would run until the tab closed.
    selectedVideo()?.pause?.();
    stopPreview();
    ro.disconnect();
    offs.forEach((off) => off());
  };
}

/** Natural pixel size of an image asset; a sane square for anything else. */
async function sizeOf(slug, entry) {
  if (!entry || entry.kind !== 'image' || !slug) return { width: 128, height: 128 };
  if (entry.width && entry.height) return { width: entry.width, height: entry.height };

  const size = await measure(mediaURL(mediaBase(slug), entry.hash, entry.ext));
  // Cache on the manifest entry so we measure once per session, not per drop.
  entry.width = size.width;
  entry.height = size.height;
  return size;
}

/* Angel Script ------------------------------------------------------------ */

function mountScript(el) {
  const status = h('span', { class: 'ags-status' });
  const fileName = h('span', { class: 'ags-file' });

  const runBtn = h(
    'button',
    { class: 'btn btn--ghost', title: 'Call this element’s onCall methods now', onClick: run },
    '▶ Test',
  );

  // MANAGER-PROJECT-01 W3b: the shipped version of this element's script, back
  // in one click. Script edits are outside the undo history by design, so a
  // select-all + delete in this pane used to brick a sample's element for good.
  const restoreBtn = h(
    'button',
    {
      class: 'btn btn--ghost',
      title: 'Replace this script with the version the sample shipped with',
      onClick: restoreDefault,
    },
    '↺ Restore default',
  );

  const bar = h(
    'div',
    { class: 'pane-toolbar' },
    fileName,
    h('div', { class: 'ws-spacer' }),
    status,
    restoreBtn,
    runBtn,
  );

  const editor = h('textarea', {
    class: 'ags-editor',
    spellcheck: false,
    placeholder: 'This script is empty. Type Angel Script here — or press ↺ Restore default to get the shipped version back.',
    onInput: () => {
      const element = store.selected;
      if (element?.script) store.setScript(element.script, editor.value);
      paintStatus();
    },
    // Tab should indent, not escape to the next pane. In a code editor, losing
    // focus on Tab is the single most disruptive default the browser has.
    onKeydown: (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = editor;
      editor.value = `${value.slice(0, s)}  ${value.slice(t)}`;
      editor.selectionStart = editor.selectionEnd = s + 2;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });

  const attach = h(
    'div',
    { class: 'pane-empty' },
    h('p', {}, 'No script attached to this element.'),
    h(
      'button',
      {
        class: 'btn',
        style: 'margin-top:10px',
        onClick: async () => {
          const element = store.selected;
          if (element) await store.attachScript(element);
          paint();
        },
      },
      '+ Attach Angel Script',
    ),
  );

  el.append(bar, editor, attach);

  function hasDefault(element) {
    return Boolean(element?.script && store.sample?.scripts?.includes(element.script));
  }

  async function restoreDefault() {
    const element = store.selected;
    if (!hasDefault(element)) return;
    const file = element.script;
    const current = store.scripts[file] ?? '';
    if (current.trim()) {
      const ok = await confirmDanger({
        title: 'Restore the default script?',
        message: h(
          'div',
          {},
          h('p', {}, `${file} will be replaced by the version the “${store.sample.sample}” sample shipped with.`),
          h('p', {}, `Its current text (${current.length} characters) will be lost. Every other script, scene and media file stays as it is.`),
        ),
        confirmLabel: 'Restore default',
      });
      if (!ok) return;
    }
    try {
      await store.restoreScriptDefault(file);
      editor.value = store.scripts[file] ?? '';
      paint();
      toast(`${file} restored to the shipped version.`);
    } catch (err) {
      toast(`Could not restore ${file}: ${err.message}`, 'error');
    }
  }

  function run() {
    const element = store.selected;
    if (!element?.script) return;

    const def = element.constructor?.agsDef;
    if (!def) return store.log({ severity: 'warning', message: 'Script has not compiled.' });

    // Fire everything the element declares as onCall -- the cheapest possible
    // "does my script do anything" without a running game loop.
    const methods = Object.keys(def.runInfo ?? {}).filter((m) =>
      (def.runInfo[m] ?? []).includes('onCall'),
    );

    if (!methods.length) {
      return store.log({ severity: 'warning', message: 'No onCall methods to test.' });
    }

    const actor = { has: () => true, name: 'TestActor' };
    for (const m of methods) {
      try {
        const result = element[m](actor);
        store.log({ severity: 'info', message: `${element.name}.${m}() → ${JSON.stringify(result) ?? 'undefined'}`, from: element.script });
      } catch (err) {
        store.log({ severity: 'error', message: `${element.name}.${m}() threw: ${err.message}`, from: element.script });
      }
    }
  }

  function paintStatus() {
    const element = store.selected;
    const errs = store.diagnostics.filter(
      (d) => d.severity === 'error' && (!element?.script || d.file === element.script),
    );
    const warns = store.diagnostics.filter(
      (d) => d.severity === 'warning' && (!element?.script || d.file === element.script),
    );

    if (errs.length) {
      status.textContent = `${errs.length} error${errs.length > 1 ? 's' : ''}`;
      status.dataset.state = 'error';
    } else if (warns.length) {
      status.textContent = `${warns.length} warning${warns.length > 1 ? 's' : ''}`;
      status.dataset.state = 'warn';
    } else if (element?.script) {
      status.textContent = 'compiled';
      status.dataset.state = 'ok';
    } else {
      status.textContent = '';
      status.dataset.state = '';
    }
  }

  function paint() {
    const element = store.selected;
    const has = Boolean(element?.script);

    editor.style.display = has ? '' : 'none';
    attach.style.display = element && !has ? '' : 'none';
    runBtn.style.display = has ? '' : 'none';
    restoreBtn.style.display = hasDefault(element) ? '' : 'none';
    fileName.textContent = element ? (element.script ?? element.name) : 'No element selected';

    if (!element) {
      attach.style.display = 'none';
      editor.style.display = 'none';
    }

    if (has) {
      const src = store.scripts[element.script] ?? '';
      // Never clobber the buffer under a typing cursor.
      if (editor.value !== src && document.activeElement !== editor) editor.value = src;
    }

    paintStatus();
  }

  const offs = [
    store.on('selection', paint),
    store.on('scene', paint),
    store.on('diagnostics', paintStatus),
  ];

  paint();
  return () => offs.forEach((off) => off());
}

/* Console ----------------------------------------------------------------- */

function mountConsole(el) {
  const list = h('div', { class: 'console' });

  const bar = h(
    'div',
    { class: 'pane-toolbar' },
    h(
      'button',
      {
        class: 'btn btn--ghost',
        onClick: () => {
          store.logs = [];
          paint();
        },
      },
      'Clear',
    ),
    h('div', { class: 'ws-spacer' }),
    h('span', { class: 'pane-count' }),
  );

  el.append(bar, list);
  const count = bar.querySelector('.pane-count');

  function line(d) {
    return h(
      'div',
      { class: 'console-line', dataset: { severity: d.severity } },
      h('span', { class: 'console-sev' }, d.severity),
      h(
        'span',
        { class: 'console-msg', dataset: { selectable: '' } },
        d.message,
        d.file ? h('span', { class: 'console-file' }, ` ${d.file}${d.line ? `:${d.line}` : ''}`) : null,
        d.from ? h('span', { class: 'console-file' }, ` ${d.from}`) : null,
      ),
    );
  }

  function paint() {
    clear(list);
    const items = [...store.diagnostics, ...store.logs];
    const errors = items.filter((i) => i.severity === 'error').length;
    count.textContent = errors ? `${errors} error${errors > 1 ? 's' : ''}` : `${items.length}`;

    if (!items.length) {
      list.append(empty('No diagnostics. Scripts compile clean.'));
      return;
    }
    for (const d of items) list.append(line(d));
    list.scrollTop = list.scrollHeight;
  }

  const offs = [store.on('diagnostics', paint), store.on('log', paint), store.on('scene', paint)];
  paint();
  return () => offs.forEach((off) => off());
}

/* Media Collection -------------------------------------------------------- */

const KIND_GLYPH = { audio: '♪', video: '▶', model: '◈', other: '◻' };

function mountMedia(el, context) {
  const slug = context?.project?.slug;
  const grid = h('div', { class: 'media-grid' });
  const picker = h('input', {
    type: 'file',
    multiple: true,
    style: 'display:none',
    onChange: async (e) => {
      await store.importFiles([...e.target.files]);
      e.target.value = ''; // re-importing the same file must fire change again
    },
  });

  const bar = h(
    'div',
    { class: 'pane-toolbar' },
    h('button', { class: 'btn btn--ghost', onClick: () => picker.click() }, '+ Import'),
    h('div', { class: 'ws-spacer' }),
    // Substring FILTER only — hides tiles whose file name doesn't match;
    // an empty box shows the whole collection again.
    h('input', {
      class: 'pane-search',
      type: 'search',
      placeholder: 'Filter…',
      title: 'Hide media whose name does not contain this text',
      onInput: (e) => {
        mediaFilter = e.target.value.trim().toLowerCase();
        applyMediaFilter();
      },
    }),
    h('span', { class: 'pane-count' }),
  );

  // MANAGER-PROJECT-01 W6: a click on a tile PREVIEWS it here — nothing is
  // placed in the scene. Images fitted over a checkerboard (so transparency
  // reads), with their pixel size; audio and video in the browser's own player;
  // anything else a line of facts. Click the tile again, or ✕, to close.
  const preview = h('div', { class: 'media-preview', hidden: true });
  let previewHash = null;

  el.append(bar, picker, grid, preview);
  const count = bar.querySelector('.pane-count');

  function closePreview() {
    previewHash = null;
    for (const m of preview.querySelectorAll('audio, video')) { m.pause(); m.removeAttribute('src'); m.load(); }
    clear(preview);
    preview.hidden = true;
    for (const t of grid.querySelectorAll('.media-tile')) delete t.dataset.selected;
  }

  function openPreview(entry) {
    if (previewHash === entry.hash) return closePreview();
    closePreview();
    previewHash = entry.hash;
    const url = mediaURL(mediaBase(slug), entry.hash, entry.ext);
    const used = store.elementsUsingMedia(entry.hash).length;
    const facts = h('div', { class: 'media-preview-facts' });
    const say = (extra) => {
      facts.textContent = [extra, formatBytes(entry.size), entry.kind, used ? `used by ${used}` : 'not placed'].filter(Boolean).join(' · ');
    };
    say('');
    let body;
    if (entry.kind === 'image') {
      body = h('img', {
        class: 'media-preview-img',
        src: url,
        alt: entry.name,
        onLoad: (ev) => say(`${ev.target.naturalWidth} × ${ev.target.naturalHeight} px`),
      });
    } else if (entry.kind === 'audio') {
      body = h('audio', { class: 'media-preview-audio', src: url, controls: true, preload: 'metadata' });
    } else if (entry.kind === 'video') {
      body = h('video', {
        class: 'media-preview-video', src: url, controls: true, muted: true, playsInline: true, preload: 'metadata',
        onLoadedmetadata: (ev) => say(`${ev.target.videoWidth} × ${ev.target.videoHeight}, ${ev.target.duration.toFixed(1)} s`),
      });
    } else {
      body = h('div', { class: 'media-preview-glyph' }, KIND_GLYPH[entry.kind] ?? '◻');
    }
    preview.append(
      h('div', { class: 'media-preview-head' },
        h('span', { class: 'media-preview-name', title: entry.name }, entry.name),
        h('button', { class: 'btn btn--ghost', title: 'Close the preview', onClick: closePreview }, '✕')),
      body,
      facts,
    );
    preview.hidden = false;
    for (const t of grid.querySelectorAll('.media-tile')) {
      if (t.dataset.hash === entry.hash) t.dataset.selected = 'true'; else delete t.dataset.selected;
    }
  }

  let mediaFilter = '';
  function applyMediaFilter() {
    for (const t of grid.querySelectorAll('.media-tile')) {
      const name = t.querySelector('.media-name')?.textContent ?? '';
      t.style.display = !mediaFilter || name.toLowerCase().includes(mediaFilter) ? '' : 'none';
    }
  }

  function tile(entry) {
    const used = store.elementsUsingMedia(entry.hash).length;

    const thumb =
      entry.kind === 'image'
        ? h('img', {
            class: 'media-thumb',
            src: mediaURL(mediaBase(slug), entry.hash, entry.ext),
            loading: 'lazy',
            alt: '',
          })
        : h('div', { class: 'media-thumb media-thumb--glyph' }, KIND_GLYPH[entry.kind] ?? '◻');

    return h(
      'div',
      {
        class: 'media-tile',
        dataset: { hash: entry.hash, ...(previewHash === entry.hash ? { selected: 'true' } : {}) },
        draggable: true,
        onClick: () => openPreview(entry), // W6: look before placing
        title: `${entry.name}\n${formatBytes(entry.size)}${used ? `\nUsed by ${used} element${used > 1 ? 's' : ''}` : ''}`,
        onDragstart: (e) => {
          e.dataTransfer.setData('application/x-ae1-media', entry.hash);
          e.dataTransfer.effectAllowed = 'copy';
        },
        // Double-click adds at the frame centre, for anyone who would rather not
        // drag. Every gesture in a tool should have a keyboard/click equivalent.
        onDblclick: async () => {
          await store.addElementFromMedia(entry.hash, { x: 560, y: 300 });
          toast(`Added "${entry.name}" to the scene.`, 'ok');
        },
      },
      thumb,
      h('div', { class: 'media-name' }, entry.name),
      h(
        'div',
        { class: 'media-meta' },
        h('span', {}, formatBytes(entry.size)),
        used ? h('span', { class: 'media-used' }, `${used}×`) : null,
        // Anim-only: this glb is a CLIP library — never merged into the scene,
        // mesh never rendered. Set it BEFORE dropping companion files and they
        // never appear as elements at all (DESIGN.md §18.10).
        entry.kind === 'model'
          ? h(
              'button',
              {
                class: `media-anim${entry.animOnly ? ' media-anim--on' : ''}`,
                title: entry.animOnly
                  ? 'Animation library: clips only, mesh never rendered. Click to make it scene content again.'
                  : 'Use as animation only — clips drive characters, the mesh never enters the scene.',
                onClick: async (e) => {
                  e.stopPropagation();
                  const on = !entry.animOnly;
                  await api.patchMedia(slug, entry.hash, { animOnly: on });
                  store.media[entry.hash].animOnly = on;
                  store.emit('media', store.media);
                  paint();
                },
              },
              'Anim',
            )
          : null,
      ),
      h(
        'button',
        {
          class: 'media-del',
          title: 'Delete asset',
          onClick: async (e) => {
            e.stopPropagation();
            const result = await store.deleteMedia(entry.hash);
            if (result.ok) return paint();

            // Refuse rather than break scenes. Content addressing stops a
            // reference dangling on RENAME, but nothing stops a delete.
            await confirmDanger({
              title: 'Asset in use',
              message: h(
                'div',
                {},
                h('p', {}, `"${entry.name}" is used by ${result.users.length} element(s):`),
                h('p', { class: 'field-hint', style: 'margin-top:8px' }, result.users.join(', ')),
                h(
                  'p',
                  { class: 'field-hint', style: 'margin-top:8px' },
                  'Remove those elements first, or point them at another asset.',
                ),
              ),
              confirmLabel: 'OK',
            });
          },
        },
        '✕',
      ),
    );
  }

  function paint() {
    clear(grid);
    const entries = Object.values(store.media);
    if (previewHash && !store.media[previewHash]) closePreview(); // its asset was deleted
    count.textContent = entries.length ? `${entries.length}` : '';

    if (!entries.length) {
      grid.append(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', {}, 'Drop images, audio, video, or 3D objects here.'),
          h(
            'p',
            { style: 'margin-top:8px' },
            'Assets are stored by content hash, so duplicates cost nothing and renaming is free.',
          ),
          h('p', { style: 'margin-top:8px' }, 'Drag a tile into the viewport to make it an element.'),
        ),
      );
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) grid.append(tile(entry));
    applyMediaFilter(); // a repaint must not un-filter the grid
  }

  // Drop onto the pane itself: import without placing.
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    el.dataset.dropping = 'true';
  });
  el.addEventListener('dragleave', () => delete el.dataset.dropping);
  el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    delete el.dataset.dropping;
    await store.importFiles([...e.dataTransfer.files]);
  });

  const offs = [store.on('media', paint), store.on('scene', paint)];
  paint();
  return () => offs.forEach((off) => off());
}

/* Registry ---------------------------------------------------------------- */

export const EDITORS = {
  viewport: { label: 'Viewport', mount: mountViewport },
  outliner: { label: 'Outliner', mount: mountOutliner },
  properties: { label: 'Properties', mount: mountProperties },
  media: { label: 'Media Collection', mount: mountMedia },
  script: { label: 'Angel Script', mount: mountScript },
  console: { label: 'Console', mount: mountConsole },
};

export const DEFAULT_EDITOR = 'viewport';

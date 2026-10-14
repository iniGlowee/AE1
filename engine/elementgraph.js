/**
 * AE1 — ElementGraph: an opt-in, engine-generated map of every scene element AND
 * the named sub-nodes inside its glb, plus the classic reference-MMO right-click
 * "Options" menu that drives interactions against them.
 *
 * THE IDEA (Austin's element-graph spec). A 3D project rarely needs to reach
 * INTO a model — but a point-and-click world does: a door is one node inside a
 * building glb, a roof is another, and the player must be able to right-click
 * exactly that node and act on it. So when a project drops an `(extends
 * ElementGraph)` element into its scene, the engine walks every bound object at
 * load and builds a searchable graph: each element is a ROOT id, and every named
 * mesh under it (`door_3`, `roofs`, …) becomes a child id with a back-link to its
 * parent — a tag-map that mirrors the live THREE scene graph the renderer built.
 * Traversal (`get`, `byName`, `childrenOf`, `nodesOfKind`) is then O(1)/O(k).
 *
 * THE AE1 FLAG. On its own the graph is just addressing. The interaction layer is
 * the opt-in extra: `classify(rec)` tags each node with an interaction KIND (by
 * name convention here — `door*`→door, `roofs`→roof — a subclass may override),
 * and `interactions()` returns, per kind, the inspection text and the primary /
 * secondary option verbs. A right-click raycasts the cursor to a node
 * (env3d.pointerPick), looks up its kind, and raises the reference-MMO-style options box; picking
 * a verb runs its handler against the node. Doors swing on their baked hinge
 * origin; roofs hide themselves whenever the player steps under one (an up-ray,
 * env3d.rayUp) — the authentic global "roofs off when indoors".
 *
 * Base class only — no genre code lives here; the reference MMO project's town-graph
 * script supplies the test town's verbs. Reference: the movement research notes
 */
import { AE1Element, defineDatAccessors } from './element.js';

const RAD = Math.PI / 180;

export class AE1ElementGraph extends AE1Element {
  /* -- lifecycle --------------------------------------------------------- */

  _egBegin() {
    // Point-and-click by default: the cursor stays visible and right-clicks
    // reach the menu. A project that wants free-look with a graph sets (cursor
    // false). Idempotent with TileMover, which sets the same flag.
    if (this.cursor !== false && this.world?.input3d) this.world.input3d.cursorMode = true;

    this._graph = new Map();     // id -> record {id,name,kind,node,parentId,el,childIds}
    this._byName = new Map();    // node name -> record (first wins; names are unique per glb)
    this._built = false;
    this._openDoors = new Set(); // ids currently swung open
    this._roofMats = [];         // cloned roof materials (visibility-toggled)
    this._roofsHidden = false;
    this._roofClock = 0;
    this._player = null;

    this._table = this.interactions?.() ?? {};
    this._menuInit();
  }

  _egTick(dt) {
    if (!this._built) { this._built = this._build(); if (!this._built) return; }

    // Right-click → options menu (take the most recent; older ones are stale).
    const rcs = this.world?.input3d?.takeRightClicks?.() ?? [];
    if (rcs.length) this._openMenu(rcs[rcs.length - 1]);

    // Roof-removal: a few times a second, is a roof directly overhead?
    this._roofClock += dt;
    if (this._roofClock >= 0.15) { this._roofClock = 0; this._roofCheck(); }

    // Keep the inspect toast pinned to the (resizable) game canvas while it's up.
    if (this._toastVisible) this._positionToast();

    // §action text: refresh the top-left "what will my click do" line from the
    // node under the live cursor. Hidden while the menu is open (that IS the
    // choice) and when there's no cursor mode.
    this._updateActionText();
  }

  _updateActionText() {
    const act = this._actionEl;
    const input = this.world?.input3d;
    const canvas = input?.canvas;
    if (!act || !canvas) return;
    if (this._menuBox && this._menuBox.style.display !== 'none') { act.style.display = 'none'; return; }
    const a = this._actionAt(input.ptrX ?? 0, input.ptrY ?? 0);
    const t = a.target ? ` <span style="color:#ff9040">${a.target}</span>` : '';
    const html = `${a.verb}${t}`;
    if (act._html !== html) { act.innerHTML = html; act._html = html; }
    const r = canvas.getBoundingClientRect();
    act.style.left = `${r.left + 8}px`;
    act.style.top = `${r.top + 6}px`;
    act.style.display = 'block';
  }

  /* -- graph build (§element-graph tag-map) ------------------------------ */

  _build() {
    const w = this.world; const env = w?.env3d;
    if (!w?.scene || !env?.objectFor) return false;
    let bound = 0;
    for (const el of w.scene.all()) {
      if (el === this) continue;
      const obj = env.objectFor(el);
      if (!obj) continue;
      bound++;
      const rootId = el.name;
      this._add(rootId, el.name, obj, null, el);
      obj.traverse((node) => {
        if (node === obj || !node.name) return;
        // nearest NAMED ancestor within this element's subtree = parent id
        let pid = rootId;
        for (let p = node.parent; p && p !== obj; p = p.parent) {
          if (p.name) { pid = `${el.name}:${p.name}`; break; }
        }
        this._add(`${el.name}:${node.name}`, node.name, node, pid, el);
      });
    }
    if (!bound) return false; // renderer hasn't bound anything yet — try next tick
    this._collectRoofMats();
    console.log(`[ElementGraph] built ${this._graph.size} nodes across ${bound} elements`);
    return true;
  }

  _add(id, name, node, parentId, el) {
    if (this._graph.has(id)) return;
    const rec = { id, name, node, parentId, el, childIds: [] };
    rec.kind = this.classify(rec);
    this._graph.set(id, rec);
    if (!this._byName.has(name)) this._byName.set(name, rec);
    if (parentId && this._graph.has(parentId)) this._graph.get(parentId).childIds.push(id);
  }

  /* -- traversal --------------------------------------------------------- */

  get(id) { return this._graph.get(id) ?? null; }
  byName(name) { return this._byName.get(name) ?? null; }
  parentOf(id) { const r = this._graph.get(id); return r?.parentId ? this._graph.get(r.parentId) : null; }
  childrenOf(id) { const r = this._graph.get(id); return r ? r.childIds.map((c) => this._graph.get(c)) : []; }
  nodesOfKind(kind) { const o = []; for (const r of this._graph.values()) if (r.kind === kind) o.push(r); return o; }
  all() { return [...this._graph.values()]; }

  /** The LOGICAL interaction node for a picked record: climb to the direct child
   *  of the element root. glTF splits a multi-material mesh (a door with plank +
   *  metal + frame materials) into primitive sub-nodes (`door_4`, `door_4_1`…);
   *  the swingable node is their shared parent — the one carrying the hinge. A
   *  raycast can land on any primitive, so every action resolves through here. */
  rootChild(rec) {
    let cur = rec;
    while (cur && cur.parentId) {
      const p = this._graph.get(cur.parentId);
      if (!p || p.parentId == null) break; // p is the root ⇒ cur is its direct child
      cur = p;
    }
    return cur;
  }

  /** Interaction KIND of a node — override in a subclass for project-specific
   *  tags. Default is by name convention, matching the assembler's group nodes. */
  classify(rec) {
    const n = (rec.name || '').toLowerCase();
    if (/door|gate/.test(n)) return 'door';
    if (/roof/.test(n)) return 'roof';
    if (rec.parentId == null) return 'root';
    return 'static';
  }

  /** Per-kind interaction options. Override to wire real verbs/text. Each option
   *  is `{ label, run(ctx) }`; ctx = { rec, graph, click }. `inspect` is a string
   *  or `(rec)=>string`. The menu always appends Walk here + Cancel. */
  interactions() {
    return {
      door: { inspect: 'A door.', primary: { label: 'Open', run: (c) => c.graph.openDoor(c.rec) } },
      roof: { inspect: 'A rooftop.' },
      static: {},
    };
  }

  /* -- actions ----------------------------------------------------------- */

  /** Swing a door on its baked hinge origin (toggle). The node was frozen by the
   *  renderer's static-matrix pass, so re-enable its auto-update to move again. */
  openDoor(rec) {
    if (!rec?.node) return;
    rec = this.rootChild(rec); // act on the whole door, never one material slice
    const open = this._openDoors.has(rec.id);
    const swing = (Number(this.doorSwing) || 90) * RAD * (Number(this.doorDir) || 1);
    rec.node.matrixAutoUpdate = true;
    rec.node.rotation.y = open ? 0 : swing;
    rec.node.updateMatrix();
    if (open) this._openDoors.delete(rec.id); else this._openDoors.add(rec.id);
  }

  /** Clone roof materials once so hiding them can't blank a shared surface. We
   *  toggle MATERIAL visibility (not object.visible) so the roofs stay in the
   *  raycast set — the overhead probe keeps detecting them and the toggle never
   *  flickers. */
  _collectRoofMats() {
    this._roofMats = [];
    for (const rec of this.nodesOfKind('roof')) {
      rec.node.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (!o.userData._egClonedMat) {
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
          o.userData._egClonedMat = true;
        }
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => this._roofMats.push(m));
      });
    }
  }

  setRoofs(visible) {
    for (const m of this._roofMats) m.visible = visible;
    this._roofsHidden = !visible;
  }

  _roofCheck() {
    if (!this._roofMats.length) return;
    const p = this._findPlayer();
    if (!p) return;
    // Exclude the player's OWN body — an up-ray from the feet hits the character
    // mesh (a static composite) before the roof, and roofs would never hide.
    const pobj = this.world?.env3d?.objectFor?.(p) ?? null;
    const hit = this.world?.env3d?.rayUp?.(p.x ?? 0, p.y ?? 0, p.z ?? 0, pobj);
    const under = !!(hit && /roof/i.test(hit.name || ''));
    if (under && !this._roofsHidden) this.setRoofs(false);
    else if (!under && this._roofsHidden) this.setRoofs(true);
  }

  _findPlayer() {
    if (this._player && this.world?.scene?.all?.().includes?.(this._player)) return this._player;
    for (const el of this.world?.scene?.all?.() ?? []) {
      if (el !== this && el.isPlayer) { this._player = el; return el; }
    }
    return null;
  }

  /** "Walk here" routes the mover exactly like a ground click at the same spot. */
  walkHere(click) { this.world?.input3d?.queueClick?.(click.nx, click.ny); }

  /**
   * What a LEFT-CLICK at (nx,ny) will do — the single source of truth for both
   * the action and the top-left action text. Pick the node, resolve to its
   * logical group, and pick the DEFAULT option in the reference MMO's priority: PRIMARY (a door's
   * Open/Close), else INSPECT if that's all it has, else Walk here. Returns
   * `{ verb, target, run }` — `run` null means "let the mover walk".
   */
  _actionAt(nx, ny) {
    const pick = this.world?.env3d?.pointerPick?.(nx, ny);
    if (pick?.name) {
      let rec = (pick.el && this.get(`${pick.el.name}:${pick.name}`)) || this.byName(pick.name);
      if (rec) rec = this.rootChild(rec);
      const kind = rec ? rec.kind : this.classify({ name: pick.name });
      const opt = this._table[kind] ?? {};
      const target = (rec && (opt.name || this._pretty(rec.name))) || '';
      if (rec && opt.primary) {
        let verb = opt.primary.label;
        if (kind === 'door') verb = this._openDoors.has(rec.id) ? 'Close' : 'Open';
        return { verb, target, run: () => opt.primary.run({ rec, graph: this, pick, click: { nx, ny } }) };
      }
      if (rec && opt.inspect) {
        const insp = typeof opt.inspect === 'function' ? opt.inspect(rec) : opt.inspect;
        return { verb: 'Inspect', target, run: () => this.inspect(insp) };
      }
    }
    return { verb: 'Walk here', target: '', run: null };
  }

  /**
   * LEFT-CLICK default action (the left-click rule). Runs the default action at
   * (nx,ny) — a door opens/closes, an inspect-only node examines — and returns
   * true; returns false for plain ground/scenery so the mover walks there.
   * Duck-typed: the TileMover calls this on any element that exposes it.
   */
  tryPrimary(nx, ny) {
    if (!this._built) { this._built = this._build(); if (!this._built) return false; }
    const a = this._actionAt(nx, ny);
    if (!a.run) return false;
    a.run();
    return true;
  }

  inspect(text) { if (text) this._toast(String(text)); }

  /* -- classic "Options" menu (DOM overlay) --------------------- */

  _menuInit() {
    if (typeof document === 'undefined') return;
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:99999;display:none;min-width:120px;font:12px/1.35 "AE1 UF",Helvetica,Arial,sans-serif;' +
      'background:rgba(93,82,52,0.96);border:1px solid #000;box-shadow:2px 2px 0 rgba(0,0,0,0.5);' +
      'color:#fff;user-select:none;cursor:default;padding-bottom:2px;';
    const head = document.createElement('div');
    head.textContent = 'Options';
    head.style.cssText = 'background:#5d5234;color:#fff;padding:2px 6px;border-bottom:1px solid #000;font-weight:bold;';
    box.appendChild(head);
    const list = document.createElement('div');
    box.appendChild(list);
    document.body.appendChild(box);
    this._menuBox = box; this._menuList = list;

    // §action text (top-left, as in the reference MMO): a persistent line showing what a LEFT-CLICK
    // will do under the cursor — "Open Door", "Walk here", "Inspect Rooftop".
    // Pinned to the game canvas's top-left, updated every tick from _actionAt.
    const act = document.createElement('div');
    act.style.cssText =
      'position:fixed;z-index:99998;display:none;pointer-events:none;white-space:nowrap;' +
      'font:bold 14px/1.3 "AE1 UF",Helvetica,Arial,sans-serif;color:#fff;' +
      'text-shadow:1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000;';
    document.body.appendChild(act);
    this._actionEl = act;

    // Dismiss on any outside pointer-down or Escape.
    this._onDocDown = (e) => { if (this._menuBox.style.display !== 'none' && !this._menuBox.contains(e.target)) this._closeMenu(); };
    this._onKey = (e) => { if (e.key === 'Escape') this._closeMenu(); };
    document.addEventListener('pointerdown', this._onDocDown, true);
    document.addEventListener('keydown', this._onKey, true);

    // Kill the BROWSER's native right-click menu everywhere while the game's own
    // "Options" box is in play — including over the game overlays (the menu
    // box, marker, toast), which the canvas-only guard in input.js can't reach.
    // OUR menu is raised on mousedown(button 2), not the contextmenu event, so it
    // is unaffected; this only suppresses the browser popup. Removed in onRemove
    // (i.e. when Play stops), so the editor's own context menus return.
    this._onCtx = (e) => e.preventDefault();
    document.addEventListener('contextmenu', this._onCtx, true);
  }

  _addRow(list, label, onPick) {
    const row = document.createElement('div');
    row.innerHTML = label;
    row.style.cssText = 'padding:2px 8px;white-space:nowrap;';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.18)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    row.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); this._closeMenu(); onPick?.(); };
    list.appendChild(row);
  }

  _openMenu(click) {
    if (!this._menuBox) return;
    const env = this.world?.env3d;
    const pick = env?.pointerPick?.(click.nx, click.ny);
    const list = this._menuList; list.innerHTML = '';

    let rec = null, kind = null, opt = {};
    if (pick?.name) {
      rec = (pick.el && this.get(`${pick.el.name}:${pick.name}`)) || this.byName(pick.name);
      // Resolve a picked primitive to its logical node (the door group, not one
      // material slice of it) so the verb acts on the whole object.
      if (rec) rec = this.rootChild(rec);
      kind = rec ? rec.kind : this.classify({ name: pick.name });
      opt = this._table[kind] ?? {};
    }
    const target = (rec && (opt.name || this._pretty(rec.name))) || '';
    const tCol = target ? ` <span style="color:#ff9040">${target}</span>` : '';
    const ctx = { rec, graph: this, click, pick };

    if (rec) {
      // primary — a door's verb flips Open/Close with its state
      if (opt.primary) {
        let lbl = opt.primary.label;
        if (kind === 'door') lbl = this._openDoors.has(rec.id) ? 'Close' : 'Open';
        this._addRow(list, `${lbl}${tCol}`, () => opt.primary.run(ctx));
      }
      for (const s of opt.secondary ?? []) this._addRow(list, `${s.label}${tCol}`, () => s.run(ctx));
      const insp = typeof opt.inspect === 'function' ? opt.inspect(rec) : opt.inspect;
      if (insp) this._addRow(list, `Inspect${tCol}`, () => this.inspect(insp));
    }
    this._addRow(list, 'Walk here', () => this.walkHere(click));
    this._addRow(list, '<span style="color:#ffff00">Cancel</span>', null);

    // Place at the cursor, then nudge on-screen.
    const box = this._menuBox;
    box.style.display = 'block';
    box.style.left = '0px'; box.style.top = '0px';
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let x = click.sx ?? 0, y = click.sy ?? 0;
    x = Math.min(x, window.innerWidth - bw - 4);
    y = Math.min(y, window.innerHeight - bh - 4);
    box.style.left = `${Math.max(2, x)}px`;
    box.style.top = `${Math.max(2, y)}px`;
  }

  _closeMenu() { if (this._menuBox) this._menuBox.style.display = 'none'; }

  _pretty(name) {
    if (!name) return '';
    return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  _toast(text) {
    if (typeof document === 'undefined') return;
    let t = this._toastEl;
    if (!t) {
      t = document.createElement('div');
      // Anchored to the GAME CANVAS (the resizable window), not the browser
      // viewport — _positionToast() places it at the canvas's lower-left every
      // frame it's up, so it rides window resizes and stays inside the game area
      // (in the editor the canvas is only a panel). It's the reference MMO's "chatbox" line.
      t.style.cssText =
        'position:fixed;z-index:99998;padding:4px 10px;' +
        'font:13px/1.4 "AE1 UF",Helvetica,Arial,sans-serif;color:#0ff;background:rgba(0,0,0,0.55);' +
        'border:1px solid #000;pointer-events:none;transition:opacity .4s;';
      document.body.appendChild(t);
      this._toastEl = t;
    }
    t.textContent = text; t.style.opacity = '1';
    this._toastVisible = true;
    this._positionToast();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.opacity = '0'; this._toastVisible = false; }, 3200);
  }

  /** Pin the inspect toast to the game canvas's lower-left (viewport pixels), so
   *  it sits inside the resizable game window and follows it as it resizes. */
  _positionToast() {
    const t = this._toastEl;
    const canvas = this.world?.input3d?.canvas;
    if (!t || !canvas) return;
    const r = canvas.getBoundingClientRect();
    t.style.maxWidth = `${Math.max(80, r.width - 24)}px`;
    t.style.left = `${r.left + 12}px`;
    t.style.top = `${r.bottom - t.offsetHeight - 12}px`;
  }

  onRemove() {
    // Tidy the DOM + document listeners when the scene changes (§builtin hygiene).
    if (typeof document !== 'undefined') {
      if (this._onDocDown) document.removeEventListener('pointerdown', this._onDocDown, true);
      if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
      if (this._onCtx) document.removeEventListener('contextmenu', this._onCtx, true);
      this._menuBox?.remove(); this._toastEl?.remove(); this._actionEl?.remove();
    }
    super.onRemove?.();
  }
}

AE1ElementGraph.agsDef = {
  name: 'ElementGraph',
  extends: 'Element',
  runInfo: { _egBegin: ['onLoad'], _egTick: ['onTick'] },
};

AE1ElementGraph.agsDat = {
  ...AE1Element.agsDat,
  cursor: true,     // force point-and-click cursor mode on load
  doorSwing: 90,    // degrees a door rotates when opened
  doorDir: 1,       // swing sign (+1 / -1) — flip if a door opens the wrong way
};

defineDatAccessors(AE1ElementGraph);

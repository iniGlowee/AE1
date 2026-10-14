/**
 * AE1 — GameHUD: the reference MMO interface as a DOM overlay pinned to the game
 * canvas. First slice: the SKILLS panel (all 23 skills + total & combat level),
 * the CHATBOX (game messages), and floating XP DROPS. Structured to grow into the
 * full tab panel / orbs / minimap (see the project plan §C).
 *
 * Genre-neutral shell: it reads whatever RSStats element is in the scene (duck-
 * typed) and exposes `chat(text)`, `xpDrop(skill,amount)`, and `grantXp(skill,
 * amount)` (= addXp + drop + level-up message) for the skilling/combat systems.
 * All overlays are position:fixed in VIEWPORT pixels, re-pinned to the canvas rect
 * each tick so they ride the resizable game window (and the editor's panel offset).
 */
import { AE1Element, defineDatAccessors } from './element.js';
import { SKILLS } from './rsskills.js';

const ABBR = {
  attack: 'Att', strength: 'Str', defence: 'Def', ranged: 'Ran', prayer: 'Pra',
  magic: 'Mag', runecraft: 'RC', hitpoints: 'HP', crafting: 'Cra', mining: 'Min',
  smithing: 'Smi', fishing: 'Fis', cooking: 'Coo', firemaking: 'FM',
  woodcutting: 'WC', agility: 'Agi', herblore: 'Her', thieving: 'Thi',
  fletching: 'Fle', slayer: 'Sla', farming: 'Far', construction: 'Con',
  hunter: 'Hun',
};

export class AE1GameHUD extends AE1Element {
  _hudBegin() {
    if (typeof document === 'undefined') return;
    this._msgs = [];
    this._drops = [];
    this._skillEls = {};

    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;z-index:99990;pointer-events:none;font:12px/1.3 "the reference MMO UF",Helvetica,Arial,sans-serif;';
    document.body.appendChild(root);
    this._root = root;

    // -- Skills panel (right) --------------------------------------------
    const skills = document.createElement('div');
    skills.style.cssText =
      'position:fixed;pointer-events:auto;background:rgba(62,53,41,0.94);border:2px solid #2b241a;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.5);color:#ffd23b;padding:4px;width:190px;';
    const cbar = document.createElement('div');
    cbar.style.cssText = 'display:flex;justify-content:space-between;padding:1px 4px 4px;color:#fff;font-weight:bold;';
    skills.appendChild(cbar);
    this._cbar = cbar;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;';
    for (const s of SKILLS) {
      const cell = document.createElement('div');
      cell.title = s;
      cell.style.cssText = 'background:rgba(0,0,0,0.28);border:1px solid #2b241a;padding:2px 3px;display:flex;justify-content:space-between;';
      const nm = document.createElement('span'); nm.textContent = ABBR[s] || s; nm.style.color = '#caa54a';
      const lv = document.createElement('span'); lv.textContent = '1'; lv.style.color = '#fff';
      cell.append(nm, lv); grid.appendChild(cell);
      this._skillEls[s] = lv;
    }
    skills.appendChild(grid);
    const tot = document.createElement('div');
    tot.style.cssText = 'text-align:center;color:#fff;padding-top:4px;';
    skills.appendChild(tot); this._totEl = tot;
    root.appendChild(skills); this._skillsPanel = skills;

    // -- Chatbox (bottom-left) -------------------------------------------
    const chat = document.createElement('div');
    chat.style.cssText =
      'position:fixed;pointer-events:none;width:min(50vw,480px);height:120px;overflow:hidden;' +
      'background:rgba(0,0,0,0.45);border:2px solid #2b241a;padding:4px 6px;color:#0ff;' +
      'display:flex;flex-direction:column;justify-content:flex-end;';
    root.appendChild(chat); this._chat = chat;

    // -- XP-drop layer (top-center) --------------------------------------
    const xp = document.createElement('div');
    xp.style.cssText = 'position:fixed;pointer-events:none;';
    root.appendChild(xp); this._xpLayer = xp;

    this.chat('Welcome to the test town.');
  }

  /* -- public API -------------------------------------------------------- */

  _stats() { return this.world?.scene?.all?.().find((e) => typeof e.combatLevel === 'function') ?? null; }

  chat(text) {
    if (!this._chat) return;
    this._msgs.push(String(text));
    while (this._msgs.length > 12) this._msgs.shift();
    this._chat.innerHTML = this._msgs.map((m) => `<div>${m}</div>`).join('');
  }

  /** Floating "+N Skill" that rises and fades near the top of the game view. */
  xpDrop(skill, amount) {
    if (!this._xpLayer || !(amount > 0)) return;
    const d = document.createElement('div');
    d.textContent = `+${amount} ${ABBR[skill] || skill}`;
    d.style.cssText = 'color:#fff;text-shadow:1px 1px 0 #000;font-weight:bold;text-align:center;transition:transform .9s linear,opacity .9s linear;';
    this._xpLayer.appendChild(d);
    this._drops.push({ el: d, t: 0 });
    requestAnimationFrame(() => { d.style.transform = 'translateY(-28px)'; d.style.opacity = '0'; });
  }

  /** Convenience for skilling/combat: award xp, show the drop, announce a level. */
  grantXp(skill, amount) {
    const st = this._stats();
    if (!st) return null;
    const r = st.addXp(skill, amount);
    if (!r) return null;
    this.xpDrop(skill, amount);
    if (r.leveled) this.chat(`<span style="color:#ff0">Congratulations, you just advanced a ${skill} level! You are now level ${r.to}.</span>`);
    return r;
  }

  /* -- per-frame --------------------------------------------------------- */

  _hudTick(dt) {
    if (!this._root) return;
    const canvas = this.world?.input3d?.canvas;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();

    // pin panels to the canvas
    this._skillsPanel.style.left = `${r.right - this._skillsPanel.offsetWidth - 8}px`;
    this._skillsPanel.style.top = `${r.top + 8}px`;
    this._chat.style.left = `${r.left + 6}px`;
    this._chat.style.top = `${r.bottom - this._chat.offsetHeight - 6}px`;
    this._xpLayer.style.left = `${r.left + r.width / 2 - 40}px`;
    this._xpLayer.style.top = `${r.top + 40}px`;

    // repaint skills when stats change
    const st = this._stats();
    if (st && (st._dirty || !this._painted)) {
      for (const s of SKILLS) if (this._skillEls[s]) this._skillEls[s].textContent = String(st.level(s));
      this._cbar.innerHTML = `<span>Combat ${st.combatLevel()}</span>`;
      this._totEl.textContent = `Total level: ${st.totalLevel()}`;
      st._dirty = false; this._painted = true;
    }

    // expire xp drops
    for (const d of this._drops) { d.t += dt; }
    this._drops = this._drops.filter((d) => { if (d.t > 1.0) { d.el.remove(); return false; } return true; });
  }

  onRemove() {
    this._root?.remove();
    super.onRemove?.();
  }
}

AE1GameHUD.agsDef = {
  name: 'GameHUD',
  extends: 'Element',
  runInfo: { _hudBegin: ['onLoad'], _hudTick: ['onTick'] },
};

AE1GameHUD.agsDat = { ...AE1Element.agsDat };

defineDatAccessors(AE1GameHUD);

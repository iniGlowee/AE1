/**
 * AE1 — RSStats: the reference MMO player-state spine (skills, XP, levels, combat
 * level, hitpoints / prayer / run energy).
 *
 * A persistent, genre-neutral stat block: 23 named skills each with an XP total,
 * the reference MMO's XP curve (level 1→99), derived levels, and the reference MMO combat
 * level. `addXp(skill, amount)` returns whether a level was gained (so the HUD can
 * fire an XP drop + level-up message). HP/prayer/run-energy are tracked as live
 * pools over their skill maxima. Everything a save file needs is here; no UI, no
 * world — the GameHUD reads it, the combat/skilling systems write it.
 *
 * Reference: the reference MMO's public XP table + the reference MMO combat-level formula. Reference use only.
 */
import { AE1Element, defineDatAccessors } from './element.js';

// Display / combat order. Hitpoints starts at level 10; everything else at 1.
export const SKILLS = [
  'attack', 'strength', 'defence', 'ranged', 'prayer', 'magic', 'runecraft',
  'hitpoints', 'crafting', 'mining', 'smithing', 'fishing', 'cooking',
  'firemaking', 'woodcutting', 'agility', 'herblore', 'thieving', 'fletching',
  'slayer', 'farming', 'construction', 'hunter',
];
const COMBAT_SKILLS = new Set(['attack', 'strength', 'defence', 'ranged', 'prayer', 'magic', 'hitpoints']);

// XP → level table (1..99), built once from the reference MMO's formula:
//   points(L) = Σ_{x=1..L-1} floor(x + 300·2^(x/7));  xpForLevel(L) = floor(points/4)
const MAX_LEVEL = 99;
const XP_FOR_LEVEL = (() => {
  const t = [0, 0]; // index by level; level 1 = 0 xp
  let points = 0;
  for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    t[lvl + 1] = Math.floor(points / 4);
  }
  return t;
})();

export function xpForLevel(level) {
  return XP_FOR_LEVEL[Math.max(1, Math.min(MAX_LEVEL, level))] ?? 0;
}
export function levelForXp(xp) {
  let lvl = 1;
  while (lvl < MAX_LEVEL && XP_FOR_LEVEL[lvl + 1] <= xp) lvl++;
  return lvl;
}

export class AE1RSStats extends AE1Element {
  _statsBegin() {
    // xp per skill. Hitpoints opens at level 10 (1154 xp); the rest at 0.
    this._xp = Object.create(null);
    for (const s of SKILLS) this._xp[s] = 0;
    this._xp.hitpoints = xpForLevel(10);
    // apply any authored start overrides: (startAttack 40) etc. on the dat.
    for (const s of SKILLS) {
      const dv = this[`start_${s}`];
      if (dv != null && dv !== '') this._xp[s] = xpForLevel(Number(dv) || 1);
    }
    // live pools
    this.hp = this.level('hitpoints');
    this.prayerPoints = this.level('prayer');
    this.runEnergy = 100;
    this._dirty = true; // HUD repaint flag
  }

  /* -- queries ----------------------------------------------------------- */

  xp(skill) { return this._xp?.[skill] ?? 0; }
  level(skill) { return levelForXp(this.xp(skill)); }
  maxHp() { return this.level('hitpoints'); }
  maxPrayer() { return this.level('prayer'); }

  totalLevel() { let t = 0; for (const s of SKILLS) t += this.level(s); return t; }
  totalXp() { let t = 0; for (const s of SKILLS) t += this.xp(s); return t; }

  /** the reference MMO combat level. */
  combatLevel() {
    const L = (s) => this.level(s);
    const base = 0.25 * (L('defence') + L('hitpoints') + Math.floor(L('prayer') / 2));
    const melee = 0.325 * (L('attack') + L('strength'));
    const range = 0.325 * Math.floor(3 * L('ranged') / 2);
    const mage = 0.325 * Math.floor(3 * L('magic') / 2);
    return Math.floor(base + Math.max(melee, range, mage));
  }

  /* -- mutation ---------------------------------------------------------- */

  /**
   * Grant XP. Returns { skill, amount, from, to, leveled } so callers (combat /
   * skilling) can fire the XP-drop + level-up message via the HUD.
   */
  addXp(skill, amount) {
    if (!(skill in this._xp) || !(amount > 0)) return null;
    const from = this.level(skill);
    this._xp[skill] = Math.min(this._xp[skill] + amount, xpForLevel(MAX_LEVEL));
    const to = this.level(skill);
    if (skill === 'hitpoints' && to > from) this.hp += (to - from); // max HP up ⇒ heal the gain
    if (skill === 'prayer' && to > from) this.prayerPoints += (to - from);
    this._dirty = true;
    return { skill, amount, from, to, leveled: to > from };
  }

  setXp(skill, xp) { if (skill in this._xp) { this._xp[skill] = Math.max(0, xp | 0); this._dirty = true; } }
  setLevel(skill, lvl) { this.setXp(skill, xpForLevel(lvl)); }

  /** Damage / heal the live HP pool; returns the new hp (0 ⇒ dead). */
  damage(n) { this.hp = Math.max(0, this.hp - (n | 0)); this._dirty = true; return this.hp; }
  heal(n) { this.hp = Math.min(this.maxHp(), this.hp + (n | 0)); this._dirty = true; return this.hp; }
  isDead() { return this.hp <= 0; }
  restore() { this.hp = this.maxHp(); this.prayerPoints = this.maxPrayer(); this.runEnergy = 100; this._dirty = true; }

  /* -- persistence (AE1SaveHandler) -------------------------------------- */

  saveState() {
    return { xp: { ...this._xp }, hp: this.hp, prayer: this.prayerPoints, run: this.runEnergy };
  }
  loadState(s) {
    if (!s) return;
    for (const k of SKILLS) if (s.xp && k in s.xp) this._xp[k] = s.xp[k] | 0;
    if (s.hp != null) this.hp = s.hp;
    if (s.prayer != null) this.prayerPoints = s.prayer;
    if (s.run != null) this.runEnergy = s.run;
    this._dirty = true;
  }
}

AE1RSStats.agsDef = {
  name: 'RSStats',
  extends: 'Element',
  runInfo: { _statsBegin: ['onLoad'] },
};

// start_<skill> dats let a project seed levels, e.g. (start_attack 40).
AE1RSStats.agsDat = {
  ...AE1Element.agsDat,
  ...Object.fromEntries(SKILLS.map((s) => [`start_${s}`, ''])),
};

defineDatAccessors(AE1RSStats);

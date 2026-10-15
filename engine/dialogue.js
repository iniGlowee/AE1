/**
 * AE1 - dialogue trees.
 *
 * Two classes, and the split between them is the whole design:
 *
 *   AE1DialogueDelegate  `(extends DialogueDelegate)` — owns the CONVERSATION:
 *                        the tree, the current node, the choices, the actions.
 *   AE1DialogueBox       `(extends DialogueBox)` — owns the PRESENTATION: where
 *                        the line is drawn and where the choice buttons sit.
 *
 * That is the same division that made SaveHandler work (DESIGN.md §16.3): the
 * engine owns the structure, the moment, and the ordering; the author owns the
 * contents. A delegate knows what Bram says and nothing about pixels; a box
 * knows about pixels and nothing about Bram.
 *
 * WHY THE BOX IS ELEMENTS AND NOT A DOM OVERLAY
 *
 * A shipped game already had a dialogue `<div>` and the editor already had a
 * Console line — say() was implemented twice and shared neither (Principle 2, in
 * the one place it had quietly slipped). That is survivable for one-way flavour
 * text. It is not survivable for a CHOICE, which has to be clicked: the div is
 * `pointer-events: none`, sits outside the canvas, ignores the letterbox, and in
 * the editor does not exist at all. Choices built on it would work in the export
 * and be invisible while authoring.
 *
 * So a choice is a Button in the HUD layer. The engine already hit-tests, hovers,
 * and dispatches clicks for those — this file adds no input machinery whatsoever.
 * video.js made the identical call for the identical reason: an overlay "would sit
 * outside the canvas, ignore the letterbox transform, and be impossible to layer
 * elements over".
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Text } from './text.js';
import { AE1Button } from './button.js';

/**
 * Read a `(dialogue …)` dat value into nodes.
 *
 *   (dialogue
 *     (start (text "Hey.") (choice "Who are you?" who))
 *     (who   (text "Bram.") (does bragging) (goto start)))
 *
 * The reader already produces this — nested lists of primitives — which is the
 * whole reason the declarative sections are LISP (DESIGN.md §6.1): a new form
 * costs nothing at the parser level, because every form is already data.
 *
 * Every field is checked rather than assumed. dat is AUTHOR-OWNED and can hold
 * anything: `(items ("New Game" "Load Game"))` once crashed a build because the
 * exporter assumed the shape of a key it did not define. A malformed tree here
 * must produce no dialogue, never an exception inside the render loop.
 */
export function dlgParseTree(raw) {
  const nodes = new Map();
  if (!Array.isArray(raw) || !raw.length) return nodes;

  // formValue collapses a single-item rest, so the SHAPE depends on the count:
  //   (dialogue (only …))       -> ['only', ['text', '…']]        <- the node
  //   (dialogue (a …) (b …))    -> [['a', …], ['b', …]]           <- a list
  // A one-node tree therefore arrives looking nothing like a two-node tree.
  // Tell them apart by whether the first item is this node's NAME or a node.
  const list = typeof raw[0] === 'string' ? [raw] : raw;

  for (const entry of list) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;

    const node = { id: entry[0], text: '', choices: [], does: [], goto: null };

    for (const form of entry.slice(1)) {
      if (!Array.isArray(form) || typeof form[0] !== 'string') continue;
      const [key, ...rest] = form;

      if (key === 'text') node.text = String(rest[0] ?? '');
      else if (key === 'choice') {
        node.choices.push({
          label: String(rest[0] ?? ''),
          // A choice with no target ends the conversation. That is a real
          // authoring intent ("Never mind."), not a mistake.
          goto: rest[1] == null ? null : String(rest[1]),
        });
      } else if (key === 'does') node.does.push(...rest.map(String));
      else if (key === 'goto') node.goto = rest[0] == null ? null : String(rest[0]);
    }

    nodes.set(node.id, node);
  }

  return nodes;
}

/* -------------------------------------------------------------------------- */

/**
 * One clickable choice. Spawned by the box, never authored.
 *
 * It inherits Button's static agsDef — and therefore `_btnClick: ['onClick']` —
 * because JavaScript inherits statics down the class chain. So it is hit-tested,
 * hovered, and clicked by the machinery that already exists, with nothing added.
 *
 * Not in BUILTINS: an author never writes `(extends DialogueChoice)`. They style
 * choices through the box.
 */
class AE1DialogueChoice extends AE1Button {
  /** Button's default press() follows `(target …)`. A choice answers instead. */
  press(_actor) {
    return this._pick?.();
  }
}

/* -------------------------------------------------------------------------- */

/**
 * `AE1DialogueBox` — where a line and its choices appear.
 *
 * Extends Text rather than Element, for the reason Button does: a dialogue box IS
 * text with a background, and a second glyph painter would be a second thing to
 * keep agreeing with the first.
 */
export class AE1DialogueBox extends AE1Text {
  /* -- state -------------------------------------------------------------- */

  /** Is the box currently holding a line? */
  get showing() {
    return Boolean(this.visible && this.text);
  }

  /* -- presenting --------------------------------------------------------- */

  /**
   * Show a node and its choices. Called by the delegate.
   *
   * @param {AE1DialogueDelegate} delegate  who to answer
   * @param {object} node                   parsed node
   * @param {Array<{label, goto}>} choices  already resolved (continue included)
   */
  present(delegate, node, choices) {
    this._cancelHide();
    this.text = String(node.text ?? '');
    this.visible = true;
    this._spawn(choices, (i) => delegate.choose(i));
    return true;
  }

  /**
   * Show a bare line — what `say()` routes here when the project has a box.
   *
   * Declines while a conversation is running: the box belongs to the conversation
   * then, and a stray say() must not wipe the choices out from under the player's
   * cursor. The line still reaches the editor's Console, which is the debug view
   * of everything said.
   *
   * @returns {boolean} whether the box took the line
   */
  say(text) {
    if (this.world?.dialogue) return false;

    this._cancelHide();
    this._despawn();
    this.text = String(text);
    this.visible = true;

    // Scales with length, because "It's locked." and a paragraph are not the same
    // read. 0 holds the line until something replaces it.
    const ms = Number(this.autoHide);
    if (ms > 0) {
      this._hideTimer = setTimeout(() => this.hide(), ms + String(text).length * 45);
    }
    return true;
  }

  /** Put the box away and drop any choices. */
  hide() {
    this._cancelHide();
    this._despawn();
    this.text = '';
    this.visible = false;
    return this;
  }

  /* -- choices ------------------------------------------------------------ */

  /**
   * Spawn one Button per choice.
   *
   * `hud.add()` fires `@add`, which makes the world rebuild the loop's schedule
   * (world.js:_change). Without that rebuild these buttons would draw perfectly
   * and never receive a click — the tables are built once, so anything spawned
   * afterwards is invisible to dispatch.
   */
  _spawn(choices, onPick) {
    this._despawn();

    const hud = this.world?.hud;
    if (!hud) return;

    if (!this.world?.dialogueBox) return; // not in the HUD; nothing to spawn into

    const h = Number(this.choiceHeight) || 36;
    const gap = Number(this.choiceGap) || 6;
    const w = Number(this.choiceWidth) || this.width;
    const above = this.choicesAbove !== false;

    this._choiceIds = [];

    choices.forEach((choice, i) => {
      // Stacked away from the box: upward when it sits at the bottom of the
      // frame, which is where a dialogue box almost always is. Downward would
      // walk them straight off the screen edge.
      const offset = (i + 1) * (h + gap);
      const y = above ? this.y - offset : this.y + this.height + offset - h;

      const btn = new AE1DialogueChoice({
        name: `${this.name} choice ${i + 1}`,
        x: this.x,
        y,
        width: w,
        height: h,
        // Above the box, and the box is already above the scene.
        layer: this.layer + 1,
        label: choice.label,
        size: this.choiceSize ?? 18,
        background: this.choiceBackground,
        hoverBackground: this.choiceHoverBackground,
        clickSound: this.choiceSound ?? '',
        hoverSound: this.choiceHoverSound ?? '',
      });

      // A plain field, not dat: which choice this is exists only for as long as
      // the button does, and nothing should ever serialize it.
      btn._pick = () => onPick(i);

      hud.add(btn);
      this._choiceIds.push(btn.id);
    });
  }

  _despawn() {
    const hud = this.world?.hud;
    for (const id of this._choiceIds ?? []) hud?.remove(id);
    this._choiceIds = [];
  }

  _cancelHide() {
    clearTimeout(this._hideTimer);
    this._hideTimer = null;
  }

  /**
   * Leave nothing behind when the WORLD stops.
   *
   * Note what this does NOT cover: a scene change. The HUD is never unloaded --
   * that is the entire point of it (DESIGN.md §12) -- so this fires only on
   * world.stop(). I originally wrote this hook believing it covered goToScene,
   * and driving it proved otherwise: three choice buttons hung over the next
   * scene, clickable, answering a delegate that no longer existed.
   *
   * A conversation interrupted by a scene change is ended by the DELEGATE's
   * onUnload instead, because the delegate is the thing that belongs to a scene.
   * See AE1DialogueDelegate._dlgUnload.
   */
  _boxEnd() {
    this._cancelHide();
    this._despawn();
  }
}

AE1DialogueBox.agsDef = {
  name: 'DialogueBox',
  extends: null,
  runInfo: { _boxEnd: ['onUnload'] },
};

AE1DialogueBox.agsDat = {
  // text (AE1Text.draw reads these)
  text: '',
  size: 22,
  color: '#f0f0f0',
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  weight: '400',
  lineHeight: 1.45,
  align: 'left',
  valign: 'top',
  padding: 18,
  wrap: true,
  shadow: true,
  background: 'rgba(10,10,12,0.86)',

  // choices
  choicesAbove: true,
  choiceHeight: 36,
  choiceGap: 6,
  choiceWidth: 0, // 0 = as wide as the box
  choiceSize: 18,
  choiceBackground: 'rgba(10,10,12,0.86)',
  choiceHoverBackground: 'rgba(60,68,86,0.94)',
  choiceSound: '',
  choiceHoverSound: '',

  // a bare say(), in ms. 0 holds it until something replaces it.
  autoHide: 1800,
};

defineDatAccessors(AE1DialogueBox);

/* -------------------------------------------------------------------------- */

/**
 * `AE1DialogueDelegate` — an element that can hold a conversation.
 *
 * The tree lives in this element's dat, so Bram's dialogue is Bram's. It is
 * never persisted: `serialize()` writes only dat that DIFFERS from the declared
 * default (DESIGN.md §5), and a tree is a declaration, not state — so it stays in
 * the .ags.txt where an author (or a modder) can read and edit it.
 */
export class AE1DialogueDelegate extends AE1Element {
  /* -- the tree ----------------------------------------------------------- */

  /** The parsed tree. Re-parsed only when the dat actually changes. */
  get tree() {
    if (this._treeSrc !== this.dialogue) {
      this._treeSrc = this.dialogue;
      this._tree = dlgParseTree(this.dialogue);
    }
    return this._tree;
  }

  /** The node showing now, or '' when not talking. */
  get node() {
    return this._node ?? '';
  }

  /** Is this element mid-conversation? */
  get inDialogue() {
    return Boolean(this._node);
  }

  /* -- the standard library ----------------------------------------------- */

  /**
   * Start talking. Wired to onClick by the static agsDef below, so an element
   * that `(extends DialogueDelegate)` and declares a tree needs NO code at all.
   */
  talk(actor) {
    return this.startDialogue(this.startNode, actor);
  }

  /**
   * Begin at a node. `startDialogue()` uses `(startNode …)`, then the first node
   * declared — an author who names their opener anything still gets a sane start.
   */
  startDialogue(nodeId, actor) {
    const tree = this.tree;
    if (!tree.size) {
      console.warn(`[ags] ${this.name}.talk() — no (dialogue …) declared.`);
      return false;
    }

    const start = nodeId && tree.has(nodeId) ? nodeId : (tree.has(this.startNode) ? this.startNode : [...tree.keys()][0]);

    // One conversation at a time. Two delegates presenting into one box would
    // fight over it every node, and the player would answer whichever spoke last.
    const other = this.world?.dialogue;
    if (other && other !== this) other.endDialogue();

    if (this.world) this.world._dialogue = this;
    this._actor = actor ?? null;

    this.world?.loop?.dispatchTo?.(this, 'onDialogueStart', this);
    this._enter(start);
    return true;
  }

  /** Answer with choice `i` of the node showing. What a choice button calls. */
  choose(i) {
    const node = this.tree.get(this.node);
    if (!node) return false;

    const choice = this._choicesFor(node)[i];
    if (!choice) return false;

    this.world?.loop?.dispatchTo?.(this, 'onChoice', choice.label, choice.goto, this);

    // No target means this choice was the way out.
    if (!choice.goto) return this.endDialogue();
    return this._enter(choice.goto);
  }

  /** Stop talking and put the box away. */
  endDialogue() {
    const last = this.node;
    this._node = '';

    this.world?.dialogueBox?.hide?.();
    if (this.world?._dialogue === this) this.world._dialogue = null;

    // Dispatched last, so a handler that inspects the world sees a finished
    // conversation rather than one caught halfway through ending.
    this.world?.loop?.dispatchTo?.(this, 'onDialogueEnd', last, this);
    return false;
  }

  /** Who clicked. Available to a `(does …)` method mid-conversation. */
  get speaker() {
    return this._actor ?? null;
  }

  /**
   * The character left, so the conversation is over.
   *
   * On the DELEGATE rather than the box, because persistence comes from which
   * layer an element lives in, never from its class (DESIGN.md §12) -- and this
   * hook inherits that for free. A delegate in a scene ends its conversation when
   * that scene unloads; a delegate in the HUD (a narrator that follows the player
   * through a door) does not, and should not.
   *
   * Without this, the box's choice buttons outlived the scene change and sat over
   * the next room answering an element that was gone.
   */
  _dlgUnload() {
    if (this.inDialogue) this.endDialogue();
  }

  /* -- progression -------------------------------------------------------- */

  /**
   * Every node presents buttons, including the ones with nothing to ask.
   *
   * A node with no choices gets a single "continue" — so there is ONE path
   * through this class rather than a conversation path and a monologue path that
   * have to be kept behaving the same.
   */
  _choicesFor(node) {
    if (node.choices.length) return node.choices;
    return [{ label: this.continueLabel ?? '▸', goto: node.goto }];
  }

  _enter(id) {
    const node = this.tree.get(id);
    if (!node) {
      console.warn(`[ags] ${this.name} — dialogue has no node "${id}".`);
      return this.endDialogue();
    }

    this._node = id;

    // Actions first, so a method that grants an item or unlocks a door has run
    // before the player reads the line claiming it happened.
    for (const method of node.does) this._run(method, node);

    this.world?.loop?.dispatchTo?.(this, 'onNode', id, this);

    // endDialogue() inside a (does …) or an onNode handler is legitimate — an
    // action can decide the conversation is over. Presenting afterwards would
    // reopen the box it just closed.
    if (this._node !== id) return true;

    const choices = this._choicesFor(node);
    const box = this.world?.dialogueBox;

    if (!box) {
      // Degrade honestly: the line still gets said, but a choice cannot be
      // clicked without something to click. Saying so once beats a conversation
      // that silently stops on its first question.
      this.say(node.text);
      if (node.choices.length && !this._warnedNoBox) {
        this._warnedNoBox = true;
        console.warn(
          `[ags] ${this.name} — this dialogue has choices, but the project has no ` +
            `DialogueBox in its HUD. Add one, or the player cannot answer.`,
        );
      }
      if (!node.choices.length && node.goto) return this._enter(node.goto);
      return true;
    }

    box.present(this, node, choices);
    return true;
  }

  /**
   * Run a `(does someMethod)` action.
   *
   * The delegate is an ordinary element, so an action already has the whole
   * standard library: `this.give(…)`, `this.playSound(…)`, and
   * `this.find("Door").unlock()` — which is how a conversation reaches out and
   * changes the rest of the game.
   */
  _run(method, node) {
    const fn = this[method];
    if (typeof fn !== 'function') {
      console.warn(`[ags] ${this.name} — node "${node.id}" does "${method}", which is not a method.`);
      return;
    }
    try {
      fn.call(this, this._actor, node.id);
    } catch (err) {
      // One bad action costs that action, never the conversation. Losing the
      // dialogue would strand the player in a box with no way out.
      console.error(`[ags] ${this.name}.${method}() threw during dialogue:`, err);
    }
  }
}

/**
 * Static def, so `(extends DialogueDelegate)` + a tree needs no methods.
 *
 * `talk` on onClick is the whole point: clicking a character talks to them. An
 * author who wants something else overrides talk() and keeps everything else.
 */
AE1DialogueDelegate.agsDef = {
  name: 'DialogueDelegate',
  extends: null,
  runInfo: {
    talk: ['onClick'],
    _dlgUnload: ['onUnload'],
  },
};

AE1DialogueDelegate.agsDat = {
  dialogue: [],
  startNode: 'start',
  continueLabel: '▸',
};

defineDatAccessors(AE1DialogueDelegate);

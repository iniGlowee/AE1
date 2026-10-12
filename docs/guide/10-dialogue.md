# 10. Dialogue

A conversation in AE1 is two things: a **character who has one**, and a **box where it appears**.

You need one of each. Click **+ Talker** to add the character, and **+Box** in the HUD row to
add the box. Then press Play and click the character.

---

## The two pieces

| | |
|---|---|
| **`(extends DialogueDelegate)`** | a character with a conversation. The tree lives in its dat. |
| **`(extends DialogueBox)`** | where the line and the choices are drawn. One per project, in the HUD. |

The box is in the HUD because a conversation has to survive a scene change — a box rebuilt on
every `goToScene` couldn't finish a sentence that walked you through a door.

**Choices are real Buttons.** They're spawned above the box while someone is talking, they hover
and click like every other button, and they're gone the moment the conversation ends. That's
also why they're styleable — see [Styling](#styling) below.

---

## The tree

```
<?dat
(dialogue
  (start
    (text "Hey. You look lost.")
    (choice "Who are you?" who)
    (choice "Do you have a key?" key)
    (choice "Never mind."))
  (who
    (text "Nobody important. I just stand here.")
    (choice "Fair enough." start))
  (key
    (text "Maybe I do. What's it worth to you?")
    (does offerTrade)
    (choice "Here, take this." paid)
    (choice "Forget it." start))
  (paid
    (text "Pleasure doing business.")
    (does giveKey)))

(startNode "start")
(continueLabel "▸")
?>
<?def
(extends DialogueDelegate)
(name "Talker")
ags?>
```

That's a complete, working conversation with **no JavaScript at all** — except the two `(does …)`
methods, which are below.

A node is `(nodeName …)` and holds:

| | |
|---|---|
| `(text "…")` | the line |
| `(choice "Label" nextNode)` | an answer. **No `nextNode` ends the conversation.** |
| `(does method)` | call `method()` on this element as the node opens |
| `(goto node)` | go straight there — for a node with no choices |

**A node with no choices** shows its line and one `(continueLabel)` button. That's how you write
a statement rather than a question.

**Clicking the character starts it.** You don't write `onClick` — `(extends DialogueDelegate)`
already did. Override `talk()` if you want something else to start it.

---

## Making a conversation do something

`(does giveKey)` calls `giveKey()` on this element as that node opens. A delegate is an ordinary
element, so it has the whole [standard library](05-standard-library.md):

```js
function giveKey() {
  this.give({ id: "brass_key", name: "Brass Key", icon: "key.png" });
}

function offerTrade() {
  this.find("Door").locked = false;   // reach out and change the game
  this.playSound("deal.mp3");
}
```

Actions run **before** the line is drawn, so a method that grants an item has already run by the
time the player reads the line claiming it did.

`(does …)` needs no `runInfo` — the tree names it.

### The whole conversation

`runInfo` is for things that care about the conversation rather than one node:

```
(runInfo whenNode onNode)
```

| mode | called with |
|---|---|
| `onDialogueStart` | `(delegate)` |
| `onNode` | `(nodeId, delegate)` |
| `onChoice` | `(label, goto, delegate)` |
| `onDialogueEnd` | `(lastNodeId, delegate)` |

> **`(runInfo …)` must be above the first `function`.** Everything after the first `function` is
> JavaScript. This is the trap that catches everyone — see [Angel Script](04-angel-script.md).

---

## From a script

```js
this.talk();                  // start at (startNode)
this.startDialogue("key");    // start somewhere specific
this.choose(0);               // answer, as a choice button does
this.endDialogue();           // stop
this.node;                    // "" when not talking
this.inDialogue;              // boolean
this.speaker;                 // who clicked
```

Calling `endDialogue()` inside a `(does …)` is fine — an action is allowed to decide the
conversation is over.

---

## say() and the box

**With a box in your HUD, `say()` draws there.** That's the whole change: `this.say("It's
locked.")` now appears on the canvas, letterboxed and layered like everything else, instead of
in a DOM strip.

Without a box, `say()` behaves exactly as it always did. Nothing you've already built changes.

**During a conversation, `say()` is ignored** — the box belongs to the conversation, and a stray
line must not wipe out the choices you're about to click. The line still shows in the editor's
Console.

---

## Styling

The box is an element. Position it, resize it, and set its dat:

| | |
|---|---|
| `(background …)` `(color …)` `(size …)` `(padding …)` | it extends Text, so all of Text's knobs work |
| `(choicesAbove true)` | choices stack up from the box. `false` puts them below. |
| `(choiceHeight …)` `(choiceGap …)` `(choiceWidth …)` | `choiceWidth` of 0 means "as wide as the box" |
| `(choiceBackground …)` `(choiceHoverBackground …)` `(choiceSize …)` | |
| `(choiceSound …)` `(choiceHoverSound …)` | media names |
| `(autoHide 1800)` | ms a bare `say()` lingers. `0` holds it until something replaces it. |

Override `draw(ctx, api)` on the box to take it over completely — the choices are separate
elements and keep working.

---

## Gotchas

**A conversation ends when its character's scene unloads.** If the Talker is in the scene you
just left, the conversation is over — which is almost always what you want. Put the delegate in
the **HUD** if you want a narrator that follows the player through doors.

**One conversation at a time.** Starting a second ends the first. Two characters presenting into
one box would fight over it every node.

**Choices need a box.** A conversation with no `DialogueBox` in the HUD still *says* its lines,
but there's nothing to click. AE1 warns in the Console rather than stopping silently.

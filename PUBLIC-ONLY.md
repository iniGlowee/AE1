# PUBLIC-ONLY ledger

This repository is normally re-derived from the private AE1 tree (exclude list plus scrub map). **Anything listed here
exists only in this repository.** A re-derivation that does not read this file first deletes it, with no error.

## Procedure for every re-derivation or sync (either direction)

1. Read this ledger first.
2. Run the pre-sync audit: the research-tree audit (nothing tracked under `research/` is a game byte, decompiled text,
   mesh or texture) and `gate.py` over every **tracked** file, not only staged ones.
3. Derive, then re-apply or cherry-pick every entry below; confirm each "would be lost" line is now false.
4. Version change first, tag second: a tag that asserts a version must point at a commit where the assertion is true.
5. Every push to the remote and every tag is Austin's decision, each time.

## Entries (MANAGER-PROJECT-01, the public UX fixes from the first outside test, 2026-10-14)

| id | what it adds | commit / branch | what a re-derivation would lose |
|---|---|---|---|
| W1 | Guide: the viewport-drop flow is marked 2D-only, a note tells 3D users what to do instead, and model files are no longer described as "stored but not drawn" | `5b1ae36` on `held/w1-docs-2026-10-14` | the corrected wording in `docs/guide/02-the-editor.md` and `06-media.md`, and the new "Keeping your work on the hosted demo" section of `09-build-and-ship.md`; the old text would say a 3D user can drop an image on the viewport and say nothing about losing work |
| W2 | Dropping an image into a 3D viewport creates a textured plane element | pending, Admin (Engine) | the image-drop plane feature and the line in the guide that replaces W1's interim note |
| W3b | A button to restore an element's script to its shipped default | pending, Admin (Engine) | the restore control; a visitor who blanks a script has no way back |
| W3c | `projects/starter/scripts/player.ags.txt` ends with a stray `ags` before the closing marker; corrected | pending, Admin (Engine) | the corrected starter script (W3b restores exactly this text) |
| W3 | Script edits recorded in the undo history (per-file snapshots) | pending, Admin (Engine); a design change | undo covering scripts; today a cleared script cannot be undone |
| W4 | Save the current project under a new name | pending, Admin (Engine) | the save-as control |
| W5 | Restore the sample project, with a confirm that names what will be lost and offers "save a copy first" (depends on W4) | pending, Admin (Engine) | the restore control and its protective dialog |
| W6 | Media preview pane (images first) | pending, Admin (Engine) | the preview pane |
| W8 | Every `#app` child is placed by grid area so the hosted banner cannot take the editor's row | `17fa9df` on `held/hosted-banner-css-2026-10-14` | the layout fix; with the banner on, the editor collapses to a 22px strip (it did on 2026-10-14) |
| W7 | The hosted banner's wording | kit-side only (`config.json` of the hosting kit, outside this repository) | nothing in this repo; listed so the set is complete |

Fill in each "pending" row with its commit as Admin (Engine) lands it. The ledger is deliberately over-complete rather than tidy.

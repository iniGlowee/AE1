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
| W2 | Dropping an image into a 3D viewport creates a card (image plane) in the scene: the `image` component (`element.js` COMPONENT_SCHEMA "Image Plane"), renderer-owned image planes in `render3d`, the viewport drop; AND a shipped-host fix in `game3d.js` (`mediaUrl` falls back to the shipped file by manifest entry, because images and particle sheets drew white in builds) | `6f3371f` on `held/mp01-ux-2026-10-14` | image drop, the component, and the build fix (a re-derivation would bring back white images in exported games) |
| W3b | Restore an element's default script: `samples/` (the pristine shipped Starter + starter.ae1proj), server routes `GET /api/projects/<slug>/sample` and `.../sample/scripts/<file>`, and "Restore default" in the script pane | `f8c5499` on `held/mp01-ux-2026-10-14` | the samples folder, the routes, the button and the empty-pane placeholder text |
| W3c | NO CHANGE: the `ags?>` at the end of the starter scripts is the format's own end marker (`compiler.js` DEF_RE `<?def ... ags?>`), not a typo; the earlier note calling it a stray typo was wrong | none | nothing |
| W3 | Script edits recorded in the undo history (per-file snapshots) | pending, Admin (Engine); a design change | undo covering scripts; today a cleared script cannot be undone |
| W4 | Save the project under a new name: `POST /api/projects/<slug>/copy`, `store.flushAll`, "Save as" in the workspace bar | `6cb5a5e` on `held/mp01-ux-2026-10-14` | save-as entirely |
| W5 | Restore the sample project: `GET .../sample/diff`, `POST .../sample/restore`, `store.forgetProject`, "Restore sample" with the dialog that names what will be lost and offers a copy first (depends on W4) | `7d2658b` on `held/mp01-ux-2026-10-14` | restore and its safety dialog |
| W6 | Media preview strip (`editors.js`, `workspace.css`) and `elementsUsingMedia` counting image planes | `f82f8be` on `held/mp01-ux-2026-10-14` | the preview and the delete guard for image-plane pictures |
| W8 | Every `#app` child is placed by grid area so the hosted banner cannot take the editor's row | `17fa9df` on `held/hosted-banner-css-2026-10-14` | the layout fix; with the banner on, the editor collapses to a 22px strip (it did on 2026-10-14) |
| W7 | The hosted banner's wording | kit-side only (`config.json` of the hosting kit, outside this repository) | nothing in this repo; listed so the set is complete |

W3 (script edits in the undo history, a design change) is the one row still pending. The ledger is deliberately over-complete rather than tidy.

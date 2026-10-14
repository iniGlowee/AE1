# samples/ — the shipped sample projects, kept pristine

Each folder here is the **shipped** copy of a sample project, with its `.ae1proj` beside it. Your working copy
lives in `projects/` and is yours to change; this folder is what the editor reads when you ask for something
back:

- **Restore default script** (the script pane) reads `samples/<sample>/scripts/<file>`.
- **Restore sample** (the workspace toolbar, only in the sample project itself) resets `projects/<slug>` to the
  folder here, after a confirm that lists what would be lost and offers to save a copy first.
- **Save as** records `basedOn` in the copy, so the copy can still restore a shipped script.

Do not edit these by hand to change a sample; change the sample in `projects/`, then copy it over here in the
same commit, so the shipped copy and the starting copy never drift.

# Contributing to AE1

AE1 is built to be understood and extended — by people, and by people working with
AI coding assistants. Contributions of every size are welcome, at your own pace.

## Ground rules

1. **No proprietary assets, ever.** Nothing extracted from a commercial game may be
   committed — models, textures, animations, audio, data tables, or sprites. Original
   or openly-licensed assets only. Engine *techniques* are welcome; someone else's
   *content* is not.
2. **Verify in Play.** Every engine change is checked in the editor's Play mode (and
   in a Build & Ship export when it touches the exporter or runtime) before it's done.
   Say what you verified in the PR.
3. **Read the docs first.** `docs/engine/01-architecture.md`, then
   `docs/engine/05-lessons.md` — the lessons exist so the same mistakes aren't made
   twice. `DESIGN.md` is the decision record (the *why*); cite it by section.
4. **Keep the base elements generic.** New reusable behaviour belongs in `engine/` as
   an opt-in base element; game-specific logic belongs in a project's `scripts/`.
5. **Match the surrounding code** — comment density, naming, idiom.

## How to contribute

- Open an issue for anything larger than a small fix so the approach can be agreed.
- Fork, branch, make the change, verify it, open a PR describing what and why.
- Documentation and examples are first-class contributions.

## Licensing

By contributing you agree your contribution is licensed under the repository's MIT
license.

## Cutting a release

An alpha sync goes **version change first, tag second**: a tag that asserts a version must point at a commit where the assertion is true. Move `ENGINE_VERSION` in `server.py` (it lands in `/api/status`, the `Server` header and every project file's `engineVersion`), add the CHANGELOG entry for what the tag will carry, commit, and only then cut the annotated tag on that commit and push the tag. A tag cut first and "fixed" by later commits names a release that does not contain its own version — v0.2.0-alpha was cut that way, which is why v0.2.1-alpha exists. Existing tags are never moved or deleted.

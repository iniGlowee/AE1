# 21 — The AE1 Game Package (AGP) format

*Spec, v1. The target-neutral container that holds everything that makes a
game THAT game — read identically by the browser build and by a future
native runtime. Introduced §18.88 (the aepack binary), formalized here with
`Build & Ship → target`.*

## Why

The browser `index.html` is a *browser artifact*: base64 payloads, an
inlined ES-module graph, an HTML boot shell. None of that is the game — it
is one way to *run* the game. The AGP separates the game (data + assets)
from any runtime, so the exporter can aim the same project at different
targets:

```
                    ┌─ target: browser ─► index.html + play.html + game.aepack + media/
project ──► build ──┤
                    └─ target: agp ─────► manifest.json + data.json + game.aepack
```

Both targets emit the identical `game.aepack`. That is the point: one
payload format, one integrity story, two runtimes.

## The package (target: agp)

A directory (zippable) containing exactly three files, plus `source/` for
readability:

```
<game>-agp/
  manifest.json     the entry point
  data.json         the game definition (no binaries)
  game.aepack       the binary payload
  source/           readable scenes + scripts (not required to run)
```

### manifest.json — the entry point

```json
{
  "agpVersion": 1,
  "engine": "1.0.0-alpha",
  "game": { "id": "...", "title": "Dev Room", "version": "0.1.0",
            "entryScene": "scene-1.json" },
  "data":    { "file": "data.json",   "bytes": 12345, "sha256": "..." },
  "payload": { "file": "game.aepack", "bytes": 987654321, "sha256": "...",
               "assets": 39 }
}
```

A reader validates `agpVersion`, then loads `data.json` and `game.aepack`,
checking each against its `sha256`. `entryScene` names where play begins.

### data.json — the game definition

The same object the browser build embeds as `<script id="ae1-data">`, minus
the binary bags. Keys:

- `gameId`, `title`, `version`, `engine` — identity.
- `width`, `height` — the design resolution.
- `entryScene` — the scene to start in.
- `scenes` — `{ "<name>.json": {id, name, elements{…}} }`. Elements carry
  transform, components (model/sprite/…), dat overrides, script name.
- `scripts` — `{ "<name>.ags.txt": "<source>" }`. AngelScript = a dat
  header + a JS body; the runtime compiles it (browser: at boot; native:
  the embedded JS engine hosts it unmodified — docs/engine/20).
- `hud` — the HUD element tree.
- `media` — the index: `{ "<sha>": {name, ext, kind, size, …} }`, mapping a
  content hash to the friendly name a script resolves (`playSound("x.mp3")`
  → hash → payload entry by name). Trimmed to shipped assets only.

### game.aepack — the binary payload

```
offset 0   : u32  magic         'AEPK'  (0x4145504B, little-endian)
offset 4   : u32  agpVersion     1
offset 8   : u32  tocLength      bytes of the TOC JSON that follows
offset 12  : TOC  (UTF-8 JSON)   { "agpVersion":1, "entries":[ … ] }
offset 12+tocLength : payloads   raw asset bytes, each 8-byte aligned
```

Each TOC entry:

```json
{ "name": "hero.glb", "bag": "glbs", "offset": 0, "length": 12245320,
  "sha256": "…" }
```

- `bag` is `"glbs"` (models, textures-in-glb, hdr, audio) or `"bins"`
  (motion-matching database packs). The runtime routes by bag the same way
  `game3d.js` does.
- `offset` is relative to the first payload byte (i.e. after the TOC).
- Assets already carry the §18.87–94 diet: KTX2 textures, meshopt geometry,
  128k MP3 audio, int16 pose streams. The pack is the *finished* payload.

A native runtime `mmap`s the file, reads the TOC once, and hands each asset
a zero-copy `(ptr, length)` — the same views `game3d.js` builds as
`Uint8Array(buf, base+offset, length)` from a fetched pack.

## How the browser target uses the same pack

`play.html` (the slim web build) `fetch`es `game.aepack`, parses the TOC,
and hands `Uint8Array` views straight to the loaders — no base64, no string
copies (§18.88). `index.html` (the file:// double-click build) instead
inlines the payloads as base64 `<script>` blocks, because `file://` cannot
`fetch`. Both decode to the same bytes.

## Building one

- Editor / API: `POST /api/projects/<slug>/export` with body
  `{"target": "agp"}` (or `"browser"`, the default). A non-browser target
  writes a separate folder `exports/<slug>-agp/` so targets never clobber.
- AGP is 3D-only (a 2D game has no binary payload); requesting it for a 2D
  project warns and builds the browser target instead.
- The exporter functions: `build_aepack(glb_blobs, bin_blobs) → (bytes, toc)`
  and `write_agp(out_dir, data, glb_blobs, bin_blobs, version)` in
  `exporter.py`. Both targets call `build_aepack`, guaranteeing byte-identical
  payloads.

## Versioning

`agpVersion` appears in three places (manifest, data-pack TOC, aepack
header) and they must agree. Bump it only for a breaking layout change;
add optional fields freely within a version. A reader must refuse a version
it does not understand rather than guess.

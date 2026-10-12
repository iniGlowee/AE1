# Vendored third-party code

## quickjs-ng 0.16.2  (`quickjs-0.16.2/`)

- **What:** the QuickJS-ng JavaScript engine — the small, embeddable JS engine
  the native player hosts so AE1 game scripts run unmodified (docs/engine/20).
- **Source:** https://github.com/quickjs-ng/quickjs — release tag `v0.16.2`
  (published 2026-08-20), the source zip from
  `.../archive/refs/tags/v0.16.2.zip`.
- **Why quickjs-ng, not Bellard's original:** the -ng fork actually builds on
  MSVC, which the original does not.
- **Library source set** (from its CMakeLists `qjs_sources`): `dtoa.c`,
  `libregexp.c`, `libunicode.c`, `quickjs.c` (+ their headers). `build.bat`
  compiles just these into `build/qjs.lib`. The rest of the tree
  (qjs.c CLI, quickjs-libc, tests, docs) is kept for reference but unused.

### AE1 LOCAL PATCH — re-apply if re-vendored

One edit to `quickjs.c`, marked `===== AE1 LOCAL PATCH =====` near line 72:
the include of `quickjs-c-atomics.h` and `#define CONFIG_ATOMICS` gained an
`&& !defined(AE1_NO_ATOMICS)` guard. `build.bat` passes `/D AE1_NO_ATOMICS`.

**Why:** quickjs uses C11 `<stdatomic.h>` ONLY in the JS Atomics/SharedArrayBuffer
builtin. VS2019 / MSVC 14.29 ships no `<stdatomic.h>` (that needs VS2022 17.5's
`/experimental:c11atomics`). AE1's native player hosts JS single-threaded and
never uses SharedArrayBuffer, so we compile the feature out instead of shimming
atomics. On VS2022 17.5+ you can drop the guard and the flag and keep Atomics.

Nothing else in the vendored source is modified.

## meshoptimizer 1.2  (`meshoptimizer/`)

- **What:** the decoder half of meshoptimizer — used to decode
  `EXT_meshopt_compression` bufferViews in the pack's GLBs (the same codec
  gltfpack produced at export). No encoder, no optimizer.
- **Source:** https://github.com/zeux/meshoptimizer — tag `v1.2` (2026-06-30).
  Four files from `src/`: `meshoptimizer.h`, `vertexcodec.cpp`, `indexcodec.cpp`,
  `vertexfilter.cpp`, plus `LICENSE.md`.
- **No patches.** Compiled straight into `ae1player` by `build.bat`.
- Decode entry points used: `meshopt_decodeVertexBuffer`,
  `meshopt_decodeIndexBuffer`, `meshopt_decodeIndexSequence`, and the filters
  `meshopt_decodeFilterOct` / `Quat` / `Exp`.

## Basis Universal transcoder 2_50  (`basis/`)

- **What:** the transcoder half of Binomial's Basis Universal — decodes the
  pack's KTX2 (`KHR_texture_basisu`) base-color textures to RGBA8. No encoder.
- **Source:** https://github.com/BinomialLLC/basis_universal — tag `v2_50`
  (2026-08-03), the entire `transcoder/` directory (`basisu_transcoder.cpp` +
  its headers and `.inc`/`.inl` tables) plus `LICENSE`.
- **No patches.** `build.bat` compiles `basisu_transcoder.cpp` once into a cached
  `build/basis.lib` with `BASISD_SUPPORT_KTX2=1` and `BASISD_SUPPORT_KTX2_ZSTD=0`
  — the base-color maps are ETC1S/UASTC without zstd supercompression, so the
  zstd dependency is left out. (Add it back if a zstd'd texture needs decoding.)
- Transcodes level 0 to `cTFRGBA32` via `basist::ktx2_transcoder`.

## stb_image 2.30  (`stb/stb_image.h`)

- **What:** single-header PNG/JPEG decoder — for pack images kept as PNG (the
  §18.96 soft-alpha cutouts) that the KTX2 path doesn't cover.
- **Source:** https://github.com/nothings/stb — `stb_image.h` (public domain).
- **No patches.** `tex.cpp` defines `STB_IMAGE_IMPLEMENTATION` + `STBI_ONLY_PNG`/
  `STBI_ONLY_JPEG` + `STBI_ONLY_HDR` (skybox) + `STBI_NO_STDIO`, decodes to RGBA8
  (`decodeImage`) and float RGB (`decodeHDR`, the equirect skybox).

## stb_truetype 1.26  (`stb/stb_truetype.h`)

- **What:** single-header TrueType rasterizer — bakes the dialogue TTF
  (`ps2_helvetica.ttf`) into a glyph atlas for the native 2D UI text overlay.
- **Source:** https://github.com/nothings/stb — `stb_truetype.h` (public domain).
- **No patches.** `tex.cpp` defines `STB_TRUETYPE_IMPLEMENTATION`; `bakeFont`
  uses `stbtt_BakeFontBitmap` → an R8 coverage atlas expanded to RGBA.

## miniaudio 0.11.25  (`miniaudio/miniaudio.h`)

- **What:** single-header audio playback + decoding (MP3/WAV/FLAC built in). The
  native audio seam — plays the pack's transcoded MP3s from memory.
- **Source:** https://github.com/mackron/miniaudio — `miniaudio.h` (public domain).
- **No patches.** `ma_impl.c` (`#define MA_IMPLEMENTATION`) compiles once into a
  cached `build/miniaudio.lib`; `audio.cpp` includes the header (declarations)
  and links it. Windows WASAPI needs `ole32.lib` (pragma in audio.cpp).

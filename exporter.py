"""AE1 - build & ship.

Turns a project into a self-contained folder in /exports/<slug>/ that can be
dropped on any web host OR opened by double-clicking index.html.

That second requirement drives the whole design. A file:// page cannot fetch()
its own scenes and cannot load ES modules -- both are blocked by the origin
rules. So the export inlines the engine, the scenes, and the scripts into
index.html as one classic script, and leaves media as loose files, because
<img src> is one of the few things file:// still permits. (Those images taint
the canvas; that costs nothing, since the game never reads pixels back.)

Output is deliberately READABLE -- no minification, no name mangling, scenes as
JSON, scripts as text (DESIGN.md Principle 3). Mods are encouraged, and gzip on
the host recovers most of what minification would have.
"""

from __future__ import annotations

import base64
import hashlib
import json
import posixpath
import re
import shutil
from pathlib import Path
from typing import Any, Callable

#: Concatenation order. Hand-maintained because it IS the dependency graph, and a
#: 20-line topological sort over a list this size would hide it rather than help.
#: A wrong order fails loudly at boot, not subtly.
ENGINE_MODULES = [
    "element.js",
    "media.js",
    "gesture.js",
    "hud.js",
    "savehandler.js",
    "text.js",
    "button.js",
    "video.js",
    # After renderer.js would read better, but a class declaration is not hoisted:
    # `class AE1Sprite extends AE1Element` evaluates in source order, so element.js
    # must already have run. It only CALLS renderer.js's frameGrid, and function
    # declarations are hoisted, so this order is safe in the one direction it must be.
    "sprite.js",
    # Same reason as sprite.js: AE1DialogueBox extends AE1Text, so text.js and
    # button.js must already have run. world.js imports it, and world.js is later.
    "dialogue.js",
    "model3d.js",
    # After model3d.js: AE1ThirdPersonCharacter extends AE1Model (class
    # declarations evaluate in source order). input.js is pure DOM, no deps.
    # hitbox.js before thirdperson.js: the character imports AE1Hitbox.
    "input.js",
    "hitbox.js",
    "thirdperson.js",
    # After thirdperson.js: AE1Projectile and AE1NPC import its quat kit,
    # AE1PassiveDialogue its character class. passivedialogue.js BEFORE
    # npc.js: AE1NPC extends AE1PassiveDialogue (§18.21).
    "projectile.js",
    "passivedialogue.js",
    "npc.js",
    "skybox.js",
    "ambience.js",
    "musicbus.js",
    "audiovolumes.js",
    "particles.js",
    "scatter.js",
    "perspectivecamera.js",
    "scene.js",
    "ags/reader.js",
    "ags/compiler.js",
    "ags/runtime.js",
    "audio.js",
    "save.js",
    "settings.js",
    "world.js",
    "loop.js",
    "renderer.js",
    "game.js",
]

IMPORT_RE = re.compile(r"^\s*import\s+.*?from\s+['\"].*?['\"];?\s*$", re.MULTILINE)
EXPORT_RE = re.compile(r"^export\s+(?=(?:default\s+)?(?:const|let|var|function|class|async))", re.MULTILINE)
EXPORT_LIST_RE = re.compile(r"^export\s*\{[^}]*\};?\s*$", re.MULTILINE)

#: Top-level declarations, for the collision check below.
DECL_RE = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


#: Content-addressed media filenames. Used to tell a hash from an authored name.
HASH_RE = re.compile(r"[0-9a-f]{8,}")


class ExportError(Exception):
    pass


def bundle_engine(engine_dir: Path) -> str:
    """Concatenate the engine's ES modules into one classic script.

    Strips `import` lines and the `export` keyword, then joins in dependency
    order. This works only because AE1 owns every module here and keeps them to
    single-line named imports -- it is a concatenator for a known input, not a
    general bundler, and it should never be pointed at third-party code.

    Nothing is wrapped in an IIFE, so every engine symbol lands in global scope.
    That is intentional: a modder in the devtools console of a shipped game wants
    AE1Element and the compiler in reach (Principle 3).
    """
    # Every engine module must be listed, and the list is hand-maintained -- so
    # the one mistake it invites is adding a file and forgetting to add it here.
    #
    # That failure is silent and total: the module simply is not in the bundle,
    # while everything REFERRING to it still is. Adding sprite.js and forgetting
    # this line shipped a build whose BUILTINS table named AE1Sprite, a class that
    # did not exist -- a ReferenceError on load, a black page, and an export that
    # reported success with no warnings. The editor was fine, because the editor
    # loads real modules. Exactly the export-only break Principle 2 exists to
    # forbid, and precisely the class of bug this file already guards against
    # everywhere else (collect_name_refs, the staged swap).
    #
    # Order still has to be thought about; membership does not.
    #
    # `vendor/` and `three3d/` are exempt. `vendor/` is third-party three.js;
    # `three3d/` is AE1's own 3D renderer, which IMPORTS three — both stay real ES
    # modules (stripping their import/export here would shred them). The editor
    # loads them via its import map; a shipped 3D game gets them through
    # bundle_modules_3d's inlined blob graph (§18.8) — never this classic bundle.
    _EXEMPT = ("vendor/", "three3d/")
    on_disk = {
        rel.as_posix()
        for p in engine_dir.rglob("*.js")
        if not (rel := p.relative_to(engine_dir)).as_posix().startswith(_EXEMPT)
    }
    unlisted = sorted(on_disk - set(ENGINE_MODULES))
    if unlisted:
        raise ExportError(
            f"Engine module(s) not in ENGINE_MODULES: {', '.join(unlisted)}. "
            f"Add them in dependency order -- an unlisted module is silently "
            f"absent from every shipped game."
        )

    parts: list[str] = []
    seen: dict[str, str] = {}

    for rel in ENGINE_MODULES:
        path = engine_dir / rel
        if not path.is_file():
            raise ExportError(f"Engine module missing: {rel}")

        src = path.read_text(encoding="utf-8")

        # A name defined twice would silently shadow once concatenated, and the
        # symptom would be a baffling runtime bug far from the cause. Refuse.
        for name in DECL_RE.findall(src):
            if name in seen and seen[name] != rel:
                raise ExportError(
                    f"Bundle collision: '{name}' is declared in both {seen[name]} and {rel}. "
                    f"Rename one — concatenated modules share one scope."
                )
            seen[name] = rel

        src = IMPORT_RE.sub("", src)
        src = EXPORT_LIST_RE.sub("", src)
        src = EXPORT_RE.sub("", src)

        parts.append(f"/* ===== engine/{rel} ===== */\n{src.strip()}\n")

    return "\n".join(parts)


#: Matches the `from '<specifier>'` part of any static import or re-export.
#: Multi-line imports (three's are hundreds of names long) still end in a
#: single-line `} from 'three';`, so this needs no multiline handling.
_ESM_FROM_RE = re.compile(r"""from\s*(['"])([^'"\n]+)\1""")

#: Where a 3D game's ES-module graph starts.
_ESM_ENTRY = "three3d/game3d.js"


def _resolve_esm_spec(spec: str, importer: str) -> str | None:
    """Import specifier -> engine-relative posix path, or None to ignore.

    None is not an error: the `from`-regex also catches prose in comments
    (GLTFLoader's docs contain `loaded from 'https://…'` and
    `from '../textures/texture.png'`), so anything that is neither a known bare
    name nor a relative .js path is deliberately dropped, not rejected.
    """
    if spec == "three":
        return "vendor/three/three.module.js"
    if spec.startswith("three/addons/"):
        return "vendor/three/addons/" + spec[len("three/addons/"):]
    if spec.startswith(".") and spec.endswith(".js"):
        return posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))
    return None


def bundle_modules_3d(engine_dir: Path, entry: str = _ESM_ENTRY) -> dict[str, Any]:
    """Collect the ES-module graph a 3D game imports, in dependency order.

    The 3D counterpart of bundle_engine. It cannot concatenate (three.js is real
    third-party ESM — stripping its imports would shred it), so instead it ships
    every module's SOURCE plus its import edges, and index.html turns them into
    Blob URLs at boot, rewriting each `from 'spec'` to the dependency's blob:
    URL, leaves first. Chromium refuses to fetch module FILES on file://, but it
    runs inline module scripts and imports blob: URLs fine — that loophole is
    what keeps the double-click promise for 3D (DESIGN.md §18.8).

    Discovery is the same regex-not-AST tradeoff as bundle_engine, with three
    guards for three.js's doc comments: non-.js relative paths are prose, a
    module's reference to itself is its own usage example, and a specifier whose
    file does not exist is prose too (each addon documents its own import line).
    """
    modules: dict[str, str] = {}
    deps: dict[str, list[list[str]]] = {}
    order: list[str] = []
    state: dict[str, int] = {}  # 1 = visiting, 2 = done

    def visit(name: str) -> None:
        if state.get(name) == 2:
            return
        if state.get(name) == 1:
            raise ExportError(f"3D bundle: import cycle through {name}.")
        state[name] = 1

        path = engine_dir / name
        if not path.is_file():
            raise ExportError(f"3D bundle: missing module engine/{name}.")
        src = path.read_text(encoding="utf-8")
        modules[name] = src

        edges: list[list[str]] = []
        for _quote, spec in _ESM_FROM_RE.findall(src):
            dep = _resolve_esm_spec(spec, name)
            if not dep or dep == name or not (engine_dir / dep).is_file():
                continue
            if [spec, dep] not in edges:
                edges.append([spec, dep])
        for _spec, dep in edges:
            visit(dep)

        deps[name] = edges
        order.append(name)
        state[name] = 2

    visit(entry)
    return {"entry": entry, "order": order, "deps": deps, "modules": modules}


def meshopt_pack(gltfpack: str, blob: bytes) -> bytes | None:
    """§18.92 — geometry compression via gltfpack (meshopt + quantization).

    Runs AFTER the texture diet, so KTX2 images are already embedded;
    gltfpack passes textures through untouched (no -tc). Flags chosen for
    AE1's binding model: -kn keeps NODE NAMES (elements bind by node name —
    pruning/renaming them unbinds the character), -km keeps materials,
    -ke keeps extras, -kv keeps the full vertex layout so skinning/UVs
    survive. Output carries EXT_meshopt_compression; the runtime decoder is
    wired in game3d. Best-effort: any failure returns None (keep input).
    """
    import os  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "in.glb")
            dst = os.path.join(td, "out.glb")
            with open(src, "wb") as fh:
                fh.write(blob)
            r = subprocess.run(
                [gltfpack, "-i", src, "-o", dst, "-cc", "-kn", "-km", "-ke"],
                capture_output=True, timeout=600)
            if r.returncode != 0 or not os.path.exists(dst):
                return None
            with open(dst, "rb") as fh:
                out = fh.read()
            return out if 0 < len(out) < len(blob) else None
    except Exception:  # noqa: BLE001 — best-effort by contract
        return None


def transcode_audio(ffmpeg: str, blob: bytes, ext: str, kbps: int = 128) -> bytes | None:
    """§18.91 — audio to 128k CBR MP3, or None (keep original).

    MP3 is the one container every browser plays from an <audio> data URL
    with no MIME guessing, and the runtime already resolves .mp3. A 167 MB
    WAV becomes ~3 MB; an already-128k MP3 won't shrink and is kept. Any
    ffmpeg complaint returns None. Best-effort, exactly like the texture diet.
    """
    import os  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, f"in.{ext}")
            dst = os.path.join(td, "out.mp3")
            with open(src, "wb") as fh:
                fh.write(blob)
            r = subprocess.run(
                [ffmpeg, "-y", "-i", src, "-vn", "-c:a", "libmp3lame",
                 "-b:a", f"{kbps}k", dst],
                capture_output=True, timeout=600)
            if r.returncode != 0 or not os.path.exists(dst):
                return None
            with open(dst, "rb") as fh:
                return fh.read()
    except Exception:  # noqa: BLE001 — best-effort by contract
        return None


def _encode_ktx2(encoder: str, im, srgb: bool, uastc: bool) -> bytes | None:
    """§18.89 — one PIL image through toktx into a mipmapped KTX2, or None.

    ETC1S for color (tiny files, 4x-compressed VRAM); UASTC for normal maps
    (block artifacts on normals shade wrong — UASTC is the data-safe tier).
    Any encoder complaint returns None and the caller falls back to JPEG/PNG.
    """
    import os  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "in.png")
            dst = os.path.join(td, "out.ktx2")
            save = im if im.mode in ("RGB", "RGBA", "L", "LA") else im.convert("RGBA")
            save.save(src, "PNG")
            args = [encoder, "--t2", "--genmipmap",
                    "--assign_oetf", "srgb" if srgb else "linear"]
            if uastc:
                args += ["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18"]
            else:
                args += ["--encode", "etc1s", "--clevel", "2", "--qlevel", "160"]
            args += [dst, src]
            r = subprocess.run(args, capture_output=True, timeout=600)
            if r.returncode != 0 or not os.path.exists(dst):
                return None
            with open(dst, "rb") as fh:
                return fh.read()
    except Exception:  # noqa: BLE001 — best-effort by contract
        return None


def optimize_glb_textures(blob: bytes, max_dim: int = 2048, jpeg_q: int = 88,
                          encoder: str | None = None) -> tuple[bytes, str]:
    """§18.87 — the texture half of a glb, put on a diet, best-effort.

    Measured on the shipped character: hero.glb was 167 MB of which 94% was
    embedded PNG (one 5792² map + four 4096²) costing ~550 MB of VRAM once
    decoded — the classic multi-frame-stutter signature on ≤6 GB GPUs.
    Three passes, all inside the glb, no runtime change required:

      1. DEDUP: byte-identical images (the NAME / NAME.dds double-embed the
         bakes ship) collapse to one — the loader was decoding and uploading
         both.
      2. DOWNSCALE: any image over `max_dim` on a side is Lanczos-resized to
         fit. the reference action game itself shipped 1-2k; the 5792 is an upscale.
      3. RE-ENCODE: opaque baseColor/emissive PNGs become JPEG (q88) — a
         4096² albedo drops ~24 MB → ~2.5 MB. Normal / metallicRoughness /
         occlusion maps and anything with a live alpha channel stay PNG
         (JPEG artifacts corrupt data maps and alpha is JPEG-impossible).

    Same contract as strip_glb_to_clips: any surprise returns the ORIGINAL
    bytes — a fat build beats a broken one. Opt out per-asset with a
    `rawTextures` flag on the media entry.
    """
    import hashlib  # noqa: PLC0415
    import io  # noqa: PLC0415
    import struct  # noqa: PLC0415

    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return blob, "Pillow unavailable"
    try:
        magic, _ver, _total = struct.unpack_from("<III", blob, 0)
        if magic != 0x46546C67:
            return blob, "not glb"
        off = 12
        gjson = None
        gbin = b""
        while off + 8 <= len(blob):
            clen, ctype = struct.unpack_from("<II", blob, off)
            payload = blob[off + 8 : off + 8 + clen]
            if ctype == 0x4E4F534A:
                gjson = json.loads(payload.decode("utf-8"))
            elif ctype == 0x004E4942:
                gbin = payload
            off += 8 + clen
        images = gjson.get("images") if gjson else None
        if not images:
            return blob, "no images"
        views = gjson["bufferViews"]

        # which image indices feed DATA slots (never JPEG those); normals
        # separately — §18.89 gives them the UASTC tier under KTX2.
        # §18.96 CUTOUT images: the baseColor of a hair/eyelash/feather
        # material carries a HARD alphaTest cutout (§18.86). ANY block
        # compression — even UASTC — leaves enough alpha error at the
        # threshold to punch holes in the strands (Austin: "spotty, holes").
        # These keep their original PNG (downscale-capped, never re-encoded to
        # KTX2/JPEG) so the cutout stays exactly as authored.
        data_imgs: set[int] = set()
        normal_imgs: set[int] = set()
        cutout_imgs: set[int] = set()
        srcs = gjson.get("textures", [])

        def _src_of(slot):
            if slot and "index" in slot and slot["index"] < len(srcs):
                return srcs[slot["index"]].get("source")
            return None

        for mat in gjson.get("materials", []):
            pbr = mat.get("pbrMetallicRoughness", {})
            nslot = mat.get("normalTexture")
            ns = _src_of(nslot)
            if ns is not None:
                normal_imgs.add(ns)
            for slot in (nslot, mat.get("occlusionTexture"),
                         pbr.get("metallicRoughnessTexture")):
                s = _src_of(slot)
                if s is not None:
                    data_imgs.add(s)
            if re.search(r"hair|lash|feather", str(mat.get("name") or ""), re.I):
                bs = _src_of(pbr.get("baseColorTexture"))
                if bs is not None:
                    cutout_imgs.add(bs)

        def img_bytes(idx):
            v = views[images[idx]["bufferView"]]
            start = v.get("byteOffset", 0)
            return gbin[start : start + v["byteLength"]]

        # pass 1 — dedup by content hash
        by_hash: dict[str, int] = {}
        remap: dict[int, int] = {}
        for i in range(len(images)):
            if "bufferView" not in images[i]:
                return blob, "external image"
            h = hashlib.md5(img_bytes(i)).hexdigest()
            if h in by_hash:
                remap[i] = by_hash[h]
                if by_hash[h] in data_imgs:
                    data_imgs.add(i)
                if i in data_imgs:
                    data_imgs.add(by_hash[h])
            else:
                by_hash[h] = i
        if remap:
            for t in srcs:
                if t.get("source") in remap:
                    t["source"] = remap[t["source"]]

        # passes 2+3 — per surviving image
        new_payloads: dict[int, tuple[bytes, str]] = {}
        ktx2_imgs: set[int] = set()
        for i in set(by_hash.values()):
            raw = img_bytes(i)
            try:
                im = Image.open(io.BytesIO(raw))
                im.load()
            except OSError:
                continue
            changed = False
            if max(im.size) > max_dim:
                scale = max_dim / max(im.size)
                im = im.resize((max(1, round(im.width * scale)),
                                max(1, round(im.height * scale))), Image.LANCZOS)
                changed = True
            has_alpha = (im.mode in ("RGBA", "LA", "PA")
                         and im.getextrema()[-1][0] < 255)
            # §18.89 KTX2 first: stays block-compressed ON THE GPU (~4x less
            # VRAM than a decoded PNG/JPEG of the same pixels). ETC1S for
            # opaque color; UASTC for normals AND anything with a live alpha
            # channel — §18.95: ETC1S's alpha slice is far too lossy for a
            # HARD CUTOUT (the player character's hair MASK went to speckled holes), UASTC keeps
            # it clean. §18.96: a hair/lash CUTOUT texture skips KTX2 entirely
            # (even UASTC's alpha error holes the strands) — kept as PNG below.
            if encoder is not None and i not in cutout_imgs:
                k = _encode_ktx2(encoder, im,
                                 srgb=i not in data_imgs,
                                 uastc=(i in normal_imgs) or has_alpha)
                if k is not None:
                    new_payloads[i] = (k, "image/ktx2")
                    ktx2_imgs.add(i)
                    continue
            out = io.BytesIO()
            if i not in data_imgs and not has_alpha:
                im.convert("RGB").save(out, "JPEG", quality=jpeg_q, optimize=True)
                mime = "image/jpeg"
            else:
                im.save(out, "PNG", optimize=True)
                mime = "image/png"
                if not changed and out.tell() >= len(raw):
                    continue  # PNG re-encode gained nothing
            if out.tell() < len(raw) or changed:
                new_payloads[i] = (out.getvalue(), mime)

        if not new_payloads and not remap:
            return blob, "already lean"

        # §18.89: textures whose image went KTX2 gain the KHR_texture_basisu
        # extension (the loader routes them through the transcoder).
        if ktx2_imgs:
            for t in srcs:
                s = t.get("source")
                if s is not None and s in ktx2_imgs:
                    t.setdefault("extensions", {})["KHR_texture_basisu"] = {"source": s}
            used = set(gjson.get("extensionsUsed", []))
            used.add("KHR_texture_basisu")
            gjson["extensionsUsed"] = sorted(used)
            req = set(gjson.get("extensionsRequired", []))
            req.add("KHR_texture_basisu")
            gjson["extensionsRequired"] = sorted(req)

        # rebuild the BIN: copy every view, swapping image payloads; orphaned
        # duplicate-image views are simply not copied.
        dead_views = {images[i]["bufferView"] for i in remap}
        new_bin = bytearray()
        for vi, v in enumerate(views):
            if vi in dead_views:
                v["byteOffset"] = 0
                v["byteLength"] = 0
                continue
            owner = next((i for i in range(len(images))
                          if images[i].get("bufferView") == vi), None)
            if owner is not None and owner in new_payloads:
                data = new_payloads[owner][0]
                images[owner]["mimeType"] = new_payloads[owner][1]
            else:
                start = v.get("byteOffset", 0)
                data = gbin[start : start + v["byteLength"]]
            while len(new_bin) % 4:
                new_bin.append(0)
            v["byteOffset"] = len(new_bin)
            v["byteLength"] = len(data)
            new_bin.extend(data)
        for i, tgt in remap.items():
            images[i] = dict(images[tgt])  # keep indices valid, share the view
        gjson["buffers"][0]["byteLength"] = len(new_bin)

        js = json.dumps(gjson, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        while len(new_bin) % 4:
            new_bin.append(0)
        out_blob = struct.pack("<III", 0x46546C67, 2,
                               12 + 8 + len(js) + 8 + len(new_bin))
        out_blob += struct.pack("<II", len(js), 0x4E4F534A) + js
        out_blob += struct.pack("<II", len(new_bin), 0x004E4942) + bytes(new_bin)
        note = f"{len(remap)} deduped, {len(new_payloads)} recoded"
        if ktx2_imgs:
            note += f", {len(ktx2_imgs)} KTX2"
        return out_blob, note
    except Exception as exc:  # noqa: BLE001 — best-effort by contract
        return blob, f"skipped ({exc})"


def strip_glb_to_clips(blob: bytes) -> bytes:
    """A .glb reduced to its ANIMATION DATA: node graph + clips, nothing else.

    An animOnly library (DESIGN.md §18.10) contributes clips; its meshes,
    textures, materials and skins are dead weight — and at 175 MB per Mixamo
    export, SEVEN of them pushed index.html to 1.89 GB, past V8's ~1 GiB string
    cap: JSON.parse could not even materialise the data and a double-clicked
    build died before boot. Stripped, each library is a few hundred KB.

    Node INDICES are preserved (animation channels target nodes by index, so
    the whole nodes array stays, minus mesh/skin/camera refs); accessors and
    bufferViews are re-packed to only what the samplers touch; GLTFLoader
    loads the result as a scene of empty named nodes plus clips, and the
    renderer binds those clips to the real character by track NAME.

    Best-effort by contract: anything unexpected returns the ORIGINAL bytes —
    a fat build beats a broken one.
    """
    import struct  # noqa: PLC0415 — used only here

    try:
        magic, _ver, _total = struct.unpack_from("<III", blob, 0)
        if magic != 0x46546C67:  # 'glTF'
            return blob
        # chunks: uint32 length, uint32 type, payload
        off = 12
        gjson = None
        gbin = b""
        while off + 8 <= len(blob):
            clen, ctype = struct.unpack_from("<II", blob, off)
            payload = blob[off + 8 : off + 8 + clen]
            if ctype == 0x4E4F534A:  # 'JSON'
                gjson = json.loads(payload.decode("utf-8"))
            elif ctype == 0x004E4942:  # 'BIN\0'
                gbin = payload
            off += 8 + clen
        if not gjson or not gjson.get("animations"):
            return blob

        # Accessors the animations touch (sparse would need more care: bail).
        acc_ids: list[int] = []
        for anim in gjson["animations"]:
            for s in anim.get("samplers", []):
                for k in ("input", "output"):
                    if s.get(k) is not None and s[k] not in acc_ids:
                        acc_ids.append(s[k])
        acc_ids.sort()
        old_accessors = gjson.get("accessors", [])
        if any("sparse" in old_accessors[i] or "bufferView" not in old_accessors[i] for i in acc_ids):
            return blob

        # Their bufferViews, re-packed into a fresh BIN.
        bv_map: dict[int, int] = {}
        new_views = []
        new_bin = bytearray()
        for i in acc_ids:
            bv = old_accessors[i]["bufferView"]
            if bv in bv_map:
                continue
            ov = gjson["bufferViews"][bv]
            start = ov.get("byteOffset", 0)
            chunk = bytes(gbin[start : start + ov["byteLength"]])
            while len(new_bin) % 4:
                new_bin.append(0)
            bv_map[bv] = len(new_views)
            new_views.append({"buffer": 0, "byteOffset": len(new_bin), "byteLength": len(chunk)})
            new_bin.extend(chunk)

        acc_map = {old: new for new, old in enumerate(acc_ids)}
        new_accessors = []
        for i in acc_ids:
            a = dict(old_accessors[i])
            a["bufferView"] = bv_map[a["bufferView"]]
            new_accessors.append(a)

        new_anims = []
        for anim in gjson["animations"]:
            new_anims.append(
                {
                    **{k: v for k, v in anim.items() if k in ("name",)},
                    "samplers": [
                        {**s, "input": acc_map[s["input"]], "output": acc_map[s["output"]]}
                        for s in anim["samplers"]
                    ],
                    "channels": anim["channels"],  # node targets: indices preserved
                }
            )

        nodes = [
            {k: v for k, v in n.items() if k not in ("mesh", "skin", "camera")}
            for n in gjson.get("nodes", [])
        ]

        out_json = {
            "asset": {"version": "2.0", "generator": "AE1 clip-strip"},
            "scene": gjson.get("scene", 0),
            "scenes": gjson.get("scenes", [{"nodes": []}]),
            "nodes": nodes,
            "animations": new_anims,
            "accessors": new_accessors,
            "bufferViews": new_views,
            "buffers": [{"byteLength": len(new_bin)}],
        }

        jpay = json.dumps(out_json, separators=(",", ":")).encode("utf-8")
        jpay += b" " * (-len(jpay) % 4)  # JSON chunks pad with spaces
        bpay = bytes(new_bin) + b"\x00" * (-len(new_bin) % 4)
        total = 12 + 8 + len(jpay) + 8 + len(bpay)
        return b"".join(
            [
                struct.pack("<III", 0x46546C67, 2, total),
                struct.pack("<II", len(jpay), 0x4E4F534A),
                jpay,
                struct.pack("<II", len(bpay), 0x004E4942),
                bpay,
            ]
        )
    except Exception:
        return blob


def collect_media_refs(scenes: dict[str, dict], hud: dict, scripts: dict[str, str]) -> set[str]:
    """Every media hash the game could reach.

    Four sources, and missing any one of them prunes an asset the game needs:
      - element sprites, in scenes AND in the persistent HUD
      - element VIDEO components
      - inventory item icons, which are data on the element, not a sprite
      - media referenced BY NAME in Angel Script (playSound "boing.mp3")

    That last one is the subtle one. A sound only ever named in a script has no
    element pointing at it, so a sprite-only sweep would prune it and the game
    would fall silent in the build but not in the editor -- the exact class of
    export-only bug Principle 2 exists to prevent.
    """
    refs: set[str] = set()

    for source in [*scenes.values(), hud]:
        for element in (source.get("elements") or {}).values():
            components = element.get("components") or {}

            for slot in ("sprite", "video"):
                media = (components.get(slot) or {}).get("media")
                if media:
                    refs.add(media)

            # A Video element names its source in dat, not in a component.
            #
            # Only collect it if it LOOKS like a hash. Authored scripts hold a
            # NAME ("intro.mp4"), which collect_name_refs resolves properly --
            # collecting it here as if it were a hash produced a confident
            # "references media intro.mp… which is not imported" warning about an
            # asset that was, in fact, imported and shipped. A warning that cries
            # wolf is worse than no warning.
            if isinstance(element.get("video"), str) and HASH_RE.fullmatch(element["video"]):
                refs.add(element["video"])

            # Inventory items carry icons. But `items` is an ordinary dat key an
            # author may use for ANYTHING -- a hamburger menu declares
            # `(items ("New Game" "Load Game"))`, a list of strings, and calling
            # .get() on those crashed the whole build. dat is author-owned: never
            # assume the shape of a key you did not define.
            items = element.get("items")
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and item.get("icon"):
                        refs.add(item["icon"])

    return refs


# Structural keys the engine owns on every element. Everything else is dat, and
# dat is author-owned -- so a media name can hide in any of it.
_STRUCTURAL_KEYS = frozenset({
    "id", "extends", "parent", "script", "name", "type", "tags",
    "x", "y", "layer", "rotation", "scaleX", "scaleY", "width", "height",
    "visible", "opacity", "flipH", "flipV", "components",
})


def _dat_text(scenes: dict[str, dict], hud: dict) -> str:
    """Every authored string in element dat, as one blob.

    Media gets named in dat, not only in scripts: a tour's background video
    carries `(video "Position_001")` as a per-element dat value so one shared
    script can drive many scenes. That name is invisible to the sprite/hash sweep
    AND to a scripts-only scan, so without this the videos prune to a black build
    that plays fine in the editor -- the export-only break Principle 2 forbids.

    dat is author-owned and any string might be a media name, so every string
    value is fair game. Over-keeping costs bytes; pruning breaks the game.
    """
    parts: list[str] = []

    def walk(v):
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    for source in [*scenes.values(), hud]:
        for element in (source.get("elements") or {}).values():
            for key, value in element.items():
                if key not in _STRUCTURAL_KEYS:
                    walk(value)
            # `components` is structural, but a component VALUE can be a media name:
            # a 3D model component carries `{media: "scene.glb"}`, the glb this
            # element draws. Miss it and the model prunes to an empty 3D scene —
            # the same export-only break as the dat case above. (Sprite/video store
            # hashes here, which no media name matches, so scanning them is a no-op.)
            walk(element.get("components"))
    return "\n".join(parts)


def collect_name_refs(scripts: dict[str, str], scenes: dict[str, dict], hud: dict, entries: dict) -> set[str]:
    """Hashes for assets whose NAME appears in a script OR in element dat.

    Two places name media with no hash pointing at it, and both are invisible to
    the sprite/hash sweep:
      - a script: `playSound("boing.mp3")`
      - element dat: `(video "Position_001")` on a background video

    Deliberately crude -- a substring scan, not a parse. An author can build a
    filename at runtime (`this.sound + ".mp3"`), so no static analysis can be
    complete. Over-keeping an asset costs bytes; wrongly pruning one silently
    breaks the shipped game. The trade is not close.
    """
    refs: set[str] = set()
    blob = "\n".join(scripts.values()) + "\n" + _dat_text(scenes, hud)
    if not blob.strip():
        return refs

    for digest, entry in entries.items():
        name = entry.get("name", "")
        stem = name.rsplit(".", 1)[0]
        if name and (name in blob or (len(stem) > 2 and stem in blob)):
            refs.add(digest)
    return refs


def optimize_image(src: Path, dst: Path) -> tuple[int, bool]:
    """Recompress an image if Pillow is available.

    Best-effort by contract (DESIGN.md §8.4): a missing or failing Pillow makes
    the export LARGER, never broken. Never let this raise.
    """
    try:
        from PIL import Image  # noqa: PLC0415 — optional by design
    except ImportError:
        shutil.copy2(src, dst)
        return dst.stat().st_size, False

    try:
        with Image.open(src) as img:
            if src.suffix.lower() in (".png",):
                img.save(dst, optimize=True)
            elif src.suffix.lower() in (".jpg", ".jpeg"):
                img.save(dst, quality=85, optimize=True, progressive=True)
            else:
                shutil.copy2(src, dst)
                return dst.stat().st_size, False

        # Optimization that makes a file bigger is not optimization.
        if dst.stat().st_size >= src.stat().st_size:
            shutil.copy2(src, dst)
            return dst.stat().st_size, False

        return dst.stat().st_size, True
    except Exception:
        shutil.copy2(src, dst)
        return dst.stat().st_size, False


INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<style>
  html, body {{
    margin: 0; padding: 0; height: 100%;
    background: #000; overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }}
  .ae1-canvas {{ display: block; touch-action: none; }}
  .ae1-dialogue {{
    position: fixed; left: 50%; bottom: 6%;
    transform: translateX(-50%) translateY(8px);
    max-width: min(70ch, 86vw);
    padding: 14px 22px;
    background: rgba(12, 12, 14, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    color: #ececec; font-size: 17px; line-height: 1.5; text-align: center;
    opacity: 0; pointer-events: none;
    transition: opacity 160ms ease, transform 160ms ease;
  }}
  .ae1-dialogue[data-show="true"] {{ opacity: 1; transform: translateX(-50%) translateY(0); }}
  @media (prefers-reduced-motion: reduce) {{
    .ae1-dialogue {{ transition: none; }}
  }}
</style>
</head>
<body>
<!--
  {title} — built with AE1 (Angel's Egg {version}).

  Everything except the media folder is inlined below, so this file opens by
  double-clicking as well as from a web server.

  Want to change something? The scripts are right there in AE1_GAME.scripts, in
  Angel Script: an s-expression `dat`/`def` header and plain JavaScript methods.
  Edit them, reload, and the game recompiles them at boot. Modding and authoring
  use the same surface on purpose.
-->
<script id="ae1-data" type="application/json">{data}</script>
<script>
{engine}
</script>
<script>
  var AE1_GAME = JSON.parse(document.getElementById('ae1-data').textContent);
  window.addEventListener('DOMContentLoaded', function () {{ bootGame(AE1_GAME); }});
</script>
</body>
</html>
"""


# A 3D game is ES modules, because three.js is — and file:// refuses to FETCH
# module files (CORS). But it will happily RUN an inline module script, and that
# script may import blob: URLs. So the whole module graph (three.js + engine) is
# inlined as JSON, turned into Blob URLs at boot in dependency order, each
# `from 'spec'` rewritten to its dependency's blob: URL, and the entry imported
# dynamically. One file, double-clickable, same promise as 2D (DESIGN.md §18.8).
INDEX_HTML_3D = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<style>
  html, body {{ margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }}
  .ae1-canvas {{ display: block; }}
  #ae1-boot {{ position: fixed; inset: 0; z-index: 99; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 18px; background: #0a0b0e;
    color: #cfd3da; font: 14px/1.5 monospace; transition: opacity .6s; }}
  #ae1-boot .ring {{ width: 46px; height: 46px; border-radius: 50%;
    border: 3px solid #2a2e36; border-top-color: #9fe0ae;
    animation: ae1spin 1s linear infinite; }}
  #ae1-boot .big {{ font-size: 18px; letter-spacing: 2px; }}
  #ae1-boot .dim {{ color: #6a7078; }}
  @keyframes ae1spin {{ to {{ transform: rotate(360deg); }} }}
</style>
</head>
<body>
<!-- The BOOT OVERLAY paints as soon as this first chunk parses — a big
     build (hundreds of MB inlined) spends 30s+ in the HTML parser alone,
     and a silent black page reads as broken. Staged text below. -->
<div id="ae1-boot">
  <div class="ring"></div>
  <div class="big">{title}</div>
  <div class="dim" id="ae1-boot-msg">unpacking the build&hellip; (a big world takes a minute)</div>
</div>
<!--
  {title} — built with AE1 (Angel's Egg), 3D.

  Everything is in this one file: scenes, scripts, every .glb (base64), and the
  full ES-module graph — three.js and the AE1 engine — inlined as JSON. file://
  cannot fetch module files, but an inline module script CAN import blob: URLs,
  so the loader below rebuilds the graph as Blob URLs, leaves first, and boots.
  The modules are unminified — read them (Principle 3).
-->
<script id="ae1-data" type="application/json">{data}</script>
<script id="ae1-modules" type="application/json">{modules}</script>
{payloads}<script type="module">
  const pack = JSON.parse(document.getElementById('ae1-modules').textContent);
  const urls = new Map();
  for (const name of pack.order) {{
    let src = pack.modules[name];
    for (const [spec, dep] of pack.deps[name]) {{
      const url = urls.get(dep);
      src = src.split("from '" + spec + "'").join("from '" + url + "'");
      src = src.split('from "' + spec + '"').join('from "' + url + '"');
    }}
    urls.set(name, URL.createObjectURL(new Blob([src], {{ type: 'text/javascript' }})));
  }}
  const {{ bootGame3D }} = await import(urls.get(pack.entry));
  const data = JSON.parse(document.getElementById('ae1-data').textContent);
  // Inlined assets ride OUTSIDE the data JSON, one script block each: V8
  // caps a single string near 512 MiB of chars, and a game whose models +
  // databases together pass that killed JSON.parse outright (this page went
  // black with no error). Per-asset blocks keep every string well under the
  // cap — the biggest single asset is the bound, not the game's total.
  data.glbs = {{}};
  data.bins = {{}};
  // §18.88 THE AEPACK PATH: over http the slim page (play.html) carries no
  // inline payloads — one binary pack holds every asset as raw bytes (no
  // base64, no string copies), and the SAME artifact is what a native
  // runtime will mmap. file:// keeps the classic inline blocks.
  let packed = false;
  if (location.protocol !== 'file:') {{
    try {{
      const r = await fetch('game.aepack');
      if (r.ok) {{
        const buf = await r.arrayBuffer();
        const dv = new DataView(buf);
        if (dv.getUint32(0, false) === 0x4145504B) {{ // 'AEPK'
          const tocLen = dv.getUint32(8, true);
          const toc = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, tocLen)));
          const base = 12 + tocLen;
          for (const e of toc.entries) {{
            (e.bag === 'bins' ? data.bins : data.glbs)[e.name] =
              new Uint8Array(buf, base + e.offset, e.length);
          }}
          packed = true;
        }}
      }}
    }} catch {{ /* no pack — fall through to the inline blocks */ }}
  }}
  if (!packed) for (const s of document.querySelectorAll('script[type="ae1-b64"]')) {{
    (s.dataset.bag === 'bins' ? data.bins : data.glbs)[s.dataset.name] = s.textContent;
    s.remove(); // §18.87 — drop the DOM's copy of the payload (it was ~660 MB
                // of parser-retained text pinned for the whole session)
  }}
  const bootMsg = document.getElementById('ae1-boot-msg');
  if (bootMsg) bootMsg.textContent = 'decoding models and motion databases…';
  const game = bootGame3D(data);
  // the loop starts only after the full glb build — THAT is "loaded"
  await new Promise((res) => {{
    const check = () => (game.loop && game.loop.running ? res() : setTimeout(check, 250));
    check();
  }});
  const b = document.getElementById('ae1-boot');
  if (b) {{ b.style.opacity = '0'; setTimeout(() => b.remove(), 700); }}
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# The AE1 Game Package (AGP) — the portable, target-neutral game container.
# docs/engine/21-agp-format.md is the spec. One payload format read by the
# browser build (game.aepack, inlined or fetched) AND by a native runtime.
# --------------------------------------------------------------------------- #

AGP_VERSION = 1
AEPACK_MAGIC = 0x4145504B  # 'AEPK'


def build_aepack(glb_blobs: dict[str, bytes], bin_blobs: dict[str, bytes]) -> tuple[bytes, list[dict]]:
    """Assemble the AEPACK binary from the collected payload blobs.

    Layout: 'AEPK' | u32 version | u32 tocLen | toc(JSON, utf-8) | payloads.
    The TOC is a list of {name, bag, offset, length}; payloads are 8-aligned
    raw bytes. Returned as (bytes, toc_entries) so callers can report counts.
    Same bytes whether it is inlined into a build or shipped beside a native
    exe — one integrity story, one reader.
    """
    import struct as _struct  # noqa: PLC0415

    toc: list[dict] = []
    payload = bytearray()
    seen: dict[str, int] = {}   # sha256 -> payload offset (dedup identical content)
    for bag_name, blobs in (("glbs", glb_blobs), ("bins", bin_blobs)):
        for nm, raw in blobs.items():
            h = hashlib.sha256(raw).hexdigest()
            # An asset that lands in BOTH bags (e.g. a skybox .hdr used as a glb
            # texture AND a bin) is stored ONCE; both TOC entries point at it.
            # Loaders resolve by name+bag, so both names still resolve, byte-identical.
            off = seen.get(h)
            if off is None:
                while len(payload) % 8:
                    payload.append(0)
                off = len(payload)
                payload.extend(raw)
                seen[h] = off
            toc.append({"name": nm, "bag": bag_name,
                        "offset": off, "length": len(raw), "sha256": h})
    toc_json = json.dumps({"agpVersion": AGP_VERSION, "entries": toc},
                          separators=(",", ":")).encode("utf-8")
    out = bytearray()
    # Magic as the RAW ASCII bytes 'AEPK', NOT struct.pack('<I', …) — the JS
    # loader reads it big-endian (getUint32(0, false) === 0x4145504B), so a
    # little-endian pack reverses it to 'KPEA' and the pack is rejected
    # (§21 regression: this silently emptied the slim play.html — zero meshes,
    # black screen). Version + tocLen stay little-endian (getUint32(…, true)).
    out += b"AEPK"
    out += _struct.pack("<II", AGP_VERSION, len(toc_json))
    out += toc_json
    out += payload
    return bytes(out), toc


def write_agp(out_dir: Path, data: dict, glb_blobs: dict[str, bytes],
              bin_blobs: dict[str, bytes], version: str) -> dict:
    """Write a standalone AGP directory — the target-neutral package a native
    runtime consumes (no HTML, no JS): manifest.json + data.json + game.aepack.

    - data.json  : the GAME DEFINITION (scenes, scripts, hud, media index) —
                   everything that is not a binary asset. Identical to the
                   browser build's <script id="ae1-data"> block.
    - game.aepack: the binary payload (models, mm packs, audio, textures).
    - manifest.json: the entry point — agpVersion, engine + game identity,
                   pointers to the two files with sizes + sha256.
    """
    aepack, toc = build_aepack(glb_blobs, bin_blobs)
    (out_dir / "game.aepack").write_bytes(aepack)
    data_json = json.dumps(data, separators=(",", ":")).encode("utf-8")
    (out_dir / "data.json").write_bytes(data_json)
    manifest = {
        "agpVersion": AGP_VERSION,
        "engine": version,
        "game": {
            "id": data.get("gameId"),
            "title": data.get("title"),
            "version": data.get("version"),
            "entryScene": data.get("entryScene"),
        },
        "data": {"file": "data.json", "bytes": len(data_json),
                 "sha256": hashlib.sha256(data_json).hexdigest()},
        "payload": {"file": "game.aepack", "bytes": len(aepack),
                    "sha256": hashlib.sha256(aepack).hexdigest(),
                    "assets": len(toc)},
    }
    (out_dir / "manifest.json").write_bytes(
        json.dumps(manifest, indent=1).encode("utf-8"))
    return {"aepackBytes": len(aepack), "assets": len(toc),
            "dataBytes": len(data_json)}


def export_project(
    project: dict,
    project_dir: Path,
    engine_dir: Path,
    out_dir: Path,
    version: str,
    target: str = "browser",
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Build a project into out_dir. Returns a report.

    target: "browser" (default) — the self-contained index.html + play.html +
    game.aepack web build. "agp" — the standalone AE1 Game Package directory
    (manifest.json + data.json + game.aepack, no HTML), the target-neutral
    container a native runtime reads (docs/engine/21). 3D projects only for
    "agp"; a 2D project falls back to browser with a warning.
    """
    say = log or (lambda _m: None)
    report: dict[str, Any] = {"steps": [], "warnings": []}

    def step(msg: str) -> None:
        report["steps"].append(msg)
        say(msg)

    target = (target or "browser").lower()
    if target not in ("browser", "agp", "windows"):
        raise ExportError(f"Unknown export target '{target}' "
                          "(expected 'browser' or 'agp').")
    # The AGP container is the 3D native-runtime package; a 2D game has no
    # binary payload and no native runtime yet, so fall back to the web build.
    if target in ("agp", "windows") and project.get("type") != "game-3d":
        report["warnings"].append(
            "The AGP/windows target is for 3D games; building the browser "
            "target instead.")
        target = "browser"

    # --- gather ---------------------------------------------------------- #

    scenes: dict[str, dict] = {}
    scenes_dir = project_dir / "scenes"
    for f in sorted(scenes_dir.glob("*.json")):
        try:
            scenes[f.name] = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ExportError(f"Scene {f.name} is not valid JSON: {exc}") from exc

    if not scenes:
        raise ExportError("This project has no scenes to export.")

    entry = project.get("entryScene") or next(iter(scenes))
    if entry not in scenes:
        raise ExportError(f"Entry scene '{entry}' is missing.")

    scripts: dict[str, str] = {}
    scripts_dir = project_dir / "scripts"
    if scripts_dir.is_dir():
        for f in sorted(scripts_dir.glob("*.ags.txt")):
            scripts[f.name] = f.read_text(encoding="utf-8")

    hud = {"name": "HUD", "elements": {}}
    hud_file = project_dir / "hud.json"
    if hud_file.is_file():
        try:
            hud = json.loads(hud_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ExportError(f"hud.json is not valid JSON: {exc}") from exc

    hud_count = len(hud.get("elements") or {})
    step(f"Collected {len(scenes)} scene(s), {len(scripts)} script(s), {hud_count} HUD element(s).")

    # --- validate -------------------------------------------------------- #

    # A build is the moment to say "this will not work", not the moment to ship
    # something broken quietly.
    referenced_scripts = {
        el.get("script")
        for source in [*scenes.values(), hud]
        for el in (source.get("elements") or {}).values()
        if el.get("script")
    }
    for missing in sorted(referenced_scripts - set(scripts)):
        report["warnings"].append(f"An element references '{missing}', which does not exist.")

    # A goToScene() naming a scene that isn't there is a dead end the player walks
    # into. Catching it at build time is worth a crude scan.
    blob = "\n".join(scripts.values())
    for m in re.finditer(r'goToScene\(\s*["\']([^"\']+)["\']', blob):
        target = m.group(1)
        known = set(scenes) | {s.get("name") for s in scenes.values()}
        known |= {f.removesuffix(".json") for f in scenes}
        if target not in known:
            report["warnings"].append(f"A script calls goToScene(\"{target}\") — no such scene.")

    # --- prepare output --------------------------------------------------- #

    # Build into staging, swap at the end. NEVER delete the previous build first.
    #
    # Deleting up-front cost a real failure: on Windows, rmtree throws WinError 32
    # if anything holds the directory -- a browser tab with the game open, an
    # Explorer window, an antivirus scan -- and by then it has already half-deleted
    # the previous build. A failed rebuild would destroy the last working one.
    # A build is not allowed to be destructive until it has something to swap in.
    staging = out_dir.with_name(out_dir.name + ".building")
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    (staging / "media").mkdir(parents=True, exist_ok=True)
    out_dir = staging  # everything below writes to staging

    # --- media: prune, dedup, optimize ------------------------------------ #

    manifest_path = project_dir / "media" / "manifest.json"
    manifest = {"entries": {}}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            report["warnings"].append("Media manifest is unreadable; shipping every asset.")

    entries = manifest.get("entries", {})
    used = collect_media_refs(scenes, hud, scripts) | collect_name_refs(scripts, scenes, hud, entries)
    unused = set(entries) - used

    # A 3D game inlines its .glb models (file:// can't fetch them), so there is no
    # need to also copy them into media/ — that would double an 18 MB character.
    is_3d = project.get("type") == "game-3d"

    copied = 0
    bytes_in = 0
    bytes_out = 0
    optimized = 0
    images = 0

    for digest in sorted(used):
        entry_meta = entries.get(digest)
        if not entry_meta:
            report["warnings"].append(f"A scene references media {digest[:8]}… which is not imported.")
            continue

        if is_3d and (
            entry_meta.get("kind") == "model"
            or entry_meta.get("kind") == "other"
            or entry_meta.get("ext") in ("hdr", "mp3", "ogg", "wav", "m4a")
        ):
            # inlined as base64 below, not copied. "other" covers fetched data
            # files (the motion-matching database packs: *_motions.json /
            # *_poses.bin / *_features.bin) — a file:// page cannot fetch a
            # relative path, so they ride the inline path like every glb.
            continue

        src = project_dir / "media" / f"{digest}.{entry_meta['ext']}"
        if not src.is_file():
            report["warnings"].append(f"Missing asset file for '{entry_meta['name']}'.")
            continue

        dst = out_dir / "media" / src.name
        bytes_in += src.stat().st_size

        if entry_meta.get("kind") == "image":
            images += 1
            size, did = optimize_image(src, dst)
            optimized += 1 if did else 0
        else:
            shutil.copy2(src, dst)
            size = dst.stat().st_size

        bytes_out += size
        copied += 1

    # Silence about what was dropped reads as "everything shipped".
    if unused:
        names = ", ".join(sorted(entries[d]["name"] for d in unused if d in entries))
        step(f"Pruned {len(unused)} unreferenced asset(s): {names}")

    step(f"Shipped {copied} asset(s), {bytes_in:,} → {bytes_out:,} bytes.")
    # Warn only when Pillow is ACTUALLY absent — "no image happened to shrink"
    # is normal (already-optimized PNGs) and must not read as a missing install.
    if images and not optimized:
        try:
            import PIL  # noqa: F401, PLC0415 — presence check only
        except ImportError:
            report["warnings"].append(
                "Pillow is not installed, so images were copied as-is. The game is correct, just larger. "
                "Install it with: .venv\\Scripts\\python -m pip install Pillow"
            )

    # --- bundle + boot ---------------------------------------------------- #

    data = {
        # Identity, so a save can tell which game it belongs to and localStorage
        # slots never collide between two games served from one origin.
        "gameId": project.get("id"),
        "title": project.get("name", "AE1 Game"),
        "version": project.get("metadata", {}).get("version", "0.1.0"),
        "engine": version,
        "width": 1280,
        "height": 720,
        "entryScene": entry,
        "scenes": scenes,
        "hud": hud,
        "scripts": scripts,
        # Shipped so the runtime can resolve playSound("boing.mp3") to a hash.
        # Trimmed to what shipped: a manifest naming pruned assets would let a
        # script resolve a name to a file that is not in the build.
        "media": {d: entries[d] for d in sorted(used) if d in entries},
        "mediaBase": "media",
    }

    if is_3d:
        # Inline every .glb as base64: file:// cannot fetch, so the game decodes
        # these to Blob URLs at boot (DESIGN.md §18.8). animOnly libraries are
        # STRIPPED to node graph + clips first — their meshes are dead weight,
        # and seven fat libraries once pushed index.html past V8's ~1 GiB
        # string cap, killing the double-click boot outright (§18.10).
        # Models, .hdr skies AND audio inline: all are fetched binaries a
        # file:// page cannot fetch — the boot turns them into Blob URLs
        # (§18.13; audio rides the same path for passive dialogue §18.18).
        # §18.87 AUTO animOnly: a glb named ONLY in animLibs/libs — never worn
        # as any element's model.media — is an animation library BY USAGE
        # (build() refuses to render it; §18.10's one rule), so its meshes are
        # provably dead weight in this build. Strip it like the manual flag.
        # Spawn-media names (lock markers, pod bolts, enemy orbs) never appear
        # in an animLibs list, so they are never at risk.
        worn_models: set[str] = set()
        lib_names_scene: set[str] = set()
        for _sc in (scenes.values() if isinstance(scenes, dict) else scenes):
            _els = _sc.get("elements", {}) if isinstance(_sc, dict) else {}
            for _el in (_els.values() if isinstance(_els, dict) else _els):
                _m = ((_el or {}).get("components") or {}).get("model") or {}
                if _m.get("media"):
                    worn_models.add(_m["media"])
                _libs = _m.get("libs")
                if isinstance(_libs, str) and _libs:
                    lib_names_scene.add(_libs)
                elif isinstance(_libs, list):
                    lib_names_scene.update(x for x in _libs if isinstance(x, str))
        lib_named: set[str] = set(lib_names_scene)
        for _txt in scripts.values():
            for _mlist in re.findall(r"\(animLibs\s*\(([^)]*)\)", _txt):
                lib_named.update(re.findall(r'"([^"]+\.glb)"', _mlist))
        auto_strip = lib_named - worn_models

        glbs: dict[str, str] = {}
        glb_blobs: dict[str, bytes] = {}  # §18.88 — raw bytes for the aepack
        bin_blobs: dict[str, bytes] = {}
        inlined_bytes = 0

        # §18.89: the KTX2 encoder (tools/ktx/toktx.exe, or PATH), and the
        # DIET CACHE — encoding a character's fifteen textures takes real
        # time, and the result is pure function of (source digest, settings),
        # so rebuilds hit the cache and stay instant.
        toktx = shutil.which("toktx")
        _cand = engine_dir.parent / "tools" / "ktx" / "toktx.exe"
        if _cand.is_file():
            toktx = str(_cand)
        diet_tag = "ktx2v3" if toktx else "jpgv1"  # §18.96: v3 = hair cutout stays PNG
        diet_cache = engine_dir.parent / "exports" / ".dietcache"
        diet_cache.mkdir(parents=True, exist_ok=True)

        # §18.91: the audio transcoder (ffmpeg → 128k MP3), best-effort.
        ffmpeg = shutil.which("ffmpeg") or (
            r"<local path>"
            if Path(r"<local path>").is_file() else None)

        # §18.92: gltfpack (geometry meshopt compression), best-effort.
        gltfpack = shutil.which("gltfpack")
        _gp = engine_dir.parent / "tools" / "meshopt" / "gltfpack.exe"
        if _gp.is_file():
            gltfpack = str(_gp)
        if gltfpack:
            diet_tag += "_mo1"
        for digest in sorted(used):
            em = entries.get(digest)
            if not em or (
                em.get("kind") != "model"
                and em.get("ext") not in ("hdr", "mp3", "ogg", "wav", "m4a")
            ):
                continue
            src = project_dir / "media" / f"{digest}.{em['ext']}"
            if not src.is_file():
                continue
            blob = src.read_bytes()
            if em.get("animOnly") or em["name"] in auto_strip:
                lean = strip_glb_to_clips(blob)
                if len(lean) < len(blob):
                    why = "flagged" if em.get("animOnly") else "auto: libs-only"
                    step(
                        f"Stripped '{em['name']}' to clips ({why}): "
                        f"{len(blob):,} → {len(lean):,} bytes."
                    )
                    blob = lean
                else:
                    report["warnings"].append(
                        f"Could not strip '{em['name']}' to clips; shipping it whole."
                    )
            elif em.get("kind") == "model" and em.get("ext") == "glb" and not em.get("rawTextures"):
                # §18.87/§18.89 texture diet — dedup / 2048 cap / KTX2 (or
                # opaque→JPEG when no encoder). Cached by source digest.
                cache_f = diet_cache / f"{digest}.{diet_tag}.glb"
                if cache_f.is_file():
                    lean = cache_f.read_bytes()
                    if len(lean) < len(blob):
                        step(
                            f"Texture diet '{em['name']}' (cached): "
                            f"{len(blob):,} → {len(lean):,} bytes."
                        )
                        blob = lean
                else:
                    lean, note = optimize_glb_textures(blob, encoder=toktx)
                    # §18.92: geometry compression AFTER textures (gltfpack
                    # passes KTX2 through; my bin-repacker can't, so order
                    # matters). Runs on whichever glb the texture stage
                    # produced.
                    if gltfpack:
                        mo = meshopt_pack(gltfpack, lean if len(lean) < len(blob) else blob)
                        if mo is not None:
                            note += f", meshopt {len(lean if len(lean)<len(blob) else blob):,}→{len(mo):,}"
                            lean = mo
                    try:
                        cache_f.write_bytes(lean if len(lean) < len(blob) else blob)
                    except OSError:
                        pass  # cache is a convenience, never a requirement
                    if len(lean) < len(blob):
                        step(
                            f"Texture diet '{em['name']}': {len(blob):,} → "
                            f"{len(lean):,} bytes ({note})."
                        )
                        blob = lean
            # §18.91 AUDIO DIET: transcode to 128k MP3, cached by digest. On
            # success the shipped media entry's ext becomes mp3 so the runtime
            # types the <audio> data URL correctly (audio/mpeg). Best-effort.
            if em.get("ext") in ("mp3", "ogg", "wav", "m4a") and ffmpeg and not em.get("rawAudio"):
                acache = diet_cache / f"{digest}.audio128.mp3"
                lean = acache.read_bytes() if acache.is_file() else None
                if lean is None:
                    lean = transcode_audio(ffmpeg, blob, em["ext"])
                    if lean is not None:
                        try:
                            acache.write_bytes(lean)
                        except OSError:
                            pass
                if lean is not None and len(lean) < len(blob):
                    step(f"Audio diet '{em['name']}': {len(blob):,} → {len(lean):,} bytes (mp3 128k).")
                    blob = lean
                    if digest in data["media"]:
                        data["media"][digest] = {**data["media"][digest], "ext": "mp3"}

            inlined_bytes += len(blob)
            glb_blobs[em["name"]] = blob
            glbs[em["name"]] = base64.b64encode(blob).decode("ascii")
        # DATA FILES (kind "other" — the motion-matching database packs) inline
        # too, in their own bag: the runtime hands them out as data: URLs
        # (the driver's fetch() decodes those natively; game3d.mediaUrlFor).
        bins: dict[str, str] = {}
        for digest in sorted(used):
            em = entries.get(digest)
            if not em or em.get("kind") != "other":
                continue
            src = project_dir / "media" / f"{digest}.{em['ext']}"
            if not src.is_file():
                continue
            blob = src.read_bytes()
            inlined_bytes += len(blob)
            bin_blobs[em["name"]] = blob
            bins[em["name"]] = base64.b64encode(blob).decode("ascii")
        if bins:
            step(f"Inlined {len(bins)} data file(s) (databases) for file:// play.")

        # §18.89: the basis TRANSCODER rides the payload bag under reserved
        # names, so KTX2 textures decode on file:// and any web host alike —
        # no external path, no CDN. ~570 KB, only when KTX2 could be present.
        if toktx:
            basis_dir = engine_dir / "vendor" / "three" / "libs" / "basis"
            for fn in ("basis_transcoder.js", "basis_transcoder.wasm"):
                p = basis_dir / fn
                if p.is_file():
                    raw = p.read_bytes()
                    key = f"__{fn}"
                    glb_blobs[key] = raw
                    glbs[key] = base64.b64encode(raw).decode("ascii")
                    inlined_bytes += len(raw)

        step(f"Inlined {len(glbs)} model(s) ({inlined_bytes:,} bytes total) for file:// play.")

        # EACH ASSET IS ITS OWN <script> BLOCK, never part of the data JSON:
        # V8 caps a single string near 512 MiB of CHARS, and the motion-matching
        # game's models + databases inside one JSON blew past it — JSON.parse
        # died and the page went black with no error. Per-asset blocks bound
        # every string by the biggest single asset instead of the game's
        # total. Base64 needs no escaping (no '<', no '&'); the name is
        # attribute-escaped.
        def b64_block(bag: str, name: str, b64: str) -> str:
            safe = name.replace("&", "&amp;").replace('"', "&quot;")
            return (f'<script type="ae1-b64" data-bag="{bag}" '
                    f'data-name="{safe}">{b64}</script>\n')

        agp_only = target in ("agp", "windows")
        payloads = ""
        pack = None
        if not agp_only:
            # The browser target's base64 <script> blocks + the inlined module
            # graph. The AGP target needs neither (it ships raw bytes + no JS),
            # so skip this work entirely for it.
            payload_parts: list[str] = []
            worst = 0
            for name, b64 in glbs.items():
                worst = max(worst, len(b64))
                payload_parts.append(b64_block("glbs", name, b64))
            for name, b64 in bins.items():
                worst = max(worst, len(b64))
                payload_parts.append(b64_block("bins", name, b64))
            payloads = "".join(payload_parts)
            if worst > 500_000_000:
                report["warnings"].append(
                    "One inlined asset exceeds ~500 MB of base64 — past V8's "
                    "single-string cap, the double-click boot WILL fail. Slim "
                    "that asset or mark it Anim-only."
                )
            # Inline the whole ES-module graph (three.js + engine) so
            # index.html boots on file:// — modules become Blob URLs at boot.
            pack = bundle_modules_3d(engine_dir)
            step(
                f"Bundled {len(pack['order'])} ES modules (three.js + engine) "
                f"into the page."
            )

        if agp_only:
            # §21 THE STANDALONE AGP: no HTML/JS — just the target-neutral
            # package a native runtime reads. index.html/play.html are the
            # browser target's artifacts; this one is the exe's.
            info = write_agp(out_dir, data, glb_blobs, bin_blobs, version)
            step(
                f"AGP: manifest.json + data.json ({info['dataBytes']:,} B) + "
                f"game.aepack ({info['aepackBytes']:,} B, {info['assets']} assets)."
            )
        else:
            html = INDEX_HTML_3D.format(
                title=data["title"],
                data=json.dumps(data, indent=1).replace("</", "<\\/"),
                # </script> inside a module source would close the tag early too.
                modules=json.dumps(pack).replace("</", "<\\/"),
                payloads=payloads,
            )
            (out_dir / "index.html").write_text(html, encoding="utf-8")

            # §18.88/§21 THE AEPACK: every asset as raw bytes in one
            # offset-indexed binary, beside a SLIM play.html that fetches it
            # over http (no 445 MB of base64 through the HTML parser).
            # index.html stays the file:// double-click artifact; game.aepack
            # is the SAME binary the standalone AGP and a native runtime read.
            aepack, toc_entries = build_aepack(glb_blobs, bin_blobs)
            (out_dir / "game.aepack").write_bytes(aepack)
            slim = INDEX_HTML_3D.format(
                title=data["title"],
                data=json.dumps(data, indent=1).replace("</", "<\\/"),
                modules=json.dumps(pack).replace("</", "<\\/"),
                payloads="",  # the pack carries everything
            )
            (out_dir / "play.html").write_text(slim, encoding="utf-8")
            step(
                f"AEPACK: game.aepack ({len(aepack):,} bytes, "
                f"{len(toc_entries)} assets) + slim play.html "
                f"({len(slim):,} bytes) for http play."
            )
    else:
        engine_src = bundle_engine(engine_dir)
        step(f"Bundled engine ({len(ENGINE_MODULES)} modules, {len(engine_src):,} bytes).")
        html = INDEX_HTML.format(
            title=data["title"],
            version=version,
            # </script> inside the JSON would close the tag early and break the page.
            data=json.dumps(data, indent=1).replace("</", "<\\/"),
            engine=engine_src,
        )
        (out_dir / "index.html").write_text(html, encoding="utf-8")

    # Loose copies alongside the inlined originals: the inlined ones are what
    # RUN, these are what a modder reads and diffs. Principle 3.
    src_dir = out_dir / "source"
    (src_dir / "scripts").mkdir(parents=True, exist_ok=True)
    for name, text in scripts.items():
        (src_dir / "scripts" / name).write_text(text, encoding="utf-8")
    (src_dir / "scenes").mkdir(parents=True, exist_ok=True)
    for name, scene in scenes.items():
        (src_dir / "scenes" / name).write_text(json.dumps(scene, indent=2), encoding="utf-8")

    if target == "windows":
        # A RUNNABLE bundle: the native player exe + the engine JS beside the AGP,
        # so double-clicking the exe finds the package + engine automatically
        # (game.cpp auto-locates engine/ and manifest.json in its own directory).
        repo = engine_dir.parent
        exe_src = repo / "native" / "build" / "ae1game.exe"
        if exe_src.is_file():
            shutil.copy2(exe_src, out_dir / "AE1Player.exe")
            step(f"Windows: player.exe ({exe_src.stat().st_size:,} B).")
        else:
            step("Windows: native player not built — run native/build.bat "
                 "(bundle has the AGP + engine only for now).")
        shutil.copytree(engine_dir, out_dir / "engine", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.map", "*.md", "__pycache__"))
        njs = sum(1 for _ in (out_dir / "engine").rglob("*.js"))
        step(f"Windows: bundled engine/ ({njs} .js modules).")
        (out_dir / "RUN.txt").write_text(
            f"{data['title']} — AE1 Windows build\n"
            f"{'=' * (len(data['title']) + 18)}\n\n"
            "Double-click AE1Player.exe to play. It reads game.aepack + engine/\n"
            "from this same folder.\n\n"
            "Controls: WASD move, mouse look, Shift run, Space jump, Esc quit.\n",
            encoding="utf-8")

        # (motion-matching gait pre-warm removed in the public build)

    if target in ("agp", "windows"):
        (out_dir / "README.txt").write_text(
            f"{data['title']} — AE1 Game Package (AGP v{AGP_VERSION})\n"
            f"{'=' * (len(data['title']) + 26)}\n\n"
            f"Built with AE1 (Angel's Egg {version}).\n\n"
            "This is a TARGET-NEUTRAL package, not a web build — no HTML, no\n"
            "JavaScript. A native AE1 runtime (or any AGP reader) consumes it.\n\n"
            "FILES\n"
            "  manifest.json  the entry point: agpVersion, game identity, and\n"
            "                 pointers to the two files below (with sha256).\n"
            "  data.json      the game definition — scenes, scripts, hud, and\n"
            "                 the media index. Everything that is not binary.\n"
            "  game.aepack    the binary payload: models, motion packs, audio,\n"
            "                 textures — 'AEPK' magic, a JSON TOC, raw bytes.\n"
            "  source/        readable copies of the scenes and scripts.\n\n"
            "The SAME game.aepack ships inside the browser build; the two\n"
            "targets share one payload format (docs/engine/21-agp-format.md).\n",
            encoding="utf-8",
        )
    else:
        # A saves/ folder the game itself cannot write to. A browser game has
        # no filesystem: saving hands the player a file, loading asks for one.
        # This is where we suggest they keep them, and why — so the constraint
        # reads as a design (your saves are yours) rather than as broken.
        saves_dir = out_dir / "saves"
        saves_dir.mkdir(parents=True, exist_ok=True)
        (saves_dir / "README.txt").write_text(
            "Save files\n"
            "==========\n\n"
            "Keep your .ae1save.json files here.\n\n"
            "When you save, your browser downloads the file (probably to Downloads).\n"
            "Move it here so you can find it again.\n\n"
            "When you load, the game asks you to pick the file. That is the only way a\n"
            "page in a browser can read a file you chose -- it cannot go looking on its\n"
            "own. The upside: your saves are ordinary JSON. Open one in a text editor.\n"
            "Change it. It is your save.\n",
            encoding="utf-8",
        )
        (out_dir / "README.txt").write_text(
            f"{data['title']}\n"
            f"{'=' * len(data['title'])}\n\n"
            f"Built with AE1 (Angel's Egg {version}).\n\n"
            "TO PLAY\n"
            "  Double-click index.html, or drop this whole folder on any web host.\n"
            "  No server, no install, no build step.\n\n"
            "SAVES\n"
            "  Saving downloads a .ae1save.json file — keep it in saves/.\n"
            "  Loading asks you to pick that file.\n"
            "  Your most recent save is also kept in the browser, so a game can offer\n"
            "  'Continue' without a file. Clearing browser data clears it; the file\n"
            "  is the copy that lasts.\n"
            "  Saves are plain JSON. Open one. Edit it. It is yours.\n\n"
            "TO MOD\n"
            "  The game's data lives in the <script id=\"ae1-data\"> block in index.html:\n"
            "  scenes as JSON, Angel Scripts as text. Edit them and reload — scripts are\n"
            "  compiled at boot, so changes take effect immediately.\n\n"
            "  source/ holds the same scenes and scripts as separate files, for reading\n"
            "  and diffing. Editing those does NOT affect the game; index.html is what runs.\n\n"
            "  Open the devtools console and use `AE1` — the live world, scene, loop, and\n"
            "  compiled classes are all there.\n\n"
            "FILES\n"
            "  index.html   the whole game in one file — double-click it (file://)\n"
            "  play.html    the SLIM page for web hosting: loads game.aepack over\n"
            "               http (3D games only; far faster than index.html there)\n"
            "  game.aepack  every asset as raw bytes, offset-indexed (3D games) —\n"
            "               the same package a native AE1 runtime reads\n"
            "  media/       assets, named by content hash\n"
            "  saves/       where to keep your save files\n"
            "  source/      readable copies of the scenes and scripts\n",
            encoding="utf-8",
        )

    total = sum(f.stat().st_size for f in out_dir.rglob("*") if f.is_file())

    # --- swap ------------------------------------------------------------- #

    final = staging.with_name(staging.name.removesuffix(".building"))
    retired = final.with_name(final.name + ".old")

    try:
        shutil.rmtree(retired, ignore_errors=True)
        if final.exists():
            final.rename(retired)
        staging.rename(final)
        shutil.rmtree(retired, ignore_errors=True)
    except OSError as exc:
        # The new build is complete and sitting in staging; the old one is
        # untouched. Say exactly that, and exactly what to do about it.
        raise ExportError(
            f"Built successfully, but could not replace the previous build: {exc}. "
            f"Something is holding {final} open — a browser tab playing the game, or an "
            f"Explorer window in that folder. Close it and build again. "
            f"Your previous build is intact and the new one is in {staging.name}."
        ) from exc

    out_dir = final
    step(f"Build complete — {total:,} bytes total.")

    report.update(
        {
            "ok": True,
            "target": target,
            "entry": ("manifest.json" if target in ("agp", "windows")
                      else "index.html"),
            "out": str(out_dir),
            "scenes": len(scenes),
            "scripts": len(scripts),
            "assets": copied,
            "pruned": len(unused),
            "optimized": optimized,
            "bytes": total,
        }
    )
    return report

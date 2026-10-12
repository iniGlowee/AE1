"""AE1 - meshforge: English -> a textured, optionally animated .glb prop (SS18.26).

The prototyping MODEL pipeline, clipforge's sibling: simple geometric props --
crates, ramps, signs, pillars, barriers -- as real glbs with procedural
PNG textures, all stdlib. BLOCKOUT TIER on purpose: organic and detailed
modelling stays in the artist pipeline; this exists so "give me a 2 m
shipping crate" is a one-message request, not a Blender session.

The whole prop is ONE NODE (the spec's name), so:
  - it decomposes into exactly one AE1 element on import, and
  - clipforge can animate it by name -- or pass an "animation" block here
    and it is BAKED INTO the model: the renderer auto-plays a model's own
    first clip, so a swinging sign or bobbing pickup needs ZERO wiring.

A spec is JSON:

    {
      "node": "crate1",
      "parts": [
        {"shape": "box", "size": [2, 2, 2], "at": [0, 1, 0], "texture": "crate"},
        {"shape": "cylinder", "radius": 0.1, "height": 2, "at": [0, 1, 0],
         "segments": 10, "texture": "metal"},
        {"shape": "plane", "size": [1, 0.6], "at": [0, 1.5, 0], "texture": "stripes"}
      ],
      "colors": {"base": [140, 96, 60], "accent": [92, 62, 38]},   # optional
      "animation": {"clip": "sway", "keys": [{"t": 0, "axis": [0,0,1], "deg": -2},
                                             {"t": 1.5, "axis": [0,0,1], "deg": 2},
                                             {"t": 3, "axis": [0,0,1], "deg": -2}]}
    }

Textures: crate, planks, metal, checker, stripes, solid -- 128 px, NEAREST
sampled (the PSX crunch this project wears on purpose). "at" offsets are
baked into the vertices, keeping the single-node contract.

Usage:
    py -3 meshforge.py spec.json out.glb [--upload 3d-sandbox]

Models upload WITHOUT the Anim flag -- they SHOULD merge as elements.
"""

from __future__ import annotations

import json
import math
import struct
import sys
import urllib.parse
import urllib.request
import zlib

from clipforge import axis_angle_quat, euler_to_quat, qmul


# -- textures: procedural 128px RGBA, written as PNG by hand ----------------- #

TEX = 128


def write_png(w: int, h: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * w * 4 : (y + 1) * w * 4] for y in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _noise(x: int, y: int) -> float:
    """Cheap deterministic value noise — texture grain without a PRNG state."""
    n = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFF) / 255.0


def make_texture(kind: str, base, accent) -> bytes:
    px = bytearray(TEX * TEX * 4)

    def put(x, y, r, g, b):
        i = (y * TEX + x) * 4
        px[i : i + 4] = bytes((max(0, min(255, int(r))), max(0, min(255, int(g))), max(0, min(255, int(b))), 255))

    br, bg, bb = base
    ar, ag, ab = accent
    for y in range(TEX):
        for x in range(TEX):
            g = 0.85 + 0.3 * _noise(x, y)  # grain everywhere
            r, gr, b = br * g, bg * g, bb * g
            if kind == "crate":
                # Planks + a frame border + a diagonal brace: the classic.
                if y % 32 in (0, 31) or x in (0, 1, 126, 127) or y in (0, 1, 126, 127):
                    r, gr, b = ar * g, ag * g, ab * g
                elif abs((x - y) % 128) < 3 or abs((x + y) % 128) < 3:
                    r, gr, b = ar * g * 1.1, ag * g * 1.1, ab * g * 1.1
            elif kind == "planks":
                if y % 32 in (0, 31):
                    r, gr, b = ar * g, ag * g, ab * g
                elif int(_noise(0, y // 32) * 128) == x:  # a knot per plank, roughly
                    r, gr, b = ar * g, ag * g, ab * g
            elif kind == "metal":
                g2 = 0.9 + 0.15 * _noise(x // 2, y // 2)
                r, gr, b = br * g2, bg * g2, bb * g2
                if (x % 32 == 16 and y % 32 == 16):  # rivets
                    r, gr, b = br * 0.5, bg * 0.5, bb * 0.5
            elif kind == "checker":
                if ((x // 16) + (y // 16)) % 2:
                    r, gr, b = ar * g, ag * g, ab * g
            elif kind == "stripes":
                if ((x + y) // 12) % 2:
                    r, gr, b = ar * g, ag * g, ab * g
            # "solid": just the grained base.
            put(x, y, r, gr, b)
    return write_png(TEX, TEX, bytes(px))


# -- geometry: positions/normals/uvs/indices per primitive ------------------- #

def box(size, at):
    sx, sy, sz = (s / 2 for s in size)
    ox, oy, oz = at
    faces = [  # normal, then 4 corners CCW seen from outside
        ((0, 0, 1), [(-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]),
        ((0, 0, -1), [(sx, -sy, -sz), (-sx, -sy, -sz), (-sx, sy, -sz), (sx, sy, -sz)]),
        ((1, 0, 0), [(sx, -sy, sz), (sx, -sy, -sz), (sx, sy, -sz), (sx, sy, sz)]),
        ((-1, 0, 0), [(-sx, -sy, -sz), (-sx, -sy, sz), (-sx, sy, sz), (-sx, sy, -sz)]),
        ((0, 1, 0), [(-sx, sy, sz), (sx, sy, sz), (sx, sy, -sz), (-sx, sy, -sz)]),
        ((0, -1, 0), [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, -sy, sz), (-sx, -sy, sz)]),
    ]
    pos, nrm, uv, idx = [], [], [], []
    for n, corners in faces:
        s = len(pos) // 3
        for i, (x, y, z) in enumerate(corners):
            pos += [x + ox, y + oy, z + oz]
            nrm += list(n)
            uv += [(0, 0), (1, 0), (1, 1), (0, 1)][i]
        idx += [s, s + 1, s + 2, s, s + 2, s + 3]
    return pos, nrm, uv, idx


def cylinder(radius, height, at, segments=12):
    ox, oy, oz = at
    h = height / 2
    pos, nrm, uv, idx = [], [], [], []
    for i in range(segments + 1):  # side, seam-duplicated for clean UVs
        a = 2 * math.pi * i / segments
        cx, cz = math.cos(a), math.sin(a)
        for y, v in ((-h, 0), (h, 1)):
            pos += [ox + radius * cx, oy + y, oz + radius * cz]
            nrm += [cx, 0, cz]
            uv += [i / segments, v]
    for i in range(segments):
        s = i * 2
        idx += [s, s + 2, s + 3, s, s + 3, s + 1]
    for top, ny in ((h, 1), (-h, -1)):  # caps: a fan around a centre vert
        c = len(pos) // 3
        pos += [ox, oy + top, oz]
        nrm += [0, ny, 0]
        uv += [0.5, 0.5]
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            pos += [ox + radius * math.cos(a), oy + top, oz + radius * math.sin(a)]
            nrm += [0, ny, 0]
            uv += [0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)]
            ring.append(c + 1 + i)
        for i in range(segments):
            a, b = ring[i], ring[(i + 1) % segments]
            idx += [c, b, a] if ny > 0 else [c, a, b]
    return pos, nrm, uv, idx


def sphere(radius, at, segments=16, rings=12):
    """Lat-long UV sphere — combat orbs, AOE waves (§18.44)."""
    ox, oy, oz = at
    pos, nrm, uv, idx = [], [], [], []
    for r in range(rings + 1):
        phi = math.pi * r / rings
        for s in range(segments + 1):
            th = 2 * math.pi * s / segments
            nx = math.sin(phi) * math.cos(th)
            ny = math.cos(phi)
            nz = math.sin(phi) * math.sin(th)
            pos += [ox + radius * nx, oy + radius * ny, oz + radius * nz]
            nrm += [nx, ny, nz]
            uv += [s / segments, r / rings]
    W = segments + 1
    for r in range(rings):
        for s in range(segments):
            a = r * W + s
            idx += [a, a + W, a + W + 1, a, a + W + 1, a + 1]
    return pos, nrm, uv, idx


def plane(size, at):
    w, hgt = size[0] / 2, size[1] / 2
    ox, oy, oz = at
    pos, nrm, uv, idx = [], [], [], []
    for (x, y), (u, v) in zip([(-w, -hgt), (w, -hgt), (w, hgt), (-w, hgt)], [(0, 0), (1, 0), (1, 1), (0, 1)]):
        pos += [ox + x, oy + y, oz]
        nrm += [0, 0, 1]
        uv += [u, v]
    idx += [0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]  # both windings: visible both sides
    return pos, nrm, uv, idx


SHAPES = {"box": lambda p: box(p.get("size", [1, 1, 1]), p.get("at", [0, 0, 0])),
          "cylinder": lambda p: cylinder(p.get("radius", 0.5), p.get("height", 1), p.get("at", [0, 0, 0]), p.get("segments", 12)),
          "sphere": lambda p: sphere(p.get("radius", 0.5), p.get("at", [0, 0, 0]), p.get("segments", 16), p.get("rings", 12)),
          "plane": lambda p: plane(p.get("size", [1, 1]), p.get("at", [0, 0, 0]))}


# -- glb assembly ------------------------------------------------------------ #

def build_glb(spec: dict) -> bytes:
    node = str(spec["node"])
    colors = spec.get("colors") or {}
    base = colors.get("base", [150, 105, 65])
    accent = colors.get("accent", [96, 66, 40])

    blob = bytearray()
    views, accessors = [], []

    def push(data: bytes, count, comp, acc_type, mn=None, mx=None, image=False):
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(data)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        if image:
            return len(views) - 1
        acc = {"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": acc_type}
        if mn is not None:
            acc["min"], acc["max"] = mn, mx
        accessors.append(acc)
        return len(accessors) - 1

    images, textures, materials, primitives = [], [], [], []
    tex_cache: dict[str, int] = {}

    for part in spec.get("parts", []):
        shape = part.get("shape", "box")
        pos, nrm, uv, idx = SHAPES[shape](part)
        kind = part.get("texture", "solid")
        # "color": a flat (optionally TRANSLUCENT) material, no image — combat
        # signal meshes (§18.44: enemy orbs, AOE waves) that read as pure hue.
        if kind == "color":
            c = part.get("base", base)
            a = float(part.get("alpha", 1.0))
            ckey = f"color:{c}:{a}"
            if ckey not in tex_cache:
                mat = {
                    "name": ckey,
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [c[0] / 255, c[1] / 255, c[2] / 255, a],
                        "metallicFactor": 0.0,
                        "roughnessFactor": 0.6,
                    },
                    "emissiveFactor": [c[0] / 510, c[1] / 510, c[2] / 510],
                    "doubleSided": True,
                }
                if a < 1.0:
                    mat["alphaMode"] = "BLEND"
                materials.append(mat)
                tex_cache[ckey] = len(materials) - 1
            kind = ckey
        elif kind not in tex_cache:
            png = make_texture(kind, part.get("base", base), part.get("accent", accent))
            img_view = push(png, 0, 0, "", image=True)
            images.append({"bufferView": img_view, "mimeType": "image/png"})
            textures.append({"sampler": 0, "source": len(images) - 1})
            materials.append({
                "name": kind,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": len(textures) - 1},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.95,
                },
            })
            tex_cache[kind] = len(materials) - 1
        xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
        p_acc = push(struct.pack(f"<{len(pos)}f", *pos), len(pos) // 3, 5126, "VEC3",
                     [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)])
        n_acc = push(struct.pack(f"<{len(nrm)}f", *nrm), len(nrm) // 3, 5126, "VEC3")
        t_acc = push(struct.pack(f"<{len(uv)}f", *uv), len(uv) // 2, 5126, "VEC2")
        i_acc = push(struct.pack(f"<{len(idx)}H", *idx), len(idx), 5123, "SCALAR")
        primitives.append({
            "attributes": {"POSITION": p_acc, "NORMAL": n_acc, "TEXCOORD_0": t_acc},
            "indices": i_acc,
            "material": tex_cache[kind],
        })

    # SOCKETS: named empty child nodes (the Blender-Empty convention the wield
    # framework reads — "SocketRightHand" lands on the hand bone, "SocketMuzzel"
    # is where rounds leave / the aim-assist barrel direction). Position only;
    # AE1 uses socket POSITIONS, never their orientation.
    #   "sockets": [{"name": "SocketRightHand", "at": [x, y, z]}, ...]
    nodes = [{"name": node, "mesh": 0}]
    sockets = spec.get("sockets") or []
    if sockets:
        nodes[0]["children"] = []
        for s in sockets:
            nodes[0]["children"].append(len(nodes))
            nodes.append({"name": str(s["name"]), "translation": [float(v) for v in s.get("at", [0, 0, 0])]})

    gltf = {
        "asset": {"version": "2.0", "generator": "AE1 meshforge"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": [{"name": node, "primitives": primitives}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 10497, "wrapT": 10497}],  # NEAREST: the PSX crunch
        "images": images,
        "textures": textures,
        "materials": materials,
        "buffers": [{"byteLength": 0}],
        "bufferViews": views,
        "accessors": accessors,
    }

    # An all-"color" prop has no images/textures — empty arrays are invalid
    # glTF, so prune them (and the then-unused sampler) rather than ship them.
    if not images:
        for k in ("images", "textures", "samplers"):
            del gltf[k]

    # A BAKED animation (clipforge keys): the renderer auto-plays a model's
    # own first clip, so a swinging sign ships pre-animated, zero wiring.
    anim = spec.get("animation")
    if anim and anim.get("keys"):
        base_q = euler_to_quat(*(anim.get("baseline") or [0, 0, 0]))
        times = [float(k["t"]) for k in anim["keys"]]
        quats = [qmul(axis_angle_quat(k.get("axis", [0, 0, 1]), float(k.get("deg", 0))), base_q) for k in anim["keys"]]
        t_acc = push(struct.pack(f"<{len(times)}f", *times), len(times), 5126, "SCALAR", [min(times)], [max(times)])
        flat = [c for q in quats for c in q]
        q_acc = push(struct.pack(f"<{len(flat)}f", *flat), len(quats), 5126, "VEC4")
        gltf["animations"] = [{
            "name": str(anim.get("clip", "loop")),
            "samplers": [{"input": t_acc, "output": q_acc, "interpolation": "LINEAR"}],
            "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}],
        }]

    gltf["buffers"][0]["byteLength"] = len(blob)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    length = 12 + 8 + len(js) + 8 + len(blob)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, length)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    return bytes(out)


def upload(slug: str, name: str, data: bytes, port: int = 8001) -> None:
    # 8001: AE1's home since 2026-08 — port 8000 belongs to the Media Deck.
    req = urllib.request.Request(
        f"http://localhost:{port}/api/projects/{slug}/media", data=data, method="POST",
        headers={"X-Filename": urllib.parse.quote(name), "Content-Type": "application/octet-stream"},
    )
    entry = json.loads(urllib.request.urlopen(req).read())
    print(f"uploaded: {name} — {entry.get('hash', entry)!r}")


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    spec = json.loads(open(sys.argv[1], encoding="utf-8-sig").read())
    data = build_glb(spec)
    with open(sys.argv[2], "wb") as f:
        f.write(data)
    print(f"wrote {sys.argv[2]} ({len(data):,} bytes)")
    if "--upload" in sys.argv:
        import pathlib

        upload(sys.argv[sys.argv.index("--upload") + 1], pathlib.Path(sys.argv[2]).name, data)


if __name__ == "__main__":
    main()

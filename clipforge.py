"""AE1 - clipforge: English -> keyframes -> an animOnly .glb (DESIGN.md SS18.25).

The prototyping animation pipeline for MECHANICAL/PROP motion: doors, chests,
topples, spins, bobs -- anything describable as clean curves on a few nodes.
(Humanoid motion stays Mixamo's job, on purpose: dozens of coordinated curves
keyframed blind read as robot-mime. This tool exists so "make the whiteboard
fall over" is a one-message request, not a Blender session.)

A spec is JSON:

    {
      "node": "whiteboard",             # the HOST glb node the clip drives
      "clip": "topple",                 # the animation's name
      "baseline": [0, -89.985, 0],      # euler XYZ deg the keys compose ONTO
                                        # (the ELEMENT's live rotation: the
                                        # mixer overrides it during playback,
                                        # so it must be baked in)
      "keys": [                         # world-axis rotation keyframes
        {"t": 0.0,  "axis": [1,0,0], "deg": 0},
        {"t": 0.12, "axis": [1,0,0], "deg": 6},
        ...
      ],
      "position": [                     # OPTIONAL absolute position keys
        {"t": 0.0, "xyz": [0, 0, 0]},
        ...
      ]
    }

Output: a minimal glTF-binary holding one node (the target's NAME -- library
clips bind by name against the host scene, SS18.10) and one animation with
LINEAR samplers. Import it, flag it Anim, add it to the element's libs, and
`playAnimation("file.glb", {loop: false})` plays it; finished one-shots HOLD
their last frame, so a topple stays toppled.

Usage:
    py -3 clipforge.py spec.json out.glb
    py -3 clipforge.py spec.json out.glb --upload 3d-sandbox   # POST + Anim flag

Pure stdlib, like everything server-side in AE1.
"""

from __future__ import annotations

import json
import math
import struct
import sys
import urllib.request


def euler_to_quat(rx: float, ry: float, rz: float) -> tuple[float, float, float, float]:
    """XYZ-order euler degrees -> quaternion (x, y, z, w), three.js convention."""
    hx, hy, hz = (math.radians(a) / 2 for a in (rx, ry, rz))
    cx, sx = math.cos(hx), math.sin(hx)
    cy, sy = math.cos(hy), math.sin(hy)
    cz, sz = math.cos(hz), math.sin(hz)
    return (
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    )


def axis_angle_quat(axis, deg):
    x, y, z = axis
    n = math.hypot(x, y, z) or 1.0
    h = math.radians(deg) / 2
    s = math.sin(h)
    return (x / n * s, y / n * s, z / n * s, math.cos(h))


def qmul(a, b):
    """Hamilton product a * b (apply b, then a)."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def build_glb(spec: dict) -> bytes:
    node = str(spec["node"])
    clip = str(spec.get("clip", "clip"))
    base = euler_to_quat(*(spec.get("baseline") or [0, 0, 0]))

    keys = spec.get("keys") or []
    times = [float(k["t"]) for k in keys]
    quats = []
    for k in keys:
        q = qmul(axis_angle_quat(k.get("axis", [1, 0, 0]), float(k.get("deg", 0))), base)
        quats.append(q)

    pos_keys = spec.get("position") or []

    # -- the binary buffer: tightly packed float32 accessors ----------------- #
    blob = bytearray()
    views, accessors = [], []

    def push(data: bytes, count: int, comp_type: int, acc_type: str, mn=None, mx=None):
        offset = len(blob)
        blob.extend(data)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        acc = {"bufferView": len(views) - 1, "componentType": comp_type, "count": count, "type": acc_type}
        if mn is not None:
            acc["min"], acc["max"] = mn, mx
        accessors.append(acc)
        return len(accessors) - 1

    samplers, channels = [], []
    if keys:
        t_acc = push(struct.pack(f"<{len(times)}f", *times), len(times), 5126, "SCALAR", [min(times)], [max(times)])
        flat = [c for q in quats for c in q]
        q_acc = push(struct.pack(f"<{len(flat)}f", *flat), len(quats), 5126, "VEC4")
        samplers.append({"input": t_acc, "output": q_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": 0, "path": "rotation"}})
    if pos_keys:
        pt = [float(k["t"]) for k in pos_keys]
        pt_acc = push(struct.pack(f"<{len(pt)}f", *pt), len(pt), 5126, "SCALAR", [min(pt)], [max(pt)])
        flat = [c for k in pos_keys for c in k["xyz"]]
        pv_acc = push(struct.pack(f"<{len(flat)}f", *flat), len(pos_keys), 5126, "VEC3")
        samplers.append({"input": pt_acc, "output": pv_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": 0, "path": "translation"}})

    gltf = {
        "asset": {"version": "2.0", "generator": "AE1 clipforge"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": node}],
        "animations": [{"name": clip, "samplers": samplers, "channels": channels}],
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": accessors,
    }

    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    length = 12 + 8 + len(js) + 8 + len(blob)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, length)  # glTF magic, version, length
    out += struct.pack("<II", len(js), 0x4E4F534A) + js  # JSON chunk
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)  # BIN chunk
    return bytes(out)


def upload(slug: str, name: str, data: bytes, port: int = 8000) -> None:
    base = f"http://localhost:{port}/api/projects/{slug}"
    req = urllib.request.Request(
        f"{base}/media", data=data, method="POST",
        headers={"X-Filename": urllib.parse.quote(name), "Content-Type": "application/octet-stream"},
    )
    entry = json.loads(urllib.request.urlopen(req).read())
    digest = entry.get("hash") or entry.get("digest") or next(iter(entry.values())) if isinstance(entry, dict) else None
    # The Anim flag: a clip library must never merge as scene elements (SS18.10).
    if isinstance(entry, dict) and entry.get("hash"):
        patch = urllib.request.Request(
            f"{base}/media/{entry['hash']}", data=json.dumps({"animOnly": True}).encode(),
            method="PATCH", headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(patch)
        print(f"uploaded + Anim-flagged: {name} ({entry['hash'][:8]}…)")
    else:
        print(f"uploaded: {name} — response {entry!r}; set the Anim pill manually if needed")


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
        slug = sys.argv[sys.argv.index("--upload") + 1]
        import pathlib

        upload(slug, pathlib.Path(sys.argv[2]).name, data)


if __name__ == "__main__":
    main()

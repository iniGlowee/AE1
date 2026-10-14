#!/usr/bin/env python3
"""AE1 - Angel's Egg 1. Local development server.

The filesystem is the only source of truth (DESIGN.md, Principle 1). This server
owns every read and write; the browser is a thin, disposable client. Nothing here
should ever ask the browser to remember something.

Standard library only. Optional packages (Pillow, ffmpeg) are detected at export
time and skipped when absent -- they change the size of a build, never its
correctness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import shutil
import sys
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from exporter import ExportError, export_project

# --------------------------------------------------------------------------- #
# Engine identity
# --------------------------------------------------------------------------- #

ENGINE_NAME = "Angel's Egg"
ENGINE_VERSION = "0.2.0-alpha"  # the public tag line (v0.1.0-alpha, v0.2.0-alpha); 1.0 is not a claim the alpha makes

#: Bumped only when the on-disk shape changes in a way that needs migration.
#: Every .ae1proj records the value it was written with, so a future AE1 can
#: always tell what it is looking at.
PROJECT_FORMAT_VERSION = 1

#: Project types are a registry, not a switch statement. Adding one must never
#: require touching the wizard (DESIGN.md 9).
PROJECT_TYPES: dict[str, dict[str, Any]] = {
    "point-click-adventure": {
        "label": "Point & Click Adventure Game",
        "description": "Scenes, rooms, characters, inventory, dialogue.",
        "available": True,
    },
    "game-3d": {
        "label": "3D Game",
        "description": "glTF scenes and models, lights, a three.js-backed viewport.",
        "available": True,
    },
}

DEFAULT_TYPE = "point-click-adventure"


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #


class Paths:
    """Resolved once at startup so nothing has to guess where it lives."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.projects = self.root / "projects"
        self.exports = self.root / "exports"
        self.editor = self.root / "editor"
        self.engine = self.root / "engine"
        self.vendor = self.root / "vendor"

    def ensure(self) -> None:
        self.projects.mkdir(parents=True, exist_ok=True)
        self.exports.mkdir(parents=True, exist_ok=True)

    @property
    def settings(self) -> Path:
        return self.root / "settings.json"

    def project_file(self, slug: str) -> Path:
        return self.projects / f"{slug}.ae1proj"

    def project_dir(self, slug: str) -> Path:
        return self.projects / slug


PATHS: Paths  # set in main()


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(name: str) -> str:
    """Fold a display name into a filesystem-safe slug.

    Display names stay free-form and live in the project file. Slugs are what
    touch the disk, so they are conservative on purpose: a name is not allowed to
    smuggle a path separator, a traversal, or a reserved Windows device name into
    a filesystem operation.
    """
    slug = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")

    # CON, PRN, AUX, NUL, COM1-9, LPT1-9 are unusable as filenames on Windows and
    # fail in ways that look like permission bugs.
    if re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])", slug):
        slug = f"{slug}-project"

    return slug or "untitled"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: Any) -> None:
    """Write atomically.

    Continuous journaling (DESIGN.md 3.1) means this runs constantly while the
    user works. A half-written project file on a crash would corrupt exactly the
    work the journal exists to protect, so writes land on a temp file and are
    swapped into place.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    tmp.replace(path)


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class RawBody:
    """An undecoded request body plus its headers, for `raw=True` routes."""

    __slots__ = ("data", "headers")

    def __init__(self, data: bytes, headers: Any) -> None:
        self.data = data
        self.headers = headers


# --------------------------------------------------------------------------- #
# Project store
# --------------------------------------------------------------------------- #


def scaffold_project(slug: str, name: str, ptype: str, metadata: dict) -> dict:
    """Create the project file and its directory tree."""
    pdir = PATHS.project_dir(slug)

    for sub in ("scenes", "media", "scripts", "snapshots", "saves"):
        (pdir / sub).mkdir(parents=True, exist_ok=True)

    # Media is content-addressed: files are named by hash, and this manifest maps
    # hash -> friendly name. That gives dedup, free renames, and references that
    # cannot dangle (DESIGN.md 4.1).
    write_json(pdir / "media" / "manifest.json", {"entries": {}})

    scene_id = str(uuid.uuid4())
    write_json(
        pdir / "scenes" / "scene-1.json",
        {
            "id": scene_id,
            "name": "Scene 1",
            "elements": {},
            "created": now_iso(),
        },
    )

    project = {
        "ae1": {
            "engine": ENGINE_NAME,
            "engineVersion": ENGINE_VERSION,
            "formatVersion": PROJECT_FORMAT_VERSION,
        },
        "id": str(uuid.uuid4()),
        "name": name,
        "slug": slug,
        "folder": slug,
        "type": ptype,
        "created": now_iso(),
        "modified": now_iso(),
        "opened": now_iso(),
        # An open map, deliberately. The wizard will grow fields and must never
        # need a migration to do it (DESIGN.md 9).
        "metadata": metadata,
        "scenes": ["scene-1.json"],
        "entryScene": "scene-1.json",
    }

    write_json(PATHS.project_file(slug), project)
    return project


def list_projects() -> list[dict]:
    projects = []
    for pf in sorted(PATHS.projects.glob("*.ae1proj")):
        try:
            data = read_json(pf)
        except (json.JSONDecodeError, OSError) as exc:
            # A corrupt project must not take down the whole list. Surface it as
            # a broken entry so the user can see and delete it.
            projects.append(
                {
                    "slug": pf.stem,
                    "name": pf.stem,
                    "broken": True,
                    "error": str(exc),
                }
            )
            continue

        data["exists"] = PATHS.project_dir(data.get("folder", pf.stem)).is_dir()
        projects.append(data)

    projects.sort(key=lambda p: p.get("opened") or "", reverse=True)
    return projects


def load_project(slug: str) -> dict:
    pf = PATHS.project_file(slug)
    if not pf.is_file():
        raise ApiError(404, f"No project named '{slug}'.")
    return read_json(pf)


def create_project(body: dict) -> dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "A project name is required.")

    ptype = body.get("type") or DEFAULT_TYPE
    info = PROJECT_TYPES.get(ptype)
    if not info:
        raise ApiError(400, f"Unknown project type '{ptype}'.")
    if not info["available"]:
        raise ApiError(400, f"{info['label']} is not implemented yet.")

    slug = slugify(name)
    if PATHS.project_file(slug).exists():
        raise ApiError(409, f"A project named '{name}' already exists.")

    metadata = body.get("metadata") or {}
    return scaffold_project(slug, name, ptype, metadata)


def update_project(slug: str, body: dict) -> dict:
    project = load_project(slug)

    if "metadata" in body:
        project.setdefault("metadata", {}).update(body["metadata"])

    if "opened" in body:
        project["opened"] = now_iso()

    new_name = (body.get("name") or "").strip()
    if new_name and new_name != project["name"]:
        project["name"] = new_name
        # The slug is intentionally NOT recomputed. Renaming a project should not
        # move its folder, invalidate paths, or race the journal. The display name
        # is what the user sees; the slug is an internal address.

    project["modified"] = now_iso()
    write_json(PATHS.project_file(slug), project)
    return project


def delete_project(slug: str) -> dict:
    pf = PATHS.project_file(slug)
    if not pf.is_file():
        raise ApiError(404, f"No project named '{slug}'.")

    project = read_json(pf)
    pdir = PATHS.project_dir(project.get("folder", slug))

    # Never delete outside /projects, whatever the project file claims its folder
    # is. The file is data, and data does not get to pick deletion targets.
    resolved = pdir.resolve()
    if resolved.parent != PATHS.projects or not resolved.is_relative_to(PATHS.projects):
        raise ApiError(400, "Project folder is outside /projects; refusing to delete.")

    if resolved.is_dir():
        shutil.rmtree(resolved)
    pf.unlink()

    return {"deleted": slug}


# --------------------------------------------------------------------------- #
# Samples: the shipped projects, kept pristine (MANAGER-PROJECT-01 W3b/W4/W5)
# --------------------------------------------------------------------------- #

#: The SHIPPED copy of every sample project, read-only by convention. A user's
#: projects/<slug> is their working copy and can be broken in two keystrokes
#: (select-all, delete in the script pane); this is what "restore" reads.
#: Resolved from this file, not from PATHS: a multi-tenant host swaps PATHS per
#: visitor, but the samples are the app's own and live beside server.py.
SAMPLES_DIR = Path(__file__).resolve().parent / "samples"

#: Never part of a sample's comparison or copy: player saves belong to a
#: playthrough, snapshots to the author's history, .tmp files to a write in flight.
_SAMPLE_SKIP_DIRS = {"saves", "snapshots"}


def sample_of(project: dict) -> str | None:
    """The sample a project came from: itself if it IS one, else its `basedOn`.

    A sample is identified by its folder having a twin in samples/; a project
    copied from one (save-as) records `basedOn` and is NOT itself a sample, so it
    can restore a shipped SCRIPT but never be reset wholesale."""
    based = project.get("basedOn")
    if based and (SAMPLES_DIR / based).is_dir():
        return based
    folder = project.get("folder") or project.get("slug")
    if not based and folder and (SAMPLES_DIR / folder).is_dir():
        return folder
    return None


def is_sample(project: dict) -> bool:
    return not project.get("basedOn") and sample_of(project) is not None


def _project_dir_of(slug: str) -> tuple[dict, Path]:
    project = load_project(slug)
    pdir = PATHS.project_dir(project.get("folder", slug)).resolve()
    if not pdir.is_relative_to(PATHS.projects):
        raise ApiError(400, "Project folder is outside /projects.")
    return project, pdir


def _tree_files(root: Path) -> dict[str, Path]:
    """relative posix path -> file, skipping saves/snapshots/.tmp."""
    out: dict[str, Path] = {}
    if not root.is_dir():
        return out
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix == ".tmp":
            continue
        rel = path.relative_to(root)
        if rel.parts and rel.parts[0] in _SAMPLE_SKIP_DIRS:
            continue
        out[rel.as_posix()] = path
    return out


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


_TEXT_SUFFIXES = {".json", ".txt", ".md", ".css", ".html", ".js"}


def _same_file(a: Path, b: Path) -> bool:
    """Equal as CONTENT, not as bytes: the editor re-saves JSON in its own
    formatting and a Windows checkout may hold CRLF, and neither is a change a
    user made — the first live test listed an untouched hud.json as a loss.
    JSON compares by value, text with newlines normalised, the rest by bytes."""
    if a.suffix.lower() in _TEXT_SUFFIXES or a.name.endswith(".ags.txt"):
        try:
            ta = a.read_text(encoding="utf-8").replace("\r\n", "\n")
            tb = b.read_text(encoding="utf-8").replace("\r\n", "\n")
        except (OSError, UnicodeDecodeError):
            return _digest(a) == _digest(b)
        if a.suffix.lower() == ".json":
            try:
                return json.loads(ta) == json.loads(tb)
            except json.JSONDecodeError:
                pass
        return ta.rstrip("\n") == tb.rstrip("\n")
    return _digest(a) == _digest(b)


def _scene_changes(old: Path | None, new: Path | None) -> dict:
    """Element-level difference of one scene file, by element id, named."""
    def els(path):
        if path is None:
            return {}
        try:
            data = read_json(path)
        except (json.JSONDecodeError, OSError):
            return {}
        e = data.get("elements") or {}
        return e if isinstance(e, dict) else {str(i): v for i, v in enumerate(e)}

    a, b = els(old), els(new)
    name = lambda d: (d or {}).get("name") or "(unnamed)"
    return {
        "added": sorted(name(b[k]) for k in b.keys() - a.keys()),
        "removed": sorted(name(a[k]) for k in a.keys() - b.keys()),
        "changed": sorted(name(b[k]) for k in a.keys() & b.keys() if a[k] != b[k]),
    }


def sample_diff(slug: str) -> dict:
    """What a restore would LOSE, in the user's terms (W5: the confirm names it).

    The project against its shipped twin: scripts edited or added, media added
    (by the name the Media Collection shows), and per scene the elements added,
    removed or changed, by name."""
    project, pdir = _project_dir_of(slug)
    sample = sample_of(project)
    if not sample:
        raise ApiError(404, f"'{slug}' is not based on a sample project.")
    mine, shipped = _tree_files(pdir), _tree_files(SAMPLES_DIR / sample)
    manifest = {}
    try:
        manifest = read_json(pdir / "media" / "manifest.json").get("entries", {})
    except (json.JSONDecodeError, OSError):
        pass

    out = {"sample": sample, "scripts": {"added": [], "changed": [], "removed": []},
           "media": {"added": [], "removed": []}, "scenes": {}, "other": []}
    for rel in sorted(mine.keys() | shipped.keys()):
        a, b = shipped.get(rel), mine.get(rel)
        if a and b and _same_file(a, b):
            continue
        top = rel.split("/", 1)[0]
        if top == "scripts":
            kind = "added" if not a else "removed" if not b else "changed"
            out["scripts"][kind].append(rel.split("/", 1)[1])
        elif top == "media":
            if rel.endswith("manifest.json"):
                continue  # the media rows below already say what changed
            digest = Path(rel).stem
            label = (manifest.get(digest) or {}).get("name", Path(rel).name)
            if not a:
                out["media"]["added"].append(label)
            elif not b:
                out["media"]["removed"].append(label)
        elif top == "scenes" and rel.endswith(".json"):
            ch = _scene_changes(a, b)
            if any(ch.values()) or not a or not b:
                ch["file"] = rel.split("/", 1)[1]
                ch["new"] = not a
                ch["deleted"] = not b
                out["scenes"][ch["file"]] = ch
        else:
            out["other"].append(rel)
    out["changed"] = bool(
        any(out["scripts"].values()) or any(out["media"].values()) or out["scenes"] or out["other"]
    )
    return out


def copy_project(slug: str, body: dict) -> dict:
    """Save-as (W4): copy a project to a new name and slug; the original is untouched."""
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "A name for the copy is required.")
    project, src = _project_dir_of(slug)
    new_slug = slugify(name)
    if PATHS.project_file(new_slug).exists() or PATHS.project_dir(new_slug).exists():
        raise ApiError(409, f"A project named '{name}' already exists.")
    dst = PATHS.project_dir(new_slug)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("*.tmp"))

    copy = json.loads(json.dumps(project))
    copy.update({
        "id": str(uuid.uuid4()),
        "name": name,
        "slug": new_slug,
        "folder": new_slug,
        "created": now_iso(),
        "modified": now_iso(),
        "opened": now_iso(),
        "copiedFrom": project.get("slug", slug),
    })
    # A copy of a sample (or of a copy of one) can still restore a shipped SCRIPT,
    # but is never itself a sample: restore-the-sample stays on the original.
    based = sample_of(project)
    copy.pop("basedOn", None)
    if based:
        copy["basedOn"] = based
    write_json(PATHS.project_file(new_slug), copy)
    return copy


def restore_sample(slug: str) -> dict:
    """Reset a sample project to its shipped state (W5). Destructive by design;
    the editor only calls it after a confirm that names the loss (sample_diff)
    and offers save-as first. The new tree is built beside the old one and
    swapped in, so a failure part-way leaves the project as it was."""
    project, pdir = _project_dir_of(slug)
    if not is_sample(project):
        raise ApiError(400, f"'{slug}' is not a sample project; only a sample can be restored.")
    sample = sample_of(project)
    src = SAMPLES_DIR / sample
    staging = pdir.with_name(f".{pdir.name}.restoring")
    retired = pdir.with_name(f".{pdir.name}.retired")
    for stale in (staging, retired):
        if stale.exists():
            shutil.rmtree(stale)
    shutil.copytree(src, staging)
    # keep the player's saves: a restore resets the PROJECT, not a playthrough
    if (pdir / "saves").is_dir():
        shutil.copytree(pdir / "saves", staging / "saves", dirs_exist_ok=True)
    pdir.rename(retired)
    staging.rename(pdir)
    shutil.rmtree(retired, ignore_errors=True)

    shipped_file = SAMPLES_DIR / f"{sample}.ae1proj"
    restored = read_json(shipped_file) if shipped_file.is_file() else dict(project)
    restored.update({
        "id": project.get("id", restored.get("id")),
        "slug": project.get("slug", slug),
        "folder": project.get("folder", slug),
        "modified": now_iso(),
        "opened": now_iso(),
        "restoredFromSample": now_iso(),
    })
    write_json(PATHS.project_file(slug), restored)
    return restored


# --------------------------------------------------------------------------- #
# Scenes
# --------------------------------------------------------------------------- #


def scene_path(slug: str, filename: str) -> Path:
    """Resolve a scene file, refusing anything that escapes the project.

    The filename arrives from the client. It is matched against a strict pattern
    rather than merely cleaned, because "reject what isn't obviously fine" fails
    safe while "strip what looks bad" is a guessing game.
    """
    if not re.fullmatch(r"[\w-]+\.json", filename):
        raise ApiError(400, f"Invalid scene filename: '{filename}'.")

    project = load_project(slug)
    path = (PATHS.project_dir(project.get("folder", slug)) / "scenes" / filename).resolve()

    if not path.is_relative_to(PATHS.projects):
        raise ApiError(400, "Scene path escapes /projects.")

    return path


# --------------------------------------------------------------------------- #
# Saves
# --------------------------------------------------------------------------- #

#: SOMENAME.ae1save.json -- the type is JSON, the full suffix identifies it.
#: Same idea as .ags.txt: openable in any editor, obvious what it is.
SAVE_RE = re.compile(r"[\w.-]+\.ae1save\.json")


def saves_dir(slug: str) -> Path:
    project = load_project(slug)
    return PATHS.project_dir(project.get("folder", slug)) / "saves"


def save_path(slug: str, filename: str) -> Path:
    if not SAVE_RE.fullmatch(filename):
        raise ApiError(400, f"Save files must be named SOMENAME.ae1save.json (got '{filename}').")

    path = (saves_dir(slug) / filename).resolve()
    if not path.is_relative_to(PATHS.projects):
        raise ApiError(400, "Save path escapes /projects.")
    return path


def list_saves(slug: str) -> list[dict]:
    """Saves, newest first, with enough to show a load list.

    Reads each file's envelope rather than trusting the filename: these are meant
    to be hand-edited and renamed, so the file's own claim about when it was saved
    and where the player was beats anything encoded in its name.
    """
    sdir = saves_dir(slug)
    if not sdir.is_dir():
        return []

    out = []
    for f in sdir.glob("*.ae1save.json"):
        entry = {"file": f.name, "size": f.stat().st_size}
        try:
            data = read_json(f)
            entry.update(
                {
                    "saved": data.get("saved"),
                    "scene": data.get("scene"),
                    "sceneName": data.get("sceneName"),
                    "saveFormat": (data.get("ae1") or {}).get("saveFormat"),
                }
            )
        except (json.JSONDecodeError, OSError) as exc:
            # A broken save must appear in the list so it can be deleted, not
            # vanish and leave the author wondering where it went.
            entry["broken"] = str(exc)
        out.append(entry)

    out.sort(key=lambda s: s.get("saved") or "", reverse=True)
    return out


def hud_path(slug: str) -> Path:
    """The persistent element layer.

    Lives beside scenes/ rather than inside one, because HUD elements must
    survive a scene change. If they lived in scenes, every scene would carry its
    own copy and the inventory would reset at every door (DESIGN.md §12).
    """
    project = load_project(slug)
    return PATHS.project_dir(project.get("folder", slug)) / "hud.json"


def load_hud(slug: str) -> dict:
    path = hud_path(slug)
    if not path.is_file():
        return {"name": "HUD", "elements": {}}
    try:
        return read_json(path)
    except (json.JSONDecodeError, OSError):
        return {"name": "HUD", "elements": {}}


def list_scenes(slug: str) -> list[dict]:
    project = load_project(slug)
    sdir = PATHS.project_dir(project.get("folder", slug)) / "scenes"
    if not sdir.is_dir():
        return []

    scenes = []
    for f in sorted(sdir.glob("*.json")):
        try:
            data = read_json(f)
            scenes.append({"file": f.name, "id": data.get("id"), "name": data.get("name", f.stem)})
        except (json.JSONDecodeError, OSError):
            scenes.append({"file": f.name, "name": f.stem, "broken": True})
    return scenes


# --------------------------------------------------------------------------- #
# Media (content-addressed)
# --------------------------------------------------------------------------- #

#: Enough of a sha256 to make an accidental collision impossible in practice,
#: short enough that the filenames stay readable in a directory listing.
HASH_LEN = 32

KINDS = {
    "image": {"png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"},
    "audio": {"wav", "mp3", "ogg", "m4a", "flac", "opus"},
    "video": {"mp4", "webm", "ogv", "mov"},
    "model": {"gltf", "glb", "obj", "fbx", "stl"},
}


def kind_for(ext: str) -> str:
    for kind, exts in KINDS.items():
        if ext in exts:
            return kind
    return "other"


def media_dir(slug: str) -> Path:
    project = load_project(slug)
    return PATHS.project_dir(project.get("folder", slug)) / "media"


def media_manifest(slug: str) -> dict:
    path = media_dir(slug) / "manifest.json"
    if not path.is_file():
        return {"entries": {}}
    try:
        data = read_json(path)
        data.setdefault("entries", {})
        return data
    except (json.JSONDecodeError, OSError):
        # A corrupt manifest must not hide the files. Rebuilding the names is
        # impossible, but the assets themselves are still on disk under their
        # hashes -- losing the manifest must never mean losing the media.
        return {"entries": {}}


def write_manifest(slug: str, manifest: dict) -> None:
    write_json(media_dir(slug) / "manifest.json", manifest)


def import_media(slug: str, filename: str, blob: bytes) -> dict:
    """Store a file by the hash of its contents.

    Content addressing (DESIGN.md 4.1) buys three things at once: the same asset
    used in forty scenes exists once on disk and once in the export; renaming
    touches one manifest line and never a file; and a scene's reference can never
    dangle from a rename, because it points at content rather than at a name.
    """
    ext = Path(filename).suffix.lstrip(".").lower() or "bin"
    digest = hashlib.sha256(blob).hexdigest()[:HASH_LEN]

    mdir = media_dir(slug)
    mdir.mkdir(parents=True, exist_ok=True)
    path = mdir / f"{digest}.{ext}"

    manifest = media_manifest(slug)
    existing = manifest["entries"].get(digest)

    # Re-importing identical bytes is a no-op, not a duplicate. Dropping the same
    # folder twice should cost nothing and change nothing.
    if not path.is_file():
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(blob)
        tmp.replace(path)

    entry = existing or {
        "name": Path(filename).name,
        "ext": ext,
        "kind": kind_for(ext),
        "size": len(blob),
        "imported": now_iso(),
        "tags": [],
    }
    manifest["entries"][digest] = entry
    write_manifest(slug, manifest)

    return {"hash": digest, "duplicate": bool(existing), **entry}


# --------------------------------------------------------------------------- #
# Scripts (.ags.txt)
# --------------------------------------------------------------------------- #

#: SOMENAME.ags.txt -- the type is text, the full suffix is what identifies it.
AGS_RE = re.compile(r"[\w-]+\.ags\.txt")


def script_path(slug: str, filename: str) -> Path:
    if not AGS_RE.fullmatch(filename):
        raise ApiError(400, f"Angel Script files must be named SOMENAME.ags.txt (got '{filename}').")

    project = load_project(slug)
    path = (PATHS.project_dir(project.get("folder", slug)) / "scripts" / filename).resolve()

    if not path.is_relative_to(PATHS.projects):
        raise ApiError(400, "Script path escapes /projects.")

    return path


def list_scripts(slug: str) -> dict[str, str]:
    """Return every script's source.

    All of them, not a file listing: resolving `extends` needs the whole set in
    hand anyway, and a project's scripts are a few KB of text. One request beats
    N round-trips to discover a chain.
    """
    project = load_project(slug)
    sdir = PATHS.project_dir(project.get("folder", slug)) / "scripts"
    if not sdir.is_dir():
        return {}

    out = {}
    for f in sorted(sdir.glob("*.ags.txt")):
        try:
            out[f.name] = f.read_text(encoding="utf-8")
        except OSError as exc:
            out[f.name] = f"; unreadable: {exc}"
    return out


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

#: Durable UI settings. These live on the server rather than in localStorage for
#: one reason: AE1 runs in incognito, so localStorage is wiped on every close.
#: A panel layout the user spent time arranging is WORK, not a disposable
#: preference -- losing it every launch would be a bug wearing a principle's
#: clothes. localStorage keeps only genuinely throwaway session state.
DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "dark",
    "layouts": {},  # projectType -> area tree
}


def load_settings() -> dict:
    if not PATHS.settings.is_file():
        return dict(DEFAULT_SETTINGS)
    try:
        return {**DEFAULT_SETTINGS, **read_json(PATHS.settings)}
    except (json.JSONDecodeError, OSError):
        # Settings are cosmetic. A corrupt file must never block the editor.
        return dict(DEFAULT_SETTINGS)


def save_settings(patch: dict) -> dict:
    settings = load_settings()
    settings.update(patch)
    write_json(PATHS.settings, settings)
    return settings


# --------------------------------------------------------------------------- #
# Routing
# --------------------------------------------------------------------------- #

Handler = Callable[..., Any]
#: (method, pattern, handler, raw)
ROUTES: list[tuple[str, re.Pattern, Handler, bool]] = []


def route(method: str, pattern: str, raw: bool = False) -> Callable[[Handler], Handler]:
    """Register a route. `raw=True` hands the handler undecoded bytes."""

    def wrap(fn: Handler) -> Handler:
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn, raw))
        return fn

    return wrap


@route("GET", r"/api/status")
def api_status(_body):
    return {
        "engine": ENGINE_NAME,
        "version": ENGINE_VERSION,
        "formatVersion": PROJECT_FORMAT_VERSION,
        "projectTypes": PROJECT_TYPES,
    }


@route("GET", r"/api/settings")
def api_settings_get(_body):
    return load_settings()


@route("PATCH", r"/api/settings")
def api_settings_patch(body):
    return save_settings(body)


@route("GET", r"/api/projects")
def api_list(_body):
    return {"projects": list_projects()}


@route("POST", r"/api/projects")
def api_create(body):
    return create_project(body)


@route("GET", r"/api/projects/([\w-]+)")
def api_get(_body, slug):
    return load_project(slug)


@route("PATCH", r"/api/projects/([\w-]+)")
def api_update(body, slug):
    return update_project(slug, body)


@route("DELETE", r"/api/projects/([\w-]+)")
def api_delete(_body, slug):
    return delete_project(slug)


@route("POST", r"/api/projects/([\w-]+)/copy")
def api_project_copy(body, slug):
    return copy_project(slug, body)


@route("GET", r"/api/projects/([\w-]+)/sample")
def api_project_sample(_body, slug):
    project = load_project(slug)
    sample = sample_of(project)
    scripts = sorted(p.name for p in (SAMPLES_DIR / sample / "scripts").glob("*.ags.txt")) if sample else []
    return {"sample": sample, "isSample": is_sample(project), "scripts": scripts}


@route("GET", r"/api/projects/([\w-]+)/sample/scripts/([\w.-]+)")
def api_project_sample_script(_body, slug, filename):
    if not AGS_RE.fullmatch(filename):
        raise ApiError(400, f"Angel Script files must be named SOMENAME.ags.txt (got '{filename}').")
    sample = sample_of(load_project(slug))
    path = (SAMPLES_DIR / sample / "scripts" / filename).resolve() if sample else None
    if not path or not path.is_relative_to(SAMPLES_DIR) or not path.is_file():
        raise ApiError(404, f"No shipped version of '{filename}' for this project.")
    return {"file": filename, "sample": sample, "content": path.read_text(encoding="utf-8")}


@route("GET", r"/api/projects/([\w-]+)/sample/diff")
def api_project_sample_diff(_body, slug):
    return sample_diff(slug)


@route("POST", r"/api/projects/([\w-]+)/sample/restore")
def api_project_sample_restore(_body, slug):
    return restore_sample(slug)


@route("POST", r"/api/projects/([\w-]+)/media", raw=True)
def api_media_upload(req, slug):
    """Import one file, sent as a raw body.

    Deliberately NOT multipart. cgi.FieldStorage -- the stdlib's multipart parser
    -- was removed in Python 3.13, and hand-rolling multipart to upload files the
    browser can already POST directly would be work in exchange for nothing. One
    request per file also gives per-file progress and per-file failure, which a
    single batched multipart post does not.
    """
    raw_name = req.headers.get("X-Filename")
    if not raw_name:
        raise ApiError(400, "X-Filename header is required.")
    if not req.data:
        raise ApiError(400, "Empty file.")

    # Percent-encoded by the client: a header may only carry latin-1, and asset
    # filenames are full of spaces, accents, and CJK.
    filename = urllib.parse.unquote(raw_name)
    return import_media(slug, filename, req.data)


@route("POST", r"/api/projects/([\w-]+)/export")
def api_export(_body, slug):
    """Build & ship. The server writes /exports/<slug>/ directly.

    Synchronous on purpose: a point-and-click project is a few MB, so this takes
    well under a second. A progress-streaming build for work this size would be
    machinery in exchange for nothing.

    Body may carry {"target": "browser"|"agp"} — browser (default) is the
    self-contained web build; agp is the standalone AE1 Game Package the
    native runtime reads (§21). A different target writes a SEPARATE output
    folder (exports/<slug>-agp) so the two never clobber each other.
    """
    project = load_project(slug)
    folder = project.get("folder", slug)
    target = (isinstance(_body, dict) and _body.get("target")) or "browser"
    out = PATHS.exports / (folder if target == "browser" else f"{folder}-{target}")

    try:
        report = export_project(
            project=project,
            project_dir=PATHS.project_dir(folder),
            engine_dir=PATHS.engine,
            out_dir=out,
            version=ENGINE_VERSION,
            target=target,
            log=lambda m: sys.stderr.write(f"  [export] {m}\n"),
        )
    except ExportError as exc:
        raise ApiError(400, str(exc)) from exc

    out_folder = out.name
    report["url"] = f"/exports/{out_folder}/{report.get('entry', 'index.html')}"
    return report


@route("GET", r"/api/projects/([\w-]+)/media")
def api_media_list(_body, slug):
    return media_manifest(slug)


@route("PATCH", r"/api/projects/([\w-]+)/media/([0-9a-f]+)")
def api_media_patch(body, slug, digest):
    manifest = media_manifest(slug)
    entry = manifest["entries"].get(digest)
    if not entry:
        raise ApiError(404, "No such media.")

    # Renaming touches this line and nothing else. The file keeps its hash name,
    # and every scene reference keeps pointing at content rather than at a label.
    # `animOnly` marks a glb as an ANIMATION LIBRARY: clips only, never merged
    # into the scene as elements, mesh never rendered (DESIGN.md §18.10).
    # `merged` records that a glb was decomposed into elements ONCE — deleting
    # those elements must be permanent, not an invitation to re-merge.
    for key in ("name", "tags", "animOnly", "merged"):
        if key in body:
            entry[key] = body[key]

    write_manifest(slug, manifest)
    return entry


@route("DELETE", r"/api/projects/([\w-]+)/media/([0-9a-f]+)")
def api_media_delete(_body, slug, digest):
    manifest = media_manifest(slug)
    entry = manifest["entries"].pop(digest, None)
    if not entry:
        raise ApiError(404, "No such media.")

    path = media_dir(slug) / f"{digest}.{entry['ext']}"
    resolved = path.resolve()
    if resolved.is_relative_to(PATHS.projects) and resolved.is_file():
        resolved.unlink()

    write_manifest(slug, manifest)
    return {"deleted": digest}


@route("GET", r"/api/projects/([\w-]+)/scripts")
def api_scripts_list(_body, slug):
    return {"scripts": list_scripts(slug)}


@route("GET", r"/api/projects/([\w-]+)/scripts/([\w.-]+)")
def api_script_get(_body, slug, filename):
    path = script_path(slug, filename)
    if not path.is_file():
        raise ApiError(404, f"No script '{filename}'.")
    return {"file": filename, "content": path.read_text(encoding="utf-8")}


@route("POST", r"/api/projects/([\w-]+)/scripts/([\w.-]+)")
@route("PUT", r"/api/projects/([\w-]+)/scripts/([\w.-]+)")
def api_script_put(body, slug, filename):
    path = script_path(slug, filename)
    content = body.get("content")
    if not isinstance(content, str):
        raise ApiError(400, "Body must be {\"content\": \"…\"}.")

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)
    return {"saved": filename, "at": now_iso()}


@route("DELETE", r"/api/projects/([\w-]+)/scripts/([\w.-]+)")
def api_script_delete(_body, slug, filename):
    path = script_path(slug, filename)
    if path.is_file():
        path.unlink()
    return {"deleted": filename}


@route("GET", r"/api/projects/([\w-]+)/saves")
def api_saves_list(_body, slug):
    return {"saves": list_saves(slug)}


@route("POST", r"/api/projects/([\w-]+)/saves")
def api_save_create(body, slug):
    """Write a save. The editor's silent background write.

    Only the EDITOR gets this. A shipped game has no server and hands the player
    a file instead -- which is the constraint that makes saves moddable.
    """
    name = body.get("name") or ""
    data = body.get("data")
    if not isinstance(data, dict):
        raise ApiError(400, 'Body must be {"name": "…", "data": {…}}.')

    path = save_path(slug, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, data)
    return {"saved": name, "at": now_iso()}


@route("GET", r"/api/projects/([\w-]+)/saves/([\w.-]+)")
def api_save_get(_body, slug, filename):
    path = save_path(slug, filename)
    if not path.is_file():
        raise ApiError(404, f"No save '{filename}'.")
    return read_json(path)


@route("DELETE", r"/api/projects/([\w-]+)/saves/([\w.-]+)")
def api_save_delete(_body, slug, filename):
    path = save_path(slug, filename)
    if path.is_file():
        path.unlink()
    return {"deleted": filename}


@route("GET", r"/api/projects/([\w-]+)/hud")
def api_hud_get(_body, slug):
    return load_hud(slug)


@route("POST", r"/api/projects/([\w-]+)/hud")
@route("PUT", r"/api/projects/([\w-]+)/hud")
def api_hud_put(body, slug):
    write_json(hud_path(slug), body)
    return {"saved": "hud.json", "at": now_iso()}


@route("GET", r"/api/projects/([\w-]+)/scenes")
def api_scenes_list(_body, slug):
    return {"scenes": list_scenes(slug)}


@route("POST", r"/api/projects/([\w-]+)/scenes")
def api_scene_create(body, slug):
    """Add a scene to a project."""
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "A scene name is required.")

    project = load_project(slug)
    sdir = PATHS.project_dir(project.get("folder", slug)) / "scenes"
    sdir.mkdir(parents=True, exist_ok=True)

    base = slugify(name)
    file = f"{base}.json"
    # Two scenes called "Kitchen" is a reasonable thing to want; silently
    # overwriting the first one is not.
    n = 2
    while (sdir / file).exists():
        file = f"{base}-{n}.json"
        n += 1

    write_json(sdir / file, {"id": str(uuid.uuid4()), "name": name, "elements": {}, "created": now_iso()})

    project.setdefault("scenes", []).append(file)
    project["modified"] = now_iso()
    write_json(PATHS.project_file(slug), project)

    return {"file": file, "name": name}


@route("DELETE", r"/api/projects/([\w-]+)/scenes/([\w.-]+)")
def api_scene_delete(_body, slug, filename):
    path = scene_path(slug, filename)
    project = load_project(slug)

    scenes = list_scenes(slug)
    if len(scenes) <= 1:
        raise ApiError(400, "A project needs at least one scene.")
    if project.get("entryScene") == filename:
        raise ApiError(400, "This is the entry scene. Make another scene the entry first.")

    if path.is_file():
        path.unlink()

    project["scenes"] = [s for s in project.get("scenes", []) if s != filename]
    project["modified"] = now_iso()
    write_json(PATHS.project_file(slug), project)
    return {"deleted": filename}


@route("GET", r"/api/projects/([\w-]+)/scenes/([\w.-]+)")
def api_scene_get(_body, slug, filename):
    path = scene_path(slug, filename)
    if not path.is_file():
        raise ApiError(404, f"No scene '{filename}'.")
    return read_json(path)


@route("POST", r"/api/projects/([\w-]+)/scenes/([\w.-]+)")
@route("PUT", r"/api/projects/([\w-]+)/scenes/([\w.-]+)")
def api_scene_put(body, slug, filename):
    """The journaling target. Called constantly while the user works.

    write_json is atomic (temp file + replace), which matters most here: a crash
    mid-write would corrupt exactly the work the journal exists to protect.

    POST is accepted alongside PUT for one reason: navigator.sendBeacon, the
    editor's unload backstop, can only issue POST. Same handler, same semantics.
    """
    path = scene_path(slug, filename)
    write_json(path, body)

    # Touch the project so the list orders by real activity, not by last open.
    try:
        project = load_project(slug)
        project["modified"] = now_iso()
        write_json(PATHS.project_file(slug), project)
    except ApiError:
        pass

    return {"saved": filename, "at": now_iso()}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

#: Root-level markdown the docs viewer (editor/docs.html) may read. A named
#: allowlist, not a *.md glob — the viewer is a reader for OUR docs, not a
#: file browser.
ROOT_DOCS = ("DESIGN.md", "respawn.md", "README.md")

#: `exports` is served so a build can be played from the editor without a second
#: server. It is output, not source. `docs` feeds the docs viewer.
STATIC_ROOTS = ("editor", "engine", "vendor", "projects", "exports", "docs")

#: Media files are named by content hash, so they may be cached forever. The
#: manifest is NOT: it holds friendly names, which change.
MEDIA_PATH_RE = re.compile(r"projects/[\w-]+/media/[0-9a-f]{8,}\.\w+$")


class AE1Handler(BaseHTTPRequestHandler):
    server_version = f"AE1/{ENGINE_VERSION}"
    # §18.87: HTTP/1.1 = keep-alive. The 1.0 default opened a fresh TCP
    # connection per asset — a cold scene load with 40 media files paid the
    # handshake 40 times.
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------- #

    def log_message(self, fmt: str, *args: Any) -> None:
        # The default logger prints every asset fetch, which buries real errors
        # under scene-load noise.
        if not args or str(args[0]).startswith(("GET /api", "POST", "PATCH", "DELETE")):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, status: int, body: bytes, ctype: str, immutable: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))

        # Content-addressed media is immutable BY DEFINITION -- the filename is
        # the hash of the bytes, so those bytes can never change. Caching it hard
        # is free correctness, and it is the reason a scene with 200 sprites does
        # not re-fetch all of them on every reload. Everything else is live
        # authoring source, where a stale cache would show the user old work and
        # look exactly like data loss.
        if immutable:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")

        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, data: Any) -> None:
        self._send(status, json.dumps(data, indent=2).encode("utf-8"), "application/json")

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ApiError(400, "Request body is not valid JSON.")

    def _read_raw(self) -> bytes:
        """Read an undecoded body, in chunks.

        A single rfile.read(length) on a 200MB video would allocate the whole
        thing at once and can short-read on a slow socket.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return b""

        chunks = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    # -- dispatch ---------------------------------------------------------- #

    def _dispatch(self, method: str) -> None:
        path = self.path.split("?", 1)[0]

        for rmethod, pattern, fn, raw in ROUTES:
            if rmethod != method:
                continue
            match = pattern.match(path)
            if not match:
                continue
            try:
                if raw:
                    body = RawBody(self._read_raw(), self.headers)
                elif method in ("POST", "PATCH", "PUT"):
                    body = self._read_body()
                else:
                    body = {}
                result = fn(body, *match.groups())
                self._send_json(200, result)
            except ApiError as exc:
                self._send_json(exc.status, {"error": exc.message})
            except Exception as exc:  # noqa: BLE001
                import traceback

                traceback.print_exc()
                self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
            return

        if method == "GET":
            self._serve_static(path)
        else:
            self._send_json(404, {"error": f"No route for {method} {path}"})

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    # -- static ------------------------------------------------------------ #

    def _serve_static(self, path: str) -> None:
        rel = path.lstrip("/")
        if rel in ("", "index.html"):
            target = PATHS.editor / "index.html"
        elif rel in ROOT_DOCS:
            # the docs viewer reads the root-level markdown (DESIGN, respawn)
            target = PATHS.root / rel
        else:
            top = rel.split("/", 1)[0]
            if top not in STATIC_ROOTS:
                self._send_json(404, {"error": f"Not found: {path}"})
                return
            target = PATHS.root / rel

        # Resolve before comparing. A path is only safe if where it actually
        # lands is inside the root, not if it merely looks fine as a string.
        try:
            resolved = target.resolve()
        except OSError:
            self._send_json(404, {"error": f"Not found: {path}"})
            return

        if not resolved.is_relative_to(PATHS.root) or not resolved.is_file():
            self._send_json(404, {"error": f"Not found: {path}"})
            return

        ctype, _ = mimetypes.guess_type(str(resolved))
        # /projects/<slug>/media/<hash>.<ext> — the hash IS the content.
        immutable = MEDIA_PATH_RE.match(rel) is not None

        try:
            stat = resolved.stat()
            mtime = self.date_time_string(int(stat.st_mtime))

            # §18.87 CONDITIONAL GET for live source: engine/editor files were
            # `no-store`, so three.module.js (~1.2 MB) re-downloaded in full on
            # every editor reload. mtime IS the "did the author change it"
            # signal — a 304 is both correct and fast. (Immutable media keeps
            # its year-long cache and never even asks.)
            if not immutable:
                ims = self.headers.get("If-Modified-Since")
                if ims == mtime:
                    self.send_response(304)
                    self.send_header("Last-Modified", mtime)
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return

            # §18.87 RANGE requests: without them <video>/<audio> could not
            # SEEK in the editor (a 58 MB tour mp4 only played from byte 0),
            # and any interrupted big fetch restarted from scratch.
            size = stat.st_size
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            partial = False
            if rng and rng.startswith("bytes="):
                m = re.match(r"bytes=(\d*)-(\d*)$", rng)
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:  # suffix form: last N bytes
                        start = max(0, size - int(m.group(2)))
                    if start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    end = min(end, size - 1)
                    partial = True

            with resolved.open("rb") as fh:
                if partial:
                    fh.seek(start)
                body = fh.read(end - start + 1)

            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if immutable:
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
                # no-cache = revalidate every time (the 304 path), never serve
                # stale silently — authoring source must always be current.
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Last-Modified", mtime)
            self.end_headers()
            self.wfile.write(body)
        except OSError as exc:
            self._send_json(500, {"error": str(exc)})


# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #


def main() -> int:
    global PATHS

    parser = argparse.ArgumentParser(description="AE1 development server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--root", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()

    PATHS = Paths(args.root)
    PATHS.ensure()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/plain", ".ags.txt")

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), AE1Handler)
    sys.stderr.write(f"  {ENGINE_NAME} {ENGINE_VERSION} serving {PATHS.root}\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())

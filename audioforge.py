"""AE1 - audioforge: English -> spoken audio -> the media collection (SS18.27).

The prototyping VOICE pipeline, third of the forges: "give the companion character a line that
says hello" becomes an .mp3 in the project without opening FL Studio. Two
backends, best-available wins:

  - "edge"  (default when installed): Microsoft's neural voices via edge-tts
            (pip; ONLINE at synth time). Native mp3. The cute ones Austin
            wants live here -- see PRESETS.
  - "sapi"  (always available, OFFLINE): Windows' built-in synthesizer via
            PowerShell -- David/Zira, the classic Microsoft-Sam tier. WAV
            out; converted to mp3 automatically when ffmpeg is on PATH.
            `--pitch +30%` on Zira is budget-anime and proud of it.

Voice presets (case-insensitive; anything else passes through verbatim):

  ana     en-US-AnaNeural      child voice, the cutest on offer
  jenny   en-US-JennyNeural    warm adult female
  aria    en-US-AriaNeural     bright adult female
  guy     en-US-GuyNeural      adult male
  nanami  ja-JP-NanamiNeural   Japanese female (anime-adjacent)
  zira    SAPI female          offline fallback
  david   SAPI male            offline fallback

Usage:
    py -3 audioforge.py "Hello world from forge" out.mp3 --voice ana
    py -3 audioforge.py "..." out.mp3 --voice zira --pitch +25% --rate -10%
    py -3 audioforge.py batch.json            # {"lines":[{"text","out",...}]}
    ... --upload 3d-sandbox                   # POST into the media collection

Wiring is dat, same as ever: add the filename to an element's
`(passiveLines ...)` / `(deathSounds ...)` or play it from any script with
`this.playSound("file.mp3")`. Fully-offline neural, if ever wanted: piper-tts
(onnx voices, headless) is the known upgrade path.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

PRESETS = {
    "ana": ("edge", "en-US-AnaNeural"),
    "jenny": ("edge", "en-US-JennyNeural"),
    "aria": ("edge", "en-US-AriaNeural"),
    "guy": ("edge", "en-US-GuyNeural"),
    "nanami": ("edge", "ja-JP-NanamiNeural"),
    "zira": ("sapi", "Microsoft Zira Desktop"),
    "david": ("sapi", "Microsoft David Desktop"),
}


def synth_edge(text: str, voice: str, out: pathlib.Path, rate: str, pitch: str) -> None:
    import asyncio

    import edge_tts

    # edge-tts wants pitch in Hz terms ("+20Hz") and rate in percent.
    pitch_hz = pitch if pitch.lower().endswith("hz") else (f"{pitch.rstrip('%')}Hz" if pitch else "+0Hz")
    asyncio.run(edge_tts.Communicate(text, voice, rate=rate or "+0%", pitch=pitch_hz).save(str(out)))


def synth_sapi(text: str, voice: str, out: pathlib.Path, rate: str, pitch: str) -> None:
    wav = out if out.suffix.lower() == ".wav" else out.with_suffix(".wav")
    # SSML prosody carries pitch AND rate; SelectVoice picks David/Zira.
    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
        f'<prosody pitch="{pitch or "+0%"}" rate="{rate or "+0%"}">{text}</prosody></speak>'
    )
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SelectVoice('{voice}');"
        f"$s.SetOutputToWaveFile('{wav}');"
        f"$s.SpeakSsml(@'\n{ssml}\n'@);"
        "$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True, capture_output=True)
    if wav != out:  # .mp3 asked for: convert when ffmpeg exists, else keep wav
        if shutil.which("ffmpeg"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "96k", str(out)],
                check=True,
            )
            wav.unlink()
        else:
            print(f"note: no ffmpeg — wrote {wav.name} instead (AE1 plays wav fine)")


def forge(text: str, out: pathlib.Path, voice: str = "ana", rate: str = "", pitch: str = "") -> pathlib.Path:
    backend, resolved = PRESETS.get(voice.lower(), ("edge" if "Neural" in voice else "sapi", voice))
    if backend == "edge":
        try:
            synth_edge(text, resolved, out, rate, pitch)
            return out
        except Exception as err:  # offline / package missing: fall back honestly
            print(f"edge-tts failed ({err}); falling back to SAPI Zira")
            backend, resolved = "sapi", "Microsoft Zira Desktop"
    synth_sapi(text, resolved, out, rate, pitch)
    return out if out.exists() else out.with_suffix(".wav")


def upload(slug: str, path: pathlib.Path, port: int = 8000) -> None:
    req = urllib.request.Request(
        f"http://localhost:{port}/api/projects/{slug}/media",
        data=path.read_bytes(),
        method="POST",
        headers={"X-Filename": urllib.parse.quote(path.name), "Content-Type": "application/octet-stream"},
    )
    entry = json.loads(urllib.request.urlopen(req).read())
    print(f"uploaded: {path.name} — {entry.get('hash', entry)!r}")


def main() -> None:
    # Positionals are argv minus flags AND THEIR VALUES — the first cut kept
    # "--upload"'s value as a positional and synthesized speech into a file
    # named after the project slug. Parse hygiene is not optional.
    flags = sys.argv[1:]
    skip = set()
    for i, a in enumerate(flags):
        if a.startswith("--"):
            skip.add(i)
            if i + 1 < len(flags) and not flags[i + 1].startswith("--"):
                skip.add(i + 1)
    args = [a for i, a in enumerate(flags) if i not in skip]

    def flag(name: str, default: str = "") -> str:
        return flags[flags.index(name) + 1] if name in flags else default

    slug = flag("--upload")
    if len(args) == 1 and args[0].endswith(".json"):  # batch
        spec = json.loads(open(args[0], encoding="utf-8-sig").read())
        for line in spec.get("lines", []):
            out = forge(line["text"], pathlib.Path(line["out"]), line.get("voice", "ana"),
                        line.get("rate", ""), line.get("pitch", ""))
            print(f"wrote {out} ({out.stat().st_size:,} bytes)")
            if slug:
                upload(slug, out)
        return
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    out = forge(args[0], pathlib.Path(args[1]), flag("--voice", "ana"), flag("--rate"), flag("--pitch"))
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")
    if slug:
        upload(slug, out)


if __name__ == "__main__":
    main()

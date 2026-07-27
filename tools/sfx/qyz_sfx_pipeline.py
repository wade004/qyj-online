#!/usr/bin/env python3
"""Offline, deterministic QYZ SFX generation and publishing pipeline."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools" / "sfx"
LOCAL = ROOT / ".local" / "sfx"
SPECS_PATH = TOOLS / "sound-specs.json"
STABLE_AUDIO = LOCAL / "stable-audio-3" / ".venv" / "Scripts" / "stable-audio.exe"


@dataclass(frozen=True)
class Event:
    event_id: str
    target: Path
    duration: float
    prompt: str
    variants: tuple[str, ...]


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command))
    environment = os.environ.copy()
    environment.setdefault("HF_HOME", str(LOCAL / "huggingface"))
    environment.setdefault("HF_HUB_OFFLINE", "1")
    return subprocess.run(command, check=True, text=True, capture_output=capture, env=environment)


def load_specs() -> tuple[dict, list[Event]]:
    raw = json.loads(SPECS_PATH.read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != 1:
        raise ValueError("Unsupported sound-specs schemaVersion")
    events = []
    for item in raw.get("events", []):
        target = ROOT / str(item["target"])
        events.append(Event(
            event_id=str(item["id"]), target=target, duration=float(item["duration"]),
            prompt=str(item["prompt"]), variants=tuple(map(str, item.get("variants", []))),
        ))
    if not events or len({event.event_id for event in events}) != len(events):
        raise ValueError("Sound specs require unique events")
    return raw, events


def selected(events: list[Event], event_id: str | None) -> list[Event]:
    if event_id is None:
        return events
    matches = [event for event in events if event.event_id == event_id]
    if not matches:
        raise ValueError(f"Unknown event: {event_id}")
    return matches


def candidate_dir(event: Event, model: str) -> Path:
    return LOCAL / "candidates" / model / event.event_id


def mastered_path(event: Event, model: str) -> Path:
    return LOCAL / "mastered" / model / f"{event.event_id}.mp3"


def prompt_for(raw: dict, event: Event, variant: str) -> str:
    return ", ".join((raw["stylePrefix"], event.prompt, variant, "single isolated effect"))


def seed_for(event: Event, index: int) -> int:
    # Stable IDs make retrying a failed batch reproducible without an LLM.
    digest = hashlib.sha256(f"qyz-sfx-v1:{event.event_id}:{index}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 2_000_000_000


def generate(raw: dict, events: list[Event], stable_audio: Path, model: str) -> None:
    if not stable_audio.exists():
        raise FileNotFoundError(f"Stable Audio executable not found: {stable_audio}")
    candidates = int(raw["defaults"]["candidates"])
    for event in events:
        output_dir = candidate_dir(event, model)
        output_dir.mkdir(parents=True, exist_ok=True)
        for index in range(candidates):
            output = output_dir / f"candidate-{index + 1:02d}.wav"
            if output.exists():
                continue
            variant = event.variants[index % len(event.variants)] if event.variants else "balanced"
            run([
                str(stable_audio), "--model", model, "-p", prompt_for(raw, event, variant),
                "--duration", str(event.duration), "--seed", str(seed_for(event, index)), "-o", str(output),
            ])


def probe_duration(path: Path) -> float:
    result = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], capture=True)
    return float(result.stdout.strip())


def peak_db(path: Path) -> float:
    result = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"], capture=True)
    match = re.search(r"max_volume:\s*(-?[\d.]+) dB", result.stderr)
    if not match:
        raise ValueError(f"Could not measure peak: {path}")
    return float(match.group(1))


def silence_seconds(path: Path) -> float:
    result = run([
        "ffmpeg", "-v", "info", "-i", str(path),
        "-af", "silencedetect=n=-45dB:d=0.05", "-f", "null", "-",
    ], capture=True)
    return sum(float(value) for value in re.findall(r"silence_duration: ([0-9.]+)", result.stderr))


def technical_score(path: Path, event: Event) -> float:
    duration = probe_duration(path)
    peak = peak_db(path)
    silence = silence_seconds(path)
    duration_error = abs(duration - event.duration)
    # Reject near-silent files and clips that substantially miss the requested length.
    if (
        peak < -42
        or duration_error > max(0.4, event.duration * 0.5)
        or silence > max(0.25, duration * 0.4)
    ):
        return float("-inf")
    return 100 - duration_error * 80 - max(0, peak + 0.5) * 8 - silence * 20


def master(raw: dict, events: list[Event], model: str) -> None:
    defaults = raw["defaults"]
    for event in events:
        files = sorted(candidate_dir(event, model).glob("*.wav"))
        if not files:
            raise FileNotFoundError(f"No candidates generated for {event.event_id}")
        ranked = sorted(
            ((technical_score(path, event), path) for path in files),
            key=lambda item: (item[0], item[1].name),
            reverse=True,
        )
        score, winner = ranked[0]
        if score == float("-inf"):
            raise RuntimeError(f"No technically valid candidate for {event.event_id}")
        output = mastered_path(event, model)
        output.parent.mkdir(parents=True, exist_ok=True)
        fade_out_at = max(0.05, event.duration - 0.06)
        filter_chain = (
            f"atrim=0:{event.duration},afade=t=in:st=0:d=0.01,"
            f"afade=t=out:st={fade_out_at}:d=0.06,"
            f"loudnorm=I={defaults['targetLufs']}:TP={defaults['truePeakDb']}:LRA=7"
        )
        run([
            "ffmpeg", "-y", "-i", str(winner), "-af", filter_chain,
            "-ar", str(defaults["sampleRate"]), "-ac", "2", "-b:a", str(defaults["bitrate"]), str(output),
        ])
        (output.with_suffix(".json")).write_text(json.dumps({
            "event": event.event_id, "model": model, "winner": str(winner.relative_to(ROOT)), "score": score,
            "duration": event.duration, "target": str(event.target.relative_to(ROOT)),
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def publish(events: list[Event], model: str) -> None:
    for event in events:
        source = mastered_path(event, model)
        if not source.exists():
            raise FileNotFoundError(f"Mastered audio is missing for {event.event_id}")
        backup = LOCAL / "backups" / event.target.relative_to(ROOT)
        backup.parent.mkdir(parents=True, exist_ok=True)
        if event.target.exists() and not backup.exists():
            shutil.copy2(event.target, backup)
        event.target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, event.target)
        print(f"published {event.event_id} -> {event.target.relative_to(ROOT)}")


def validate(events: list[Event]) -> None:
    for event in events:
        if event.duration <= 0 or event.duration > 3:
            raise ValueError(f"Invalid duration for {event.event_id}")
        if event.target.suffix.lower() != ".mp3":
            raise ValueError(f"QYZ runtime targets must be MP3: {event.event_id}")
        if not event.prompt.strip():
            raise ValueError(f"Missing prompt for {event.event_id}")
    print(f"validated {len(events)} SFX specifications")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "generate", "master", "publish", "all"))
    parser.add_argument("--event")
    parser.add_argument("--stable-audio", type=Path, default=STABLE_AUDIO)
    parser.add_argument("--model", default=None, choices=("small-sfx", "medium"))
    args = parser.parse_args()
    raw, events = load_specs()
    events = selected(events, args.event)
    validate(events)
    model = args.model or raw["defaults"].get("stableAudioModel", "small-sfx")
    if args.command == "validate":
        return
    if args.command in ("generate", "all"):
        generate(raw, events, args.stable_audio, model)
    if args.command in ("master", "all"):
        master(raw, events, model)
    if args.command in ("publish", "all"):
        publish(events, model)


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"SFX pipeline failed: {error}", file=sys.stderr)
        raise SystemExit(1)

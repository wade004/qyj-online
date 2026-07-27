#!/usr/bin/env python3
"""Generate local Chinese QYZ voice lines with Qwen3-TTS."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / ".local" / "tts" / "qwen3"
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"


def local_model_path(model: str) -> str:
    direct_path = Path(model)
    if direct_path.exists():
        return str(direct_path)
    snapshot_root = LOCAL / "huggingface" / "hub" / f"models--{model.replace('/', '--')}" / "snapshots"
    snapshots = sorted((path for path in snapshot_root.iterdir() if path.is_dir()), reverse=True) if snapshot_root.exists() else []
    return str(snapshots[0]) if snapshots else model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--speaker", default="Vivian")
    parser.add_argument("--style", default="沉稳、自信、略带古风的游戏旁白，普通话清晰自然。")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    os.environ.setdefault("HF_HOME", str(LOCAL / "huggingface"))

    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    model_path = local_model_path(args.model)
    print(f"Loading {model_path} on {device}")
    model = Qwen3TTSModel.from_pretrained(model_path, device_map=device, dtype=dtype)
    wavs, sample_rate = model.generate_custom_voice(
        text=args.text,
        language="Chinese",
        speaker=args.speaker,
        instruct=args.style,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, wavs[0], sample_rate)
    print(f"Saved: {args.output.resolve()}")


if __name__ == "__main__":
    main()

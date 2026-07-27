# QYZ Local SFX Pipeline

This is an offline-only production pipeline for short game sound effects. It
does not load audio models in the browser and does not touch training assets.

## Install Stable Audio

Run from PowerShell after reviewing the Stable Audio license for your release:

```powershell
.\tools\sfx\install-stable-audio.ps1 -SmokeTest
```

Small SFX is a gated Hugging Face model. Before its weights can download,
accept the license at https://huggingface.co/stabilityai/stable-audio-3-small-sfx
and authenticate locally without sharing the token with this project:

```powershell
Set-Location .\.local\sfx\stable-audio-3
$env:HF_HOME = (Resolve-Path ..\huggingface)
uv run hf auth login
```

Then re-run the installer. The token and the model cache stay in `.local/sfx`.

To install the higher-quality CUDA model on an RTX GPU, use:

```powershell
.\tools\sfx\install-stable-audio.ps1 -Model medium -SmokeTest
```

The model, Python environment, Hugging Face cache, candidate WAV files, and
backups are all stored under `.local/sfx/`, which is intentionally ignored by
Git. The installer uses the official Stable Audio 3 repository and creates an
isolated Python 3.12 environment. It does not modify ComfyUI or Ollama.

## Generate and publish

```powershell
python .\tools\sfx\qyz_sfx_pipeline.py validate
python .\tools\sfx\qyz_sfx_pipeline.py generate --event draw
python .\tools\sfx\qyz_sfx_pipeline.py master --event draw
python .\tools\sfx\qyz_sfx_pipeline.py publish --event draw
```

After Medium has been installed, use `--model medium` consistently for
generation, mastering, and publishing so its candidates stay separate from
the faster Small SFX drafts.

`generate` creates deterministic prompt variations. `master` rejects clips
that fail duration, silence, or peak checks; it normalizes the winner and
encodes an MP3. `publish` backs up the existing game file before replacing it.

Use `all` to run the complete batch after Stable Audio has been installed:

```powershell
python .\tools\sfx\qyz_sfx_pipeline.py all
```

The pipeline never invokes an LLM at run time. The QYZ sound style and prompt
variants are frozen in `sound-specs.json` for reproducibility.

# QYZ Local Chinese TTS

This isolated toolchain generates Mandarin game voice lines with
Qwen3-TTS 1.7B CustomVoice. It does not change ComfyUI, Ollama, game assets,
or the poker bot training environment.

## Install and verify

```powershell
.\tools\tts\install-qwen3-tts.ps1 -SmokeTest
```

The model and its cache are stored in `.local/tts/qwen3/` and ignored by Git.
The installer pins a CUDA 12.6 PyTorch runtime so an NVIDIA RTX GPU is used
when available.

## Generate a line

```powershell
& .\.local\tts\qwen3\.venv\Scripts\python.exe .\tools\tts\qyz_tts.py `
  --speaker Vivian `
  --style '沉稳、自信、略带古风的游戏旁白，普通话清晰自然。' `
  --text '牌桌之上，胜负尚未落定。' `
  --output .\.local\tts\preview\narrator.wav
```

Available Chinese speakers include `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`,
and `Eric`. Keep generated files outside game assets until they have passed
listening review and normalization.

[CmdletBinding()]
param(
  [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localRoot = Join-Path $repoRoot '.local\tts\qwen3'
$venvRoot = Join-Path $localRoot '.venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
$hfRoot = Join-Path $localRoot 'huggingface'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw 'uv is required but was not found on PATH.'
}

New-Item -ItemType Directory -Force -Path $localRoot, $hfRoot | Out-Null
$env:HF_HOME = $hfRoot
if (-not (Test-Path $python)) {
  uv venv --python 3.12 $venvRoot
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Qwen3-TTS environment.' }
}
uv pip install --python $python --upgrade qwen-tts soundfile
if ($LASTEXITCODE -ne 0) { throw 'Could not install Qwen3-TTS.' }
uv pip install --python $python --upgrade torch==2.7.1+cu126 torchaudio==2.7.1+cu126 --index-url https://download.pytorch.org/whl/cu126
if ($LASTEXITCODE -ne 0) { throw 'Could not install the CUDA PyTorch runtime required by Qwen3-TTS.' }

if ($SmokeTest) {
  & $python (Join-Path $repoRoot 'tools\tts\qyz_tts.py') --text 'QYZ TTS smoke test.' --output (Join-Path $localRoot 'qwen3-tts-smoke.wav')
  if ($LASTEXITCODE -ne 0) { throw 'Qwen3-TTS smoke generation failed.' }
}

Write-Host "Qwen3-TTS installed in $localRoot"

[CmdletBinding()]
param(
  [switch]$SmokeTest,
  [ValidateSet('small-sfx', 'medium')]
  [string]$Model = 'small-sfx'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localRoot = Join-Path $repoRoot '.local\sfx'
$sourceRoot = Join-Path $localRoot 'stable-audio-3'
$hfRoot = Join-Path $localRoot 'huggingface'
$python = Join-Path $sourceRoot '.venv\Scripts\python.exe'
$stableAudio = Join-Path $sourceRoot '.venv\Scripts\stable-audio.exe'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw 'uv is required but was not found on PATH.'
}

New-Item -ItemType Directory -Force -Path $localRoot, $hfRoot | Out-Null
$env:HF_HOME = $hfRoot
if (-not (Test-Path (Join-Path $sourceRoot '.git'))) {
  git clone https://github.com/Stability-AI/stable-audio-3.git $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw 'Could not clone Stable Audio 3.' }
}

Push-Location $sourceRoot
try {
  uv python install 3.12
  if ($LASTEXITCODE -ne 0) { throw 'Could not install Python 3.12 for Stable Audio.' }
  if (-not (Test-Path $python)) {
    uv sync --python 3.12
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Stable Audio environment.' }
  }
  if ($Model -eq 'medium') {
    uv pip install --python $python --upgrade torch==2.7.1+cu126 torchaudio==2.7.1+cu126 --index-url https://download.pytorch.org/whl/cu126
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the CUDA PyTorch runtime required by Stable Audio Medium.' }
  }
  if ($SmokeTest) {
    $output = Join-Path $localRoot ("stable-audio-$Model-smoke.wav")
    & $stableAudio --model $Model -p 'short dry bronze coin click, no speech' --duration 1 -o $output
    if ($LASTEXITCODE -ne 0) {
      throw 'Stable Audio model download failed. Accept the required model license on Hugging Face, then run: uv run hf auth login. Re-run this script after login.'
    }
  }
} finally {
  Pop-Location
}

Write-Host "Stable Audio 3 installed in $sourceRoot"
Write-Host 'Run the QYZ pipeline with: python tools\sfx\qyz_sfx_pipeline.py validate'

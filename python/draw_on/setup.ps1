$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $root ".venv"
if (-not (Test-Path $venv)) {
    Write-Host "Creating venv at $venv (Python 3.12)..."
    py -3.12 -m venv $venv
}
$python = Join-Path $venv "Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $root "requirements.txt")
Write-Host ""
Write-Host "Setup complete. Activate the venv with:"
Write-Host "  . $venv\Scripts\Activate.ps1"

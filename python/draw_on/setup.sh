#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
venv="$root/.venv"
if [ ! -d "$venv" ]; then
    echo "Creating venv at $venv (Python 3.12)..."
    python3.12 -m venv "$venv"
fi
"$venv/bin/python" -m pip install --upgrade pip
"$venv/bin/python" -m pip install -r "$root/requirements.txt"
echo
echo "Setup complete. Activate the venv with:"
echo "  source $venv/bin/activate"

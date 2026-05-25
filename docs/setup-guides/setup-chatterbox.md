# Chatterbox TTS Setup Guide

HistForge's `chatterbox` TTS provider talks to a **local** [Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) (devnen's MIT-licensed FastAPI wrapper around Resemble AI's open-source Chatterbox model). Unlike AI33 and GenAIPro, there is no API key and no remote SaaS; the operator runs the server on the same machine (or another reachable host) and HistForge sends synchronous `POST /tts` requests to it. The wrapper returns WAV; the provider transcodes WAV→MP3 inline so step 07 (alignment) and step 14 (render) see the same `audio/narration.mp3` they always have.

> **Two projects, two version numbers.** The thing you `git clone` is **Chatterbox-TTS-Server** (devnen's wrapper, currently v1.0.0). The TTS *library* it loads internally is shipped as **[chatterbox-v2](https://github.com/devnen/chatterbox-v2)** — devnen's fork of Resemble AI's `chatterbox-tts`. The PyPI package `chatterbox-tts` (0.1.7 at time of writing) is **not** what the wrapper installs; its torch pin (`==2.6.0`) is incompatible with the wrapper's stack. Don't install `chatterbox-tts` from PyPI on top of the wrapper — you will break it. The fork install is handled for you in the install steps below.

## Hardware

- **NVIDIA GPU strongly recommended.** Two CUDA paths, picked by GPU generation:
  - **RTX 20/30/40 series** → CUDA 12.1 build (PyTorch 2.5.1+cu121, `requirements-nvidia.txt`).
  - **RTX 50 / Blackwell** (5060 Ti, 5070, 5070 Ti, 5080, 5090) → CUDA 12.8 build (PyTorch 2.9.0, sm_120, `requirements-nvidia-cu128.txt`).
  - CPU fallback works but is too slow for narration cadence.
  - **Check:** `nvidia-smi` in PowerShell. The `CUDA Version: X.Y` in the top-right (the *driver's max supported CUDA*) must be ≥12.1 for RTX 20/30/40 or ≥12.8 for RTX 50 / Blackwell. If `nvidia-smi` errors or isn't found, fix the NVIDIA driver first.
- ~10 GB free disk for Python deps and the model cache (weights download from Hugging Face on first generation, ~2 GB).
  - **Check:** `Get-PSDrive C` (use whichever drive will hold the clone target) — `Free` column should show ≥10 GB.
- 8 GB RAM minimum.
  - **Check:** `(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB` — should print ≥8.

## Prerequisites

Run each check below before installing. If a check passes, skip the install for that item.

- **Python 3.10 or newer.** The wrapper's `start.bat` searches for an interpreter in this order: `python3` → `python` → `py -3.12` → `py -3.11` → `py -3.10` → `py -3`, and accepts the first one that's 3.10+. Devnen's README still says "3.10 mandatory", but the launcher in practice runs on 3.10/3.11/3.12 because the `chatterbox-v2` fork ships wheels for those.
  - **Check:** `py -0` lists every interpreter the launcher knows about. Any one of them being 3.10+ is fine. If none are, install Python 3.10/3.11/3.12 from python.org.
  - **Coexisting with older or 2.x Python:** Tick "Install launcher for all users" in the python.org installer — that registers the new interpreter with the `py` launcher without disturbing your PATH.
- `git` on PATH.
  - **Check:** `git --version`. Expect `git version 2.x.x`. If missing, install Git for Windows from git-scm.com (accept the default "Git from the command line and also from 3rd-party software" PATH option).
- `ffmpeg` on PATH. HistForge already requires it for step 14 (render); the Chatterbox provider also pipes through it for the WAV→MP3 transcode.
  - **Check:** `ffmpeg -version`. If missing, install (e.g. `winget install Gyan.FFmpeg`) and open a fresh PowerShell window so it picks up the updated PATH.

## 1. Clone the wrapper

In a directory of your choice (outside the HistForge repo — it has its own venv and weights):

```
git clone https://github.com/devnen/Chatterbox-TTS-Server.git
cd Chatterbox-TTS-Server
```

## 2. Install: pick a path

### Path A — `start.bat` (recommended)

`start.bat` runs `start.py`, which does the full sequence: creates a venv, installs the right requirements file for your hardware, installs the `chatterbox-v2` fork with `--no-deps`, force-reinstalls protobuf in the onnx-compatible range, and launches the server.

```
start.bat
```

It prompts you to pick CPU / NVIDIA CUDA 12.1 / NVIDIA CUDA 12.8 / AMD ROCm. Pick the one that matches your GPU. The first run takes several minutes. The first **generation** also takes longer than steady-state because the model weights download from Hugging Face on demand (~2 GB).

To skip the menu next time:

```
start.bat --nvidia          # CUDA 12.1 (RTX 20/30/40)
start.bat --nvidia-cu128    # CUDA 12.8 (RTX 50 / Blackwell)
start.bat --cpu             # CPU only
```

Useful flags: `start.bat --reinstall` (delete the venv and reinstall fresh — use this if the install ever drifts), `start.bat --upgrade` (pull and re-install latest, keeping the hardware choice).

### Path B — Manual install

If you want to see exactly what `start.py` does, or you're on a non-Windows host:

```
python -m venv venv
.\venv\Scripts\activate
pip install --upgrade pip
pip install "setuptools<81"
```

Two reasons the `setuptools<81` pin is explicit:

1. Python 3.12+ venvs no longer bundle `setuptools` at all.
2. `setuptools` 81 (mid-2025) removed the legacy `pkg_resources` API, but `resemble-perth` 1.0.1 still imports `from pkg_resources import resource_filename`. Without it, Perth's `__init__.py` silently swallows the `ImportError` and sets `PerthImplicitWatermarker = None`, causing Chatterbox's model load to crash at startup with `TypeError: 'NoneType' object is not callable`.

So you need a `setuptools` that's **installed** (point 1) and **<81** (point 2). The pip line above settles both.

Then run **all three** of the following commands in order. The hardware-specific requirements file is the only line that changes.

**RTX 20/30/40 (CUDA 12.1):**

```
pip install -r requirements-nvidia.txt
pip install --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0
pip install --no-deps --force-reinstall "protobuf>=4.25.0"
```

**RTX 50 / Blackwell (CUDA 12.8):**

```
pip install -r requirements-nvidia-cu128.txt
pip install --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0
pip install --no-deps --force-reinstall "protobuf>=4.25.0"
```

**CPU only:**

```
pip install -r requirements.txt
pip install --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0
pip install --no-deps --force-reinstall "protobuf>=4.25.0"
```

All three steps are required. Devnen's README "Option 2" only shows the first two; the third (`protobuf` force-reinstall) is appended silently by `start.py`. Without it, `descript-audiotools` can demote `protobuf<3.20`, which breaks `onnx`'s `builder` import and stops `from chatterbox.tts import ChatterboxTTS` from working.

If `Activate.ps1` errors with "running scripts is disabled", run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then retry.

Then start the server:

```
python server.py
```

### Why the `--no-deps` line and devnen's `chatterbox-v2` fork?

`chatterbox-tts` on PyPI (currently 0.1.7) hard-pins `torch==2.6.0` and `transformers==5.2.0`. The wrapper's stack is built around `torch==2.5.1+cu121` (CUDA 12.1) or `torch==2.9.0` (CUDA 12.8) — both incompatible with the PyPI library's pins, and the comment in `requirements-nvidia.txt` calls this out: *"Updated to use PyTorch 2.5.1 for compatibility with our Colab-compatible chatterbox fork."* devnen forked the library as [`chatterbox-v2`](https://github.com/devnen/chatterbox-v2) to keep it on a torch version that has prebuilt wheels on Colab and current CUDA stacks, and to avoid forcing ONNX source builds on user machines without a C++ toolchain. `--no-deps` installs the fork without re-asserting its declared torch pin, so the wrapper's pinned torch survives.

## 3. Verify the server is up

The server listens on `http://127.0.0.1:8004` by default.

- Open `http://127.0.0.1:8004/` — devnen's web UI loads.
- `http://127.0.0.1:8004/docs` — Swagger / OpenAPI for the wrapper.

Smoke-test the same endpoint HistForge calls (`POST /tts`, predefined-voice path). The default voice in `config.yaml` is `Emily.wav`. PowerShell mangles inline-JSON bodies when passing them to `curl.exe` (it word-splits on spaces inside the body), so use `Invoke-WebRequest` instead:

```powershell
$body = @{
  text = "Hello from Chatterbox."
  voice_mode = "predefined"
  predefined_voice_id = "Emily.wav"
  output_format = "wav"
} | ConvertTo-Json -Compress

Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:8004/tts" `
  -ContentType "application/json" -Body $body -OutFile smoke.wav
```

You should get a `smoke.wav` of roughly 100–300 KB at 24 kHz mono. Check with `(Get-Item smoke.wav).Length`. If it's a few hundred bytes, the wrapper returned a JSON error body — open it in a text editor to see why (most often: `Emily.wav` doesn't exist on your install). Swap it for any filename the web UI's voice picker shows under **Predefined voices** and retry.

If you'd rather use `curl.exe`, the PowerShell stop-parsing token `--%` lets cmd-style quoting through verbatim:

```powershell
curl.exe --% -X POST http://127.0.0.1:8004/tts -H "Content-Type: application/json" -d "{\"text\":\"Hello from Chatterbox.\",\"voice_mode\":\"predefined\",\"predefined_voice_id\":\"Emily.wav\",\"output_format\":\"wav\"}" --output smoke.wav
```

GPU sanity check (run inside the activated venv):

```
python -c "import torch; print(torch.__version__, 'cuda=', torch.cuda.is_available())"
python -c "from chatterbox.tts import ChatterboxTTS; print('ok')"
```

Expected for CUDA 12.1: `2.5.1+cu121 cuda= True`. For CUDA 12.8: `2.9.0+cu128 cuda= True`. The second line should print `ok`.

## 4. Running the server day-to-day

The server has to be running anytime HistForge generates audio on a Chatterbox-backed workflow. It's a separate process — when its console window closes (or you Ctrl+C it), it stops. After a reboot, you'll need to start it again.

You don't have to re-run install. Only the activate + `python server.py` pair:

```powershell
cd C:\Chatterbox-TTS-Server
.\venv\Scripts\activate
python server.py
```

For convenience, save the same sequence as a `.bat` file (e.g. `chatterbox-run.bat` on your Desktop):

```bat
@echo off
cd /d "C:\Chatterbox-TTS-Server"
call .\venv\Scripts\activate.bat
python server.py
```

Double-click → console opens, venv activates, server starts. Close the window or Ctrl+C to stop.

> **Don't** use devnen's bundled `start.bat` for the day-to-day launch if you installed manually because of a Python version conflict (e.g., you have Python 3.14 on PATH for another project). `start.bat` does its own Python search and may re-detect the wrong interpreter; the custom `.bat` above bypasses that and uses the venv's Python directly.

## 5. Supply a voice

The wrapper looks for two directories inside its repo:

- `voices/` — **predefined voices**. One short reference clip per file; the filename (e.g. `Emily.wav`) is the voice's identity.
- `reference_audio/` — **clone references**. A ~10-second mono WAV is ideal. Filename is again the identity.

You can either drop files directly into those directories, or use the web UI's upload buttons under each section (web UI: `http://127.0.0.1:8004/`). HistForge does not manage voices — voice library upkeep is operator-side, in the wrapper.

## 6. Point HistForge at the server

In HistForge → **Settings** → **TTS** tab, fill in:

- `chatterbox_base_url` — `http://127.0.0.1:8004` (default; change if you moved the server or changed `server.port` in `config.yaml`).
- `chatterbox_voice_mode` — `predefined` to read from `voices/`, or `clone` to read from `reference_audio/`.
- `chatterbox_voice_filename` — the exact filename of the voice from the directory the mode picks (e.g. `Emily.wav`). Required.

Then in the workflow you want to use Chatterbox on: **Workflows** → edit → **TTS provider** → **Chatterbox** → save. Existing videos already queued against another provider keep their pinned snapshot; only newly queued videos pick up the change.

Chatterbox has its own `chatterbox_speed_factor` slider (range 0.25–4, sent as `speed_factor` on `/tts`); the wrapper clamps it server-side per its own `config.yaml` if it's out of range. The ElevenLabs-shaped sliders (stability, similarity, style, speaker boost, voice ID, model, `voice_speed`) live in the **GenAIPro / AI33** view of the Settings → TTS panel and are **not** consumed by Chatterbox.

## 7. Smoke test end-to-end

1. In HistForge, create a short video (low `chapter_count`, e.g. 2–3) on a workflow whose TTS provider is Chatterbox.
2. Start it. Watch step 06 (`voiceover`) in the dashboard — it should complete in seconds-to-minutes for a short script.
3. Open the video's audio asset (`audio/narration.mp3`) and confirm it plays.
4. Step 07 (`align`) runs aeneas against the MP3 + script; alignment is provider-independent, so it works the same way it does for AI33/GenAIPro.

## License and watermark

- The wrapper is **MIT** (devnen) and the model weights are **MIT** (Resemble AI). No license blockers for downstream YouTube use.
- **Every output carries Resemble AI's Perth perceptual watermark.** The watermark is inaudible, survives MP3 transcoding and ordinary editing, and is detectable by Resemble AI's own tooling. This is informational — there is no opt-out — but operators should know the rendered narration carries an inaudible signature.

## Troubleshooting

**`start.bat` exits silently or can't find Python**

It tries `python3` → `python` → `py -3.12` → `py -3.11` → `py -3.10` → `py -3` and rejects anything older than 3.10. Run `py -0` in a fresh PowerShell — at least one of those must be Python 3.10+. If none are, install Python 3.10 (or 3.11 / 3.12) from python.org with "Install launcher for all users" ticked.

**GPU not detected (server logs say it fell back to CPU)**

- Run `nvidia-smi` — if that itself errors, fix the NVIDIA driver first.
- Check the CUDA version in `nvidia-smi` against the install path you took. `requirements-nvidia.txt` needs CUDA ≥12.1; `requirements-nvidia-cu128.txt` needs CUDA ≥12.8.
- You may have installed the wrong requirements file for your GPU. RTX 20/30/40 → 12.1; RTX 50 / Blackwell → 12.8. To switch: `start.bat --reinstall --nvidia-cu128` (or `--nvidia`).
- Edit `config.yaml` → `tts_engine.device` to force `cuda` (defaults to `auto`).
- Restart the server after any `config.yaml` edit.

**Port 8004 already in use**

Change `server.port` in the wrapper's `config.yaml`, restart the server, and update `chatterbox_base_url` in HistForge → Settings → TTS to match.

**First generation is much slower than later ones**

Expected. The model weights (~2 GB) download from Hugging Face on the first call and live in the local cache afterwards. Don't time out the request from HistForge's side on this first run; subsequent calls are an order of magnitude faster.

**HistForge step 06 fails with a non-2xx response**

The error message includes the wrapper's response body. Common reasons:

- `chatterbox_voice_filename` doesn't match an actual file in `voices/` (predefined mode) or `reference_audio/` (clone mode). Filenames are case-sensitive on most filesystems; copy the exact name from the wrapper's web UI.
- The server isn't running, or `chatterbox_base_url` points at the wrong host/port. `curl http://127.0.0.1:8004/docs` from the HistForge host first.

**Server logs `CRITICAL: TTS Model failed to load on startup` with `TypeError: 'NoneType' object is not callable` at `tts_turbo.py:130` (`self.watermarker = perth.PerthImplicitWatermarker()`)**

The `resemble-perth` package needs `pkg_resources`, which used to ship with `setuptools`. Two ways to hit this:

- Python 3.12+ venvs don't bundle `setuptools` at all.
- `setuptools` 81+ (mid-2025) ships *without* `pkg_resources` even when installed.

Perth's `__init__.py` catches the resulting `ImportError` and sets `PerthImplicitWatermarker = None`, which then explodes when chatterbox-v2 tries to instantiate it.

To diagnose, surface the real import error directly:

```powershell
python -c "from perth.perth_net.perth_net_implicit.perth_watermarker import PerthImplicitWatermarker; print('OK')"
```

If it ends with `ModuleNotFoundError: No module named 'pkg_resources'`, fix with:

```powershell
pip install "setuptools<81"
```

Verify with `python -c "import perth; print(perth.PerthImplicitWatermarker)"` — should print the class, not `None`. Then restart the server.

**`from chatterbox.tts import ChatterboxTTS` errors with `ImportError: cannot import name 'builder' from 'google.protobuf.internal'`**

You skipped (or `start.py` was interrupted before running) the `pip install --no-deps --force-reinstall "protobuf>=4.25.0"` step. Re-run it inside the activated venv. The conflict: `descript-audiotools` declares `protobuf<3.20`, but `onnx` needs `>=3.20.2` for the `builder` symbol. The force-reinstall settles it in `onnx`'s favor.

**You re-ran `pip install --force-reinstall -r requirements-*.txt` and the server stopped working**

The force-reinstall reverts the `--no-deps chatterbox-v2` install and the protobuf pin. Redo the second and third commands from "Path B — Manual install" and you're back. Or just run `start.bat --reinstall` and let it do the full sequence.

**PowerShell venv activation does not persist across shells**

Every new PowerShell window must run `.\venv\Scripts\activate` before `python server.py` — your prompt should show `(venv)` once it's active. If you see `ModuleNotFoundError: No module named 'yaml'`, you almost certainly forgot to activate the venv. Confirm with `python -c "import sys; print(sys.executable)"` — it should point inside `...\Chatterbox-TTS-Server\venv\Scripts\python.exe`.

**You see a `chatterbox-tts 0.1.7 requires torch==2.6.0` error**

Something pulled the upstream PyPI `chatterbox-tts` package on top of (or instead of) the `chatterbox-v2` fork. Easiest fix: `start.bat --reinstall` and pick the same hardware option. Manual fix: `pip uninstall -y chatterbox-tts chatterbox`, then re-run the second and third commands from Path B.

## How the pieces fit together

- The Chatterbox server is a **local sidecar process**. HistForge talks to it over HTTP on `127.0.0.1` by default; nothing about the integration touches the public internet (model weights aside, downloaded once on first generation).
- The provider sends WAV requests, gets WAV back, and transcodes WAV→MP3 inline via piped `ffmpeg`. Step 07 (alignment) and step 14 (render) see the same `audio/narration.mp3` they see for AI33 / GenAIPro.
- Voice management lives in the wrapper, not in HistForge. Add, remove, or audition voices via the wrapper's web UI at `http://127.0.0.1:8004/`. HistForge stores only the filename to use.
- Provider selection is **per workflow**, pinned into `videos.workflow_snapshot.tts_provider` at queue time. Switching a workflow from AI33 to Chatterbox does not retroactively change videos already queued against the old provider.
- The wrapper installs Resemble AI's library as devnen's [`chatterbox-v2`](https://github.com/devnen/chatterbox-v2) fork (not the PyPI `chatterbox-tts` package). The fork is pinned to a torch version that has wheels on Colab and current CUDA stacks; the upstream PyPI release tracks newer torch and isn't compatible with the wrapper's pinned stack.

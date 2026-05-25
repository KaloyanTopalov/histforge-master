# histforge

Unattended pipeline that turns a one-line topic into a finished 2-hour historical YouTube video. Solo operator, local machine, one video at a time.

See `histforge-spec.md` for the full design.

---

## Dependencies

### System (install once on your machine)

| Dependency | Version | Where | Purpose |
|---|---|---|---|
| **Windows 10 or 11** | — | host | Operating system |
| **WSL2 + Ubuntu** | latest | Windows feature | Hosts aeneas only |
| **Node.js** | 20 LTS | Windows native | Runtime for Next.js + worker |
| **npm** | bundled with Node | Windows native | Package manager |
| **Git** | any recent | Windows native | Source control |
| **ffmpeg** | 6.0+ | Windows native, on PATH | Video/audio rendering |
| **Python** | **3.11 exactly** | inside WSL2 Ubuntu | Runs `align.py` (aeneas is incompatible with 3.12+) |
| **espeak** | apt package | inside WSL2 Ubuntu | aeneas dependency |
| **espeak-data, libespeak-dev** | apt packages | inside WSL2 Ubuntu | aeneas dependency |
| **build-essential, python3.11-dev** | apt packages | inside WSL2 Ubuntu | aeneas compile deps |

### Python packages (installed inside WSL2 only)

| Package | Purpose |
|---|---|
| `aeneas` | Forced alignment of script text to narration audio |
| `numpy` | aeneas dependency |

### Node packages (Windows native, installed via `npm install`)

**Runtime**

| Package | Purpose |
|---|---|
| `next` | Web framework (App Router) |
| `react`, `react-dom` | UI |
| `tailwindcss`, `postcss`, `autoprefixer` | Styling |
| `better-sqlite3` | SQLite client (synchronous, single-process friendly) |
| `playwright` | Headed Chromium for Freepik scraping |
| `ulid` | ID generation for topics/videos |
| `sbd` | Sentence boundary detection (JS, for alignment pre-processing) |
| `zod` | Settings/topic validation |
| `dotenv` | `.env` loading |

**Dev**

| Package | Purpose |
|---|---|
| `typescript` | TS compiler |
| `tsx` | Worker dev runner with watch mode |
| `concurrently` | Run Next.js + worker in one command |
| `@types/node`, `@types/react`, `@types/better-sqlite3` | Type defs |
| `eslint`, `eslint-config-next` | Linting |

### External services (API keys required)

| Service | Purpose | Env var |
|---|---|---|
| **OpenRouter** | LLM access for research, characters, hook, chapters, structure extraction, image-prompt enrichment | `OPENROUTER_API_KEY` |
| **AI33** | Text-to-speech (ElevenLabs-compatible cloud API) for narration | `AI33_API_KEY` |
| **ComfyUI** (local) | AI image generation via local Stable Diffusion. See `docs/setup-comfyui.md`. | (no key — local API) |
| **Freepik** (paid plan) | AI image-to-video generation. Used via headed-browser automation, not API. | (no key — uses browser session) |

### Additional one-time setup

| Item | Notes |
|---|---|
| **Freepik account** | Must have AI image generation enabled on your plan. |
| **Freepik custom style** | Create a saved custom style in your Freepik account. Note its exact name; you'll set it in Settings as `freepik_style_name`. |
| **AI33/ElevenLabs voice** | Pick a voice ID. Set in Settings as `voice_id`. |

---

## Install

### 1. Enable WSL2 and install Ubuntu

In an elevated PowerShell:
```powershell
wsl --install -d Ubuntu
```
Reboot when prompted. Set up your Ubuntu username/password on first launch.

### 2. Install aeneas system deps inside WSL2

Open Ubuntu in Windows (search "Ubuntu" in the Start menu).

**Important:** aeneas is an unmaintained 2017 package and does **not** build on Python 3.12+ because it uses `numpy.distutils`, which was removed from numpy on Python 3.12. Ubuntu 24.04 ships with 3.12 by default, so we install Python 3.11 alongside it from the deadsnakes PPA and use that inside the venv.

```bash
sudo apt update
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.11 python3.11-venv python3.11-dev \
  espeak espeak-data libespeak-dev \
  build-essential ffmpeg
```

Your system's default `python3` (3.12) stays untouched — we only use `python3.11` inside the histforge venv.

aeneas itself is installed in step 6.

### 3. Install Node.js (Windows native)

Download Node 20 LTS from https://nodejs.org/ and install. Verify:
```powershell
node --version    # v20.x
npm --version
```

### 4. Install ffmpeg (Windows native)

ffmpeg is installed directly on Windows (not WSL) — histforge's worker invokes it for video/audio rendering. There is no installer; you just download a static build, drop it in a folder, and add it to PATH.

**4a. Download a static build**

Go to **https://www.gyan.dev/ffmpeg/builds/** and download `ffmpeg-release-essentials.zip` from the "release builds" section. The "essentials" build has everything histforge needs (libx264, libmp3lame, etc.) and is smaller than the "full" build.

**4b. Extract to a permanent location**

Extract the zip and move/rename the resulting folder so the final path is exactly:

```
C:\ffmpeg\
  └── bin\
      ├── ffmpeg.exe
      ├── ffplay.exe
      └── ffprobe.exe
```

The zip extracts to a folder like `ffmpeg-7.1-essentials_build\` — rename it to just `ffmpeg`. The location must be permanent: don't put it in Downloads or Desktop, or PATH will break the next time you tidy up.

**4c. Add `C:\ffmpeg\bin` to your PATH**

1. Press **Win**, type `environment variables`, click **Edit the system environment variables**.
2. In System Properties, click **Environment Variables...** at the bottom.
3. Under **User variables for <your-name>**, select **Path**, click **Edit...**.
4. Click **New**, paste `C:\ffmpeg\bin`, click **OK** on every dialog.

Use **User variables** (not System variables) unless you need ffmpeg available for other Windows accounts on the same machine.

**4d. Verify**

Open a **fresh** PowerShell window (existing terminals won't see the new PATH):

```powershell
ffmpeg -version
ffprobe -version
```

Both should print version banners. If you get `'ffmpeg' is not recognized`, either you're still in an old terminal window or `C:\ffmpeg\bin\ffmpeg.exe` doesn't actually exist at that path — check both.

### 5. Clone and install histforge

```powershell
git clone <repo-url> histforge
cd histforge
npm install
npx playwright install chromium
```

### 6. Install Python deps inside WSL2

aeneas installation has several quirks that require a specific sequence (see comments below). Run this **inside a WSL shell**, from the histforge folder:

```bash
cd $(wslpath -a .)

# 1. Create venv using Python 3.11 (not the system default 3.12)
python3.11 -m venv python/.venv

# 2. Pin build tools — aeneas's build needs setuptools < 60 for numpy.distutils
python/.venv/bin/pip install --upgrade pip wheel
python/.venv/bin/pip install "setuptools<60"

# 3. Install numpy FIRST and pin to 1.x (aeneas is incompatible with numpy 2.x)
python/.venv/bin/pip install "numpy<2"

# 4. Install aeneas with build isolation disabled so it can see the venv's numpy + setuptools
python/.venv/bin/pip install --no-build-isolation --no-cache-dir aeneas

# 5. Verify
python/.venv/bin/python3.11 -c "import aeneas; print('ok', aeneas.__version__)"
```

**Why each flag matters:**
- `numpy` must be installed in a **separate** `pip install` call before aeneas — aeneas's `setup.py` imports numpy at build time and fails otherwise.
- `--no-build-isolation` tells pip to use the venv's own numpy and setuptools when building aeneas, instead of creating a sandboxed build environment that wouldn't see them.
- `setuptools<60` is required because modern setuptools removed the `numpy.distutils` glue aeneas uses to compile its C extensions.
- `numpy<2` is required because aeneas uses the old numpy 1.x C API.

**Important symlink caveat:** When the venv is created on an NTFS-mounted path (`/mnt/c/...`), the `bin/python3` symlink points to the **system** `/usr/bin/python3` (3.12), not to the venv's 3.11. This means `python3` won't see the venv's site-packages. Always use `python3.11` explicitly — both in verification commands and in any code that invokes the venv. The pipeline's `align.ts` already uses `python3.11` for this reason.

If step 4 fails, see the aeneas section under **Troubleshooting** below.

### 7. Configure environment

```powershell
copy .env.example .env
notepad .env
```

Fill in:
```
OPENROUTER_API_KEY=...
AI33_API_KEY=...
DATABASE_URL=./data/histforge.db
PROJECTS_DIR=./projects
WSL_DISTRO=Ubuntu
```

`ffmpeg` must be on Windows PATH (step 4). The Python venv binary (`python3.11`) is invoked by absolute path inside WSL, so no PATH configuration is needed for it.

### 8. Initialize the database

```powershell
npm run db:init
```

### 9. First Freepik login

```powershell
npm run freepik:login
```
This opens a headed Chromium window. Sign in to Freepik with your Google account. Close the window when you see your Freepik dashboard. The session is saved to `data/freepik-profile/`.

### 10. Configure settings

Start the app in dev mode:
```powershell
npm run dev
```

Open http://localhost:3000/settings in your browser and fill in (on the Script tab's Provider section):
- `openrouter_script_model` — OpenRouter model ID for script-writing steps (e.g. `anthropic/claude-sonnet-4.6`)
- `openrouter_visual_model` — OpenRouter model ID for visual-prompt enrichment and moderation (e.g. `anthropic/claude-haiku-4.5`)
- `freepik_style_name` — exact name of your saved Freepik custom style
- `voice_id` — your ElevenLabs voice ID (TTS tab)
- (other render/voice settings have sensible defaults)

---

## Run

### Development (file-watch reloads)
```powershell
npm run dev
```
Starts both Next.js (http://localhost:3000) and the worker via `concurrently`. Code changes restart the relevant process. Use this while editing.

### Unattended / overnight (no reloads)
```powershell
npm run build
npm start
```
Production build, no file watching. Use this when you queue topics and walk away — file-watch reloads during a long run would corrupt in-progress steps.

**To produce videos overnight:**
1. Open http://localhost:3000/topics, add as many topics as you want.
2. For each topic, click **Queue**.
3. Open http://localhost:3000/videos, click **Start queue**.
4. Walk away. Come back to finished `.mp4` files in `projects/<video_id>/final.mp4`.

---

## Running from both Windows and WSL

`better-sqlite3` is a native module — the compiled `better_sqlite3.node` binary only loads under the OS and Node ABI it was built for. If you run npm commands from both Windows *and* WSL against the same checkout, whichever runtime built it last wins and the other explodes with `invalid ELF header` or `%1 is not a valid Win32 application`.

Every npm entry point (`dev`, `test`, `test:watch`, `build`, `start`, `db:init`) runs `scripts/ensure-native-modules.js` first. It:

1. Tries to `require('better-sqlite3')`. If it loads cleanly, nothing else happens — near-zero cost.
2. On failure, checks `data/.native-cache/` for a previously-built binary matching the current `(platform, arch, Node ABI, sqlite version)` and copies it in. Sub-second swap.
3. If the cache is cold, runs `npm rebuild better-sqlite3` and saves the result to the cache so the next switch is fast.

**Cost:** first run per platform is a ~30 s rebuild; every subsequent Windows↔WSL switch is a file copy.

**Race warning:** don't run npm entry points from both environments simultaneously against the same checkout — they'll fight over the single `better_sqlite3.node` file. Safe pattern: let whichever side is running finish before kicking off the other.

---

## Troubleshooting

**"Freepik session expired" banner**
Click **Re-login** in the dashboard. A headed Chromium window opens; sign in again, click "Done" in the dashboard. Queue resumes from where it stopped.

**A video is stuck in `failed`**
Open `/videos/<id>`, click **View pipeline log**, read the error. Common causes: OpenRouter rate limit, AI33 task failure, Freepik UI change. Click **Retry failed step** to try again, or **Restart from beginning** to wipe and start over.

**`wsl: command not found`**
WSL2 not installed or not enabled. See step 1.

**`aeneas` import errors**
The Python venv inside WSL is missing or broken. Re-run step 6.

**aeneas install fails with `You must install numpy before installing aeneas`**
Misleading error — the real cause is usually one of:
1. You're on Python 3.12+ (aeneas needs 3.11 or older — see step 2).
2. You forgot `--no-build-isolation` on the `pip install aeneas` command.
3. numpy isn't actually installed in the venv yet, or was installed in the *same* pip call as aeneas (must be a separate, earlier call).

Verify with:
```bash
python/.venv/bin/python3.11 --version                                # must be 3.11.x
python/.venv/bin/python3.11 -c "import numpy.distutils.misc_util; print('ok')"
```
If either check fails, wipe the venv (`rm -rf python/.venv`) and redo step 6 from scratch.

**`import aeneas` fails even though `pip show aeneas` says it's installed**
On NTFS-mounted WSL paths (`/mnt/c/...`), the venv's `bin/python3` symlink points to the **system** `/usr/bin/python3` (typically 3.12), not the venv's Python 3.11. System Python 3.12 can't see the venv's 3.11 site-packages. Always use `python3.11` explicitly:
```bash
python/.venv/bin/python3.11 -c "import aeneas; print('ok')"    # works
python/.venv/bin/python3 -c "import aeneas; print('ok')"       # fails — uses system 3.12
```

**aeneas install fails during `Building wheel for aeneas`**
Your setuptools is too new. Inside the venv: `python/.venv/bin/pip install "setuptools<60"` and re-run the aeneas install.

**`ffmpeg` not found**
Not on Windows PATH. See step 4.

**`invalid ELF header` or `%1 is not a valid Win32 application` from `better-sqlite3`**
The native binary was built for the other OS. Run any npm entry point (`npm test`, `npm run dev`, etc.) — the `ensure-native-modules.js` pre-hook will swap the cached binary in (fast) or rebuild (~30 s). See the "Running from both Windows and WSL" section above.

**Render is extremely slow**
This is expected — encoding 240 segments + a 240-step xfade chain is heavy. First run on a video of typical length can take 30 min – 2 hr depending on CPU.

---

## Project status

v1 — single user, local, manual YouTube upload, no review UI. See `histforge-spec.md` section 1 for goals/non-goals and section 20 for known risks.

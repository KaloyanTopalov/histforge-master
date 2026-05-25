# HistForge — Onboarding Manual

HistForge is an unattended pipeline that turns a one-line topic into a finished historical YouTube video. It has two parts: a **Next.js dashboard** (web UI in the browser) and a **background worker** that runs the per-video pipeline.

---

## 1. Prerequisites

Install these before anything else:

| Dependency | Why |
|---|---|
| **Node.js >= 20** | Runtime for the app and worker |
| **FFmpeg** (on PATH) | The render step uses it to compose the final video |
| **WSL + Ubuntu** (Windows) | The audio-text alignment step calls a Python script via WSL |
| **Python 3 + aeneas** (inside WSL) | `python/align.py` uses the `aeneas` library for forced alignment |
| **ComfyUI** (running locally) | Generates the per-chunk images and hook video clips |

---

## 2. API Keys — What to Get and Where

You need accounts on **two** external services.

### OpenRouter (for LLM / script generation)

- **What it is:** A proxy service that lets you call models from OpenAI, Anthropic, Google, etc. through a single API key. HistForge routes **all** LLM calls through OpenRouter — it does not call OpenAI directly.
- **Sign up:** [openrouter.ai](https://openrouter.ai). Create an account, add credits, and generate an API key.
- **Env var:** `OPENROUTER_API_KEY` — your OpenRouter key, **not** your OpenAI key.

> **To use GPT-4o:** You don't put an OpenAI key anywhere. Instead, you set the **model** in the dashboard Settings page (step 7). The OpenRouter model ID for GPT-4o is `openai/gpt-4o`. OpenRouter proxies the request using your OpenRouter credits.

### AI33 (for TTS / voiceover)

- **What it is:** An ElevenLabs-compatible TTS cloud API.
- **Env var:** `AI33_API_KEY` — put your AI33 API key here.
- You'll also need an **ElevenLabs voice ID** (e.g. from the ElevenLabs voice library). You enter this in the dashboard Settings, not in the `.env` file.

### ComfyUI (for images and hook video)

- **No API key needed.** ComfyUI runs locally. See `docs/setup-comfyui.md` for installation and checkpoint setup.
- You need two workflow JSON files: one for images (the default ships at `prompts/comfyui/default-workflow.json`) and one for hook videos (**not shipped** — you supply your own; see step 8).

---

## 3. Environment Setup

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx    # Your OpenRouter API key
AI33_API_KEY=xxxxxxxxxxxxxxxx               # Your AI33 API key
DATABASE_URL=./data/histforge.db             # Leave as-is
PROJECTS_DIR=./projects                      # Leave as-is
WSL_DISTRO=Ubuntu                            # Your WSL distro name
```

---

## 4. Install and Initialize

```bash
npm install          # Install Node dependencies (compiles better-sqlite3)
npm run db:init      # Create the SQLite database and seed default settings
```

---

## 5. Start ComfyUI

Launch ComfyUI locally before starting HistForge. By default HistForge expects it at `http://127.0.0.1:8188`; change `comfyui_base_url` in Settings if yours runs elsewhere.

---

## 6. Start the App

```bash
npm run dev
```

This starts **two processes** simultaneously:
- The Next.js dashboard on **http://localhost:3000**
- The background worker that processes the video queue

**Open your browser** and go to **http://localhost:3000**.

For production use: `npm run build && npm start`.

---

## 7. Configure Settings (in the browser)

Go to **http://localhost:3000/settings**. Settings are grouped into six tabs — fill in at least the required fields before queuing anything:

**Script tab — required (provider section, OpenRouter view):**

| Setting | What to enter | Example |
|---|---|---|
| `openrouter_script_model` | OpenRouter model ID for script-writing steps | `anthropic/claude-sonnet-4.6` |
| `openrouter_visual_model` | OpenRouter model ID for visual-prompt enrichment + Google Flow moderation | `anthropic/claude-haiku-4.5` |

(Switch the Provider dropdown to "Claude CLI" if you want to use a local `claude` binary; the binary must be on PATH, and the equivalent fields are `claude_cli_script_model` / `claude_cli_visual_model`.)

**TTS tab — required (AI33 / GenAIPro view):**

| Setting | What to enter | Example |
|---|---|---|
| `voice_id` | ElevenLabs voice ID | `21m00Tcm4TlvDq8ikWAM` |

**ComfyUI tab — verify or adjust:**

| Setting | Default | Notes |
|---|---|---|
| `comfyui_base_url` | `http://127.0.0.1:8188` | Change if ComfyUI runs elsewhere |
| `comfyui_workflow_path` | `prompts/comfyui/default-workflow.json` | Ships with the repo |
| `comfyui_hook_video_workflow_path` | `prompts/comfyui/default-hook-video-workflow.json` | You must supply this — see step 8 |

**Script tab — length and pacing:**

| Setting | Default | Notes |
|---|---|---|
| `script_length_minutes` | `90` | Total chapter narration length in minutes (6..600). Chapter count is derived at ~6 min/chapter. |
| `hook_length_seconds` | `120` | Total hook section length in seconds (4..400). Internal hook chunk count is derived from this and the provider's clip-seconds. |
| `hook_video_clip_seconds` | `8` | ComfyUI-only hook clip length. For Google Flow, use the Google Flow tab's Hook Clip Seconds. |

**Render tab — optional tweaks:**

| Setting | Default | Notes |
|---|---|---|
| `aspect_ratio` | `16:9` | Options: 16:9, 9:16, 1:1, 4:5 |
| `long_edge_px` | `1920` | Resolution |
| `framerate` | `30` | 30 or 60 |

**Google Flow tab — when using the Google Flow workflow:**

| Setting | Default | Notes |
|---|---|---|
| `google_flow_hook_clip_seconds` | `"8"` | Per-clip duration for the Google Flow hook video provider: `"4"`, `"6"`, or `"8"`. Picks the corresponding Veo variant for hook tasks. |

Click **Save**. Unsaved changes are flagged with a small dot on each tab label.

---

## 8. Supply a ComfyUI Hook-Video Workflow

HistForge does **not** ship a default hook-video workflow — it's model-specific (SVD, AnimateDiff, Wan, LTX, …) and depends on what you have installed locally in ComfyUI. In ComfyUI, build a text-to-video workflow, export it via **"Save (API Format)"**, and drop the JSON at the path configured in the ComfyUI tab (default: `prompts/comfyui/default-hook-video-workflow.json`).

The workflow must expose:
- A positive-prompt node (a `CLIPTextEncode` — the first one is used; you can mark a specific node with `_histforge_prompt: true` to override).
- A video output node of class `SaveVideo`, `VHS_VideoCombine`, or any class whose declared output type is `VIDEO`.

---

## 9. Add a Video and Start It

1. Go to **http://localhost:3000/videos** (this is also the home page).
2. Click **"Add Topic"**.
3. Fill in:
   - **Title** — e.g. "The Fall of Constantinople"
   - **Topic info** — a paragraph describing what the video should cover (seeds the LLM research step)
   - **Workflow** — pick **ComfyUI**. (Google Flow is selectable but not yet implemented — it will fail at runtime.)
4. Click **Save**. The new row appears in the **Video Queue** section with status `new`.
5. Click **Start** on the row to move it to `queued`. The worker picks it up FIFO. Use **Start All** in the header to bulk-queue every `new` video at once.

**Editing:** Click **Edit** on a `new` row to change Title / Topic info / Workflow. Edit is only allowed while status is `new`.

**Deleting:** Click **Delete** on any row except `done` videos.
- `new` — removes the row.
- `queued` / `failed` — removes the row and all generated files for that video.
- `in_progress` — the row shows "Deleting…" while the worker finishes the current step, then cleans up and removes everything.
- `done` — deletion is not allowed from the dashboard; remove `<projectsDir>/<video_id>/` manually if needed.

---

## 10. Watch It Run

The `/videos` page auto-refreshes every 5 seconds.

- **Video Queue** section shows rows with status `new`, `queued`, `in_progress`, or `failed`.
- **Finished Videos** section shows rows with status `done`, sorted newest first.
- **Status** column — `new` → `queued` → `in_progress` → `done` (or `failed`).
- **Workflow** column — a short label; hover for the full description.

A toast notification appears when a video finishes or fails.

Click a video title to open the detail page, which shows the step list, step timings, artifacts, and a "View pipeline log" link.

**Failure recovery:** On a failed video's detail page:
- **Retry failed step** — re-runs the failed step, keeping everything before it.
- **Restart from beginning** — deletes all artifacts and re-queues from step 1.

**Manual voiceover upload (skip TTS):** On the video detail page there is a **Voiceover** card with an upload button. Drop in a pre-rendered MP3 (or WAV / M4A / AAC / OGG / FLAC — non-MP3 files are transcoded on the server via ffmpeg) and the file lands at `audio/narration.mp3`. The voiceover step detects the file at entry and skips the TTS provider call. If you upload **after** the voiceover step has already run with TTS, click **Retry failed step** on the voiceover row (or **Restart from beginning** if you want to redo everything) so the pipeline re-enters step 06 and picks up your file.

**Manual alignment upload (skip WSL/aeneas):** Same pattern as voiceover. The **Alignment** card accepts `.json` (aeneas-shape `[{id, text, begin, end}]`) or `.srt` / `.vtt` (parsed and converted server-side). Lands at `alignment/alignment.json`. The align step detects valid content at entry and skips the WSL/aeneas spawn — useful when WSL isn't installed on Windows, or when you already have a Whisper/Descript transcript. Malformed files fall through to aeneas (treated as if no upload happened) so a corrupt drop can't break the chunker downstream.

**Auto-transcribe with Whisper:** The Alignment card has an **Auto-transcribe (Whisper)** button next to Upload. It reads `audio/narration.mp3`, ffmpeg-downsamples it to mono 16 kHz 24 kbps (so it fits Whisper's 25 MB upload cap up to ~2.5 hours of narration), POSTs it to an OpenAI-compatible `/v1/audio/transcriptions` endpoint with `response_format=srt`, parses the returned SRT, and writes `alignment.json`. Configure via three env vars in `.env`:

```
WHISPER_API_KEY=...                                   # required
WHISPER_BASE_URL=https://api.openai.com/v1            # default
WHISPER_MODEL=whisper-1                               # default
```

Works against any endpoint that implements the OpenAI shape — confirmed with OpenAI (`whisper-1`) and Groq (`https://api.groq.com/openai/v1` + `whisper-large-v3`). For narrations longer than the 25 MB cap can hold (~2.5 hours at mono 24 kbps), the route fails with `audio_too_long` and you fall back to uploading an SRT manually.

---

## 11. Copy Path (finished videos)

In the **Finished Videos** section, click **Copy Path** on a row to copy `<projectsDir>/<video_id>/` to your clipboard. Open it in your file manager to find `final.mp4` (and the retained `script/full_script.md` + `pipeline.log`).

---

## Quick Reference

| What | Command / URL |
|---|---|
| Install deps | `npm install` |
| Init database | `npm run db:init` |
| Start dev | `npm run dev` |
| Production build | `npm run build && npm start` |
| Dashboard | http://localhost:3000 |
| Videos page | http://localhost:3000/videos |
| Settings page | http://localhost:3000/settings |
| Run tests | `npm run test` |
| Lint | `npm run lint` |

---

## Troubleshooting

- **Worker not picking up a video?** Check its status in the Video Queue section. Only `queued` videos are picked up — click **Start** (or Start All) to move `new` rows to `queued`.
- **ComfyUI step fails with "ECONNREFUSED"?** Start ComfyUI locally, or update `comfyui_base_url` in Settings to match where it's actually running.
- **Hook-video step fails with "drop your ComfyUI video workflow at …"?** You haven't supplied the hook-video workflow JSON — see step 8.
- **Video stuck in `in_progress` after a crash?** Restart the worker — on startup it resets stale running steps and resumes from the first non-`done` step.
- **"Copy .env.example" error?** You forgot to create the `.env` file or left a key blank.
- **YouForge Flow popup rejects the Character lock value?** Confirm it's a UUID in 8-4-4-4-12 lowercase hex format. Capture the value from Flow's network call (DevTools → Network → `flowMedia:batchGenerateImages` payload → `referenceEntities[0].entityId`). See `docs/setup-guides/setup-google-flow.md` → "Step: Lock a character".
- **Image tasks fail with `BadCharacterLockError`?** The stored lock value is corrupt (popup validation should have prevented this; the most likely cause is a direct `chrome.storage.local` write). Re-capture the entity ID from Flow and save it through the popup.
- **Is the character lock active?** Open the YouForge Flow service-worker console. Every image task logs `[api] Task <id> characterLock=<UUID>`. `characterLock=none` means the lock is unset for that profile.

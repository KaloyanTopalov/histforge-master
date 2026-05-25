# ComfyUI Setup Guide

HistForge uses a local ComfyUI instance to generate images for video chapters. This guide covers installation on Windows, checkpoint setup, and integration with HistForge.

## Prerequisites

- Windows 10/11 with an NVIDIA GPU (4 GB+ VRAM recommended; 8 GB+ for SDXL at higher resolutions)
- No Python install required — the portable package bundles everything

## Installation

1. Download the latest **ComfyUI portable** package from [https://github.com/comfyanonymous/ComfyUI/releases](https://github.com/comfyanonymous/ComfyUI/releases). Choose the file named `ComfyUI_windows_portable_*.7z`.
2. Extract the archive to a permanent location (e.g., `C:\ComfyUI`).
3. Run `ComfyUI_windows_portable\run_nvidia_gpu.bat` to start ComfyUI.
4. Open `http://127.0.0.1:8188` in a browser. You should see the ComfyUI web UI.

## Install a checkpoint

HistForge's default workflow expects an SDXL checkpoint.

1. Download `sd_xl_base_1.0.safetensors` from [Hugging Face](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/tree/main) (~6.9 GB).
2. Place it in `ComfyUI_windows_portable\ComfyUI\models\checkpoints\`.
3. Restart ComfyUI if it was already running.

Other SDXL-compatible checkpoints work too — just update the `ckpt_name` in your workflow file (see "Custom workflows" below).

## Verify the connection

With ComfyUI running, confirm HistForge can reach it:

```bash
curl http://127.0.0.1:8188/system_stats
```

You should get a JSON response with GPU and queue info. If HistForge is configured with a different URL, adjust accordingly.

## HistForge settings

These settings control the ComfyUI integration (configured via the dashboard Settings page or directly in SQLite):

| Setting | Default | Description |
|---------|---------|-------------|
| `image_provider` | `comfyui` | Image generation backend |
| `comfyui_base_url` | `http://127.0.0.1:8188` | ComfyUI API URL |
| `comfyui_workflow_path` | `prompts/comfyui/default-workflow.json` | Path to the workflow file |
| `aspect_ratio` | `16:9` | Output aspect ratio |
| `long_edge_px` | `1920` | Long edge in pixels (width/height computed from aspect ratio) |

If ComfyUI runs on a different machine or port, update `comfyui_base_url`.

## Custom workflows (Optional)

HistForge ships a default SDXL workflow at `prompts/comfyui/default-workflow.json`. To use your own:

1. Build your workflow in the ComfyUI web UI.
2. Click the gear icon and enable **Dev mode options**.
3. Click **Save (API Format)** — this exports the node-based JSON that HistForge expects (not the UI-graph format).
4. Mark your positive-prompt node by adding `"_histforge_prompt": true` at the top level of that node's JSON (sibling to `class_type`):
   ```json
   {
     "class_type": "CLIPTextEncode",
     "_histforge_prompt": true,
     "inputs": {
       "text": "PROMPT_PLACEHOLDER",
       "clip": ["4", 1]
     }
   }
   ```
5. Save the file anywhere in the project and set `comfyui_workflow_path` to point to it.

HistForge locates nodes by `class_type`, so your workflow must include:
- **CLIPTextEncode** — positive prompt is injected here (the `_histforge_prompt` marker, or first by node ID)
- **EmptyLatentImage** — resolution (width/height) is injected here
- **SaveImage** or **PreviewImage** — output image is downloaded from here

See `prompts/comfyui/README.md` for node details, LoRA instructions, and resolution guidance.

## Troubleshooting

**ComfyUI won't start / port conflict**
The default port is 8188. If something else uses it, edit `run_nvidia_gpu.bat` and add `--port 8189` (or any free port) to the command line, then update `comfyui_base_url` in HistForge settings.

**"ComfyUI is unreachable" error in HistForge**
ComfyUI must be running before starting image generation steps (10 and 11). Start it before unpausing the queue.

**Out of VRAM / CUDA out of memory**
- Lower `long_edge_px` to `1024` — SDXL works best around 1024px.
- Close other GPU-intensive applications.
- Add `--lowvram` to the bat file launch arguments for aggressive memory management.

**"Workflow has no CLIPTextEncode node" or similar**
Your workflow file is not in API format. Re-export using **Save (API Format)** with Dev mode enabled.

**Wrong checkpoint name**
If ComfyUI logs `CheckpointLoaderSimple: file not found`, the `ckpt_name` in your workflow doesn't match a file in `models/checkpoints/`. Check the exact filename (case-sensitive) and update the workflow JSON.

**Images look bad / wrong style**
The default workflow uses a vanilla SDXL checkpoint with basic settings. For better results, swap in a fine-tuned checkpoint or add LoRA nodes. See the workflow README for instructions.

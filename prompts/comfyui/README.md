# ComfyUI Workflow Templates

This directory contains ComfyUI workflow files in **API format** (node-based JSON). HistForge loads the workflow specified by the `comfyui_workflow_path` setting and injects the image prompt and resolution before submitting it to ComfyUI.

## How HistForge uses the workflow

On each image generation request, HistForge:

1. **Injects the prompt** into the positive-prompt node. It looks for:
   - A node with `"_histforge_prompt": true` (preferred), or
   - The first `CLIPTextEncode` node by numeric key order (fallback).
2. **Injects resolution** (width/height) into the `EmptyLatentImage` node, derived from the `aspect_ratio` and `long_edge_px` settings.
3. Submits the modified workflow to ComfyUI's `/prompt` endpoint.
4. Polls `/history/{prompt_id}` until the output is ready.
5. Downloads the output image from the `SaveImage` (or `PreviewImage`) node.

## Default workflow (`default-workflow.json`)

A minimal SDXL workflow: checkpoint loader, positive/negative CLIP text encode, KSampler, VAE decode, and SaveImage. Node "6" is marked with `_histforge_prompt` so HistForge knows where to inject the image prompt.

### Nodes

| Node | Class | Purpose |
|------|-------|---------|
| 3 | KSampler | Sampling (25 steps, euler, cfg 7) |
| 4 | CheckpointLoaderSimple | Loads the SDXL checkpoint |
| 5 | EmptyLatentImage | Starting latent (resolution injected by HistForge) |
| 6 | CLIPTextEncode | **Positive prompt** (injected by HistForge) |
| 7 | CLIPTextEncode | Negative prompt |
| 8 | VAEDecode | Decode latent to pixel image |
| 9 | SaveImage | Save output (HistForge downloads from here) |

## Exporting a custom workflow from ComfyUI

1. Build your workflow in ComfyUI's web UI.
2. Click the gear icon, then **Enable Dev mode options**.
3. Click **Save (API Format)** — this produces the node-based JSON that HistForge expects.
4. Mark your positive-prompt node by adding `"_histforge_prompt": true` at the top level of that node's JSON object (sibling to `class_type`).
5. Save the file and update the `comfyui_workflow_path` setting to point to it.

## Swapping checkpoints or adding LoRAs

- **Checkpoint**: Change `ckpt_name` in node 4 to match the filename in your `ComfyUI/models/checkpoints/` directory.
- **LoRA**: Add a `LoraLoader` node between the checkpoint and the KSampler. Connect it to the model and CLIP outputs. Export in API format as above.

## Resolution guidance

HistForge computes width/height from the `aspect_ratio` and `long_edge_px` settings. The `EmptyLatentImage` node values in this file are overridden at runtime. Common combinations:

| Aspect Ratio | Long Edge | Resolution |
|-------------|-----------|------------|
| 16:9 | 1920 | 1920 x 1080 |
| 16:9 | 1024 | 1024 x 576 |
| 9:16 | 1920 | 1080 x 1920 |
| 1:1 | 1024 | 1024 x 1024 |
| 4:5 | 1920 | 1536 x 1920 |

SDXL works best at ~1024px total resolution. For higher values, consider adding an upscaler node to your workflow.

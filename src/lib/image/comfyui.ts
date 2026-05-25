import type { Database as DatabaseType } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getDb } from "../db";
import { getSetting } from "../settings";
import { computeResolution } from "../render";
import { isAbortError, throwIfAborted } from "@/worker/cancellation";
import type { ImageProvider, ImageProviderGenerateBatchOpts } from "./types";

export interface ComfyUIGenerateBatchOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  /** Delay between history polls, in ms. Tests pass 0. */
  pollIntervalMs?: number;
  /** Cancellation signal — passed to fetch and checked between items. */
  signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/**
 * Bound on consecutive non-fatal poll failures (network drop, HTTP non-2xx,
 * non-JSON body). Prevents a wedged ComfyUI from spinning forever; same
 * mitigation pattern used in lib/tts/ai33.ts.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  [key: string]: unknown;
};
type Workflow = Record<string, WorkflowNode>;

/**
 * Find the positive-prompt node in the workflow. Priority:
 * 1. A node with `_histforge_prompt: true`
 * 2. The first CLIPTextEncode node (by numeric key order)
 */
function findPromptNode(workflow: Workflow): WorkflowNode {
  // Priority 1: explicit marker
  for (const node of Object.values(workflow)) {
    if (node._histforge_prompt) return node;
  }
  // Priority 2: first CLIPTextEncode by numeric key order
  const clipEntries = Object.entries(workflow)
    .filter(([, n]) => n.class_type === "CLIPTextEncode")
    .sort(([a], [b]) => Number(a) - Number(b));
  if (clipEntries.length === 0) {
    throw new Error(
      "Workflow has no CLIPTextEncode node — cannot inject prompt"
    );
  }
  return clipEntries[0][1];
}

/** Find the EmptyLatentImage node and return it. */
function findLatentNode(workflow: Workflow): WorkflowNode {
  const entry = Object.values(workflow).find(
    (n) => n.class_type === "EmptyLatentImage"
  );
  if (!entry) {
    throw new Error(
      "Workflow has no EmptyLatentImage node — cannot inject resolution"
    );
  }
  return entry;
}

/** Find the first SaveImage (or PreviewImage) node to locate outputs. */
function findOutputNodeId(workflow: Workflow): string {
  const entry = Object.entries(workflow).find(
    ([, n]) =>
      n.class_type === "SaveImage" || n.class_type === "PreviewImage"
  );
  if (!entry) {
    throw new Error("Workflow has no SaveImage node — cannot locate output");
  }
  return entry[0];
}

/**
 * Find a video-saving node to locate outputs. The user supplies the
 * workflow, and different backends (SVD, AnimateDiff, VHS, LTX) use
 * different output nodes — match by class-name pattern rather than a
 * fixed whitelist.
 */
function findVideoOutputNodeId(workflow: Workflow): string {
  const entry = Object.entries(workflow).find(([, n]) => {
    const c = n.class_type;
    return (
      c.startsWith("SaveVideo") ||
      c === "VHS_VideoCombine" ||
      c === "VideoCombine" ||
      c === "SaveAnimatedWEBP"
    );
  });
  if (!entry) {
    throw new Error(
      "Workflow has no video-saving node — expected one of SaveVideo, VHS_VideoCombine, or similar"
    );
  }
  return entry[0];
}

async function submitPrompt(
  baseUrl: string,
  workflow: Workflow,
  signal?: AbortSignal
): Promise<string> {
  const url = `${baseUrl}/prompt`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `ComfyUI POST /prompt ${response.status}: ${await response.text()}`
    );
  }
  const json = (await response.json()) as { prompt_id?: string };
  if (typeof json.prompt_id !== "string") {
    throw new Error(
      `ComfyUI POST /prompt response missing prompt_id: ${JSON.stringify(json)}`
    );
  }
  return json.prompt_id;
}

interface OutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

async function pollUntilComplete(
  baseUrl: string,
  promptId: string,
  outputNodeId: string,
  pollIntervalMs: number,
  signal?: AbortSignal
): Promise<OutputImage> {
  const url = `${baseUrl}/history/${promptId}`;
  let consecutiveFailures = 0;
  const noteFailure = (kind: string): void => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      throw new Error(
        `ComfyUI prompt ${promptId}: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures (${kind}) — giving up`
      );
    }
  };

  for (;;) {
    throwIfAborted(signal);
    await sleep(pollIntervalMs);
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      noteFailure("network");
      continue;
    }
    if (!response.ok) {
      noteFailure(`http-${response.status}`);
      continue;
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      noteFailure("non-json-body");
      continue;
    }

    const entry = json[promptId] as
      | {
          status?: {
            status_str?: string;
            messages?: [string, { exception_message?: string }][];
          };
          outputs?: Record<string, { images?: OutputImage[] }>;
        }
      | undefined;
    if (!entry) {
      // "not ready yet" is a successful poll, not a failure — reset cap.
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures = 0;

    // Detect execution errors before checking outputs
    if (entry.status?.status_str === "error") {
      const errMsg =
        entry.status.messages
          ?.find(([tag]) => tag === "execution_error")
          ?.[1]?.exception_message ?? "unknown error";
      throw new Error(
        `ComfyUI prompt ${promptId} failed: ${errMsg}`
      );
    }

    const images = entry.outputs?.[outputNodeId]?.images;
    if (!images || images.length === 0) continue;

    return images[0];
  }
}

async function downloadImage(
  baseUrl: string,
  image: OutputImage,
  outPath: string,
  signal?: AbortSignal
): Promise<void> {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  const url = `${baseUrl}/view?${params.toString()}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`ComfyUI GET /view ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(outPath, bytes);
}

/**
 * Poll /history/<prompt_id> until the output node produces any array of
 * {filename, subfolder, type}. Unlike pollUntilComplete (which checks
 * specifically for `.images`), this iterates all keys under the output
 * node because video nodes emit under varying keys (videos, gifs, files).
 */
async function pollUntilCompleteVideo(
  baseUrl: string,
  promptId: string,
  outputNodeId: string,
  pollIntervalMs: number,
  signal?: AbortSignal
): Promise<OutputImage> {
  const url = `${baseUrl}/history/${promptId}`;
  let consecutiveFailures = 0;
  const noteFailure = (kind: string): void => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      throw new Error(
        `ComfyUI prompt ${promptId}: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures (${kind}) — giving up`
      );
    }
  };

  for (;;) {
    throwIfAborted(signal);
    await sleep(pollIntervalMs);
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      noteFailure("network");
      continue;
    }
    if (!response.ok) {
      noteFailure(`http-${response.status}`);
      continue;
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      noteFailure("non-json-body");
      continue;
    }

    const entry = json[promptId] as
      | {
          status?: {
            status_str?: string;
            messages?: [string, { exception_message?: string }][];
          };
          outputs?: Record<string, Record<string, unknown>>;
        }
      | undefined;
    if (!entry) {
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures = 0;

    if (entry.status?.status_str === "error") {
      const errMsg =
        entry.status.messages
          ?.find(([tag]) => tag === "execution_error")
          ?.[1]?.exception_message ?? "unknown error";
      throw new Error(`ComfyUI prompt ${promptId} failed: ${errMsg}`);
    }

    const nodeOutputs = entry.outputs?.[outputNodeId];
    if (!nodeOutputs) continue;

    for (const value of Object.values(nodeOutputs)) {
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof (value[0] as OutputImage)?.filename === "string"
      ) {
        return value[0] as OutputImage;
      }
    }
    // node reached but no file entries yet
  }
}

export interface ComfyUIGenerateHookVideoOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Generate a video clip per item using the user-supplied ComfyUI workflow
 * at `comfyui_hook_video_workflow_path`. Wrapped by `comfyuiVideoProvider`
 * for any workflow that produces clip-kind chunks. Reuses the image
 * submit/download plumbing; output-node detection and poll are
 * video-aware. Outputs land at `<targetDir>/<id>.mp4`. The "hook" prefix
 * on the helper and on the setting key is a historic artifact — the
 * physics it captures (one clip per chunk) survives the asset-type rename.
 */
export async function generateHookVideoBatch(
  items: { id: string; prompt: string }[],
  targetDir: string,
  opts: ComfyUIGenerateHookVideoOpts = {}
): Promise<void> {
  const db = opts.db ?? getDb();
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const baseUrl = getSetting("comfyui_base_url", db);
  const workflowPath = getSetting("comfyui_hook_video_workflow_path", db);

  let workflowTemplate: Workflow;
  try {
    workflowTemplate = JSON.parse(readFileSync(workflowPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `ComfyUI hook-video workflow not found at ${workflowPath} — drop your ComfyUI video workflow JSON there and retry.`
      );
    }
    throw err;
  }
  const outputNodeId = findVideoOutputNodeId(workflowTemplate);

  mkdirSync(targetDir, { recursive: true });

  const total = items.length;
  for (let i = 0; i < total; i++) {
    throwIfAborted(opts.signal);
    const item = items[i];
    const outPath = join(targetDir, `${item.id}.mp4`);

    if (existsSync(outPath)) {
      opts.log?.(`Skipping ${item.id} — already exists`);
      continue;
    }

    opts.log?.(`Generating hook video ${i + 1}/${total}: ${item.id}`);

    const workflow: Workflow = JSON.parse(JSON.stringify(workflowTemplate));
    findPromptNode(workflow).inputs.text = item.prompt;

    try {
      const promptId = await submitPrompt(baseUrl, workflow, opts.signal);
      const output = await pollUntilCompleteVideo(
        baseUrl,
        promptId,
        outputNodeId,
        pollInterval,
        opts.signal
      );
      await downloadImage(baseUrl, output, outPath, opts.signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (
        err instanceof TypeError &&
        (err.message.includes("fetch failed") ||
          err.message.includes("ECONNREFUSED"))
      ) {
        throw new Error(
          `ComfyUI is unreachable at ${baseUrl} — is it running? (${err.message})`
        );
      }
      throw err;
    }
  }
}

async function generateBatch(
  items: { id: string; prompt: string }[],
  targetDir: string,
  opts: ImageProviderGenerateBatchOpts
): Promise<void> {
  const db = opts.db ?? getDb();
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const baseUrl = getSetting("comfyui_base_url", db);
  const workflowPath = getSetting("comfyui_workflow_path", db);
  const aspectRatio = getSetting("aspect_ratio", db);
  const longEdgePx = getSetting("long_edge_px", db);

  const { width, height } = computeResolution(aspectRatio, longEdgePx);
  const workflowTemplate: Workflow = JSON.parse(
    readFileSync(workflowPath, "utf-8")
  );
  const outputNodeId = findOutputNodeId(workflowTemplate);

  mkdirSync(targetDir, { recursive: true });

  const total = items.length;
  for (let i = 0; i < total; i++) {
    throwIfAborted(opts.signal);
    const item = items[i];
    const outPath = join(targetDir, `${item.id}.png`);

    if (existsSync(outPath)) {
      opts.log?.(`Skipping ${item.id} — already exists`);
      continue;
    }

    opts.log?.(`Generating image ${i + 1}/${total}: ${item.id}`);

    // Deep-clone and inject prompt + resolution
    const workflow: Workflow = JSON.parse(JSON.stringify(workflowTemplate));
    findPromptNode(workflow).inputs.text = item.prompt;
    const latent = findLatentNode(workflow);
    latent.inputs.width = width;
    latent.inputs.height = height;

    try {
      const promptId = await submitPrompt(baseUrl, workflow, opts.signal);
      const output = await pollUntilComplete(
        baseUrl,
        promptId,
        outputNodeId,
        pollInterval,
        opts.signal
      );
      await downloadImage(baseUrl, output, outPath, opts.signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (
        err instanceof TypeError &&
        (err.message.includes("fetch failed") ||
          err.message.includes("ECONNREFUSED"))
      ) {
        throw new Error(
          `ComfyUI is unreachable at ${baseUrl} — is it running? (${err.message})`
        );
      }
      throw err;
    }
  }
}

export const comfyuiProvider: ImageProvider = {
  generateBatch,
  cleanup: async (videoId, opts) => {
    rmSync(join(opts.projectsDir, videoId, "images"), {
      recursive: true,
      force: true,
    });
  },
};

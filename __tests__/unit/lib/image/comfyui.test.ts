import {
  describe,
  it,
  expect,
  afterEach,
  vi,
} from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import {
  comfyuiProvider,
  generateHookVideoBatch,
} from "@/lib/image/comfyui";

const originalFetch = global.fetch;
const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

/** Minimal ComfyUI API-format workflow with the nodes the client needs. */
function makeWorkflow() {
  return {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sdxl.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "positive placeholder", clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "bad quality", clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

/** Write workflow file to disk and configure the DB setting to point at it. */
function setupWorkflow(
  db: DatabaseType,
  workflow?: Record<string, unknown>
): string {
  const dir = tempDir("workflow");
  const path = join(dir, "workflow.json");
  writeFileSync(path, JSON.stringify(workflow ?? makeWorkflow()), "utf-8");
  setSetting("comfyui_workflow_path", path, db);
  return path;
}

/**
 * ComfyUI ignores videoId/projectsDir at runtime; this helper fills in
 * stubs so test calls satisfy ImageProviderGenerateBatchOpts.
 */
function gbOpts(
  db: DatabaseType,
  overrides: Partial<{
    pollIntervalMs: number;
    log: (m: string) => void;
  }> = {}
) {
  return {
    db,
    videoId: "v_test",
    projectsDir: "/tmp/projects-stub",
    pollIntervalMs: overrides.pollIntervalMs ?? 0,
    ...(overrides.log ? { log: overrides.log } : {}),
  };
}

/** Build a mock ComfyUI /history response for a completed prompt. */
function historyDone(promptId: string, filename: string) {
  return {
    [promptId]: {
      outputs: {
        "9": {
          images: [{ filename, subfolder: "", type: "output" }],
        },
      },
    },
  };
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("comfyuiProvider.generateBatch", () => {
  it("enqueues workflow, polls until complete, downloads output image", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const fetchMock = vi
      .fn()
      // POST /prompt
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_001" }), { status: 200 })
      )
      // GET /history/p_001 — not ready
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      )
      // GET /history/p_001 — done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_001", "ComfyUI_00001_.png")),
          { status: 200 }
        )
      )
      // GET /view — download image
      .mockResolvedValueOnce(new Response(pngBytes, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [{ id: "image_001", prompt: "a medieval castle" }],
      targetDir,
      gbOpts(db)
    );

    // Image file written to <targetDir>/<id>.png
    const outPath = join(targetDir, "image_001.png");
    expect(existsSync(outPath)).toBe(true);
    expect(new Uint8Array(readFileSync(outPath))).toEqual(pngBytes);

    expect(fetchMock).toHaveBeenCalledTimes(4);

    // POST /prompt to comfyui_base_url
    const [submitUrl, submitInit] = fetchMock.mock.calls[0];
    expect(submitUrl).toBe("http://127.0.0.1:8188/prompt");
    expect((submitInit as RequestInit).method).toBe("POST");

    // Two polls: GET /history/{prompt_id}
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:8188/history/p_001"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "http://127.0.0.1:8188/history/p_001"
    );

    // Download: GET /view?filename=...&subfolder=...&type=...
    const viewUrl = fetchMock.mock.calls[3][0] as string;
    expect(viewUrl).toContain("/view?");
    expect(viewUrl).toContain("filename=ComfyUI_00001_.png");
  });

  it("injects prompt text into the first CLIPTextEncode node in the submitted workflow", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_inj" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_inj", "out.png")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [{ id: "c1", prompt: "a burning library in Rome" }],
      targetDir,
      gbOpts(db)
    );

    // Inspect the workflow sent in POST /prompt body
    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    const workflow = submitBody.prompt;

    // Node "6" is the first CLIPTextEncode (by key order "6" < "7")
    expect(workflow["6"].inputs.text).toBe("a burning library in Rome");
    // Negative prompt (node "7") should be untouched
    expect(workflow["7"].inputs.text).toBe("bad quality");
  });

  it("injects width/height into EmptyLatentImage derived from aspect_ratio + long_edge_px", async () => {
    const db = freshDb();
    setupWorkflow(db);
    // 16:9 at 1920 long edge → 1920×1080 (both even)
    setSetting("aspect_ratio", "16:9", db);
    setSetting("long_edge_px", 1920, db);
    const targetDir = join(tempDir("project"), "images");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_res" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_res", "out.png")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [{ id: "c1", prompt: "test" }],
      targetDir,
      gbOpts(db)
    );

    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    const latentInputs = submitBody.prompt["5"].inputs;
    expect(latentInputs.width).toBe(1920);
    expect(latentInputs.height).toBe(1080);
  });

  it("processes multiple items sequentially, writing <id>.png for each", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    // Two items → two rounds of submit/poll/download
    const fetchMock = vi
      .fn()
      // Item 1: submit
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_a" }), { status: 200 })
      )
      // Item 1: poll → done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_a", "img_a.png")),
          { status: 200 }
        )
      )
      // Item 1: download
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xaa]), { status: 200 })
      )
      // Item 2: submit
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_b" }), { status: 200 })
      )
      // Item 2: poll → done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_b", "img_b.png")),
          { status: 200 }
        )
      )
      // Item 2: download
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xbb]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [
        { id: "image_001", prompt: "castle" },
        { id: "image_002", prompt: "forest" },
      ],
      targetDir,
      gbOpts(db)
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(readFileSync(join(targetDir, "image_001.png"))).toEqual(
      Buffer.from([0xaa])
    );
    expect(readFileSync(join(targetDir, "image_002.png"))).toEqual(
      Buffer.from([0xbb])
    );

    // Items are sequential: item 2's submit comes after item 1's download
    // Submit calls at indices 0 and 3
    expect((fetchMock.mock.calls[0][0] as string)).toContain("/prompt");
    expect((fetchMock.mock.calls[3][0] as string)).toContain("/prompt");
  });

  it("skips items whose output file already exists (resume semantics)", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    // Pre-create image_001.png so it gets skipped
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "image_001.png"), Buffer.from([0x01]));

    // Only image_002 should hit ComfyUI
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_resume" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_resume", "out.png")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x02]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [
        { id: "image_001", prompt: "castle" },
        { id: "image_002", prompt: "forest" },
      ],
      targetDir,
      gbOpts(db)
    );

    // Only 3 fetch calls (submit + poll + download for image_002 only)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // image_001 is still the original byte, not overwritten
    expect(readFileSync(join(targetDir, "image_001.png"))).toEqual(
      Buffer.from([0x01])
    );
    // image_002 was generated
    expect(readFileSync(join(targetDir, "image_002.png"))).toEqual(
      Buffer.from([0x02])
    );
  });

  it("logs progress per item and skip messages for existing files", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    // Pre-create first item
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "image_001.png"), Buffer.from([0x01]));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_log" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_log", "out.png")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await comfyuiProvider.generateBatch(
      [
        { id: "image_001", prompt: "castle" },
        { id: "image_002", prompt: "forest" },
      ],
      targetDir,
      gbOpts(db, { log })
    );

    // Skip message for image_001, progress message for image_002
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/Skipping image_001/);
    expect(log.mock.calls[1][0]).toMatch(/2\/2.*image_002/);
  });

  it("surfaces helpful error when ComfyUI is unreachable", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      comfyuiProvider.generateBatch(
        [{ id: "c1", prompt: "test" }],
        targetDir,
        gbOpts(db)
      )
    ).rejects.toThrow(/unreachable.*127\.0\.0\.1:8188/i);
  });

  it("prefers a node with _histforge_prompt over the first CLIPTextEncode", async () => {
    const db = freshDb();
    // Workflow where node "7" (normally negative) has the marker
    const workflow = makeWorkflow() as Record<string, Record<string, unknown>>;
    (workflow["7"] as Record<string, unknown>)._histforge_prompt = true;
    setupWorkflow(db, workflow);
    const targetDir = join(tempDir("project"), "images");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_mark" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDone("p_mark", "out.png")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await comfyuiProvider.generateBatch(
      [{ id: "c1", prompt: "a Viking ship" }],
      targetDir,
      gbOpts(db)
    );

    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    const submitted = submitBody.prompt;

    // Node "7" (marked) gets the prompt injected
    expect(submitted["7"].inputs.text).toBe("a Viking ship");
    // Node "6" (first CLIPTextEncode by key order, but NOT marked) is untouched
    expect(submitted["6"].inputs.text).toBe("positive placeholder");
  });

  // ─── generateHookVideoBatch ──────────────────────────────────────────

  /** Minimal workflow using a SaveVideo output node. */
  function makeVideoWorkflow(outputClass = "SaveVideo") {
    return {
      "6": {
        class_type: "CLIPTextEncode",
        inputs: { text: "positive placeholder" },
      },
      "10": {
        class_type: outputClass,
        inputs: { filename_prefix: "hook", images: ["9", 0] },
      },
    };
  }

  function setupVideoWorkflow(
    db: DatabaseType,
    workflow?: Record<string, unknown>
  ): string {
    const dir = tempDir("hook-wf");
    const path = join(dir, "hook-workflow.json");
    writeFileSync(
      path,
      JSON.stringify(workflow ?? makeVideoWorkflow()),
      "utf-8"
    );
    setSetting("comfyui_hook_video_workflow_path", path, db);
    return path;
  }

  function historyDoneVideo(
    promptId: string,
    filename: string,
    outputKey = "videos",
    outputNodeId = "10"
  ) {
    return {
      [promptId]: {
        outputs: {
          [outputNodeId]: {
            [outputKey]: [{ filename, subfolder: "", type: "output" }],
          },
        },
      },
    };
  }

  it("generateHookVideoBatch enqueues video workflow, polls, downloads .mp4", async () => {
    const db = freshDb();
    setupVideoWorkflow(db);
    const targetDir = join(tempDir("project"), "videos", "clip");
    const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_vid1" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDoneVideo("p_vid1", "hook_00001_.mp4")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(mp4Bytes, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await generateHookVideoBatch(
      [{ id: "clip_01", prompt: "a thundering horse charge" }],
      targetDir,
      gbOpts(db)
    );

    const outPath = join(targetDir, "clip_01.mp4");
    expect(existsSync(outPath)).toBe(true);
    expect(new Uint8Array(readFileSync(outPath))).toEqual(mp4Bytes);

    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(submitBody.prompt["6"].inputs.text).toBe(
      "a thundering horse charge"
    );
  });

  it("generateHookVideoBatch recognizes VHS_VideoCombine as a video output node", async () => {
    const db = freshDb();
    setupVideoWorkflow(db, makeVideoWorkflow("VHS_VideoCombine"));
    const targetDir = join(tempDir("project"), "videos", "clip");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_vhs" }), { status: 200 })
      )
      // VHS_VideoCombine reports outputs under a different key
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(historyDoneVideo("p_vhs", "hook.mp4", "gifs")),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await generateHookVideoBatch(
      [{ id: "clip_02", prompt: "a silent empty battlefield" }],
      targetDir,
      gbOpts(db)
    );

    expect(existsSync(join(targetDir, "clip_02.mp4"))).toBe(true);
  });

  it("generateHookVideoBatch throws a helpful error when the workflow path does not resolve", async () => {
    const db = freshDb();
    setSetting(
      "comfyui_hook_video_workflow_path",
      "/tmp/this-path-does-not-exist-histforge.json",
      db
    );
    const targetDir = join(tempDir("project"), "videos", "clip");

    await expect(
      generateHookVideoBatch(
        [{ id: "clip_01", prompt: "test" }],
        targetDir,
        gbOpts(db)
      )
    ).rejects.toThrow(/ComfyUI.*hook.*workflow.*not found/i);
  });

  it("cleanup removes <projectsDir>/<videoId>/images recursively", () => {
    const projectsDir = tempDir("project");
    const videoId = "v_clean";
    const imagesDir = join(projectsDir, videoId, "images");
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, "image_001.png"), "fake-png", "utf-8");
    expect(existsSync(imagesDir)).toBe(true);

    comfyuiProvider.cleanup!(videoId, { projectsDir });

    expect(existsSync(imagesDir)).toBe(false);
    // Other project subdirectories untouched
    expect(existsSync(join(projectsDir, videoId))).toBe(true);
  });

  it("cleanup is a no-op when target dir doesn't exist (force: true)", () => {
    const projectsDir = tempDir("project");
    expect(() =>
      comfyuiProvider.cleanup!("v_missing", { projectsDir })
    ).not.toThrow();
  });

  it("throws when ComfyUI reports an execution error instead of polling forever", async () => {
    const db = freshDb();
    setupWorkflow(db);
    const targetDir = join(tempDir("project"), "images");

    const fetchMock = vi
      .fn()
      // POST /prompt — accepted
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: "p_err" }), { status: 200 })
      )
      // GET /history/p_err — error status, empty outputs
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            p_err: {
              status: {
                status_str: "error",
                completed: false,
                messages: [
                  [
                    "execution_error",
                    {
                      node_id: "3",
                      node_type: "KSampler",
                      exception_message: "Model file not found: sdxl.safetensors",
                    },
                  ],
                ],
              },
              outputs: {},
            },
          }),
          { status: 200 }
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      comfyuiProvider.generateBatch(
        [{ id: "c1", prompt: "test" }],
        targetDir,
        gbOpts(db)
      )
    ).rejects.toThrow(/Model file not found/);

    // Only 2 calls: submit + one poll. No infinite loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

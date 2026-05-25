import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import * as videosRepo from "@/lib/repos/videos";

/**
 * Phase 4 Task 12 integration test. End-to-end: a workflow with
 * `script_llm_provider: "claude_cli"` runs the three script-module steps
 * via `child_process.spawn` instead of fetch. The mock is at the spawn
 * boundary only — `getLlmProvider`, `claudeCliProvider.chat`, and
 * `spawnAndCapture` all run as production code.
 *
 * Step 04 (`write_chapters`) makes more than one chat call (extract +
 * batch chapter + story_so_far per batch), so the per-step spawn count
 * isn't 1:1. We assert at least four invocations (one per script step is
 * the floor, and step 04 alone contributes three for chapter_count=1) and
 * check the model arg on every call rather than pinning a specific count.
 */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

const { runPipeline } = await import("@/worker/pipeline");
const { REAL_STEPS } = await import("@/worker/steps");

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

/**
 * Default spawn behavior. Inspects the prompt piped to stdin and picks a
 * reply that satisfies the current step's parser:
 *
 *   - Step 04's extract phase ("Extract the chapters ...") needs a JSON
 *     array matching `chapter_count = 1`.
 *   - Step 01 counts ``**Title**`` blocks against the derived chapter
 *     count and triggers a repair loop if short, so its reply must
 *     contain at least one such block.
 *   - Step 02 (write_hook), step 04's chapter batch, and step 04's
 *     story_so_far accept any string; the outline-shaped reply works for
 *     all three (batch with `chapter_count = 1` is one unsplit part).
 */
const JSON_CHAPTER_REPLY = '[{"number":1,"title":"X","summary":"Y"}]';
const OUTLINE_REPLY = "**Chapter 1: X**\n\nbody text";

function pickReply(prompt: string): string {
  if (prompt.includes("Extract the chapters from this outline as JSON")) {
    return JSON_CHAPTER_REPLY;
  }
  return OUTLINE_REPLY;
}

function installDefaultSpawnBehavior(): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    setImmediate(() => {
      const endMock = child.stdin.end as ReturnType<typeof vi.fn>;
      const prompt = (endMock.mock.calls[0]?.[0] as string) ?? "";
      child.stdout.emit("data", Buffer.from(pickReply(prompt)));
      child.emit("close", 0);
    });
    return child;
  });
}

/**
 * Insert a clone of `comfyui` keyed `comfyui-cli` whose
 * `script_llm_provider` is `claude_cli`. Reuses the four script-module
 * step rows from BUILTIN_WORKFLOWS[0] so `materializeStepList` produces
 * the same expansion as the seeded workflow.
 */
function seedClaudeCliWorkflow(db: DatabaseType): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, label, short_label, description, script_llm_provider,
        tts_provider, image_provider, video_provider,
        is_builtin, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`
  ).run(
    "comfyui-cli",
    "ComfyUI (Claude CLI)",
    "ComfyUI CLI",
    null,
    "claude_cli",
    "ai33",
    "comfyui",
    "comfyui",
    now,
    now
  );
  const insertStep = db.prepare(
    "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
  );
  const slugs = [
    "research_outline",
    "write_hook",
    "write_chapters",
  ];
  slugs.forEach((slug, position) => {
    insertStep.run("comfyui-cli", position, slug);
  });
}

const SCRIPT_STEP_NAMES = [
  "research_outline",
  "write_hook",
  "write_chapters",
];

function scriptSteps() {
  const bySlug = new Map(REAL_STEPS.map((s) => [s.name, s] as const));
  return SCRIPT_STEP_NAMES.map((slug) => {
    const s = bySlug.get(slug);
    if (!s) throw new Error(`unknown step ${slug}`);
    return s;
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  installDefaultSpawnBehavior();
});

afterEach(() => {
  vi.restoreAllMocks();
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("runPipeline — script_llm_provider = claude_cli", () => {
  it("runs the three script steps via spawn and marks each video_steps row 'done'", async () => {
    const db = freshDb();
    seedClaudeCliWorkflow(db);
    // script_length_minutes=6 → 1 chapter keeps step 04's batch loop to one iteration so the
    // canned reply (a one-entry JSON array) is enough for both the
    // extract phase and the single batch.
    setSetting("script_length_minutes", 6, db);
    setSetting("claude_cli_script_model", "claude-opus-4-7", db);

    videosRepo.createNewVideo(db, {
      id: "v_cli",
      title: "The Fall of Constantinople",
      topic_info: "1453 Ottoman siege",
      workflow_id: "comfyui-cli",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_cli");
    videosRepo.markInProgress(db, "v_cli", Date.now());

    await runPipeline("v_cli", {
      db,
      steps: scriptSteps(),
      projectsDir: tempDir("projects"),
    });

    const rows = db
      .prepare(
        "SELECT step_name, status FROM video_steps WHERE video_id = ? ORDER BY step_name"
      )
      .all("v_cli") as Array<{ step_name: string; status: string }>;
    expect(rows).toEqual([
      { step_name: "research_outline", status: "done" },
      { step_name: "write_chapters", status: "done" },
      { step_name: "write_hook", status: "done" },
    ]);
  });

  it("invokes spawn at least once per script step with the seeded claude_cli_script_model", async () => {
    const db = freshDb();
    seedClaudeCliWorkflow(db);
    setSetting("script_length_minutes", 6, db);
    setSetting("claude_cli_script_model", "claude-opus-4-7", db);

    videosRepo.createNewVideo(db, {
      id: "v_cli2",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui-cli",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_cli2");
    videosRepo.markInProgress(db, "v_cli2", Date.now());

    await runPipeline("v_cli2", {
      db,
      steps: scriptSteps(),
      projectsDir: tempDir("projects"),
    });

    // Step 04 makes >1 calls so 4 is a floor, not an equality. Use the
    // floor to prove every script step contributed at least one spawn.
    expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(4);

    // Every spawn call carries the seeded model — proves chat() is
    // resolved through claudeCliProvider, not openrouterProvider, on
    // every script-step call.
    for (const [cliPath, args] of spawnMock.mock.calls as Array<
      [string, string[]]
    >) {
      expect(cliPath).toBe("claude");
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe("claude-opus-4-7");
    }
  });

  it("aborts the in-flight spawn and wipes the video when cancellation fires mid-step", async () => {
    // Task 2.4 contract: ctx.signal threads through to the provider so a
    // delete-driven cancellation reaches into a running spawn. The script
    // step calls ctx.chat() with no opts; signal must be folded in by
    // buildStepContext. End-to-end check: the watcher flips, abort fires,
    // child.kill() lands, and the pipeline takes the wipe path.
    const db = freshDb();
    seedClaudeCliWorkflow(db);
    setSetting("script_length_minutes", 6, db);
    setSetting("claude_cli_script_model", "claude-opus-4-7", db);

    videosRepo.createNewVideo(db, {
      id: "v_cli_abort",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui-cli",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_cli_abort");
    videosRepo.markInProgress(db, "v_cli_abort", Date.now());

    // First spawn hangs (no close emit) so the watcher has time to abort
    // mid-flight. Capture the kill spy from the actual fake to assert on.
    let firstChildKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementationOnce(() => {
      const child = fakeChild();
      firstChildKill = child.kill;
      return child;
    });

    // Source flips true after a tick — first poll (immediate) sees false,
    // a subsequent poll (intervalMs=5) sees true and aborts. That gives
    // step 01 time to enter spawn before cancellation fires.
    let triggered = false;
    setTimeout(() => {
      triggered = true;
    }, 10);

    await runPipeline("v_cli_abort", {
      db,
      steps: scriptSteps(),
      projectsDir: tempDir("projects"),
      cancellationSource: () => triggered,
      cancellationIntervalMs: 5,
    });

    expect(firstChildKill).toBeDefined();
    expect(firstChildKill!).toHaveBeenCalled();

    // Pipeline took the wipe-and-remove path on AbortError.
    const row = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v_cli_abort");
    expect(row).toBeUndefined();
  });

  it("preserves script_llm_provider='claude_cli' on the pinned snapshot after the run", async () => {
    const db = freshDb();
    seedClaudeCliWorkflow(db);
    setSetting("script_length_minutes", 6, db);

    videosRepo.createNewVideo(db, {
      id: "v_cli3",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui-cli",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_cli3");
    videosRepo.markInProgress(db, "v_cli3", Date.now());

    await runPipeline("v_cli3", {
      db,
      steps: scriptSteps(),
      projectsDir: tempDir("projects"),
    });

    const row = db
      .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
      .get("v_cli3") as { workflow_snapshot: string };
    const snapshot = JSON.parse(row.workflow_snapshot);
    expect(snapshot.script_llm_provider).toBe("claude_cli");
  });
});

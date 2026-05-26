import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
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
import * as gfRepo from "@/lib/repos/google-flow";
import { createPromptModerator } from "@/lib/moderator";
import { runGoogleFlowStep, type GoogleFlowStepSpec } from "@/worker/steps/google-flow-common";
import { noOpModerator } from "../../../helpers/no-op-moderator";
import type { Chunk, ModerationEvent } from "@/types";
import type { ChatMessage } from "@/lib/llm/types";

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

afterEach(() => {
  while (openDbs.length) {
    try { openDbs.pop()!.close(); } catch { /* ignore */ }
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function insertVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "google-flow", "in_progress", 1);
}

function insertAccount(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO google_flow_accounts (id, name, token, enabled, paused_until, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, `tok_${id}`, 1, null, 1);
}

function writeChunks(projectsDir: string, videoId: string, chunks: Chunk[]): void {
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks, null, 2));
}

function readChunks(projectsDir: string, videoId: string): Chunk[] {
  return JSON.parse(
    readFileSync(join(projectsDir, videoId, "chunks", "chunks.json"), "utf-8")
  ) as Chunk[];
}

function makeImageChunks(n: number, prompt: string = "p"): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `image_${String(i + 1).padStart(3, "0")}`,
    kind: "image" as const,
    start: i * 10,
    end: (i + 1) * 10,
    text: `text for chunk ${i + 1}`,
    prompt,
  }));
}

const SPEC = {
  stepName: "generate_images",
  chunkKind: "image" as const,
  queueKind: "image" as const,
  mode: "createImage" as const,
  outputDir: "images",
  outputExt: ".png",
};

function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  writeFileSync(
    join(promptsDir, "moderate_blocked_prompts.md"),
    "ROUND={{round}}\nESC=[{{escalation_guidance}}]\nPLAY=[{{tag_playbooks}}]\nREWRITE THESE: {{batch_json}}",
    "utf-8"
  );
}

/**
 * Drive a moderation-aware run of runGoogleFlowStep:
 *   1) start the step (it enqueues N rows pending)
 *   2) immediately mark all of them failed with `failureReason` so the
 *      first wait-drain returns ok with content-policy failures present
 *   3) when the moderator chat stub fires, schedule (after the step's
 *      requeue txn lands) a flip-to-done on the requeued rows so the
 *      second wait-drain returns clean.
 *
 * Returns the started promise; callers await/assert on it.
 */
function startWithModerator(
  db: DatabaseType,
  projectsDir: string,
  promptsDir: string,
  chatStub: (messages: ChatMessage[], opts?: unknown) => Promise<string>,
  failureReason: string,
  videoId = "v1"
): Promise<void | { deferred: true; retryAfter: number }> {
  const moderator = createPromptModerator({
    chat: chatStub as never,
    promptsDir,
    db,
  });
  const promise = runGoogleFlowStep(
    videoId,
    {
      db,
      projectsDir,
      moderator,
      log: () => {},
      pollIntervalMs: 1,
    },
    SPEC
  );
  // Let the synchronous enqueue happen, then mark every row failed.
  setTimeout(() => {
    db.prepare(
      `UPDATE google_flow_queue
          SET status = 'failed', error_reason = ?
        WHERE video_id = ? AND status IN ('pending', 'dispatched')`
    ).run(failureReason, videoId);
  }, 2);
  return promise;
}

describe("runGoogleFlowStep — moderation loop", () => {
  it("falls through to existing aggregation when moderation is disabled", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-disabled");
    const promptsDir = tempDir("gflow-prompts-disabled");
    seedPrompts(promptsDir);
    setSetting("google_flow_content_moderation_enabled", false, db);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const chat = vi.fn();
    const promise = startWithModerator(
      db,
      projectsDir,
      promptsDir,
      chat as never,
      "PUBLIC_ERROR_DANGER_FILTER"
    );

    await expect(promise).rejects.toThrow(/PUBLIC_ERROR_DANGER_FILTER/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("rewrites blocked prompts, requeues at round 1, and exits cleanly", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-happy");
    const promptsDir = tempDir("gflow-prompts-happy");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const chat = vi.fn(async () => {
      // After requeue lands, mark the new pending rows done.
      setTimeout(() => {
        db.prepare(
          "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 1"
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rewrite" },
          { id: "image_002", rewritten_prompt: "p2-rewrite" },
        ],
      });
    });

    await expect(
      startWithModerator(
        db,
        projectsDir,
        promptsDir,
        chat as never,
        "PUBLIC_ERROR_DANGER_FILTER"
      )
    ).resolves.toBeUndefined();

    expect(chat).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare(
        "SELECT chunk_id, prompt, status, moderation_round FROM google_flow_queue ORDER BY id"
      )
      .all() as Array<{ chunk_id: string; prompt: string; status: string; moderation_round: number }>;
    expect(rows).toEqual([
      { chunk_id: "image_001", prompt: "p1-rewrite", status: "done", moderation_round: 1 },
      { chunk_id: "image_002", prompt: "p2-rewrite", status: "done", moderation_round: 1 },
    ]);
  });

  it("writes one moderation_events row per rewrite with the canonical reason_tag", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-events");
    const promptsDir = tempDir("gflow-prompts-events");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const chat = vi.fn(async () => {
      setTimeout(() => {
        db.prepare(
          "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 1"
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rewrite" },
          { id: "image_002", rewritten_prompt: "p2-rewrite" },
        ],
      });
    });

    await startWithModerator(
      db,
      projectsDir,
      promptsDir,
      chat as never,
      "PUBLIC_ERROR_DANGER_FILTER"
    );

    const events = gfRepo.listModerationEventsForVideo(db, "v1");
    expect(events).toHaveLength(2);
    expect(
      events.map((e: ModerationEvent) => ({
        chunk_id: e.chunk_id,
        kind: e.kind,
        round: e.round,
        original_prompt: e.original_prompt,
        rewritten_prompt: e.rewritten_prompt,
        reason_tag: e.reason_tag,
      }))
    ).toEqual([
      {
        chunk_id: "image_001",
        kind: "image",
        round: 1,
        original_prompt: "p",
        rewritten_prompt: "p1-rewrite",
        reason_tag: "PUBLIC_ERROR_DANGER_FILTER",
      },
      {
        chunk_id: "image_002",
        kind: "image",
        round: 1,
        original_prompt: "p",
        rewritten_prompt: "p2-rewrite",
        reason_tag: "PUBLIC_ERROR_DANGER_FILTER",
      },
    ]);
  });

  it("updates chunks.json prompts and pushes the previous prompt onto prompt_history", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-chunks");
    const promptsDir = tempDir("gflow-prompts-chunks");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const chat = vi.fn(async () => {
      setTimeout(() => {
        db.prepare(
          "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 1"
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rewrite" },
          { id: "image_002", rewritten_prompt: "p2-rewrite" },
        ],
      });
    });

    await startWithModerator(
      db,
      projectsDir,
      promptsDir,
      chat as never,
      "PUBLIC_ERROR_DANGER_FILTER"
    );

    const chunks = readChunks(projectsDir, "v1");
    expect(chunks[0].prompt).toBe("p1-rewrite");
    expect(chunks[0].prompt_history).toEqual(["p"]);
    expect(chunks[1].prompt).toBe("p2-rewrite");
    expect(chunks[1].prompt_history).toEqual(["p"]);
  });

  it("escalates to round-2 guidance when round 1 still fails", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-escalate");
    const promptsDir = tempDir("gflow-prompts-escalate");
    seedPrompts(promptsDir);
    setSetting("google_flow_content_moderation_max_rounds", 2, db);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const capturedPrompts: string[] = [];
    let callIndex = 0;
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      capturedPrompts.push(messages[0].content);
      callIndex++;
      if (callIndex === 1) {
        // Round 1 requeue lands → fail those rows again so round 2 fires.
        setTimeout(() => {
          db.prepare(
            `UPDATE google_flow_queue
                SET status = 'failed', error_reason = 'PUBLIC_ERROR_DANGER_FILTER'
              WHERE status = 'pending' AND moderation_round = 1`
          ).run();
        }, 5);
      } else {
        // Round 2 requeue lands → mark them done so the run exits clean.
        setTimeout(() => {
          db.prepare(
            "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 2"
          ).run();
        }, 5);
      }
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: `p1-rw-r${callIndex}` },
          { id: "image_002", rewritten_prompt: `p2-rw-r${callIndex}` },
        ],
      });
    });

    await startWithModerator(
      db,
      projectsDir,
      promptsDir,
      chat as never,
      "PUBLIC_ERROR_DANGER_FILTER"
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).toContain("ROUND=1");
    expect(capturedPrompts[1]).toContain("ROUND=2");
    expect(capturedPrompts[0]).toContain("first rewrite pass");
    expect(capturedPrompts[0]).not.toContain("previous rewrite still failed");
    expect(capturedPrompts[1]).toContain("previous rewrite still failed");
    expect(capturedPrompts[1]).not.toContain("first rewrite pass");
  });

  it("threads the audio playbook into the moderator prompt when failures carry PUBLIC_ERROR_AUDIO_FILTERED", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-audio");
    const promptsDir = tempDir("gflow-prompts-audio");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      setTimeout(() => {
        db.prepare(
          "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 1"
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rw" },
          { id: "image_002", rewritten_prompt: "p2-rw" },
        ],
      });
    });

    await startWithModerator(
      db,
      projectsDir,
      promptsDir,
      chat as never,
      "PUBLIC_ERROR_AUDIO_FILTERED"
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(captured).toContain("Audio playbook");
    expect(captured).toContain("speech-implying");
    expect(captured).not.toContain("Danger playbook");
  });

  it("throws with the original error reasons when failures persist past max_rounds", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-exhausted");
    const promptsDir = tempDir("gflow-prompts-exhausted");
    seedPrompts(promptsDir);
    setSetting("google_flow_content_moderation_max_rounds", 1, db);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    const chat = vi.fn(async () => {
      // Each time we requeue, fail again with the same content-policy reason.
      setTimeout(() => {
        db.prepare(
          `UPDATE google_flow_queue
              SET status = 'failed', error_reason = 'PUBLIC_ERROR_DANGER_FILTER'
            WHERE status = 'pending'`
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rewrite" },
          { id: "image_002", rewritten_prompt: "p2-rewrite" },
        ],
      });
    });

    await expect(
      startWithModerator(
        db,
        projectsDir,
        promptsDir,
        chat as never,
        "PUBLIC_ERROR_DANGER_FILTER"
      )
    ).rejects.toThrow(/PUBLIC_ERROR_DANGER_FILTER/);
    // Exactly one moderator call: round 1. Round 2 would be > max_rounds=1.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("preserves DB and disk state when the moderator throws (atomicity)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-atomic");
    const promptsDir = tempDir("gflow-prompts-atomic");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));
    const chunksPath = join(projectsDir, "v1", "chunks", "chunks.json");
    const chunksBefore = readFileSync(chunksPath, "utf-8");

    const chat = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      startWithModerator(
        db,
        projectsDir,
        promptsDir,
        chat as never,
        "PUBLIC_ERROR_DANGER_FILTER"
      )
    ).rejects.toThrow(/boom/);

    expect(gfRepo.listModerationEventsForVideo(db, "v1")).toEqual([]);
    const rows = db
      .prepare(
        "SELECT prompt, status, moderation_round, error_reason FROM google_flow_queue ORDER BY id"
      )
      .all() as Array<{ prompt: string; status: string; moderation_round: number; error_reason: string }>;
    expect(rows).toEqual([
      { prompt: "p", status: "failed", moderation_round: 0, error_reason: "PUBLIC_ERROR_DANGER_FILTER" },
      { prompt: "p", status: "failed", moderation_round: 0, error_reason: "PUBLIC_ERROR_DANGER_FILTER" },
    ]);
    expect(readFileSync(chunksPath, "utf-8")).toBe(chunksBefore);
  });

  it("does not double-enqueue when a moderation-eligible failed row already exists for a chunk", async () => {
    // Models the "Retry failed step" path: a prior step run left one
    // failed row whose error_reason will revive via the moderation loop.
    // Re-entry must NOT spawn a parallel new row for the same chunk —
    // both would dispatch and race on the same output_path.
    const db = freshDb();
    const projectsDir = tempDir("gflow-mod-no-dup");
    const promptsDir = tempDir("gflow-prompts-no-dup");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    // Pre-existing state from the prior run: both rows already failed
    // with a content-policy reason. No output files on disk.
    const id1 = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "image_001",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/image_001.png",
      created_at: 1,
    });
    const id2 = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "image_002",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/image_002.png",
      created_at: 1,
    });
    gfRepo.failTask(
      db,
      id1,
      'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":13,"message":"INTERNAL"}'
    );
    gfRepo.failTask(db, id2, "PUBLIC_ERROR_DANGER_FILTER");

    const chat = vi.fn(async () => {
      setTimeout(() => {
        db.prepare(
          "UPDATE google_flow_queue SET status = 'done' WHERE moderation_round = 1"
        ).run();
      }, 5);
      return JSON.stringify({
        rewrites: [
          { id: "image_001", rewritten_prompt: "p1-rewrite" },
          { id: "image_002", rewritten_prompt: "p2-rewrite" },
        ],
      });
    });

    const moderator = createPromptModerator({
      chat: chat as never,
      promptsDir,
      db,
    });
    await expect(
      runGoogleFlowStep(
        "v1",
        {
          db,
          projectsDir,
          moderator,
          log: () => {},
          pollIntervalMs: 1,
        },
        SPEC
      )
    ).resolves.toBeUndefined();

    // Row count must stay at 2 — the pre-existing failed rows were
    // revived in place rather than getting parallel new rows.
    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM google_flow_queue WHERE video_id = 'v1'")
      .get() as { n: number };
    expect(rowCount.n).toBe(2);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does enqueue a fresh row when the failed row's error is not moderation-eligible", async () => {
    // Counterpart to the prior test: a non-content-policy failure
    // (timeout, download_failed) is genuinely settled; the moderator
    // won't revive it. Retry must enqueue a fresh row so the chunk
    // gets another shot at the wire.
    const db = freshDb();
    const projectsDir = tempDir("gflow-fresh-enq");
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(1));

    const id1 = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "image_001",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/image_001.png",
      created_at: 1,
    });
    gfRepo.failTask(db, id1, "Video generation timed out after 10 minutes");

    const promise = runGoogleFlowStep(
      "v1",
      {
        db,
        projectsDir,
        moderator: noOpModerator,
        log: () => {},
        pollIntervalMs: 1,
      },
      SPEC
    );
    // Let enqueue happen, then succeed the new row + materialize its
    // output file so aggregateFailures (which filters failed rows by
    // disk presence) treats the stale failed row as resolved.
    setTimeout(() => {
      mkdirSync(join(projectsDir, "v1", "images"), {
        recursive: true,
      });
      writeFileSync(
        join(projectsDir, "v1", "images", "image_001.png"),
        ""
      );
      db.prepare(
        "UPDATE google_flow_queue SET status = 'done' WHERE id != ?"
      ).run(id1);
    }, 2);
    await expect(promise).resolves.toBeUndefined();

    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM google_flow_queue WHERE video_id = 'v1'")
      .get() as { n: number };
    expect(rowCount.n).toBe(2);
  });
});

/**
 * Drive runGoogleFlowStep on the happy path: enqueue, then mark every
 * row done so the wait-drain returns clean and aggregateFailures finds
 * nothing missing. Caller is responsible for pre-creating output files
 * if they want the aggregator to not throw. Returns the promise.
 */
function startHappyPath(
  db: DatabaseType,
  projectsDir: string,
  promptsDir: string,
  videoId = "v1",
  spec: GoogleFlowStepSpec = SPEC
): Promise<void | { deferred: true; retryAfter: number }> {
  const moderator = noOpModerator;
  const promise = runGoogleFlowStep(
    videoId,
    {
      db,
      projectsDir,
      moderator,
      log: () => {},
      pollIntervalMs: 1,
    },
    spec
  );
  // Let the synchronous enqueue commit, then mark all rows done AND
  // create the corresponding output files (aggregateFailures checks
  // for missing-on-disk rather than just failed rows).
  setTimeout(() => {
    const rows = db
      .prepare(
        "SELECT id, output_path FROM google_flow_queue WHERE video_id = ?"
      )
      .all(videoId) as Array<{ id: number; output_path: string }>;
    for (const row of rows) {
      const outPath = join(projectsDir, videoId, row.output_path);
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, Buffer.from([0]));
    }
    db.prepare(
      `UPDATE google_flow_queue SET status = 'done' WHERE video_id = ?`
    ).run(videoId);
  }, 2);
  return promise;
}

describe("runGoogleFlowStep — character reference plumbing (phase A step 3)", () => {
  it("sets reference_image to the per-video character reference basename when the file exists", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-ref-set");
    const promptsDir = tempDir("gflow-ref-set-prompts");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));
    // Seed the per-video character reference so enqueueChunks picks it up.
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(
      join(projectsDir, "v1", "character_reference.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );

    await expect(
      startHappyPath(db, projectsDir, promptsDir)
    ).resolves.toBeUndefined();

    const rows = db
      .prepare(
        "SELECT chunk_id, reference_image FROM google_flow_queue WHERE video_id = 'v1' ORDER BY id"
      )
      .all() as Array<{ chunk_id: string; reference_image: string | null }>;
    expect(rows).toEqual([
      { chunk_id: "image_001", reference_image: "character_reference.png" },
      { chunk_id: "image_002", reference_image: "character_reference.png" },
    ]);
  });

  it("leaves reference_image null when no character reference file is present", async () => {
    const db = freshDb();
    const projectsDir = tempDir("gflow-ref-absent");
    const promptsDir = tempDir("gflow-ref-absent-prompts");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", makeImageChunks(2));

    await expect(
      startHappyPath(db, projectsDir, promptsDir)
    ).resolves.toBeUndefined();

    const rows = db
      .prepare(
        "SELECT reference_image FROM google_flow_queue WHERE video_id = 'v1'"
      )
      .all() as Array<{ reference_image: string | null }>;
    expect(rows.every((r) => r.reference_image === null)).toBe(true);
  });

  it("does NOT look up the character reference for clip-kind steps", async () => {
    // Veo's clip generation uses startFrame/endFrame, not character
    // references, so the per-image lookup must be skipped to avoid
    // attaching irrelevant state to clip rows.
    const db = freshDb();
    const projectsDir = tempDir("gflow-ref-clip");
    const promptsDir = tempDir("gflow-ref-clip-prompts");
    seedPrompts(promptsDir);
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    // Write a character_reference.png but use a clip-kind spec.
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(
      join(projectsDir, "v1", "character_reference.png"),
      Buffer.from([0x89])
    );
    const clipChunks: Chunk[] = [
      {
        id: "clip_01",
        kind: "clip",
        start: 0,
        end: 8,
        text: "t",
        prompt: "p",
      },
    ];
    writeChunks(projectsDir, "v1", clipChunks);

    const clipSpec = {
      stepName: "generate_clips",
      chunkKind: "clip" as const,
      queueKind: "clip" as const,
      mode: "text" as const,
      outputDir: "clips",
      outputExt: ".mp4",
    };

    await expect(
      startHappyPath(db, projectsDir, promptsDir, "v1", clipSpec)
    ).resolves.toBeUndefined();

    const row = db
      .prepare(
        "SELECT reference_image FROM google_flow_queue WHERE video_id = 'v1' AND chunk_id = 'clip_01'"
      )
      .get() as { reference_image: string | null };
    expect(row.reference_image).toBeNull();
  });
});

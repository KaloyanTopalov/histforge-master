import type { Database as DatabaseType } from "better-sqlite3";
import type { Video, VideoKind, VideoStatus } from "@/types";
import { computeSnapshot } from "@/lib/workflows";
import { computeVisualStyleSnapshot } from "@/lib/visual-styles";

/**
 * Video repository — atomic SQL wrappers over the `videos` table. Each
 * exported function is either a single prepared statement OR a single
 * conceptual write that intrinsically spans tables and therefore opens
 * its own `db.transaction(...)` (e.g. `createNewVideo`,
 * `updateVideoDraft`, `transitionNewToQueued`, `transitionAllNewToQueued`,
 * `deleteVideoFullyRemoved`). Multi-statement compositions across distinct
 * concerns (retry, restart, recordStepFailure, enterStep, the resume
 * cascade) live in `src/lib/lifecycle/video.ts` and compose these helpers.
 *
 * Snapshot lifecycle: `videos.workflow_snapshot` and
 * `videos.visual_style_snapshot` are pinned at the same four lifecycle
 * hooks below (createNewVideo, updateVideoDraft when the relevant FK
 * changes, transitionNewToQueued, transitionAllNewToQueued) via
 * `computeSnapshot` and `computeVisualStyleSnapshot`. After `queued`,
 * both snapshots are immutable — the orchestrator reads only the
 * snapshots, never the live `workflows` / `visual_styles` rows. See
 * README "Invariant B" for the full lifecycle rules.
 */

export function findById(
  db: DatabaseType,
  id: string
): Video | undefined {
  return db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as Video | undefined;
}

/**
 * Narrow existence check used for the files-route authorization gate.
 * `SELECT id` avoids loading the full row when all the caller needs is
 * "is this a known video?".
 */
export function existsById(db: DatabaseType, id: string): boolean {
  const row = db
    .prepare("SELECT id FROM videos WHERE id = ?")
    .get(id) as { id: string } | undefined;
  return row !== undefined;
}

export function list(db: DatabaseType): Video[] {
  return db
    .prepare("SELECT * FROM videos ORDER BY created_at DESC")
    .all() as Video[];
}

/**
 * Insert a fresh draft video in the `new` status. All lifecycle
 * columns start null/0 and `created_at` stamps the current time. Both
 * `workflow_snapshot` and `visual_style_snapshot` are computed inside
 * the same transaction as the INSERT (Invariant B point 1) so a partial
 * failure leaves no half-inserted row. `computeSnapshot` throws on
 * unknown `workflow_id` — that error propagates and the transaction
 * rolls back before INSERT. `computeVisualStyleSnapshot` returns null
 * for a null FK or a deleted row (decision 13), never throws.
 *
 * Per-kind invariants (Plan 1 Phase 1.1 Task 5) enforced at the
 * function boundary so the API route validator can stay thin:
 *  - kind='narrative' (default): topic_info is required (non-empty);
 *    none of the four music-video fields may be supplied.
 *  - kind='music_video': all four music-video fields are required;
 *    topic_info, provided_script, and visual_style_id must be absent.
 *    topic_info lands as "" in SQL because the column is NOT NULL.
 *  Throws on contract violation; the transaction never opens.
 */
export function createNewVideo(
  db: DatabaseType,
  input: {
    id: string;
    title: string;
    workflow_id: string;
    kind?: VideoKind;
    topic_info?: string;
    provided_script?: string | null;
    visual_style_id?: string | null;
    magnific_image_prompt?: string;
    magnific_motion_prompt?: string;
    suno_style_prompt?: string;
    song_count?: number;
    repeat_factor?: number;
    created_at: number;
  }
): void {
  const kind: VideoKind = input.kind ?? "narrative";

  if (kind === "narrative") {
    if (!input.topic_info || input.topic_info.length === 0) {
      throw new Error(
        "createNewVideo: kind='narrative' requires a non-empty topic_info"
      );
    }
    if (
      input.magnific_image_prompt !== undefined ||
      input.magnific_motion_prompt !== undefined ||
      input.suno_style_prompt !== undefined ||
      input.song_count !== undefined ||
      input.repeat_factor !== undefined
    ) {
      throw new Error(
        "createNewVideo: kind='narrative' forbids music-video fields"
      );
    }
  } else {
    // kind === "music_video"
    if (
      input.magnific_image_prompt === undefined ||
      input.magnific_motion_prompt === undefined ||
      input.suno_style_prompt === undefined ||
      input.song_count === undefined ||
      input.repeat_factor === undefined
    ) {
      throw new Error(
        "createNewVideo: kind='music_video' requires magnific_image_prompt, magnific_motion_prompt, suno_style_prompt, song_count, and repeat_factor"
      );
    }
    if (input.topic_info !== undefined) {
      throw new Error(
        "createNewVideo: kind='music_video' forbids topic_info"
      );
    }
    if (input.provided_script !== undefined) {
      throw new Error(
        "createNewVideo: kind='music_video' forbids provided_script"
      );
    }
    if (input.visual_style_id !== undefined) {
      throw new Error(
        "createNewVideo: kind='music_video' forbids visual_style_id"
      );
    }
  }

  db.transaction(() => {
    const snapshot = computeSnapshot(db, input.workflow_id);
    const visualStyleId = input.visual_style_id ?? null;
    const visualStyleSnapshot = computeVisualStyleSnapshot(db, visualStyleId);
    // topic_info column is NOT NULL — music_video rows write empty string
    // by convention since the kind has no concept of topic_info.
    const topicInfo = kind === "music_video" ? "" : input.topic_info!;
    db.prepare(
      `INSERT INTO videos (
         id, title, topic_info, workflow_id, workflow_snapshot,
         visual_style_id, visual_style_snapshot, provided_script,
         kind, magnific_image_prompt, magnific_motion_prompt, suno_style_prompt,
         song_count, repeat_factor,
         status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    ).run(
      input.id,
      input.title,
      topicInfo,
      input.workflow_id,
      snapshot,
      visualStyleId,
      visualStyleSnapshot,
      input.provided_script ?? null,
      kind,
      input.magnific_image_prompt ?? null,
      input.magnific_motion_prompt ?? null,
      input.suno_style_prompt ?? null,
      input.song_count ?? null,
      input.repeat_factor ?? null,
      input.created_at
    );
  })();
}

export function setStatus(
  db: DatabaseType,
  id: string,
  status: VideoStatus
): void {
  db.prepare("UPDATE videos SET status = ? WHERE id = ?").run(status, id);
}

/**
 * Patch a draft video's user-editable fields. Guarded on
 * status IN ('new','queued') so no in-flight or finished video can be
 * mutated through this helper. The API route at
 * `src/app/api/videos/[id]/route.ts` already accepts both states and
 * rejects others with 409; this guard matches it.
 *
 * When `workflow_id` is included in the patch, `workflow_snapshot` is
 * recomputed in the same transaction (Invariant B point 2); the same
 * holds for `visual_style_id` → `visual_style_snapshot`. Other fields
 * leave the snapshots untouched. `computeSnapshot` throws on unknown
 * workflow ids — the transaction rolls back before UPDATE.
 */
export function updateVideoDraft(
  db: DatabaseType,
  id: string,
  fields: {
    title?: string;
    topic_info?: string;
    workflow_id?: string;
    provided_script?: string;
    visual_style_id?: string | null;
    magnific_image_prompt?: string;
    magnific_motion_prompt?: string;
    suno_style_prompt?: string;
    song_count?: number;
    repeat_factor?: number;
    image_chunk_target_seconds?: number | null;
    image_chunk_min_seconds?: number | null;
    image_chunk_max_seconds?: number | null;
  }
): void {
  if (
    fields.title === undefined &&
    fields.topic_info === undefined &&
    fields.workflow_id === undefined &&
    fields.provided_script === undefined &&
    fields.visual_style_id === undefined &&
    fields.magnific_image_prompt === undefined &&
    fields.magnific_motion_prompt === undefined &&
    fields.suno_style_prompt === undefined &&
    fields.song_count === undefined &&
    fields.repeat_factor === undefined &&
    fields.image_chunk_target_seconds === undefined &&
    fields.image_chunk_min_seconds === undefined &&
    fields.image_chunk_max_seconds === undefined
  ) {
    return;
  }
  db.transaction(() => {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      args.push(fields.title);
    }
    if (fields.topic_info !== undefined) {
      sets.push("topic_info = ?");
      args.push(fields.topic_info);
    }
    if (fields.workflow_id !== undefined) {
      sets.push("workflow_id = ?");
      args.push(fields.workflow_id);
      sets.push("workflow_snapshot = ?");
      args.push(computeSnapshot(db, fields.workflow_id));
    }
    if (fields.provided_script !== undefined) {
      sets.push("provided_script = ?");
      args.push(fields.provided_script);
    }
    if (fields.visual_style_id !== undefined) {
      sets.push("visual_style_id = ?");
      args.push(fields.visual_style_id);
      sets.push("visual_style_snapshot = ?");
      args.push(computeVisualStyleSnapshot(db, fields.visual_style_id));
    }
    if (fields.magnific_image_prompt !== undefined) {
      sets.push("magnific_image_prompt = ?");
      args.push(fields.magnific_image_prompt);
    }
    if (fields.magnific_motion_prompt !== undefined) {
      sets.push("magnific_motion_prompt = ?");
      args.push(fields.magnific_motion_prompt);
    }
    if (fields.suno_style_prompt !== undefined) {
      sets.push("suno_style_prompt = ?");
      args.push(fields.suno_style_prompt);
    }
    if (fields.song_count !== undefined) {
      sets.push("song_count = ?");
      args.push(fields.song_count);
    }
    if (fields.repeat_factor !== undefined) {
      sets.push("repeat_factor = ?");
      args.push(fields.repeat_factor);
    }
    if (fields.image_chunk_target_seconds !== undefined) {
      sets.push("image_chunk_target_seconds = ?");
      args.push(fields.image_chunk_target_seconds);
    }
    if (fields.image_chunk_min_seconds !== undefined) {
      sets.push("image_chunk_min_seconds = ?");
      args.push(fields.image_chunk_min_seconds);
    }
    if (fields.image_chunk_max_seconds !== undefined) {
      sets.push("image_chunk_max_seconds = ?");
      args.push(fields.image_chunk_max_seconds);
    }
    args.push(id);
    db.prepare(
      `UPDATE videos SET ${sets.join(", ")} WHERE id = ? AND status IN ('new','queued')`
    ).run(...args);
  })();
}

/**
 * Flip `delete_requested` on for the given video. The orchestrator
 * picks this up between steps and tears down the full project dir + DB
 * rows. Used by the DELETE route when a video is `in_progress`.
 */
export function setDeleteRequested(db: DatabaseType, id: string): void {
  db.prepare(
    "UPDATE videos SET delete_requested = 1 WHERE id = ?"
  ).run(id);
}

/**
 * Transition a single video from `new` to `queued`. Guarded on
 * status='new' so accidental double-clicks from a stale UI state cannot
 * re-queue an already-running video. Re-resolves both
 * `workflow_snapshot` and `visual_style_snapshot` in the same
 * transaction (Invariant B point 3) so the queued video pins whatever
 * the live `workflows` / `visual_styles` rows say at queue time. If the
 * referenced visual-style row was deleted between create and queue,
 * the snapshot lands as NULL (decision 13).
 */
export function transitionNewToQueued(
  db: DatabaseType,
  id: string
): { changes: number } {
  const result = { changes: 0 };
  db.transaction(() => {
    const row = db
      .prepare(
        "SELECT workflow_id, visual_style_id FROM videos WHERE id = ? AND status = 'new'"
      )
      .get(id) as
      | { workflow_id: string; visual_style_id: string | null }
      | undefined;
    if (!row) return;
    const snapshot = computeSnapshot(db, row.workflow_id);
    const visualStyleSnapshot = computeVisualStyleSnapshot(
      db,
      row.visual_style_id
    );
    const info = db
      .prepare(
        "UPDATE videos SET status = 'queued', workflow_snapshot = ?, visual_style_snapshot = ? WHERE id = ? AND status = 'new'"
      )
      .run(snapshot, visualStyleSnapshot, id);
    result.changes = info.changes as number;
  })();
  return result;
}

/**
 * Bulk transition every `new` video to `queued`. Returns the list of
 * ids that were actually flipped so the caller can drive per-row
 * follow-up work (queue-time prep for ready-script videos) and report
 * the count via `result.length`.
 *
 * Implemented as a transaction-wrapped per-row loop (not a single bulk
 * UPDATE) because the snapshots are per-video — we read each row's
 * `workflow_id` + `visual_style_id`, resolve fresh snapshots, and write
 * the status flip + both snapshots in one statement per row.
 * `computeSnapshot` throws on unknown workflow ids; the transaction
 * rolls back the whole batch.
 */
export function transitionAllNewToQueued(db: DatabaseType): string[] {
  const flipped: string[] = [];
  db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT id, workflow_id, visual_style_id FROM videos WHERE status = 'new'"
      )
      .all() as Array<{
      id: string;
      workflow_id: string;
      visual_style_id: string | null;
    }>;
    const update = db.prepare(
      "UPDATE videos SET status = 'queued', workflow_snapshot = ?, visual_style_snapshot = ? WHERE id = ? AND status = 'new'"
    );
    for (const row of rows) {
      const snapshot = computeSnapshot(db, row.workflow_id);
      const visualStyleSnapshot = computeVisualStyleSnapshot(
        db,
        row.visual_style_id
      );
      const info = update.run(snapshot, visualStyleSnapshot, row.id);
      if ((info.changes as number) === 1) {
        flipped.push(row.id);
      }
    }
  })();
  return flipped;
}

export function setCurrentStep(
  db: DatabaseType,
  id: string,
  stepName: string | null
): void {
  db.prepare("UPDATE videos SET current_step = ? WHERE id = ?").run(
    stepName,
    id
  );
}

export function markFailed(
  db: DatabaseType,
  id: string,
  failedStep: string,
  failedReason: string,
  finishedAt: number
): void {
  db.prepare(
    "UPDATE videos SET status = 'failed', current_step = NULL, failed_step = ?, failed_reason = ?, finished_at = ? WHERE id = ?"
  ).run(failedStep, failedReason, finishedAt, id);
}

export function markDone(
  db: DatabaseType,
  id: string,
  outputPath: string,
  finishedAt: number
): void {
  db.prepare(
    "UPDATE videos SET status = 'done', current_step = NULL, output_path = ?, finished_at = ? WHERE id = ?"
  ).run(outputPath, finishedAt, id);
}

/**
 * Clear failure metadata (failed_step, failed_reason, finished_at) on
 * the video. Used by the retry flow after a failed video is re-queued.
 * Does not set status — the caller sequences that separately.
 */
export function clearFailure(db: DatabaseType, id: string): void {
  db.prepare(
    "UPDATE videos SET failed_step = NULL, failed_reason = NULL, finished_at = NULL WHERE id = ?"
  ).run(id);
}

/**
 * Full restart wipe — status→queued, all per-run fields nulled. Used by
 * the restart flow on failed/done videos. `paused` is cleared too: a
 * restart is an explicit "run this from scratch" action, and leaving
 * paused set would queue the row into a state the runner's paused=0
 * filter would skip, making the button look broken.
 */
export function resetToQueued(db: DatabaseType, id: string): void {
  db.prepare(
    `UPDATE videos
         SET status = 'queued',
             failed_step = NULL,
             failed_reason = NULL,
             started_at = NULL,
             finished_at = NULL,
             current_step = NULL,
             output_path = NULL,
             paused = 0
       WHERE id = ?`
  ).run(id);
}

/**
 * Atomic set of in_progress + stamp started_at only if currently NULL.
 * Used by the runner's tickOnce. The IS NULL guard preserves the
 * original pickup time across resume cycles.
 */
export function markInProgress(
  db: DatabaseType,
  id: string,
  now: number
): void {
  db.prepare(
    "UPDATE videos SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?"
  ).run(now, id);
}

/**
 * Pause and defer are orthogonal eligibility gates — a video must be
 * unpaused AND past its `deferred_until` to be picked. The defer clause
 * lives on both pick helpers (findOldestQueuedId / findInProgressId) so a
 * grep for "deferred_until" in this file finds them side by side. Do
 * NOT copy this filter into anyInProgressExists: that helper enforces
 * the one-at-a-time invariant and must see deferred rows so the runner
 * idles instead of stealing a queued pick while a defer is outstanding.
 */
export function findOldestQueuedId(db: DatabaseType): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM videos
        WHERE status = 'queued'
          AND paused = 0
          AND (deferred_until IS NULL OR deferred_until <= unixepoch())
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get() as { id: string } | undefined;
  return row?.id;
}

export function findInProgressId(db: DatabaseType): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM videos
        WHERE status = 'in_progress'
          AND paused = 0
          AND (deferred_until IS NULL OR deferred_until <= unixepoch())
        LIMIT 1`
    )
    .get() as { id: string } | undefined;
  return row?.id;
}

/**
 * Return any video with `delete_requested = 1`, ignoring pause and defer
 * gates. The runner uses this to bypass `queue_state='paused'` /
 * `videos.paused=1` / `deferred_until` when the user has explicitly asked
 * to delete — otherwise the orchestrator's between-step delete hook never
 * gets a chance to run and the row + artifacts stay stuck.
 */
export function findDeleteRequestedId(db: DatabaseType): string | undefined {
  const row = db
    .prepare("SELECT id FROM videos WHERE delete_requested = 1 LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id;
}

/**
 * UNFILTERED existence check for in_progress rows — counts paused rows
 * too. Preserves the one-at-a-time invariant: the runner must idle when
 * a paused in_progress video exists, not fall through to a queued row.
 */
export function anyInProgressExists(db: DatabaseType): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM videos WHERE status = 'in_progress' LIMIT 1")
    .get() as { one: number } | undefined;
  return row !== undefined;
}

/**
 * Read the video's `delete_requested` flag. Returns `false` for missing
 * videos — the caller treats absent rows the same as "not requested".
 * Used by the orchestrator between steps to abort an in-flight pipeline
 * when the user has asked to delete the video.
 */
export function readDeleteRequested(db: DatabaseType, id: string): boolean {
  const row = db
    .prepare("SELECT delete_requested FROM videos WHERE id = ?")
    .get(id) as { delete_requested: number } | undefined;
  return row?.delete_requested === 1;
}

/**
 * Defer the video until the given unix-seconds timestamp. Used by the
 * Flow step when every account is in cooldown — the orchestrator sees
 * `deferred_until > now` and moves to the next video. Passing `null`
 * clears the defer so the next tick can pick the video up.
 */
export function setDeferredUntil(
  db: DatabaseType,
  id: string,
  at: number | null
): void {
  db.prepare("UPDATE videos SET deferred_until = ? WHERE id = ?").run(at, id);
}

export function clearDeferredUntil(db: DatabaseType, id: string): void {
  db.prepare("UPDATE videos SET deferred_until = NULL WHERE id = ?").run(id);
}

/**
 * Cache the Magnific Project UUID created for this video's narrative
 * image batch. Passing `null` clears it (e.g. when a cached Project was
 * deleted in Magnific and must be re-created). Idempotent at the row
 * level — re-setting the same value is a no-op UPDATE.
 */
export function setMagnificProjectId(
  db: DatabaseType,
  id: string,
  projectId: string | null
): void {
  db.prepare("UPDATE videos SET magnific_project_id = ? WHERE id = ?").run(
    projectId,
    id
  );
}

export function setPaused(db: DatabaseType, id: string): void {
  db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run(id);
}

export function clearPaused(db: DatabaseType, id: string): void {
  db.prepare("UPDATE videos SET paused = 0 WHERE id = ?").run(id);
}

export function readPaused(db: DatabaseType, id: string): boolean {
  const row = db
    .prepare("SELECT paused FROM videos WHERE id = ?")
    .get(id) as { paused: number } | undefined;
  return row?.paused === 1;
}

/**
 * Hard-delete a video and every video_steps row referencing it. Runs in
 * a single transaction so a crash between the two deletes cannot leave
 * orphan step rows (which would violate the FK if any existed; belt-
 * and-suspenders since video_steps.video_id has ON DELETE behavior
 * omitted from the schema).
 */
export function deleteVideoFullyRemoved(
  db: DatabaseType,
  id: string
): void {
  db.transaction(() => {
    db.prepare("DELETE FROM video_steps WHERE video_id = ?").run(id);
    db.prepare("DELETE FROM videos WHERE id = ?").run(id);
  })();
}

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  seedDefaultSettings,
  seedDefaultWorkflows,
} from "@/lib/db";

// Some pragmas (journal_mode=WAL) only take effect on real file-backed DBs.
// Helper to create an isolated temp file DB per test and clean it up.
const tmpDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-db-test-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold SQLite/WAL file handles after close().
      // Temp dirs are OS-managed — safe to leave if cleanup races.
    }
  }
});

// Greenfield videos.workflow_id has a FK to workflows(id), so any test
// that inserts a video by hand needs a parent workflow row to satisfy
// the constraint. Tests that exercise non-FK behaviours just call this
// helper with the slug their video uses.
function seedWorkflowRow(
  db: ReturnType<typeof createDb>,
  id: string
): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    id,
    id,
    null,
    "openrouter",
    "ai33",
    id === "google-flow" ? "google_flow" : "comfyui",
    id === "google-flow" ? "google_flow" : "comfyui",
    1,
    1,
    1,
    now,
    now
  );
}

describe("createDb", () => {
  it("creates three tables on first call (no topics table)", () => {
    const db = createDb(":memory:");

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).not.toContain("topics");
    expect(tableNames).toContain("videos");
    expect(tableNames).toContain("video_steps");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("workflows");
    expect(tableNames).toContain("workflow_steps");

    db.close();
  });

  it("videos table carries topic_info + workflow_id + delete_requested and no topic_id", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName).not.toHaveProperty("topic_id");
      expect(byName.topic_info).toMatchObject({ notnull: 1 });
      expect(byName.workflow_id).toMatchObject({ notnull: 1 });
      expect(byName.delete_requested).toMatchObject({
        notnull: 1,
        dflt_value: "0",
      });
    } finally {
      db.close();
    }
  });

  it("videos table carries paused NOT NULL DEFAULT 0", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.paused).toMatchObject({ notnull: 1, dflt_value: "0" });
    } finally {
      db.close();
    }
  });

  it("enables WAL journal mode and foreign_keys pragma", () => {
    const db = createDb(tempDbPath());
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("creates missing parent directories for the db file path", () => {
    // Fresh checkout scenario: DATABASE_URL=./data/histforge.db but ./data/
    // does not yet exist. createDb must create it, not throw.
    const rootDir = mkdtempSync(join(tmpdir(), "histforge-mkdir-test-"));
    tmpDirs.push(rootDir);
    const nestedDbPath = join(rootDir, "nested", "dir", "histforge.db");

    expect(existsSync(join(rootDir, "nested"))).toBe(false);

    const db = createDb(nestedDbPath);
    try {
      expect(existsSync(nestedDbPath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("adds the paused column to an existing videos table that predates it", () => {
    // Simulates an on-disk DB that was created before the paused column
    // existed. createDb must ALTER the table on next open and must not
    // throw when called again (duplicate-column on second open).
    const path = tempDbPath();

    // Build a pre-paused schema by hand.
    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          topic_info       TEXT NOT NULL,
          workflow_id      TEXT NOT NULL,
          status           TEXT NOT NULL,
          current_step     TEXT,
          failed_step      TEXT,
          failed_reason    TEXT,
          started_at       INTEGER,
          finished_at      INTEGER,
          output_path      TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.paused).toMatchObject({ notnull: 1, dflt_value: "0" });

      // Pre-existing row gets default paused=0.
      const row = db
        .prepare("SELECT paused FROM videos WHERE id = ?")
        .get("v_legacy") as { paused: number };
      expect(row.paused).toBe(0);
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column is narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });

  it("is idempotent across multiple opens of the same file", () => {
    const path = tempDbPath();

    // First open — tables created, data inserted.
    const db1 = createDb(path);
    try {
      seedWorkflowRow(db1, "comfyui");
      db1
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_1", "Existing Video", "info", "comfyui", "new", 1);
    } finally {
      db1.close();
    }

    // Second open — must not throw and must preserve pre-existing rows.
    const db2 = createDb(path);
    try {
      const video = db2
        .prepare("SELECT id, title FROM videos WHERE id = ?")
        .get("v_1") as { id: string; title: string } | undefined;
      expect(video).toEqual({ id: "v_1", title: "Existing Video" });
    } finally {
      db2.close();
    }
  });
});

describe("createDb — google_flow_video_projects", () => {
  it("creates the google_flow_video_projects table on a fresh DB", () => {
    const db = createDb(":memory:");
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain(
        "google_flow_video_projects"
      );
    } finally {
      db.close();
    }
  });

  it("composite PK (video_id, account_id) rejects duplicate inserts", () => {
    const db = createDb(":memory:");
    try {
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_1", "V", "info", "google-flow", "in_progress", 1);

      const insert = db.prepare(
        `INSERT INTO google_flow_video_projects
           (video_id, account_id, flow_project_id, created_at)
         VALUES (?, ?, ?, ?)`
      );
      insert.run("v_1", "acc_01", "proj-1", 100);
      expect(() => insert.run("v_1", "acc_01", "proj-2", 101)).toThrow(
        /UNIQUE|PRIMARY KEY/i
      );
    } finally {
      db.close();
    }
  });

  it("ON DELETE CASCADE from videos removes per-account project rows", () => {
    const db = createDb(":memory:");
    try {
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_1", "V", "info", "google-flow", "in_progress", 1);
      db.prepare(
        `INSERT INTO google_flow_video_projects
           (video_id, account_id, flow_project_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).run("v_1", "acc_01", "proj-1", 100);
      db.prepare(
        `INSERT INTO google_flow_video_projects
           (video_id, account_id, flow_project_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).run("v_1", "acc_02", "proj-2", 101);

      db.prepare("DELETE FROM videos WHERE id = ?").run("v_1");

      const rows = db
        .prepare("SELECT * FROM google_flow_video_projects WHERE video_id = ?")
        .all("v_1");
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("createDb — content moderation schema", () => {
  // The moderation loop inside runGoogleFlowStep needs to know which round
  // each failed-then-rewritten queue row is on. moderation_round is a
  // separate dimension from retry_count (which counts transient retries).
  // Pre-existing failed rows from before this feature shipped need to
  // start at round 0 so the loop picks them up at round 1 on next attempt.

  it("creates moderation_round column on google_flow_queue (NOT NULL DEFAULT 0)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_queue)")
        .all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
        type: string;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.moderation_round).toMatchObject({
        notnull: 1,
        dflt_value: "0",
        type: "INTEGER",
      });
    } finally {
      db.close();
    }
  });

  it("creates moderation_events table with the expected columns", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(moderation_events)")
        .all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName.id).toMatchObject({ type: "INTEGER" });
      expect(byName.video_id).toMatchObject({ notnull: 1, type: "TEXT" });
      expect(byName.chunk_id).toMatchObject({ notnull: 1, type: "TEXT" });
      expect(byName.kind).toMatchObject({ notnull: 1, type: "TEXT" });
      expect(byName.round).toMatchObject({ notnull: 1, type: "INTEGER" });
      expect(byName.original_prompt).toMatchObject({
        notnull: 1,
        type: "TEXT",
      });
      expect(byName.rewritten_prompt).toMatchObject({
        notnull: 1,
        type: "TEXT",
      });
      // reason_tag is nullable — extractContentPolicyTag may return null
      // and we want to record the event anyway with the raw error_reason
      // pushed into the prompt context instead.
      expect(byName.reason_tag).toMatchObject({ notnull: 0, type: "TEXT" });
      expect(byName.created_at).toMatchObject({ notnull: 1, type: "INTEGER" });
    } finally {
      db.close();
    }
  });

  it("cascade-deletes moderation_events when its video is deleted", () => {
    const db = createDb(":memory:");
    try {
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_1", "V", "info", "google-flow", "in_progress", 1);
      db.prepare(
        `INSERT INTO moderation_events
           (video_id, chunk_id, kind, round, original_prompt, rewritten_prompt, reason_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_1", "hook_02", "hook_video", 1, "old", "new", "SAFETY", 100);

      db.prepare("DELETE FROM videos WHERE id = ?").run("v_1");

      const rows = db
        .prepare("SELECT * FROM moderation_events WHERE video_id = ?")
        .all("v_1");
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("ALTERs an existing google_flow_queue that predates moderation_round", () => {
    // Simulates an upgrade scenario: an existing on-disk DB has a
    // google_flow_queue table without the column. createDb must add it
    // and pre-existing rows must default to 0.
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          topic_info       TEXT NOT NULL,
          workflow_id      TEXT NOT NULL,
          status           TEXT NOT NULL,
          current_step     TEXT,
          failed_step      TEXT,
          failed_reason    TEXT,
          started_at       INTEGER,
          finished_at      INTEGER,
          output_path      TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL
        );
        CREATE TABLE google_flow_queue (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id              TEXT NOT NULL,
          chunk_id              TEXT,
          kind                  TEXT NOT NULL,
          mode                  TEXT NOT NULL,
          prompt                TEXT NOT NULL,
          reference_image       TEXT,
          start_frame           TEXT,
          end_frame             TEXT,
          output_path           TEXT NOT NULL,
          status                TEXT NOT NULL,
          assigned_account_id   TEXT,
          external_task_id      TEXT,
          result_url            TEXT,
          error_reason          TEXT,
          retry_count           INTEGER NOT NULL DEFAULT 0,
          priority              INTEGER NOT NULL DEFAULT 0,
          created_at            INTEGER NOT NULL,
          dispatched_at         INTEGER,
          completed_at          INTEGER
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "google-flow", "in_progress", 1);
      raw
        .prepare(
          `INSERT INTO google_flow_queue
             (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("v_legacy", "main_01", "main_image", "createImage", "p", "/tmp/x", "failed", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_queue)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.moderation_round).toMatchObject({
        notnull: 1,
        dflt_value: "0",
      });

      const row = db
        .prepare(
          "SELECT moderation_round FROM google_flow_queue WHERE video_id = ?"
        )
        .get("v_legacy") as { moderation_round: number };
      expect(row.moderation_round).toBe(0);
    } finally {
      db.close();
    }

    // Re-open must not throw (duplicate-column swallowed).
    const db2 = createDb(path);
    db2.close();
  });
});

describe("createDb — google_flow settings migration", () => {
  // These migrations exist because:
  //  - google_flow_image_model used to be a free-form string; pre-existing
  //    DBs may carry values like "GEM_PIX" (an old Gemini variant) or ""
  //    that the new enum schema would reject at read time.
  //  - google_flow_video_quality has been removed from the schema; if its
  //    row stays in the DB it's dead weight (and surfaces as an
  //    "unknown setting key" if anything iterates rows).
  //  - google_flow_video_model is a new key. seedDefaultSettings only runs
  //    via `npm run db:init`, so the runtime getDb() path can't depend on
  //    it; createDb must seed the new key on existing installs.

  it("coerces a pre-existing out-of-enum image_model value to NARWHAL", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Simulate an existing install where image_model was a free-form
      // string and got set to a now-invalid value.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
      ).run("google_flow_image_model", "GEM_PIX");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_image_model") as { value: string };
      expect(row.value).toBe("NARWHAL");
    } finally {
      db2.close();
    }
  });

  it("preserves an in-enum image_model value across reopens", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
      ).run("google_flow_image_model", "IMAGEN_3_5");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_image_model") as { value: string };
      expect(row.value).toBe("IMAGEN_3_5");
    } finally {
      db2.close();
    }
  });

  it("deletes any orphan google_flow_video_quality row", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Inject the legacy row by hand — the new schema doesn't include it.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
      ).run("google_flow_video_quality", "fast");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_video_quality");
      expect(row).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("seeds google_flow_video_model for upgraded DBs that never ran db:init", () => {
    // Simulate the runtime path on an existing install: createDb only,
    // no seedDefaultSettings. The new key must be present so getSetting
    // doesn't throw "Setting not seeded" the first time the next-task
    // route runs.
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Wipe the auto-seeded row to simulate a pre-this-version DB.
      db.prepare("DELETE FROM settings WHERE key = ?").run(
        "google_flow_video_model"
      );
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_video_model") as { value: string };
      expect(row.value).toBe("veo_3_1_t2v_lite_low_priority");
    } finally {
      db2.close();
    }
  });

  it("does not overwrite a user-customized google_flow_video_model on reopen", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("google_flow_video_model", "veo_3_1_t2v_fast_ultra");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_video_model") as { value: string };
      expect(row.value).toBe("veo_3_1_t2v_fast_ultra");
    } finally {
      db2.close();
    }
  });

  it("is idempotent across many opens of the same DB", () => {
    const path = tempDbPath();
    for (let i = 0; i < 3; i++) {
      const db = createDb(path);
      db.close();
    }
    // Re-opening shouldn't throw, and the seeded video_model should still be
    // the default.
    const db = createDb(path);
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("google_flow_video_model") as { value: string };
      expect(row.value).toBe("veo_3_1_t2v_lite_low_priority");
    } finally {
      db.close();
    }
  });

  it("seeds the three content-moderation settings on upgraded DBs", () => {
    // Same scenario as google_flow_video_model: an existing install
    // doesn't re-run db:init, so the runtime createDb() path must seed
    // the new keys so getSetting() doesn't throw "Setting not seeded"
    // when the moderation loop reads them.
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "DELETE FROM settings WHERE key LIKE 'google_flow_content_moderation_%'"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'google_flow_content_moderation_%'"
        )
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(asMap).toEqual({
        google_flow_content_moderation_enabled: "true",
        google_flow_content_moderation_max_rounds: "2",
        google_flow_content_moderation_model: "",
      });
    } finally {
      db2.close();
    }
  });

  it("does not overwrite user-customized content-moderation settings on reopen", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("google_flow_content_moderation_max_rounds", "5");
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("google_flow_content_moderation_enabled", "false");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'google_flow_content_moderation_%'"
        )
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(asMap.google_flow_content_moderation_max_rounds).toBe("5");
      expect(asMap.google_flow_content_moderation_enabled).toBe("false");
    } finally {
      db2.close();
    }
  });
});

describe("createDb — research_characters scrub migration", () => {
  // When the research_characters step was removed from REAL_STEPS, the
  // worker's bootValidate refuses to start while any non-terminal video
  // still pins the slug in its workflow_snapshot or while any workflow
  // row still references the slug. createDb's idempotent migration
  // scrubs both surfaces.

  it("removes any workflow_steps row that references research_characters", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      // Inject the legacy slug at an arbitrary position; the migration
      // must remove it regardless of position.
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("legacy-wf", 0, "research_outline");
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("legacy-wf", 1, "research_characters");
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("legacy-wf", 2, "write_hook");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT step_name FROM workflow_steps WHERE workflow_id = ? ORDER BY position"
        )
        .all("legacy-wf") as Array<{ step_name: string }>;
      expect(rows.map((r) => r.step_name)).toEqual([
        "research_outline",
        "write_hook",
      ]);
    } finally {
      db2.close();
    }
  });

  it("compacts positions on a built-in workflow so seedDefaultWorkflows doesn't duplicate steps into the gap", () => {
    // Reproduces the upgrade-time bug: an old DB has comfyui with steps
    // [0=research_outline, 1=research_characters, 2=write_hook,
    // 3=write_chapters]. The DELETE removes position 1, leaving a gap.
    // Without compaction, seedDefaultWorkflows's INSERT OR IGNORE with
    // the new 3-step list fills position 1 with write_hook — alongside
    // the leftover write_hook at position 2 — producing a duplicated
    // step list that the worker would silently double-execute.
    const path = tempDbPath();
    {
      const db = createDb(path);
      // First open auto-seeds the new 3-step comfyui list. Wipe and
      // replace with the old 4-step shape to simulate an upgraded DB.
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = 'comfyui'").run();
      const ins = db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      );
      ins.run("comfyui", 0, "research_outline");
      ins.run("comfyui", 1, "research_characters");
      ins.run("comfyui", 2, "write_hook");
      ins.run("comfyui", 3, "write_chapters");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT position, step_name FROM workflow_steps WHERE workflow_id = 'comfyui' ORDER BY position"
        )
        .all() as Array<{ position: number; step_name: string }>;
      expect(rows).toEqual([
        { position: 0, step_name: "research_outline" },
        { position: 1, step_name: "write_hook" },
        { position: 2, step_name: "write_chapters" },
      ]);
    } finally {
      db2.close();
    }
  });

  it("filters research_characters out of a non-terminal video's workflow_snapshot", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      const snapshot = {
        workflow_id: "legacy-wf",
        version: 1,
        script_llm_provider: "openrouter",
        tts_provider: "ai33",
        image_provider: "comfyui",
        video_provider: "comfyui",
        steps: [
          { step_name: "research_outline" },
          { step_name: "research_characters" },
          { step_name: "write_hook" },
          { step_name: "write_chapters" },
        ],
      };
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "v_live",
        "T",
        "info",
        "legacy-wf",
        JSON.stringify(snapshot),
        "queued",
        1
      );
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_live") as { workflow_snapshot: string };
      const parsed = JSON.parse(row.workflow_snapshot);
      expect(parsed.steps.map((s: { step_name: string }) => s.step_name)).toEqual([
        "research_outline",
        "write_hook",
        "write_chapters",
      ]);
    } finally {
      db2.close();
    }
  });

  it("leaves terminal videos' workflow_snapshot untouched even if it contains research_characters", () => {
    // bootValidate ignores done/failed videos, so their snapshots can keep
    // historical slugs without breaking the worker. The migration only
    // touches non-terminal rows to minimize churn.
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      const snapshot = {
        workflow_id: "legacy-wf",
        version: 1,
        script_llm_provider: "openrouter",
        tts_provider: "ai33",
        image_provider: "comfyui",
        video_provider: "comfyui",
        steps: [
          { step_name: "research_outline" },
          { step_name: "research_characters" },
          { step_name: "write_hook" },
        ],
      };
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "v_done",
        "T",
        "info",
        "legacy-wf",
        JSON.stringify(snapshot),
        "done",
        1
      );
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_done") as { workflow_snapshot: string };
      const parsed = JSON.parse(row.workflow_snapshot);
      expect(parsed.steps.map((s: { step_name: string }) => s.step_name)).toContain(
        "research_characters"
      );
    } finally {
      db2.close();
    }
  });

  it("is idempotent — re-running createDb a second time is a no-op", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("legacy-wf", 0, "research_characters");
      db.close();
    }
    // First reopen runs the migration.
    {
      const db = createDb(path);
      db.close();
    }
    // Second reopen must not throw and must leave the post-migration state intact.
    const db3 = createDb(path);
    try {
      const rows = db3
        .prepare(
          "SELECT step_name FROM workflow_steps WHERE workflow_id = ?"
        )
        .all("legacy-wf") as Array<{ step_name: string }>;
      expect(rows).toEqual([]);
    } finally {
      db3.close();
    }
  });
});

describe("createDb — chunker_step workflow_snapshot scrub migration", () => {
  // workflow_snapshot is pinned JSON on each video. When the chunker_step
  // column lands, every in-flight snapshot must surface the new field so
  // resumed runs pick the right chunker slug. The scrub injects the
  // default ("chunk_clips_then_images") on any snapshot missing it. Runs
  // unconditionally (no status filter) — terminal videos are dormant but
  // future Restart re-snapshots from the live row anyway; belt-and-
  // suspenders covers it.

  it("injects chunker_step into a legacy snapshot that lacks the field", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      const legacySnapshot = {
        workflow_id: "legacy-wf",
        version: 1,
        script_llm_provider: "openrouter",
        tts_provider: "ai33",
        image_provider: "comfyui",
        video_provider: "comfyui",
        steps: [
          { step_name: "research_outline" },
          { step_name: "write_hook" },
          { step_name: "write_chapters" },
        ],
      };
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "v_live",
        "T",
        "info",
        "legacy-wf",
        JSON.stringify(legacySnapshot),
        "queued",
        1
      );
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_live") as { workflow_snapshot: string };
      const parsed = JSON.parse(row.workflow_snapshot);
      expect(parsed.chunker_step).toBe("chunk_clips_then_images");
    } finally {
      db2.close();
    }
  });

  it("leaves an already-migrated snapshot untouched (idempotent)", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      const newSnapshot = {
        workflow_id: "legacy-wf",
        version: 1,
        script_llm_provider: "openrouter",
        tts_provider: "ai33",
        image_provider: null,
        video_provider: "google_flow",
        chunker_step: "chunk_clips_only",
        steps: [{ step_name: "research_outline" }],
      };
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "v_modern",
        "T",
        "info",
        "legacy-wf",
        JSON.stringify(newSnapshot),
        "queued",
        1
      );
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_modern") as { workflow_snapshot: string };
      const parsed = JSON.parse(row.workflow_snapshot);
      // Pre-set value must not be overwritten with the default.
      expect(parsed.chunker_step).toBe("chunk_clips_only");
    } finally {
      db2.close();
    }
  });

  it("is a no-op for videos with no workflow_snapshot", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "legacy-wf");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("v_null", "T", "info", "legacy-wf", null, "new", 1);
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_null") as { workflow_snapshot: string | null };
      expect(row.workflow_snapshot).toBeNull();
    } finally {
      db2.close();
    }
  });
});

describe("createDb — google_flow_queue / moderation_events kind rename migration", () => {
  // Asset-type rename: google_flow_queue.kind and moderation_events.kind
  // values "main_image" → "image" and "hook_video" → "clip". The columns
  // have no CHECK constraint, so legacy values can sit in the DB until
  // the next createDb pass rewrites them. Idempotent because the WHERE
  // clause filters by old value.

  it("rewrites legacy kind values on google_flow_queue rows", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_legacy_q", "T", "info", "google-flow", "in_progress", 1);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_legacy_q", "x_01", "main_image", "createImage", "p", "/tmp/x.png", "failed", 1);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_legacy_q", "x_02", "hook_video", "text", "p", "/tmp/y.mp4", "done", 1);
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare("SELECT chunk_id, kind FROM google_flow_queue WHERE video_id = ? ORDER BY id")
        .all("v_legacy_q") as { chunk_id: string; kind: string }[];
      expect(rows).toEqual([
        { chunk_id: "x_01", kind: "image" },
        { chunk_id: "x_02", kind: "clip" },
      ]);
    } finally {
      db2.close();
    }
  });

  it("rewrites legacy kind values on moderation_events rows", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_legacy_m", "T", "info", "google-flow", "in_progress", 1);
      db.prepare(
        `INSERT INTO moderation_events
           (video_id, chunk_id, kind, round, original_prompt, rewritten_prompt, reason_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_legacy_m", "x_01", "main_image", 1, "old", "new", "SAFETY", 100);
      db.prepare(
        `INSERT INTO moderation_events
           (video_id, chunk_id, kind, round, original_prompt, rewritten_prompt, reason_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_legacy_m", "x_02", "hook_video", 1, "old", "new", "SAFETY", 101);
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare("SELECT chunk_id, kind FROM moderation_events WHERE video_id = ? ORDER BY id")
        .all("v_legacy_m") as { chunk_id: string; kind: string }[];
      expect(rows).toEqual([
        { chunk_id: "x_01", kind: "image" },
        { chunk_id: "x_02", kind: "clip" },
      ]);
    } finally {
      db2.close();
    }
  });

  it("leaves already-migrated rows untouched (idempotent)", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      seedWorkflowRow(db, "google-flow");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_modern", "T", "info", "google-flow", "in_progress", 1);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_modern", "x_01", "image", "createImage", "p", "/tmp/x.png", "done", 1);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_modern", "x_02", "clip", "text", "p", "/tmp/y.mp4", "done", 1);
      db.close();
    }
    // Second open re-runs the migration; new values must survive unchanged.
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare("SELECT chunk_id, kind FROM google_flow_queue WHERE video_id = ? ORDER BY id")
        .all("v_modern") as { chunk_id: string; kind: string }[];
      expect(rows).toEqual([
        { chunk_id: "x_01", kind: "image" },
        { chunk_id: "x_02", kind: "clip" },
      ]);
    } finally {
      db2.close();
    }
  });
});

describe("createDb — act_distribution row delete migration", () => {
  // act_distribution was removed from the schema. Any leftover row on an
  // upgraded DB would surface as an orphan in getAllSettings (which reads
  // the table, not the schema) and confuse operators — drop it.

  it("removes the act_distribution row if it exists on the upgraded DB", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('act_distribution', '3,9,3')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = 'act_distribution'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("is a no-op on a DB that never had act_distribution", () => {
    const path = tempDbPath();
    // First open creates a clean DB.
    {
      const db = createDb(path);
      db.close();
    }
    // Second open must not throw and the row stays absent.
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = 'act_distribution'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      db2.close();
    }
  });
});

describe("createDb — script_length_minutes migration", () => {
  // The Phase 3 migration seeds script_length_minutes from existing
  // chapter_count × 6 (preserving operator preference), with a 90-min
  // fallback for DBs that never had chapter_count, and drops the now-
  // obsolete chapter_count + chapter_target_words rows.

  it("seeds script_length_minutes from chapter_count × 6 on an upgraded DB", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Simulate an old DB: write the legacy rows back in (createDb
      // already deletes them on this same open, but we restore them to
      // emulate a pre-migration DB shape on the next open).
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('chapter_count', '20')"
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('chapter_target_words', '1500')"
      ).run();
      db.prepare("DELETE FROM settings WHERE key = 'script_length_minutes'").run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const slm = db2
        .prepare("SELECT value FROM settings WHERE key = 'script_length_minutes'")
        .get() as { value: string } | undefined;
      expect(slm?.value).toBe("120");

      const cc = db2
        .prepare("SELECT value FROM settings WHERE key = 'chapter_count'")
        .get();
      expect(cc).toBeUndefined();

      const ctw = db2
        .prepare("SELECT value FROM settings WHERE key = 'chapter_target_words'")
        .get();
      expect(ctw).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("falls back to 90 when there's no chapter_count row to convert", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Remove both keys to emulate a DB that has neither chapter_count
      // nor script_length_minutes — the fallback INSERT must fire.
      db.prepare("DELETE FROM settings WHERE key = 'script_length_minutes'").run();
      db.prepare("DELETE FROM settings WHERE key = 'chapter_count'").run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const slm = db2
        .prepare("SELECT value FROM settings WHERE key = 'script_length_minutes'")
        .get() as { value: string } | undefined;
      expect(slm?.value).toBe("90");
    } finally {
      db2.close();
    }
  });

  it("preserves an existing script_length_minutes value across re-runs", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('script_length_minutes', '180')"
      ).run();
      // Restore chapter_count to verify (a) doesn't clobber an existing
      // script_length_minutes via INSERT OR IGNORE.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('chapter_count', '20')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const slm = db2
        .prepare("SELECT value FROM settings WHERE key = 'script_length_minutes'")
        .get() as { value: string };
      expect(slm.value).toBe("180");
    } finally {
      db2.close();
    }
  });
});

describe("createDb — hook_length_seconds migration", () => {
  // Mirrors the script_length_minutes migration above: convert legacy
  // hook_chunk_count × hook_video_clip_seconds into hook_length_seconds,
  // fall back to 120 on fresh DBs, then drop the legacy hook_chunk_count
  // row. The (a) → (b) → (c) order is load-bearing — (a) must run before
  // (c) deletes hook_chunk_count, and (b) covers fresh DBs.

  it("seeds hook_length_seconds = round(count × clip) on an upgraded DB", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // Emulate a pre-migration DB: restore the legacy hook_chunk_count
      // row and remove the new hook_length_seconds so the migration runs
      // on the next open.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_chunk_count', '20')"
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_video_clip_seconds', '6')"
      ).run();
      db.prepare(
        "DELETE FROM settings WHERE key = 'hook_length_seconds'"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const hls = db2
        .prepare("SELECT value FROM settings WHERE key = 'hook_length_seconds'")
        .get() as { value: string } | undefined;
      // 20 × 6 = 120.
      expect(hls?.value).toBe("120");

      const hcc = db2
        .prepare("SELECT value FROM settings WHERE key = 'hook_chunk_count'")
        .get();
      expect(hcc).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("rounds non-integer products when the legacy clip was fractional", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      // 15 × 7.5 = 112.5 → ROUND yields 113.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_chunk_count', '15')"
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_video_clip_seconds', '7.5')"
      ).run();
      db.prepare(
        "DELETE FROM settings WHERE key = 'hook_length_seconds'"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const hls = db2
        .prepare("SELECT value FROM settings WHERE key = 'hook_length_seconds'")
        .get() as { value: string } | undefined;
      expect(hls?.value).toBe("113");
    } finally {
      db2.close();
    }
  });

  it("falls back to 120 when neither hook_chunk_count nor hook_length_seconds is present", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "DELETE FROM settings WHERE key = 'hook_length_seconds'"
      ).run();
      db.prepare("DELETE FROM settings WHERE key = 'hook_chunk_count'").run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const hls = db2
        .prepare("SELECT value FROM settings WHERE key = 'hook_length_seconds'")
        .get() as { value: string } | undefined;
      expect(hls?.value).toBe("120");
    } finally {
      db2.close();
    }
  });

  it("preserves an existing hook_length_seconds value across re-runs", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_length_seconds', '200')"
      ).run();
      // Re-introduce the legacy row to verify (a)'s INSERT OR IGNORE
      // doesn't overwrite an existing hook_length_seconds.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hook_chunk_count', '20')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const hls = db2
        .prepare("SELECT value FROM settings WHERE key = 'hook_length_seconds'")
        .get() as { value: string };
      expect(hls.value).toBe("200");
    } finally {
      db2.close();
    }
  });
});

describe("createDb — workflows + workflow_steps schema", () => {
  it("creates workflows table with the expected columns and defaults", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      // SQLite reports notnull=0 for PRIMARY KEY columns even when the
      // column is declared NOT NULL — uniqueness is enforced by the PK
      // index, so the notnull flag is left off. Just check pk + type.
      expect(byName.id).toMatchObject({ type: "TEXT", pk: 1 });
      expect(byName.label).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.short_label).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.description).toMatchObject({ type: "TEXT", notnull: 0 });
      // Plan 1 Phase 1.1 Task 2: script_llm_provider relaxed to nullable
      // so music_video workflows can carry null (forward-only on greenfield).
      expect(byName.script_llm_provider).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.tts_provider).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.image_provider).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.video_provider).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.is_builtin).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      });
      expect(byName.enabled).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "1",
      });
      expect(byName.version).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "1",
      });
      expect(byName.created_at).toMatchObject({ type: "INTEGER", notnull: 1 });
      expect(byName.updated_at).toMatchObject({ type: "INTEGER", notnull: 1 });
      // Plan 1 Phase 1.1 Task 2: chunker_step relaxed to nullable so
      // music_video workflows can carry null. DEFAULT dropped — the seed
      // explicitly passes a value for narrative rows and null for
      // music_video rows.
      expect(byName.chunker_step).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("creates workflow_steps table with composite PK on (workflow_id, position)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflow_steps)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName.workflow_id).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.position).toMatchObject({ type: "INTEGER", notnull: 1 });
      expect(byName.step_name).toMatchObject({ type: "TEXT", notnull: 1 });
      // composite PK — pk numbers are 1 and 2 for the two PK members.
      expect(byName.workflow_id.pk).toBeGreaterThan(0);
      expect(byName.position.pk).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("creates idx_workflow_steps_workflow index on workflow_steps", () => {
    const db = createDb(":memory:");
    try {
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_steps_workflow'"
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_workflow_steps_workflow");
    } finally {
      db.close();
    }
  });

  it("ON DELETE CASCADE removes workflow_steps when their workflow is deleted", () => {
    const db = createDb(":memory:");
    try {
      const now = Date.now();
      db.prepare(
        "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "wf-x",
        "Workflow X",
        "X",
        null,
        "openrouter",
        "ai33",
        "comfyui",
        "comfyui",
        1,
        1,
        1,
        now,
        now
      );
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("wf-x", 0, "research_outline");
      db.prepare(
        "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
      ).run("wf-x", 1, "write_hook");

      db.prepare("DELETE FROM workflows WHERE id = ?").run("wf-x");

      const remaining = db
        .prepare(
          "SELECT COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ?"
        )
        .get("wf-x") as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("videos.workflow_snapshot column exists on greenfield (TEXT, nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.workflow_snapshot).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("videos.provided_script column exists on greenfield (TEXT, nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.provided_script).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("adds the provided_script column to an existing videos table that predates it", () => {
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          topic_info       TEXT NOT NULL,
          workflow_id      TEXT NOT NULL,
          status           TEXT NOT NULL,
          current_step     TEXT,
          failed_step      TEXT,
          failed_reason    TEXT,
          started_at       INTEGER,
          finished_at      INTEGER,
          output_path      TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          paused           INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.provided_script).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare("SELECT provided_script FROM videos WHERE id = ?")
        .get("v_legacy") as { provided_script: string | null };
      expect(row.provided_script).toBeNull();
    } finally {
      db.close();
    }

    const db2 = createDb(path);
    db2.close();
  });

  it("videos FK to workflows(id) ON DELETE RESTRICT enforces presence on greenfield", () => {
    // Greenfield-only behavior: ALTER cannot retrofit FK on existing
    // DBs, so we only assert this on a freshly created DB.
    const db = createDb(":memory:");
    try {
      // Inserting a video with a missing workflow_id reference must fail.
      expect(() =>
        db
          .prepare(
            "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("v1", "T", "info", "ghost-workflow", "new", 1)
      ).toThrow(/FOREIGN KEY/i);

      // createDb auto-seeds the built-in "comfyui" row, so a referencing
      // insert succeeds without further setup.
      expect(() =>
        db
          .prepare(
            "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("v1", "T", "info", "comfyui", "new", 1)
      ).not.toThrow();

      // Deleting the workflow with a referencing video must be rejected.
      expect(() =>
        db.prepare("DELETE FROM workflows WHERE id = ?").run("comfyui")
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it("adds chunker_step to an existing workflows table that predates it", () => {
    // Simulates an on-disk DB created before the column existed: createDb
    // must ALTER on next open, surface the default on legacy rows, and a
    // second open must not throw.
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE workflows (
          id                  TEXT PRIMARY KEY,
          label               TEXT NOT NULL,
          short_label         TEXT NOT NULL,
          description         TEXT,
          script_llm_provider TEXT NOT NULL,
          tts_provider        TEXT,
          image_provider      TEXT,
          video_provider      TEXT,
          is_builtin          INTEGER NOT NULL DEFAULT 0,
          enabled             INTEGER NOT NULL DEFAULT 1,
          version             INTEGER NOT NULL DEFAULT 1,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "legacy-wf",
          "Legacy",
          "L",
          null,
          "openrouter",
          "ai33",
          "comfyui",
          "comfyui",
          1,
          1,
          1,
          1,
          1
        );
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      // Plan 1 Phase 1.1 Task 2: the table-rebuild relaxes chunker_step
      // to nullable when the upgrade path runs against a legacy DB. The
      // ADD COLUMN above stamps the default for any row that pre-dates
      // the column; the rebuild preserves that value without re-imposing
      // the NOT NULL constraint.
      expect(byName.chunker_step).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare("SELECT chunker_step FROM workflows WHERE id = ?")
        .get("legacy-wf") as { chunker_step: string };
      expect(row.chunker_step).toBe("chunk_clips_then_images");
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });

  it("adds the workflow_snapshot column to an existing videos table that predates it", () => {
    // Simulates an on-disk DB created before the column existed: createDb
    // must ALTER on next open and a second open must not throw.
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          topic_info       TEXT NOT NULL,
          workflow_id      TEXT NOT NULL,
          status           TEXT NOT NULL,
          current_step     TEXT,
          failed_step      TEXT,
          failed_reason    TEXT,
          started_at       INTEGER,
          finished_at      INTEGER,
          output_path      TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          paused           INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.workflow_snapshot).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
        .get("v_legacy") as { workflow_snapshot: string | null };
      expect(row.workflow_snapshot).toBeNull();
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });

  it("videos.visual_style_id column exists on greenfield (TEXT, nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.visual_style_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("videos.visual_style_snapshot column exists on greenfield (TEXT, nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.visual_style_snapshot).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("greenfield videos.visual_style_id FK ON DELETE SET NULL nulls referencing rows", () => {
    const db = createDb(":memory:");
    try {
      const now = Date.now();
      db.prepare(
        "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run("vs1", "Cinematic noir", "noir prompt", now, now);
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, visual_style_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("v1", "T", "info", "comfyui", "vs1", "new", now);

      db.prepare("DELETE FROM visual_styles WHERE id = ?").run("vs1");

      const row = db
        .prepare("SELECT visual_style_id FROM videos WHERE id = ?")
        .get("v1") as { visual_style_id: string | null };
      expect(row.visual_style_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("adds visual_style_id and visual_style_snapshot to an existing videos table that predates them", () => {
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id                TEXT PRIMARY KEY,
          title             TEXT NOT NULL,
          topic_info        TEXT NOT NULL,
          workflow_id       TEXT NOT NULL,
          workflow_snapshot TEXT,
          status            TEXT NOT NULL,
          current_step      TEXT,
          failed_step       TEXT,
          failed_reason     TEXT,
          started_at        INTEGER,
          finished_at       INTEGER,
          output_path       TEXT,
          delete_requested  INTEGER NOT NULL DEFAULT 0,
          paused            INTEGER NOT NULL DEFAULT 0,
          provided_script   TEXT,
          created_at        INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.visual_style_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.visual_style_snapshot).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare(
          "SELECT visual_style_id, visual_style_snapshot FROM videos WHERE id = ?"
        )
        .get("v_legacy") as {
        visual_style_id: string | null;
        visual_style_snapshot: string | null;
      };
      expect(row.visual_style_id).toBeNull();
      expect(row.visual_style_snapshot).toBeNull();
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });
});

describe("seedDefaultWorkflows", () => {
  it("inserts both built-in workflows with stamped lifecycle columns", () => {
    const db = createDb(":memory:");
    try {
      // createDb auto-seeds; clear and reseed manually to assert the
      // seedDefaultWorkflows function does the work itself.
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");

      const before = Date.now();
      seedDefaultWorkflows(db);
      const after = Date.now();

      const rows = db
        .prepare("SELECT * FROM workflows ORDER BY id")
        .all() as Array<{
        id: string;
        label: string;
        short_label: string;
        description: string | null;
        kind: string;
        script_llm_provider: string | null;
        tts_provider: string | null;
        image_provider: string | null;
        video_provider: string | null;
        is_builtin: number;
        enabled: number;
        version: number;
        created_at: number;
        updated_at: number;
        chunker_step: string | null;
      }>;
      expect(rows.map((r) => r.id)).toEqual([
        "comfyui",
        "google-flow",
        "google-flow-clips-only",
        "google-flow-images-only",
        "music-video-magnific-suno",
      ]);

      // Lifecycle columns are stamped uniformly across all builtins
      // regardless of kind. Per-kind provider invariants are asserted
      // below in dedicated lookups.
      for (const row of rows) {
        expect(row.is_builtin).toBe(1);
        expect(row.enabled).toBe(1);
        expect(row.version).toBe(1);
        expect(row.created_at).toBeGreaterThanOrEqual(before);
        expect(row.created_at).toBeLessThanOrEqual(after);
        expect(row.updated_at).toBe(row.created_at);
      }

      // Narrative builtins share script_llm_provider='openrouter' and
      // tts_provider='ai33'; the music-video builtin leaves both null.
      for (const row of rows.filter((r) => r.kind === "narrative")) {
        expect(row.script_llm_provider).toBe("openrouter");
        expect(row.tts_provider).toBe("ai33");
      }

      const comfy = rows.find((r) => r.id === "comfyui")!;
      expect(comfy.image_provider).toBe("comfyui");
      expect(comfy.video_provider).toBe("comfyui");
      expect(comfy.chunker_step).toBe("chunk_clips_then_images");

      const flow = rows.find((r) => r.id === "google-flow")!;
      expect(flow.image_provider).toBe("google_flow");
      expect(flow.video_provider).toBe("google_flow");
      expect(flow.chunker_step).toBe("chunk_clips_then_images");

      const imagesOnly = rows.find((r) => r.id === "google-flow-images-only")!;
      expect(imagesOnly.image_provider).toBe("google_flow");
      expect(imagesOnly.video_provider).toBeNull();
      expect(imagesOnly.chunker_step).toBe("chunk_images_only");

      const clipsOnly = rows.find((r) => r.id === "google-flow-clips-only")!;
      expect(clipsOnly.image_provider).toBeNull();
      expect(clipsOnly.video_provider).toBe("google_flow");
      expect(clipsOnly.chunker_step).toBe("chunk_clips_only");
    } finally {
      db.close();
    }
  });

  it("seeds the three script-module steps in order for each built-in", () => {
    const db = createDb(":memory:");
    try {
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");
      seedDefaultWorkflows(db);

      const expected = [
        "research_outline",
        "write_hook",
        "write_chapters",
      ];
      for (const wfId of [
        "comfyui",
        "google-flow",
        "google-flow-images-only",
        "google-flow-clips-only",
      ]) {
        const steps = db
          .prepare(
            "SELECT step_name, position FROM workflow_steps WHERE workflow_id = ? ORDER BY position"
          )
          .all(wfId) as Array<{ step_name: string; position: number }>;
        expect(steps.map((s) => s.step_name)).toEqual(expected);
        expect(steps.map((s) => s.position)).toEqual([0, 1, 2]);
      }
    } finally {
      db.close();
    }
  });

  it("does not overwrite user-edited workflow rows on re-seed (INSERT OR IGNORE)", () => {
    // db:init is operator-safe: re-running it after the operator has
    // edited a workflow must preserve those edits.
    const db = createDb(":memory:");
    try {
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");
      seedDefaultWorkflows(db);

      db.prepare("UPDATE workflows SET label = ? WHERE id = ?").run(
        "Edited Label",
        "comfyui"
      );

      seedDefaultWorkflows(db);

      const row = db
        .prepare("SELECT label FROM workflows WHERE id = ?")
        .get("comfyui") as { label: string };
      expect(row.label).toBe("Edited Label");
    } finally {
      db.close();
    }
  });

  it("createDb itself ensures the built-in workflow rows are present", () => {
    // createDb is the runtime path (no db:init needed). Tests that bypass
    // seedDefaultSettings still need the FK target rows present.
    const db = createDb(":memory:");
    try {
      const ids = db
        .prepare("SELECT id FROM workflows ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(ids.map((r) => r.id)).toEqual([
        "comfyui",
        "google-flow",
        "google-flow-clips-only",
        "google-flow-images-only",
        "music-video-magnific-suno",
      ]);
    } finally {
      db.close();
    }
  });

  it("narrative builtins ship with kind='narrative'", () => {
    const db = createDb(":memory:");
    try {
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");
      seedDefaultWorkflows(db);

      const rows = db
        .prepare(
          "SELECT id, kind FROM workflows WHERE kind = 'narrative' ORDER BY id"
        )
        .all() as Array<{ id: string; kind: string }>;
      expect(rows.map((r) => r.id)).toEqual([
        "comfyui",
        "google-flow",
        "google-flow-clips-only",
        "google-flow-images-only",
      ]);
      for (const row of rows) {
        expect(row.kind).toBe("narrative");
      }
    } finally {
      db.close();
    }
  });

  it("seeds the music-video-magnific-suno builtin workflow with the expected provider triple", () => {
    // Plan 1 Phase 1.1 Task 3: the music-video builtin row hard-codes the
    // only valid provider triple — image=magnific, video=magnific,
    // music=suno — and leaves the narrative-only provider columns + the
    // chunker_step null. The advisory validator (Phase 1.2) enforces this
    // shape; the seed is the canonical example.
    const db = createDb(":memory:");
    try {
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");
      seedDefaultWorkflows(db);

      const row = db
        .prepare("SELECT * FROM workflows WHERE id = ?")
        .get("music-video-magnific-suno") as
        | {
            id: string;
            label: string;
            short_label: string;
            description: string | null;
            kind: string;
            script_llm_provider: string | null;
            tts_provider: string | null;
            image_provider: string | null;
            video_provider: string | null;
            music_provider: string | null;
            upscaler_provider: string | null;
            chunker_step: string | null;
            is_builtin: number;
            enabled: number;
            version: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.kind).toBe("music_video");
      expect(row!.image_provider).toBe("magnific");
      expect(row!.video_provider).toBe("magnific");
      expect(row!.music_provider).toBe("suno");
      expect(row!.upscaler_provider).toBeNull();
      expect(row!.script_llm_provider).toBeNull();
      expect(row!.tts_provider).toBeNull();
      expect(row!.chunker_step).toBeNull();
      expect(row!.is_builtin).toBe(1);
      expect(row!.enabled).toBe(1);
      expect(row!.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it("music-video-magnific-suno has no workflow_steps rows", () => {
    // Music-video workflows don't materialize script-module steps —
    // the six step names come from the materializer's kind switch, not
    // from workflow_steps. Same convention as the glue/module steps for
    // narrative workflows.
    const db = createDb(":memory:");
    try {
      db.exec("DELETE FROM workflow_steps; DELETE FROM workflows;");
      seedDefaultWorkflows(db);

      const steps = db
        .prepare(
          "SELECT step_name FROM workflow_steps WHERE workflow_id = ?"
        )
        .all("music-video-magnific-suno") as Array<{ step_name: string }>;
      expect(steps).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("seedDefaultSettings", () => {
  it("inserts every setting key with its spec-defined default", () => {
    const db = createDb(":memory:");
    try {
      seedDefaultSettings(db);

      const rows = db
        .prepare("SELECT key, value FROM settings")
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));

      // Exact equality — no extra keys, no missing keys. Required-string
      // keys (model_name, voice_id) seed as "".
      expect(asMap).toEqual({
        openrouter_script_model: "",
        openrouter_visual_model: "",
        claude_cli_script_model: "claude-opus-4-7",
        claude_cli_visual_model: "claude-opus-4-7",
        image_provider: "comfyui",
        comfyui_base_url: "http://127.0.0.1:8188",
        comfyui_workflow_path: "prompts/comfyui/default-workflow.json",
        comfyui_hook_video_workflow_path:
          "prompts/comfyui/default-hook-video-workflow.json",
        google_flow_relogin_needed: "false",
        flow_create_project_failed: "",
        flow_service_overload_until: "",
        google_flow_service_overload_cooldown_minutes: "15",
        google_flow_account_cooldown_hours: "4",
        google_flow_max_retries: "3",
        google_flow_image_model: "NARWHAL",
        google_flow_video_model: "veo_3_1_t2v_lite_low_priority",
        google_flow_aspect_ratio: "landscape",
        google_flow_image_aspect_ratio: "16:9",
        google_flow_hook_clip_seconds: "8",
        google_flow_dispatch_timeout_minutes: "30",
        aspect_ratio: "16:9",
        long_edge_px: "1920",
        framerate: "30",
        video_encoder: "libx264",
        hook_video_clip_seconds: "8",
        hook_length_seconds: "120",
        script_length_minutes: "90",
        voice_id: "",
        voiceover_model_id: "eleven_multilingual_v2",
        voice_stability: "0.75",
        voice_similarity: "0.5",
        voice_style: "0.0",
        voice_speed: "1.0",
        voice_use_speaker_boost: "true",
        queue_state: "running",
        google_flow_content_moderation_enabled: "true",
        google_flow_content_moderation_max_rounds: "2",
        google_flow_content_moderation_model: "",
        chatterbox_base_url: "http://127.0.0.1:8004",
        chatterbox_fast_base_url: "http://127.0.0.1:8005",
        chatterbox_voice_mode: "predefined",
        chatterbox_voice_filename: "",
        chatterbox_temperature: "0.8",
        chatterbox_exaggeration: "0.5",
        chatterbox_cfg_weight: "0.5",
        chatterbox_speed_factor: "1.0",
        chatterbox_fast_max_chunk_chars: "300",
        chatterbox_fast_silence_ms: "150",
        chatterbox_fast_workers: "2",
        visual_prompts_batch_size: "8",
        claude_cli_visual_prompts_concurrency: "2",
        openrouter_visual_prompts_concurrency: "8",
        image_chunk_target_seconds: "8",
        magnific_token: "",
        magnific_dispatch_timeout_minutes: "30",
        magnific_image_model: "flux-realism",
        magnific_video_model: "seedance",
        magnific_relogin_needed: "false",
        music_video_loop_trim_tail_seconds: "0.3",
        music_video_loop_xfade_seconds: "0.2",
        style_lock_description:
          "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.",
        character_lock_negative:
          "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression",
      });
    } finally {
      db.close();
    }
  });

  it("does not overwrite settings values that already exist", () => {
    // Operator safety: re-running `npm run db:init` after an operator has
    // configured their settings must preserve those values. INSERT OR IGNORE.
    const db = createDb(":memory:");
    try {
      seedDefaultSettings(db);

      // Operator edits a couple of keys.
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        "custom-voice-id",
        "voice_id"
      );
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        "openai/gpt-4o",
        "openrouter_script_model"
      );

      // Re-seed — simulates a second `npm run db:init`.
      seedDefaultSettings(db);

      const voiceId = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("voice_id") as { value: string };
      const scriptModel = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("openrouter_script_model") as { value: string };

      expect(voiceId.value).toBe("custom-voice-id");
      expect(scriptModel.value).toBe("openai/gpt-4o");
    } finally {
      db.close();
    }
  });
});

describe("createDb — operation persistence", () => {
  // The extension submits a video generation, gets back an operation
  // name + projectId, and posts both to HistForge so a poll-resume after
  // requeue can recover the operation instead of blindly re-submitting.
  // Both columns are nullable: pre-submit rows have no operation yet.

  it("creates google_operation_id + google_operation_project_id columns on greenfield", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_queue)")
        .all() as Array<{ name: string; notnull: number; type: string }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.google_operation_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.google_operation_project_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("ALTERs an existing google_flow_queue that predates the operation columns", () => {
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          topic_info       TEXT NOT NULL,
          workflow_id      TEXT NOT NULL,
          status           TEXT NOT NULL,
          current_step     TEXT,
          failed_step      TEXT,
          failed_reason    TEXT,
          started_at       INTEGER,
          finished_at      INTEGER,
          output_path      TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL
        );
        CREATE TABLE google_flow_queue (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id              TEXT NOT NULL,
          chunk_id              TEXT,
          kind                  TEXT NOT NULL,
          mode                  TEXT NOT NULL,
          prompt                TEXT NOT NULL,
          reference_image       TEXT,
          start_frame           TEXT,
          end_frame             TEXT,
          output_path           TEXT NOT NULL,
          status                TEXT NOT NULL,
          assigned_account_id   TEXT,
          external_task_id      TEXT,
          result_url            TEXT,
          error_reason          TEXT,
          retry_count           INTEGER NOT NULL DEFAULT 0,
          priority              INTEGER NOT NULL DEFAULT 0,
          created_at            INTEGER NOT NULL,
          dispatched_at         INTEGER,
          completed_at          INTEGER
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "google-flow", "in_progress", 1);
      raw
        .prepare(
          `INSERT INTO google_flow_queue
             (video_id, chunk_id, kind, mode, prompt, output_path, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "v_legacy",
          "main_01",
          "main_image",
          "createImage",
          "p",
          "/tmp/x",
          "dispatched",
          1
        );
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_queue)")
        .all() as Array<{ name: string; notnull: number; type: string }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.google_operation_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.google_operation_project_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare(
          "SELECT google_operation_id, google_operation_project_id FROM google_flow_queue WHERE video_id = ?"
        )
        .get("v_legacy") as {
        google_operation_id: string | null;
        google_operation_project_id: string | null;
      };
      expect(row.google_operation_id).toBeNull();
      expect(row.google_operation_project_id).toBeNull();
    } finally {
      db.close();
    }

    const db2 = createDb(path);
    db2.close();
  });
});

describe("createDb — LLM settings restructure migration", () => {
  // The legacy single-model keys fan out into per-purpose pairs; the
  // global enrich-provider knob and the Claude CLI path/extra-args knobs
  // are dropped outright. The migration runs every open so installs that
  // never re-run db:init pick it up on the next worker boot.

  it("fans out model_name into both openrouter_*_model fields on first reopen", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('model_name', 'openai/gpt-4o')"
      ).run();
      // Wipe new keys so we exercise the migration's INSERT OR IGNORE,
      // not the OR-IGNORE preservation branch (covered separately below).
      db.prepare(
        "DELETE FROM settings WHERE key IN ('openrouter_script_model', 'openrouter_visual_model')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'openrouter_%_model'"
        )
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(asMap.openrouter_script_model).toBe("openai/gpt-4o");
      expect(asMap.openrouter_visual_model).toBe("openai/gpt-4o");

      const legacy = db2
        .prepare("SELECT value FROM settings WHERE key = 'model_name'")
        .get();
      expect(legacy).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("fans out claude_cli_model into both claude_cli_*_model fields", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('claude_cli_model', 'claude-haiku-4-5')"
      ).run();
      db.prepare(
        "DELETE FROM settings WHERE key IN ('claude_cli_script_model', 'claude_cli_visual_model')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const rows = db2
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'claude_cli_%_model'"
        )
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(asMap.claude_cli_script_model).toBe("claude-haiku-4-5");
      expect(asMap.claude_cli_visual_model).toBe("claude-haiku-4-5");

      const legacy = db2
        .prepare("SELECT value FROM settings WHERE key = 'claude_cli_model'")
        .get();
      expect(legacy).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("preserves an already-set new key — does not clobber operator edits", () => {
    // Migration must be operator-safe: someone who already set the new
    // keys to per-purpose values shouldn't get them overwritten by the
    // legacy single-model fan-out on the next worker boot.
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('model_name', 'openai/gpt-4o')"
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('openrouter_visual_model', 'anthropic/claude-haiku-4.5')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare(
          "SELECT value FROM settings WHERE key = 'openrouter_visual_model'"
        )
        .get() as { value: string };
      expect(row.value).toBe("anthropic/claude-haiku-4.5");
    } finally {
      db2.close();
    }
  });

  it.each([
    "enrich_chunks_llm_provider",
    "claude_cli_path",
    "claude_cli_extra_args",
  ] as const)("drops legacy %s row outright", (legacyKey) => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
      ).run(legacyKey, "whatever");
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(legacyKey);
      expect(row).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("is idempotent across multiple opens", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('model_name', 'openai/gpt-4o')"
      ).run();
      db.close();
    }
    // First reopen runs the migration; subsequent must be no-ops.
    for (let i = 0; i < 3; i++) {
      const db = createDb(path);
      db.close();
    }
    const db = createDb(path);
    try {
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'openrouter_%_model'"
        )
        .all() as Array<{ key: string; value: string }>;
      const asMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      // First reopen seeded both from model_name. Subsequent reopens see
      // model_name already gone and INSERT OR IGNORE preserves the seeded
      // values without re-fanning anything.
      expect(asMap.openrouter_script_model).toBe("openai/gpt-4o");
      expect(asMap.openrouter_visual_model).toBe("openai/gpt-4o");

      const legacy = db
        .prepare("SELECT value FROM settings WHERE key = 'model_name'")
        .get();
      expect(legacy).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("createDb — style_prompt_default cleanup migration", () => {
  // The setting key was removed when the per-video visual_style_snapshot
  // took over (Phase 4 of the visual-style-gallery work). createDb runs
  // a one-shot DELETE so existing DBs don't keep an orphan row sitting
  // around — `DEFAULT_SETTINGS` no longer carries the key, so without
  // this delete the row would survive forever.

  it("removes a pre-existing style_prompt_default row", () => {
    const path = tempDbPath();
    {
      const db = createDb(path);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('style_prompt_default', 'noir')"
      ).run();
      db.close();
    }
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare("SELECT value FROM settings WHERE key = 'style_prompt_default'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it("is idempotent when the row doesn't exist", () => {
    const path = tempDbPath();
    // Greenfield open — the row was never inserted.
    {
      const db = createDb(path);
      db.close();
    }
    // Re-opening twice more must not throw.
    for (let i = 0; i < 2; i++) {
      const db = createDb(path);
      db.close();
    }
    const db = createDb(path);
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'style_prompt_default'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("createDb — videos kind + music-video columns", () => {
  // Plan 1 Phase 1.1 Task 1: kind discriminator + four music-video-only
  // columns ship on a fresh CREATE TABLE and as idempotent ALTER blocks for
  // pre-existing DBs. `kind` defaults to 'narrative' so existing rows behave
  // as narrative; the four typed columns are nullable because they only
  // carry data when `kind = 'music_video'`.

  it("videos.kind column exists on greenfield (TEXT NOT NULL DEFAULT 'narrative')", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.kind).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'narrative'",
      });
    } finally {
      db.close();
    }
  });

  it("videos music-video columns exist on greenfield (nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.magnific_image_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.magnific_motion_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.suno_style_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.song_count).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(byName.repeat_factor).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("adds kind + music-video columns to an existing videos table that predates them", () => {
    // Simulates an on-disk DB created before any of the five columns
    // existed. createDb must ALTER on next open; pre-existing rows must
    // default to kind='narrative' and null for the four typed columns;
    // a second open must not throw.
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id                    TEXT PRIMARY KEY,
          title                 TEXT NOT NULL,
          topic_info            TEXT NOT NULL,
          workflow_id           TEXT NOT NULL,
          workflow_snapshot     TEXT,
          visual_style_id       TEXT,
          visual_style_snapshot TEXT,
          status                TEXT NOT NULL,
          current_step          TEXT,
          failed_step           TEXT,
          failed_reason         TEXT,
          started_at            INTEGER,
          finished_at           INTEGER,
          output_path           TEXT,
          delete_requested      INTEGER NOT NULL DEFAULT 0,
          paused                INTEGER NOT NULL DEFAULT 0,
          provided_script       TEXT,
          created_at            INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.kind).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'narrative'",
      });
      expect(byName.magnific_image_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.magnific_motion_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.suno_style_prompt).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.song_count).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(byName.repeat_factor).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });

      const row = db
        .prepare(
          "SELECT kind, magnific_image_prompt, magnific_motion_prompt, suno_style_prompt, song_count, repeat_factor FROM videos WHERE id = ?"
        )
        .get("v_legacy") as {
        kind: string;
        magnific_image_prompt: string | null;
        magnific_motion_prompt: string | null;
        suno_style_prompt: string | null;
        song_count: number | null;
        repeat_factor: number | null;
      };
      expect(row.kind).toBe("narrative");
      expect(row.magnific_image_prompt).toBeNull();
      expect(row.magnific_motion_prompt).toBeNull();
      expect(row.suno_style_prompt).toBeNull();
      expect(row.song_count).toBeNull();
      expect(row.repeat_factor).toBeNull();
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });

  // Plan — "Dedicated Magnific motion-prompt field for music videos" Task 1.1:
  // when the magnific_motion_prompt column lands, an in-flight music_video
  // row created before the migration must get a sensible default written so
  // generate_loop_clip doesn't throw "magnific_motion_prompt is missing" on
  // the next orchestrator re-entry. The backfill mirrors the legacy
  // MOTION_SUFFIX heuristic into the column once, at migration time.
  it("backfills magnific_motion_prompt for existing music_video rows from magnific_image_prompt", () => {
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id                    TEXT PRIMARY KEY,
          title                 TEXT NOT NULL,
          topic_info            TEXT NOT NULL,
          workflow_id           TEXT NOT NULL,
          workflow_snapshot     TEXT,
          visual_style_id       TEXT,
          visual_style_snapshot TEXT,
          status                TEXT NOT NULL,
          current_step          TEXT,
          failed_step           TEXT,
          failed_reason         TEXT,
          started_at            INTEGER,
          finished_at           INTEGER,
          output_path           TEXT,
          delete_requested      INTEGER NOT NULL DEFAULT 0,
          paused                INTEGER NOT NULL DEFAULT 0,
          provided_script       TEXT,
          kind                  TEXT NOT NULL DEFAULT 'narrative',
          magnific_image_prompt TEXT,
          suno_style_prompt     TEXT,
          song_count            INTEGER,
          repeat_factor         INTEGER,
          created_at            INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, magnific_image_prompt, suno_style_prompt, song_count, repeat_factor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "v_mv_legacy",
          "Legacy Music Video",
          "",
          "music-video-magnific-suno",
          "in_progress",
          "music_video",
          "a glowing cathedral at dusk",
          "ambient choral drone",
          3,
          2,
          1
        );
      // Narrative row: must remain NULL after migration (backfill is
      // guarded by kind='music_video').
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_nar_legacy", "Narrative", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const mv = db
        .prepare(
          "SELECT magnific_image_prompt, magnific_motion_prompt FROM videos WHERE id = ?"
        )
        .get("v_mv_legacy") as {
        magnific_image_prompt: string | null;
        magnific_motion_prompt: string | null;
      };
      // The backfill writes magnific_image_prompt || ' — slow cinematic
      // motion, smooth loop, looping camera' once, at migration time.
      expect(mv.magnific_motion_prompt).toBe(
        "a glowing cathedral at dusk — slow cinematic motion, smooth loop, looping camera"
      );

      const nar = db
        .prepare(
          "SELECT kind, magnific_motion_prompt FROM videos WHERE id = ?"
        )
        .get("v_nar_legacy") as {
        kind: string;
        magnific_motion_prompt: string | null;
      };
      expect(nar.kind).toBe("narrative");
      expect(nar.magnific_motion_prompt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not clobber a magnific_motion_prompt that is already set", () => {
    // Once an operator's value lands in the column (via the new form), a
    // re-open of the DB must NOT overwrite it with the suffix-derived
    // backfill. The migration's WHERE clause guards on IS NULL.
    const path = tempDbPath();

    // First open: createDb materializes the modern schema (column exists).
    {
      const db = createDb(path);
      seedWorkflowRow(db, "music-video-magnific-suno");
      db.prepare(
        `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind,
          magnific_image_prompt, magnific_motion_prompt, suno_style_prompt,
          song_count, repeat_factor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "v_mv_modern",
        "Modern",
        "",
        "music-video-magnific-suno",
        "in_progress",
        "music_video",
        "still image prompt",
        "operator-supplied aggressive push-in",
        "style",
        3,
        2,
        1
      );
      db.close();
    }

    // Re-open re-runs the migration; the operator's value must survive.
    const db2 = createDb(path);
    try {
      const row = db2
        .prepare(
          "SELECT magnific_motion_prompt FROM videos WHERE id = ?"
        )
        .get("v_mv_modern") as { magnific_motion_prompt: string };
      expect(row.magnific_motion_prompt).toBe(
        "operator-supplied aggressive push-in"
      );
    } finally {
      db2.close();
    }
  });
});

describe("createDb — workflows kind + music_provider + upscaler_provider", () => {
  // Plan 1 Phase 1.1 Task 2: workflows gains a `kind` discriminator + two
  // provider columns. `script_llm_provider` and `chunker_step` are also
  // relaxed to nullable on greenfield (forward-only — SQLite can't ALTER
  // COLUMN, and pre-existing rows are already populated). The advisory
  // workflow validator (Phase 1.2) is the runtime enforcer.

  it("workflows.kind exists on greenfield (TEXT NOT NULL DEFAULT 'narrative')", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.kind).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'narrative'",
      });
    } finally {
      db.close();
    }
  });

  it("workflows.music_provider + upscaler_provider exist on greenfield (nullable)", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.music_provider).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.upscaler_provider).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("relaxes script_llm_provider + chunker_step to nullable on greenfield", () => {
    // Forward-only relaxation: SQLite cannot ALTER COLUMN, so pre-existing
    // legacy rows keep their NOT NULL constraint (they're already populated
    // non-null anyway). New CREATE TABLE ships with both columns relaxed
    // so music_video rows can carry null.
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{ name: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.script_llm_provider.notnull).toBe(0);
      expect(byName.chunker_step.notnull).toBe(0);
    } finally {
      db.close();
    }
  });

  it("greenfield workflows accepts a row with null script_llm_provider + chunker_step", () => {
    // The music-video seed (Task 3) writes one such row; verify the SQL
    // accepts it.
    const db = createDb(":memory:");
    try {
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, music_provider, upscaler_provider, kind, is_builtin, enabled, version, created_at, updated_at, chunker_step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            "mv-test",
            "MV",
            "MV",
            null,
            null,
            null,
            "magnific",
            "magnific",
            "suno",
            null,
            "music_video",
            1,
            1,
            1,
            now,
            now,
            null
          )
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("rebuilds a legacy workflows table to relax script_llm_provider + chunker_step to nullable so the music-video builtin can seed", () => {
    // Forward-only relax via rename-create-copy-drop table rebuild. The
    // legacy table has both columns NOT NULL, which would block the seed
    // INSERT of `music-video-magnific-suno` (script null, chunker null).
    // After createDb, the relaxed shape must hold AND the music-video
    // builtin row must be present.
    const path = tempDbPath();
    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE workflows (
          id                  TEXT PRIMARY KEY,
          label               TEXT NOT NULL,
          short_label         TEXT NOT NULL,
          description         TEXT,
          script_llm_provider TEXT NOT NULL,
          tts_provider        TEXT,
          image_provider      TEXT,
          video_provider      TEXT,
          is_builtin          INTEGER NOT NULL DEFAULT 0,
          enabled             INTEGER NOT NULL DEFAULT 1,
          version             INTEGER NOT NULL DEFAULT 1,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          chunker_step        TEXT NOT NULL DEFAULT 'chunk_clips_then_images'
        );
      `);
      // A representative narrative row that must survive the rebuild.
      raw
        .prepare(
          "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at, chunker_step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "legacy-narr",
          "Legacy narr",
          "Narr",
          null,
          "openrouter",
          "ai33",
          "comfyui",
          "comfyui",
          1,
          1,
          7,
          1234,
          5678,
          "chunk_clips_then_images"
        );
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{ name: string; notnull: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.script_llm_provider.notnull).toBe(0);
      expect(byName.chunker_step.notnull).toBe(0);

      // Legacy row survived with original values + version preserved.
      const legacy = db
        .prepare("SELECT * FROM workflows WHERE id = ?")
        .get("legacy-narr") as {
        script_llm_provider: string;
        chunker_step: string;
        version: number;
        created_at: number;
      };
      expect(legacy.script_llm_provider).toBe("openrouter");
      expect(legacy.chunker_step).toBe("chunk_clips_then_images");
      expect(legacy.version).toBe(7);
      expect(legacy.created_at).toBe(1234);

      // Music-video builtin landed because the rebuilt schema allows null.
      const mv = db
        .prepare("SELECT * FROM workflows WHERE id = ?")
        .get("music-video-magnific-suno") as
        | { kind: string; script_llm_provider: string | null; chunker_step: string | null }
        | undefined;
      expect(mv).toBeDefined();
      expect(mv!.kind).toBe("music_video");
      expect(mv!.script_llm_provider).toBeNull();
      expect(mv!.chunker_step).toBeNull();
    } finally {
      db.close();
    }

    // Second open must not throw — the rebuild detection short-circuits
    // because the relaxed columns now have notnull=0.
    const db2 = createDb(path);
    db2.close();
  });

  it("adds kind + music_provider + upscaler_provider to an existing workflows table that predates them", () => {
    const path = tempDbPath();

    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE workflows (
          id                  TEXT PRIMARY KEY,
          label               TEXT NOT NULL,
          short_label         TEXT NOT NULL,
          description         TEXT,
          script_llm_provider TEXT NOT NULL,
          tts_provider        TEXT,
          image_provider      TEXT,
          video_provider      TEXT,
          is_builtin          INTEGER NOT NULL DEFAULT 0,
          enabled             INTEGER NOT NULL DEFAULT 1,
          version             INTEGER NOT NULL DEFAULT 1,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          chunker_step        TEXT NOT NULL DEFAULT 'chunk_clips_then_images'
        );
      `);
      raw
        .prepare(
          "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at, chunker_step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "legacy-wf",
          "Legacy",
          "L",
          null,
          "openrouter",
          "ai33",
          "comfyui",
          "comfyui",
          1,
          1,
          1,
          1,
          1,
          "chunk_clips_then_images"
        );
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(workflows)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.kind).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'narrative'",
      });
      expect(byName.music_provider).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.upscaler_provider).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const row = db
        .prepare(
          "SELECT kind, music_provider, upscaler_provider FROM workflows WHERE id = ?"
        )
        .get("legacy-wf") as {
        kind: string;
        music_provider: string | null;
        upscaler_provider: string | null;
      };
      expect(row.kind).toBe("narrative");
      expect(row.music_provider).toBeNull();
      expect(row.upscaler_provider).toBeNull();
    } finally {
      db.close();
    }

    // Second open must not throw (duplicate-column narrowly swallowed).
    const db2 = createDb(path);
    db2.close();
  });
});

// ─── Plan 2 Phase 2.1 Task 2: magnific_queue table + Magnific settings ───
// New net-new table for the music-video kind's Magnific (image-hitl +
// image-to-video) queue. Single-account semantics: no assigned_account_id,
// no per-account FK. The `no_timeout` column gates the reaper per
// ADR-0012: image-hitl rows set it to 1 because operator selection can
// legitimately take days; image-to-video rows leave it 0 so a hung
// extension session triggers a normal dispatch-age requeue.

describe("createDb — magnific_queue table", () => {
  it("creates magnific_queue with the expected column shape on greenfield", () => {
    const db = createDb(":memory:");
    try {
      const cols = db
        .prepare("PRAGMA table_info(magnific_queue)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      expect(cols.length).toBeGreaterThan(0);

      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName.id).toMatchObject({ type: "INTEGER", pk: 1 });
      expect(byName.video_id).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.mode).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.prompt).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.reference_image).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.output_path).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.status).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'pending'",
      });
      expect(byName.no_timeout).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      });
      expect(byName.external_task_id).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(byName.result_url).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.error_reason).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.retry_count).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      });
      expect(byName.created_at).toMatchObject({
        type: "INTEGER",
        notnull: 1,
      });
      expect(byName.dispatched_at).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(byName.completed_at).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("creates idx_magnific_queue_pickup on (status, id)", () => {
    const db = createDb(":memory:");
    try {
      const indexes = db
        .prepare("PRAGMA index_list(magnific_queue)")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_magnific_queue_pickup");

      const cols = db
        .prepare("PRAGMA index_info(idx_magnific_queue_pickup)")
        .all() as Array<{ name: string; seqno: number }>;
      const colNames = cols
        .slice()
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name);
      expect(colNames).toEqual(["status", "id"]);
    } finally {
      db.close();
    }
  });

  it("cascades magnific_queue rows when their parent video is deleted", () => {
    const db = createDb(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      seedWorkflowRow(db, "music-video-magnific-suno");
      db.prepare(
        "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("v_mv", "T", "info", "music-video-magnific-suno", "in_progress", 1);
      db.prepare(
        `INSERT INTO magnific_queue
           (video_id, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("v_mv", "image-hitl", "p", "loop_image.png", "pending", 1);

      db.prepare("DELETE FROM videos WHERE id = ?").run("v_mv");

      const remaining = db
        .prepare("SELECT id FROM magnific_queue WHERE video_id = ?")
        .all("v_mv");
      expect(remaining).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("seedDefaultSettings — Magnific keys", () => {
  it("seeds magnific_token (empty default — minted at first Settings open)", () => {
    const db = createDb(":memory:");
    try {
      seedDefaultSettings(db);
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("magnific_token") as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe("");
    } finally {
      db.close();
    }
  });

  it("seeds magnific_dispatch_timeout_minutes default '30'", () => {
    const db = createDb(":memory:");
    try {
      seedDefaultSettings(db);
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("magnific_dispatch_timeout_minutes") as
        | { value: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe("30");
    } finally {
      db.close();
    }
  });

  it("seeds magnific_image_model and magnific_video_model with non-null defaults", () => {
    const db = createDb(":memory:");
    try {
      seedDefaultSettings(db);
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('magnific_image_model', 'magnific_video_model')"
        )
        .all() as Array<{ key: string; value: string }>;
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(byKey.magnific_image_model).toBeDefined();
      expect(byKey.magnific_video_model).toBeDefined();
    } finally {
      db.close();
    }
  });
});

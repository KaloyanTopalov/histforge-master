import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@/lib/db";
import { bootValidate } from "@/worker/boot";

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  openDbs.push(db);
  return db;
}

function tempProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-boot-"));
  tmpDirs.push(dir);
  return dir;
}

const NO_PROJECTS = "/dev/null/no-projects";

afterEach(() => {
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
      // already cleaned
    }
  }
});

describe("bootValidate", () => {
  it("returns without throwing when seeded built-in workflows reference only known steps", () => {
    const db = freshDb();
    expect(() => bootValidate(db, NO_PROJECTS)).not.toThrow();
  });

  it("throws with a clear message when a workflow_steps row references an unknown slug", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("comfyui", 99, "not_a_real_step");

    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/not_a_real_step/);
  });
});

describe("bootValidate — Invariant C point 3 (snapshot-validity)", () => {
  function legacySnapshot(): string {
    // Pre-Phase-5 snapshots emitted `generate_main_images_comfyui` /
    // `_google_flow` slugs via the Invariant A mapping. The mapping is gone;
    // any persisted snapshot still naming those slugs is now structurally
    // invalid. We simulate one by putting the legacy slug in `steps[]` —
    // the materializer pushes script-module step names through unchanged.
    return JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      steps: [{ step_name: "generate_main_images_comfyui" }],
    });
  }

  function insertVideo(
    db: DatabaseType,
    id: string,
    status: string,
    snapshot: string
  ): void {
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "T", "i", "comfyui", snapshot, status, 1);
  }

  it.each(["new", "queued", "in_progress"])(
    "throws when a `%s`-status video's snapshot materializes to an unknown slug",
    (status) => {
      const db = freshDb();
      const id = `v_${status}`;
      insertVideo(db, id, status, legacySnapshot());

      expect(() => bootValidate(db, NO_PROJECTS)).toThrow(new RegExp(id));
      expect(() => bootValidate(db, NO_PROJECTS)).toThrow(
        /generate_main_images_comfyui/
      );
      expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/drain or restart/i);
    }
  );

  it.each(["done", "failed"])(
    "does not throw for a `%s`-status video with a legacy snapshot (terminal status, skipped)",
    (status) => {
      const db = freshDb();
      insertVideo(db, `v_${status}`, status, legacySnapshot());

      expect(() => bootValidate(db, NO_PROJECTS)).not.toThrow();
    }
  );

  it("catches any unknown slug, not just the legacy `_comfyui` / `_google_flow` patterns", () => {
    // The check is a set membership test against REAL_STEPS, not a regex
    // for the legacy pattern. A snapshot with any slug not in REAL_STEPS
    // should fail — guards against future drift where the validator gets
    // pattern-narrowed by mistake.
    const snapshot = JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      steps: [{ step_name: "totally_made_up_step" }],
    });
    const db = freshDb();
    insertVideo(db, "v_made_up", "queued", snapshot);

    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/totally_made_up_step/);
  });
});

describe("bootValidate — on-disk legacy artifacts (Task 11)", () => {
  function freshSnapshot(): string {
    return JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      chunker_step: "chunk_clips_then_images",
      steps: [],
    });
  }

  function insertVideo(
    db: DatabaseType,
    id: string,
    status: string
  ): void {
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "T", "i", "comfyui", freshSnapshot(), status, 1);
  }

  function writeChunksJson(
    projectsDir: string,
    videoId: string,
    chunks: { id: string; kind: string }[]
  ): void {
    const dir = join(projectsDir, videoId, "chunks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks));
  }

  it.each(["hook", "main"])(
    "throws when a non-terminal video's chunks.json contains the legacy `%s` kind",
    (legacyKind) => {
      const db = freshDb();
      const projectsDir = tempProjectsDir();
      insertVideo(db, "v_legacy", "in_progress");
      writeChunksJson(projectsDir, "v_legacy", [
        { id: "x_01", kind: legacyKind },
      ]);

      expect(() => bootValidate(db, projectsDir)).toThrow(/v_legacy/);
      expect(() => bootValidate(db, projectsDir)).toThrow(
        new RegExp(legacyKind)
      );
      expect(() => bootValidate(db, projectsDir)).toThrow(/drain or restart/i);
    }
  );

  it.each(["done", "failed"])(
    "does not throw for a `%s`-status video whose chunks.json has a legacy kind",
    (status) => {
      const db = freshDb();
      const projectsDir = tempProjectsDir();
      insertVideo(db, `v_${status}`, status);
      writeChunksJson(projectsDir, `v_${status}`, [
        { id: "x_01", kind: "hook" },
      ]);

      expect(() => bootValidate(db, projectsDir)).not.toThrow();
    }
  );

  it("does not throw when chunks.json uses the new `clip` / `image` kinds", () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_ok", "in_progress");
    writeChunksJson(projectsDir, "v_ok", [
      { id: "clip_01", kind: "clip" },
      { id: "image_001", kind: "image" },
    ]);

    expect(() => bootValidate(db, projectsDir)).not.toThrow();
  });

  it("throws when a non-terminal video has a legacy `videos/hook/` directory", () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_hookdir", "queued");
    mkdirSync(join(projectsDir, "v_hookdir", "videos", "hook"), {
      recursive: true,
    });

    expect(() => bootValidate(db, projectsDir)).toThrow(/v_hookdir/);
    expect(() => bootValidate(db, projectsDir)).toThrow(/videos\/hook/);
    expect(() => bootValidate(db, projectsDir)).toThrow(/drain or restart/i);
  });

  it("throws when a non-terminal video has a legacy `images/main/` directory", () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_maindir", "new");
    mkdirSync(join(projectsDir, "v_maindir", "images", "main"), {
      recursive: true,
    });

    expect(() => bootValidate(db, projectsDir)).toThrow(/v_maindir/);
    expect(() => bootValidate(db, projectsDir)).toThrow(/images\/main/);
  });

  it.each(["done", "failed"])(
    "does not throw for a `%s`-status video with a legacy directory present",
    (status) => {
      const db = freshDb();
      const projectsDir = tempProjectsDir();
      insertVideo(db, `v_${status}`, status);
      mkdirSync(join(projectsDir, `v_${status}`, "videos", "hook"), {
        recursive: true,
      });

      expect(() => bootValidate(db, projectsDir)).not.toThrow();
    }
  );

  it("does not throw when the per-video project directory doesn't exist yet (new video, pre-pipeline)", () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_unstarted", "queued");
    // No directory created — fresh queued video has no on-disk presence.

    expect(() => bootValidate(db, projectsDir)).not.toThrow();
  });
});

describe("bootValidate — chunker_step ↔ provider consistency (Task 15)", () => {
  it("does not throw for seeded built-in workflows (all consistent)", () => {
    const db = freshDb();
    expect(() => bootValidate(db, NO_PROJECTS)).not.toThrow();
  });

  it("throws when a workflow row has chunk_clips_then_images but no image_provider", () => {
    const db = freshDb();
    // Mutate the seeded comfyui row to violate the consistency rule.
    db.prepare(
      "UPDATE workflows SET image_provider = NULL WHERE id = 'comfyui'"
    ).run();

    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/comfyui/);
    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/image_provider/);
  });

  it("throws when a workflow has chunk_images_only but video_provider is set", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows
         (id, label, short_label, description, script_llm_provider,
          tts_provider, image_provider, video_provider, chunker_step,
          is_builtin, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`
    ).run(
      "img-only-bad",
      "Bad",
      "B",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui", // forbidden — chunk_images_only requires video_provider=null
      "chunk_images_only",
      now,
      now
    );

    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/img-only-bad/);
    expect(() => bootValidate(db, NO_PROJECTS)).toThrow(/video_provider/);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as workflowsRepo from "@/lib/repos/workflows";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  // createDb auto-seeds the two built-in workflow rows with their
  // script-module step lists, so each test starts with a working
  // baseline. Tests that need exotic data INSERT additional rows.
  const db = createDb(":memory:");
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      /* ignore */
    }
  }
});

describe("workflowsRepo.findById", () => {
  it("returns the row for an existing workflow id", () => {
    const db = freshDb();
    const row = workflowsRepo.findById(db, "comfyui");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("comfyui");
    expect(row!.short_label).toBe("ComfyUI");
    expect(row!.script_llm_provider).toBe("openrouter");
    expect(row!.image_provider).toBe("comfyui");
    expect(row!.video_provider).toBe("comfyui");
    expect(row!.is_builtin).toBe(1);
    expect(row!.enabled).toBe(1);
    expect(row!.version).toBe(1);
  });

  it("returns null for an unknown workflow id", () => {
    const db = freshDb();
    expect(workflowsRepo.findById(db, "nope")).toBeNull();
  });
});

describe("workflowsRepo.list", () => {
  it("returns all workflows", () => {
    const db = freshDb();
    const ids = workflowsRepo.list(db).map((w) => w.id).sort();
    expect(ids).toEqual([
      "comfyui",
      "google-flow",
      "google-flow-clips-only",
      "google-flow-images-only",
      "music-video-magnific-suno",
      "narrative-magnific-nano-banana",
      "narrative-magnific-nano-banana-doodle-polished",
      "narrative-magnific-nano-banana-doodle-rough",
    ]);
  });
});

describe("workflowsRepo.findStepsByWorkflow", () => {
  it("returns the step list ordered by position", () => {
    const db = freshDb();
    const steps = workflowsRepo.findStepsByWorkflow(db, "comfyui");
    expect(steps.map((s) => s.step_name)).toEqual([
      "research_outline",
      "write_hook",
      "write_chapters",
    ]);
    expect(steps.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("orders by position even if rows were inserted out of order", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO workflows (id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "wf-mix",
      "Mix",
      "M",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui",
      0,
      1,
      1,
      now,
      now
    );
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("wf-mix", 2, "third");
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("wf-mix", 0, "first");
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("wf-mix", 1, "second");

    const steps = workflowsRepo.findStepsByWorkflow(db, "wf-mix");
    expect(steps.map((s) => s.step_name)).toEqual(["first", "second", "third"]);
  });

  it("returns [] for an unknown workflow id", () => {
    const db = freshDb();
    expect(workflowsRepo.findStepsByWorkflow(db, "nope")).toEqual([]);
  });
});

describe("workflowsRepo.insert", () => {
  it("inserts a row that findById can read back", () => {
    const db = freshDb();
    const now = Date.now();
    workflowsRepo.insert(db, {
      id: "fresh-row",
      label: "Fresh",
      short_label: "F",
      description: null,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      music_provider: null,
      upscaler_provider: null,
      is_builtin: 0,
      enabled: 1,
      version: 1,
      created_at: now,
      updated_at: now,
      chunker_step: "chunk_clips_then_images",
    });
    const row = workflowsRepo.findById(db, "fresh-row");
    expect(row).not.toBeNull();
    expect(row!.label).toBe("Fresh");
    expect(row!.is_builtin).toBe(0);
    expect(row!.version).toBe(1);
  });

  it("replaceSteps deletes existing rows and inserts new ones with 0-based positions", () => {
    const db = freshDb();
    workflowsRepo.replaceSteps(db, "comfyui", [
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ]);
    const steps = workflowsRepo.findStepsByWorkflow(db, "comfyui");
    expect(steps.map((s) => s.step_name)).toEqual([
      "write_hook",
      "write_chapters",
    ]);
    expect(steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it("replaceSteps with empty array clears all steps", () => {
    const db = freshDb();
    workflowsRepo.replaceSteps(db, "comfyui", []);
    expect(workflowsRepo.findStepsByWorkflow(db, "comfyui")).toEqual([]);
  });

  it("update writes provided fields and skips undefined", () => {
    const db = freshDb();
    workflowsRepo.update(db, "comfyui", { label: "Renamed" });
    const row = workflowsRepo.findById(db, "comfyui")!;
    expect(row.label).toBe("Renamed");
    expect(row.short_label).toBe("ComfyUI");
  });

  it("update writes SQL NULL when value is null", () => {
    const db = freshDb();
    workflowsRepo.update(db, "comfyui", { description: null });
    const row = workflowsRepo.findById(db, "comfyui")!;
    expect(row.description).toBeNull();
  });

  it("update writes chunker_step when provided", () => {
    const db = freshDb();
    workflowsRepo.update(db, "comfyui", {
      chunker_step: "chunk_images_only",
    });
    const row = workflowsRepo.findById(db, "comfyui")!;
    expect(row.chunker_step).toBe("chunk_images_only");
  });

  // Plan 1 Phase 1.1 Task 6: insert + update cover the three new
  // workflows columns. Reset-to-default (used on the music-video builtin)
  // exercises null writes to script_llm_provider + chunker_step too.

  it("insert writes kind, music_provider, upscaler_provider", () => {
    const db = freshDb();
    const now = Date.now();
    workflowsRepo.insert(db, {
      id: "mv-row",
      label: "MV",
      short_label: "MV",
      description: null,
      kind: "music_video",
      script_llm_provider: null,
      tts_provider: null,
      image_provider: "magnific",
      video_provider: "magnific",
      music_provider: "suno",
      upscaler_provider: null,
      is_builtin: 0,
      enabled: 1,
      version: 1,
      created_at: now,
      updated_at: now,
      chunker_step: null,
    });
    const row = workflowsRepo.findById(db, "mv-row")!;
    expect(row.kind).toBe("music_video");
    expect(row.music_provider).toBe("suno");
    expect(row.upscaler_provider).toBeNull();
    expect(row.script_llm_provider).toBeNull();
    expect(row.chunker_step).toBeNull();
  });

  it("update writes kind, music_provider, upscaler_provider when provided", () => {
    const db = freshDb();
    workflowsRepo.update(db, "comfyui", {
      music_provider: "suno",
      upscaler_provider: "magnific",
    });
    const row = workflowsRepo.findById(db, "comfyui")!;
    expect(row.music_provider).toBe("suno");
    expect(row.upscaler_provider).toBe("magnific");
  });

  it("update accepts null for script_llm_provider + chunker_step (writes SQL NULL)", () => {
    // The reset-to-default flow on the music-video builtin writes null for
    // both. The repo layer must accept null and translate to SQL NULL.
    const db = freshDb();
    workflowsRepo.update(db, "comfyui", {
      script_llm_provider: null,
      chunker_step: null,
    });
    const row = workflowsRepo.findById(db, "comfyui")!;
    expect(row.script_llm_provider).toBeNull();
    expect(row.chunker_step).toBeNull();
  });

  it("update is a no-op when no fields are provided", () => {
    const db = freshDb();
    const before = workflowsRepo.findById(db, "comfyui")!;
    workflowsRepo.update(db, "comfyui", {});
    const after = workflowsRepo.findById(db, "comfyui")!;
    expect(after.label).toBe(before.label);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("throws on id collision (PK constraint)", () => {
    const db = freshDb();
    const now = Date.now();
    expect(() =>
      workflowsRepo.insert(db, {
        id: "comfyui",
        label: "Dup",
        short_label: "D",
        description: null,
        kind: "narrative",
        script_llm_provider: "openrouter",
        tts_provider: null,
        image_provider: null,
        video_provider: null,
        music_provider: null,
        upscaler_provider: null,
        is_builtin: 0,
        enabled: 1,
        version: 1,
        created_at: now,
        updated_at: now,
        chunker_step: "chunk_clips_then_images",
      })
    ).toThrow();
  });

  it("bumpVersion increments version, stamps updated_at, returns new version", () => {
    const db = freshDb();
    const before = workflowsRepo.findById(db, "comfyui")!;
    const result = workflowsRepo.bumpVersion(db, "comfyui");
    expect(result.version).toBe(before.version + 1);
    const after = workflowsRepo.findById(db, "comfyui")!;
    expect(after.version).toBe(before.version + 1);
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("deleteById removes the row and cascades to workflow_steps", () => {
    const db = freshDb();
    const now = Date.now();
    workflowsRepo.insert(db, {
      id: "to-delete",
      label: "Tmp",
      short_label: "T",
      description: null,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      music_provider: null,
      upscaler_provider: null,
      is_builtin: 0,
      enabled: 1,
      version: 1,
      created_at: now,
      updated_at: now,
      chunker_step: "chunk_clips_then_images",
    });
    workflowsRepo.replaceSteps(db, "to-delete", [
      { step_name: "research_outline" },
    ]);
    const result = workflowsRepo.deleteById(db, "to-delete");
    expect(result.deleted).toBe(true);
    expect(workflowsRepo.findById(db, "to-delete")).toBeNull();
    expect(workflowsRepo.findStepsByWorkflow(db, "to-delete")).toEqual([]);
  });

  it("deleteById returns deleted=false when row is missing", () => {
    const db = freshDb();
    expect(workflowsRepo.deleteById(db, "nope").deleted).toBe(false);
  });

  it("countVideosUsingWorkflow returns the number of videos pinned to the workflow", () => {
    const db = freshDb();
    expect(workflowsRepo.countVideosUsingWorkflow(db, "comfyui")).toBe(0);
    const now = Date.now();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v1", "T", "topic", "comfyui", "new", now);
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v2", "T", "topic", "comfyui", "new", now);
    expect(workflowsRepo.countVideosUsingWorkflow(db, "comfyui")).toBe(2);
    expect(workflowsRepo.countVideosUsingWorkflow(db, "google-flow")).toBe(0);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import {
  getWorkflowFromDb,
  listWorkflows,
  resolveSnapshot,
  computeSnapshot,
  materializeStepList,
} from "@/lib/workflows";
import type { WorkflowSnapshot } from "@/types";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
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

// Built-in step list for the two clips-then-images builtins (comfyui +
// google-flow). Both materialize to the same unified 12-slug list after
// Phase 5 — provider dispatch happens at runtime via ctx.imageProvider /
// ctx.videoProvider, not via slug name.
const BUILTIN_STEPS = [
  "research_outline",
  "write_hook",
  "write_chapters",
  "assemble_script",
  "voiceover",
  "align",
  "chunk_clips_then_images",
  "generate_visual_prompts",
  "generate_images",
  "generate_clips",
  "render",
  "cleanup",
];

// google-flow-images-only: no video_provider, so generate_clips is
// elided; the chunker variant emits only image chunks. 11 slugs.
const IMAGES_ONLY_STEPS = [
  "research_outline",
  "write_hook",
  "write_chapters",
  "assemble_script",
  "voiceover",
  "align",
  "chunk_images_only",
  "generate_visual_prompts",
  "generate_images",
  "render",
  "cleanup",
];

// google-flow-clips-only: no image_provider, so generate_images is
// elided; the chunker variant emits only clip chunks. 11 slugs.
const CLIPS_ONLY_STEPS = [
  "research_outline",
  "write_hook",
  "write_chapters",
  "assemble_script",
  "voiceover",
  "align",
  "chunk_clips_only",
  "generate_visual_prompts",
  "generate_clips",
  "render",
  "cleanup",
];

// Music-video kind: the six-step backbone the materializer emits when
// `snapshot.kind === 'music_video'`. None of the narrative glue (script,
// assemble, align, chunker, visual prompts, narrative render, cleanup)
// applies.
const MUSIC_VIDEO_STEPS = [
  "generate_loop_image",
  "generate_loop_clip",
  "make_thumbnail",
  "generate_music",
  "download_music",
  "render_music_video",
];

describe("getWorkflowFromDb", () => {
  it("returns the seeded built-in workflow row", () => {
    const db = freshDb();
    const row = getWorkflowFromDb(db, "comfyui");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("comfyui");
  });

  it("returns null for an unknown id", () => {
    const db = freshDb();
    expect(getWorkflowFromDb(db, "ghost")).toBeNull();
  });
});

describe("listWorkflows", () => {
  it("returns every workflow row", () => {
    const db = freshDb();
    const ids = listWorkflows(db).map((w) => w.id).sort();
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

describe("resolveSnapshot", () => {
  it("returns the snapshot JSON shape for comfyui", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "comfyui");
    expect(snap).toEqual({
      workflow_id: "comfyui",
      version: 1,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      music_provider: null,
      upscaler_provider: null,
      chunker_step: "chunk_clips_then_images",
      image_style: null,
      steps: [
        { step_name: "research_outline" },
        { step_name: "write_hook" },
        { step_name: "write_chapters" },
      ],
    });
  });

  it("returns the snapshot JSON shape for the music-video builtin (kind, music_provider, null script/tts/chunker)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "music-video-magnific-suno");
    expect(snap).toEqual({
      workflow_id: "music-video-magnific-suno",
      version: 1,
      kind: "music_video",
      script_llm_provider: null,
      tts_provider: null,
      image_provider: "magnific",
      video_provider: "magnific",
      music_provider: "suno",
      upscaler_provider: null,
      chunker_step: null,
      image_style: null,
      steps: [],
    });
  });

  it("throws on an unknown workflow id", () => {
    const db = freshDb();
    expect(() => resolveSnapshot(db, "ghost")).toThrow(/ghost/);
  });

  it("propagates image_style from the workflow row when set (greenfield doodle workflow)", () => {
    const db = freshDb();
    // Seed Task 7 ships two doodle workflows; until then, force the
    // value onto an existing seeded workflow to prove the snapshot
    // builder reads the column. After Task 7 this test can switch to
    // resolveSnapshot("narrative-magnific-nano-banana-doodle-polished").
    db.prepare("UPDATE workflows SET image_style = ? WHERE id = ?")
      .run("doodle_polished", "narrative-magnific-nano-banana");
    const snap = resolveSnapshot(db, "narrative-magnific-nano-banana");
    expect(snap.image_style).toBe("doodle_polished");
  });
});

describe("WorkflowSnapshot — pinning lifecycle backwards-compat (load-bearing)", () => {
  // The snapshot blob is written ONCE to videos.workflow_snapshot at
  // queue time and never mutated afterward. An already-queued video's
  // blob does NOT contain image_style — the column didn't exist when
  // the blob was written. The pinning contract requires that
  // already-queued videos continue to run identically. This test pins
  // the contract: an old blob without image_style parses to a snapshot
  // where image_style is `undefined` (NOT throws, NOT auto-populated).
  // Step 09 then resolves `snapshot.image_style ?? "cinematic"` →
  // "cinematic" → global locks → byte-identical pre-doodle output.
  //
  // If this test ever flips to expect a non-undefined value, an
  // in-place db.ts JSON scrub is required (see chunker_step backfill
  // at db.ts:~1188 for the pattern). Until then the absence is benign.

  it("parses an old pinned blob (no image_style key) without throwing — image_style is undefined", () => {
    const oldBlob = JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      music_provider: null,
      upscaler_provider: null,
      chunker_step: "chunk_clips_then_images",
      steps: [{ step_name: "research_outline" }],
      // image_style intentionally absent — this is the pre-PR shape.
    });
    const parsed = JSON.parse(oldBlob) as WorkflowSnapshot;
    expect(parsed.image_style).toBeUndefined();
    // Confirm the cinematic-fallback resolution that step 09 will run:
    expect(parsed.image_style ?? "cinematic").toBe("cinematic");
  });

  it("a new blob carrying image_style preserves it across JSON.stringify → JSON.parse", () => {
    const db = freshDb();
    db.prepare("UPDATE workflows SET image_style = ? WHERE id = ?")
      .run("doodle_rough", "narrative-magnific-nano-banana");
    const json = computeSnapshot(db, "narrative-magnific-nano-banana");
    const parsed = JSON.parse(json) as WorkflowSnapshot;
    expect(parsed.image_style).toBe("doodle_rough");
  });
});

describe("computeSnapshot", () => {
  it("returns a JSON-serialized snapshot", () => {
    const db = freshDb();
    const json = computeSnapshot(db, "comfyui");
    const parsed = JSON.parse(json) as WorkflowSnapshot;
    expect(parsed.workflow_id).toBe("comfyui");
    expect(parsed.steps.map((s) => s.step_name)).toEqual([
      "research_outline",
      "write_hook",
      "write_chapters",
    ]);
  });
});

describe("materializeStepList — built-in regression target", () => {
  it("comfyui snapshot expands to the unified 12-step list", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "comfyui");
    expect(materializeStepList(snap)).toEqual(BUILTIN_STEPS);
  });

  it("google-flow snapshot expands to the unified 12-step list (same as comfyui)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "google-flow");
    expect(materializeStepList(snap)).toEqual(BUILTIN_STEPS);
  });

  it("google-flow-images-only snapshot expands to the 11-step images-only list (no generate_clips)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "google-flow-images-only");
    expect(materializeStepList(snap)).toEqual(IMAGES_ONLY_STEPS);
  });

  it("google-flow-clips-only snapshot expands to the 11-step clips-only list (no generate_images)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "google-flow-clips-only");
    expect(materializeStepList(snap)).toEqual(CLIPS_ONLY_STEPS);
  });
});

describe("narrative-magnific-nano-banana built-in (S2: enabled)", () => {
  it("resolves with image_provider=magnific, chunk_images_only, no video provider", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "narrative-magnific-nano-banana");
    expect(snap).toEqual({
      workflow_id: "narrative-magnific-nano-banana",
      version: 1,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "magnific",
      video_provider: null,
      music_provider: null,
      upscaler_provider: null,
      chunker_step: "chunk_images_only",
      image_style: null,
      steps: [
        { step_name: "research_outline" },
        { step_name: "write_hook" },
        { step_name: "write_chapters" },
      ],
    });
  });

  it("materializes to the images-only unified step list (unified generate_images, no generate_clips)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "narrative-magnific-nano-banana");
    expect(materializeStepList(snap)).toEqual(IMAGES_ONLY_STEPS);
  });

  it("is seeded enabled=1 (S2 landed the real Magnific provider)", () => {
    const db = freshDb();
    expect(
      getWorkflowFromDb(db, "narrative-magnific-nano-banana")!.enabled
    ).toBe(1);
  });
});

describe("materializeStepList — null providers skip their slot", () => {
  function snapshot(overrides: Partial<WorkflowSnapshot>): WorkflowSnapshot {
    return {
      workflow_id: "test",
      version: 1,
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      music_provider: null,
      upscaler_provider: null,
      chunker_step: "chunk_clips_then_images",
      steps: [{ step_name: "research_outline" }],
      ...overrides,
    };
  }

  it("tts_provider=null skips voiceover", () => {
    const list = materializeStepList(snapshot({ tts_provider: null }));
    expect(list).not.toContain("voiceover");
  });

  it("image_provider=null skips the image module step", () => {
    const list = materializeStepList(snapshot({ image_provider: null }));
    expect(list).not.toContain("generate_images");
  });

  it("video_provider=null skips the video module step", () => {
    const list = materializeStepList(snapshot({ video_provider: null }));
    expect(list).not.toContain("generate_clips");
  });

  it("script steps come first, glue after, in canonical order", () => {
    const snap = snapshot({
      steps: [
        { step_name: "step_a" },
        { step_name: "step_b" },
      ],
    });
    expect(materializeStepList(snap)).toEqual([
      "step_a",
      "step_b",
      "assemble_script",
      "voiceover",
      "align",
      "chunk_clips_then_images",
      "generate_visual_prompts",
      "generate_images",
      "generate_clips",
      "render",
      "cleanup",
    ]);
  });

  it("uses snapshot.chunker_step as the chunker slug (images-only variant)", () => {
    const list = materializeStepList(
      snapshot({ chunker_step: "chunk_images_only" })
    );
    expect(list).toContain("chunk_images_only");
    expect(list).not.toContain("chunk_clips_then_images");
    const alignIdx = list.indexOf("align");
    const promptsIdx = list.indexOf("generate_visual_prompts");
    expect(list[alignIdx + 1]).toBe("chunk_images_only");
    expect(promptsIdx).toBe(alignIdx + 2);
  });

  it("uses snapshot.chunker_step as the chunker slug (clips-only variant)", () => {
    const list = materializeStepList(
      snapshot({ chunker_step: "chunk_clips_only" })
    );
    expect(list).toContain("chunk_clips_only");
    expect(list).not.toContain("chunk_clips_then_images");
  });
});

describe("materializeStepList — kind switch", () => {
  it("emits the six-step music-video backbone for kind='music_video' (seeded builtin)", () => {
    const db = freshDb();
    const snap = resolveSnapshot(db, "music-video-magnific-suno");
    expect(materializeStepList(snap)).toEqual(MUSIC_VIDEO_STEPS);
  });

  it("ignores narrative-glue inputs on a music_video snapshot (no script chain, no chunker, no narrative render)", () => {
    // A music_video snapshot synthesized with leftover narrative fields
    // must NOT pull them into the materialized list — the kind switch
    // short-circuits before the narrative branch runs.
    const snap: WorkflowSnapshot = {
      workflow_id: "synthetic",
      version: 1,
      kind: "music_video",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "magnific",
      video_provider: "magnific",
      music_provider: "suno",
      upscaler_provider: null,
      chunker_step: "chunk_clips_then_images",
      steps: [{ step_name: "research_outline" }],
    };
    expect(materializeStepList(snap)).toEqual(MUSIC_VIDEO_STEPS);
  });
});

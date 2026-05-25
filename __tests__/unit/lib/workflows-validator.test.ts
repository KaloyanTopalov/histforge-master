import { describe, it, expect } from "vitest";
import {
  globMatches,
  validateChunkerStepConsistency,
  validateInputAvailability,
  validateWorkflowConsistency,
} from "@/lib/workflows-validator";
import type { WorkflowSnapshot } from "@/types";

function snapshot(
  overrides: Partial<WorkflowSnapshot> = {}
): WorkflowSnapshot {
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
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
    ...overrides,
  };
}

describe("globMatches", () => {
  it("matches literal == literal", () => {
    expect(globMatches("script/01_outline.md", "script/01_outline.md")).toBe(true);
  });

  it("matches identical globs (provided glob == required glob)", () => {
    expect(globMatches("script/04_chapter_*.md", "script/04_chapter_*.md")).toBe(true);
  });

  it("matches glob-provided against literal-required", () => {
    expect(globMatches("script/04_chapter_*.md", "script/04_chapter_01.md")).toBe(true);
  });

  it("rejects different prefix (anchoring guard)", () => {
    expect(globMatches("script/01_outline.md", "prefix/script/01_outline.md")).toBe(false);
  });

  it("rejects different extension", () => {
    expect(globMatches("script/01_outline.md", "script/01_outline.txt")).toBe(false);
  });

  it("rejects ** patterns with a clear error", () => {
    expect(() => globMatches("**/foo.md", "script/foo.md")).toThrow(/\*\*/);
    expect(() => globMatches("script/foo.md", "**/foo.md")).toThrow(/\*\*/);
  });

  it("does not match across path separators (single * is segment-scoped)", () => {
    expect(globMatches("script/*.md", "script/sub/01.md")).toBe(false);
  });
});

describe("validateInputAvailability — built-in seeded snapshots", () => {
  it("comfyui snapshot is clean", () => {
    const result = validateInputAvailability(snapshot({ image_provider: "comfyui", video_provider: "comfyui" }));
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("google-flow snapshot is clean", () => {
    const result = validateInputAvailability(
      snapshot({ image_provider: "google_flow", video_provider: "google_flow" })
    );
    expect(result).toEqual({ ok: true, warnings: [] });
  });
});

describe("validateInputAvailability — broken snapshots", () => {
  it("empty steps array warns twice on assemble_script (hook + chapters missing)", () => {
    const result = validateInputAvailability(snapshot({ steps: [] }));
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((w) => w.step_name === "assemble_script")).toBe(true);
    const missing = result.warnings.map((w) => w.missing_input).sort();
    expect(missing).toEqual(["script/03_hook.md", "script/04_chapter_*.md"]);
  });
});

describe("validateChunkerStepConsistency — chunk_clips_then_images requires both providers", () => {
  it("is clean when both image_provider and video_provider are set", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_then_images",
        image_provider: "comfyui",
        video_provider: "comfyui",
      })
    );
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("warns when image_provider is null", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_then_images",
        image_provider: null,
        video_provider: "comfyui",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      step_name: "chunk_clips_then_images",
      missing_input: "image_provider",
    });
  });

  it("warns when video_provider is null", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_then_images",
        image_provider: "comfyui",
        video_provider: null,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      step_name: "chunk_clips_then_images",
      missing_input: "video_provider",
    });
  });

  it("warns twice when both providers are null", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_then_images",
        image_provider: null,
        video_provider: null,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });
});

describe("validateChunkerStepConsistency — chunk_images_only requires image_provider only", () => {
  it("is clean when only image_provider is set", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_images_only",
        image_provider: "comfyui",
        video_provider: null,
      })
    );
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("warns when image_provider is missing", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_images_only",
        image_provider: null,
        video_provider: null,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "image_provider")).toBe(true);
  });

  it("warns when video_provider is set (must be null)", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_images_only",
        image_provider: "comfyui",
        video_provider: "comfyui",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      step_name: "chunk_images_only",
      missing_input: "video_provider",
    });
    // Message tells the operator the constraint direction: not "missing", "extra".
    expect(result.warnings[0].message).toMatch(/null|unset|none/i);
  });
});

describe("validateChunkerStepConsistency — chunk_clips_only requires video_provider only", () => {
  it("is clean when only video_provider is set", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_only",
        image_provider: null,
        video_provider: "google_flow",
      })
    );
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("warns when video_provider is missing", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_only",
        image_provider: null,
        video_provider: null,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "video_provider")).toBe(true);
  });

  it("warns when image_provider is set (must be null)", () => {
    const result = validateChunkerStepConsistency(
      snapshot({
        chunker_step: "chunk_clips_only",
        image_provider: "comfyui",
        video_provider: "google_flow",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      step_name: "chunk_clips_only",
      missing_input: "image_provider",
    });
    expect(result.warnings[0].message).toMatch(/null|unset|none/i);
  });
});

// Music-video provider/glue invariants enforced by validateWorkflowConsistency
// (the kind-aware entry point). Each helper produces the seeded
// music-video-magnific-suno provider triple; tests mutate one field at a
// time to verify the validator flags the violation.
function musicVideoSnapshot(
  overrides: Partial<WorkflowSnapshot> = {}
): WorkflowSnapshot {
  return {
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
    steps: [],
    ...overrides,
  };
}

describe("validateWorkflowConsistency — narrative delegates to chunker rule", () => {
  it("is clean for the comfyui narrative builtin shape", () => {
    expect(validateWorkflowConsistency(snapshot())).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("propagates the narrative chunker_step ↔ provider warning", () => {
    const result = validateWorkflowConsistency(
      snapshot({
        chunker_step: "chunk_images_only",
        image_provider: "comfyui",
        video_provider: "comfyui",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      step_name: "chunk_images_only",
      missing_input: "video_provider",
    });
  });
});

describe("validateWorkflowConsistency — music_video provider triple", () => {
  it("is clean for the seeded music-video provider triple", () => {
    expect(validateWorkflowConsistency(musicVideoSnapshot())).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("warns when image_provider is not 'magnific'", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ image_provider: "comfyui" })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "image_provider")).toBe(
      true
    );
  });

  it("warns when video_provider is not 'magnific'", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ video_provider: "google_flow" })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "video_provider")).toBe(
      true
    );
  });

  it("warns when music_provider is not 'suno'", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ music_provider: null })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "music_provider")).toBe(
      true
    );
  });

  it("warns when script_llm_provider is set (must be null)", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ script_llm_provider: "openrouter" })
    );
    expect(result.ok).toBe(false);
    expect(
      result.warnings.some((w) => w.missing_input === "script_llm_provider")
    ).toBe(true);
    expect(result.warnings[0].message).toMatch(/null|unset|none/i);
  });

  it("warns when tts_provider is set (must be null)", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ tts_provider: "ai33" })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "tts_provider")).toBe(
      true
    );
  });

  it("warns when chunker_step is set (must be null)", () => {
    const result = validateWorkflowConsistency(
      musicVideoSnapshot({ chunker_step: "chunk_clips_then_images" })
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.missing_input === "chunker_step")).toBe(
      true
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  WorkflowRowSchema,
  WorkflowPatchSchema,
  WorkflowImportSchema,
} from "@/lib/workflows-schema";

const VALID_ROW = {
  id: "my-workflow",
  label: "My Workflow",
  short_label: "Mine",
  description: "A workflow.",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  image_style: null,
  video_provider: "comfyui",
  steps: [{ step_name: "research_outline" }, { step_name: "write_hook" }],
};

describe("WorkflowRowSchema", () => {
  it("accepts a valid row", () => {
    const result = WorkflowRowSchema.safeParse(VALID_ROW);
    expect(result.success).toBe(true);
  });

  it("rejects non-kebab-case slugs", () => {
    for (const bad of ["MyWorkflow", "my_workflow", "my workflow"]) {
      const result = WorkflowRowSchema.safeParse({ ...VALID_ROW, id: bad });
      expect(result.success).toBe(false);
    }
  });

  it("accepts description as string, null, or absent", () => {
    expect(
      WorkflowRowSchema.safeParse({ ...VALID_ROW, description: "x" }).success
    ).toBe(true);
    expect(
      WorkflowRowSchema.safeParse({ ...VALID_ROW, description: null }).success
    ).toBe(true);
    const { description: _omit, ...withoutDescription } = VALID_ROW;
    expect(WorkflowRowSchema.safeParse(withoutDescription).success).toBe(true);
  });

  it("rejects non-script step names (e.g. tts/glue steps)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_ROW,
      steps: [{ step_name: "voiceover" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown providers", () => {
    expect(
      WorkflowRowSchema.safeParse({
        ...VALID_ROW,
        script_llm_provider: "ollama",
      }).success
    ).toBe(false);
    expect(
      WorkflowRowSchema.safeParse({ ...VALID_ROW, image_provider: "midjourney" })
        .success
    ).toBe(false);
  });

  it("accepts image_provider 'magnific' on a narrative row (narrative-magnific workflow)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_ROW,
      image_provider: "magnific",
    });
    expect(result.success).toBe(true);
  });

  it("accepts every documented tts_provider value (incl. null)", () => {
    for (const v of ["ai33", "genaipro", "chatterbox", null]) {
      const result = WorkflowRowSchema.safeParse({
        ...VALID_ROW,
        tts_provider: v,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown tts_provider", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_ROW,
      tts_provider: "elevenlabs",
    });
    expect(result.success).toBe(false);
  });

  it("accepts each chunker_step slug", () => {
    for (const slug of [
      "chunk_clips_then_images",
      "chunk_images_only",
      "chunk_clips_only",
    ]) {
      const result = WorkflowRowSchema.safeParse({
        ...VALID_ROW,
        chunker_step: slug,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chunker_step).toBe(slug);
      }
    }
  });

  it("defaults chunker_step to chunk_clips_then_images when absent", () => {
    const result = WorkflowRowSchema.safeParse(VALID_ROW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chunker_step).toBe("chunk_clips_then_images");
    }
  });

  it("rejects unknown chunker_step values", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_ROW,
      chunker_step: "chunk_everything",
    });
    expect(result.success).toBe(false);
  });

  it("accepts every documented image_style value (incl. null)", () => {
    for (const v of [
      "cinematic",
      "doodle_polished",
      "doodle_rough",
      null,
    ]) {
      const result = WorkflowRowSchema.safeParse({
        ...VALID_ROW,
        image_style: v,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as { image_style: unknown }).image_style).toBe(v);
      }
    }
  });

  it("accepts a narrative row that omits image_style entirely (legacy AI-skill drafts)", () => {
    // image_style deviates from image_provider's chain by also being
    // `.optional()` — it's an additive field, so pre-PR import payloads
    // and legacy AI-skill drafts (which don't carry the key at all)
    // round-trip cleanly. Undefined and null both mean "no per-workflow
    // style override"; step 09 resolves either to "cinematic" at runtime.
    // If we later enforce explicit-null on imports, this test flips to
    // expect(false) and every legacy fixture grows a "image_style": null.
    const { image_style: _omit, ...withoutImageStyle } = VALID_ROW;
    const result = WorkflowRowSchema.safeParse(withoutImageStyle);
    expect(result.success).toBe(true);
  });

  it("rejects unknown image_style values", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_ROW,
      image_style: "watercolor",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkflowPatchSchema", () => {
  it("requires expected_version", () => {
    const result = WorkflowPatchSchema.safeParse({ label: "New label" });
    expect(result.success).toBe(false);
  });

  it("accepts a partial body with expected_version", () => {
    const result = WorkflowPatchSchema.safeParse({
      label: "New label",
      expected_version: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.label).toBe("New label");
  });

  it("strips unknown id field from body", () => {
    const result = WorkflowPatchSchema.safeParse({
      id: "should-be-stripped",
      label: "x",
      expected_version: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { id?: unknown }).id).toBeUndefined();
    }
  });

  it("accepts an empty body (just expected_version) after image_style added — image_style must NOT be required", () => {
    // Regression anchor for the auto-pickup contract: adding image_style
    // to NarrativeRowSchema must NOT make it required on PATCH. The
    // .partial() on the omit-id-kind base makes every narrative field
    // optional, including the new one. If this flips, every existing
    // PATCH client breaks at once.
    const result = WorkflowPatchSchema.safeParse({ expected_version: 1 });
    expect(result.success).toBe(true);
  });

  it("auto-picks up image_style via .partial() — body with image_style is accepted", () => {
    const result = WorkflowPatchSchema.safeParse({
      expected_version: 1,
      image_style: "doodle_polished",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as { image_style?: string | null }).image_style
      ).toBe("doodle_polished");
    }
  });

  it("rejects PATCH bodies with unknown image_style values", () => {
    const result = WorkflowPatchSchema.safeParse({
      expected_version: 1,
      image_style: "watercolor",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkflowImportSchema", () => {
  it("strips is_builtin from input (server-controlled)", () => {
    const result = WorkflowImportSchema.safeParse({
      ...VALID_ROW,
      is_builtin: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { is_builtin?: unknown }).is_builtin).toBeUndefined();
    }
  });
});

// Music-video kind branch of the discriminated union. The seeded
// music-video-magnific-suno provider triple is the only valid shape;
// narrative-only fields must be null.
const VALID_MUSIC_VIDEO_ROW = {
  id: "music-video-custom",
  label: "Custom music video",
  short_label: "Custom",
  description: "A custom music-video workflow.",
  kind: "music_video",
  script_llm_provider: null,
  tts_provider: null,
  image_provider: "magnific",
  video_provider: "magnific",
  music_provider: "suno",
  upscaler_provider: null,
  chunker_step: null,
  steps: [],
};

describe("WorkflowRowSchema — kind discriminator", () => {
  it("defaults missing kind to 'narrative' (backward compat with pre-kind drafts)", () => {
    const { ...withoutKind } = VALID_ROW;
    const result = WorkflowRowSchema.safeParse(withoutKind);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("narrative");
    }
  });

  it("accepts an explicit kind='narrative' on a narrative payload", () => {
    const result = WorkflowRowSchema.safeParse({ ...VALID_ROW, kind: "narrative" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind value", () => {
    const result = WorkflowRowSchema.safeParse({ ...VALID_ROW, kind: "bogus" });
    expect(result.success).toBe(false);
  });
});

describe("WorkflowRowSchema — music_video branch", () => {
  it("accepts the seeded music-video provider triple", () => {
    const result = WorkflowRowSchema.safeParse(VALID_MUSIC_VIDEO_ROW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("music_video");
      expect(result.data.image_provider).toBe("magnific");
      expect(result.data.video_provider).toBe("magnific");
      expect(result.data.music_provider).toBe("suno");
    }
  });

  it("rejects when image_provider is not 'magnific'", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      image_provider: "comfyui",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when video_provider is not 'magnific'", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      video_provider: "google_flow",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when music_provider is not 'suno'", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      music_provider: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when script_llm_provider is set (must be null)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      script_llm_provider: "openrouter",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when tts_provider is set (must be null)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      tts_provider: "ai33",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when chunker_step is set (must be null)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      chunker_step: "chunk_clips_then_images",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when steps[] is non-empty (music_video has no script steps)", () => {
    const result = WorkflowRowSchema.safeParse({
      ...VALID_MUSIC_VIDEO_ROW,
      steps: [{ step_name: "research_outline" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkflowImportSchema — kind round-trip", () => {
  it("accepts a music_video payload (round-trip parity with export)", () => {
    const result = WorkflowImportSchema.safeParse(VALID_MUSIC_VIDEO_ROW);
    expect(result.success).toBe(true);
  });

  it("accepts a narrative payload with kind omitted (legacy AI-skill drafts)", () => {
    const result = WorkflowImportSchema.safeParse(VALID_ROW);
    expect(result.success).toBe(true);
  });
});

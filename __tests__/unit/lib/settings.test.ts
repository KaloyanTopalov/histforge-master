import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkflowSnapshot } from "@/types";
import { createDb, seedDefaultSettings } from "@/lib/db";
import {
  getAllSettings,
  getDerivedChapterCount,
  getDerivedHookChunkCount,
  getHookClipSeconds,
  getImageChunkPacing,
  ImageChunkPacingInvariantError,
  getSetting,
  setSetting,
} from "@/lib/settings";

// Phase 1 helpers take a snapshot but never read provider-aware fields
// from it. A null-provider stand-in matches the chunker's FALLBACK_SNAPSHOT
// so tests don't have to mint a fresh row each time.
const NULL_SNAPSHOT: WorkflowSnapshot = {
  workflow_id: "",
  version: 0,
  kind: "narrative",
  script_llm_provider: "",
  tts_provider: null,
  image_provider: null,
  video_provider: null,
  music_provider: null,
  upscaler_provider: null,
  chunker_step: "chunk_clips_then_images",
  steps: [],
};

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      // already closed by test
    }
  }
});

describe("getSetting", () => {
  it("coerces every stored value type to its native representation", () => {
    const db = freshDb();

    // string
    expect(getSetting("openrouter_script_model", db)).toBe("");
    expect(typeof getSetting("openrouter_script_model", db)).toBe("string");

    // int
    expect(getSetting("long_edge_px", db)).toBe(1920);
    expect(typeof getSetting("long_edge_px", db)).toBe("number");
    expect(Number.isInteger(getSetting("long_edge_px", db))).toBe(true);

    // float
    expect(getSetting("voice_stability", db)).toBe(0.75);
    expect(typeof getSetting("voice_stability", db)).toBe("number");

    // bool
    expect(getSetting("voice_use_speaker_boost", db)).toBe(true);
    expect(typeof getSetting("voice_use_speaker_boost", db)).toBe("boolean");

    // enum
    expect(getSetting("aspect_ratio", db)).toBe("16:9");
    expect(getSetting("image_provider", db)).toBe("comfyui");

    // string (URLs and paths)
    expect(getSetting("comfyui_base_url", db)).toBe("http://127.0.0.1:8188");
    expect(getSetting("comfyui_workflow_path", db)).toBe(
      "prompts/comfyui/default-workflow.json"
    );
    expect(getSetting("comfyui_hook_video_workflow_path", db)).toBe(
      "prompts/comfyui/default-hook-video-workflow.json"
    );
  });

  it("throws when a stored bool value is not exactly 'true' or 'false'", () => {
    // Defends against silently coercing corrupted DB rows. The previous
    // schema (z.preprocess(v => v === "true")) returned `false` for any
    // garbage input — masking data corruption. Only "true"/"false" are
    // valid string forms.
    const db = freshDb();
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "garbage",
      "voice_use_speaker_boost"
    );
    expect(() => getSetting("voice_use_speaker_boost", db)).toThrow();
  });

  it("throws a clear 'unknown setting key' error for keys not in the schema", () => {
    const db = freshDb();
    // Cast bypasses compile-time safety to test the runtime guard —
    // config typos or dynamic keys shouldn't silently return undefined.
    expect(() => getSetting("not_a_real_key" as never, db)).toThrow(
      /unknown setting key.*not_a_real_key/i
    );
  });

  it("throws unknown-key error even when an unknown row exists in the DB", () => {
    // Without an explicit guard the code crashes inside zod with
    // "Cannot read properties of undefined (reading 'parse')". The guard
    // must fire before the schema lookup, regardless of DB contents.
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "stray_key",
      "anything"
    );
    expect(() => getSetting("stray_key" as never, db)).toThrow(
      /unknown setting key.*stray_key/i
    );
  });
});

describe("setSetting", () => {
  it("round-trips typed values through the database", () => {
    const db = freshDb();

    // int
    setSetting("long_edge_px", 1080, db);
    expect(getSetting("long_edge_px", db)).toBe(1080);

    // float
    setSetting("voice_stability", 0.42, db);
    expect(getSetting("voice_stability", db)).toBe(0.42);

    // framerate (the only valid alternative to 30)
    setSetting("framerate", 60, db);
    expect(getSetting("framerate", db)).toBe(60);

    // bool
    setSetting("voice_use_speaker_boost", false, db);
    expect(getSetting("voice_use_speaker_boost", db)).toBe(false);

    // enum
    setSetting("image_provider", "comfyui", db);
    expect(getSetting("image_provider", db)).toBe("comfyui");

    // string
    setSetting("openrouter_script_model", "openai/gpt-4o", db);
    expect(getSetting("openrouter_script_model", db)).toBe("openai/gpt-4o");
    setSetting("openrouter_visual_model", "openai/gpt-4o-mini", db);
    expect(getSetting("openrouter_visual_model", db)).toBe("openai/gpt-4o-mini");
    setSetting("claude_cli_script_model", "claude-opus-4-7", db);
    expect(getSetting("claude_cli_script_model", db)).toBe("claude-opus-4-7");
    setSetting("claude_cli_visual_model", "claude-haiku-4-5", db);
    expect(getSetting("claude_cli_visual_model", db)).toBe("claude-haiku-4-5");
    setSetting("comfyui_base_url", "http://192.168.1.50:8188", db);
    expect(getSetting("comfyui_base_url", db)).toBe("http://192.168.1.50:8188");
    setSetting("comfyui_workflow_path", "custom/my-workflow.json", db);
    expect(getSetting("comfyui_workflow_path", db)).toBe("custom/my-workflow.json");
  });

  it("rejects values that fail schema validation", () => {
    const db = freshDb();

    // voice_speed is constrained to 0.7..1.2
    expect(() => setSetting("voice_speed", 2.0, db)).toThrow();
    expect(() => setSetting("voice_speed", 0.5, db)).toThrow();

    // chatterbox_speed_factor is constrained to 0.25..4
    expect(() => setSetting("chatterbox_speed_factor", 5.0, db)).toThrow();
    expect(() => setSetting("chatterbox_speed_factor", 0.1, db)).toThrow();

    // voice_stability is 0..1
    expect(() => setSetting("voice_stability", 1.5, db)).toThrow();

    // aspect_ratio is a fixed enum
    expect(() =>
      setSetting("aspect_ratio", "21:9" as never, db)
    ).toThrow();

    // image_provider enum
    expect(() =>
      setSetting("image_provider", "unknown" as never, db)
    ).toThrow();

    // framerate must be exactly 30 or 60 (spec line 222)
    expect(() => setSetting("framerate", 24, db)).toThrow();
    expect(() => setSetting("framerate", 144, db)).toThrow();

    // Rejected writes must NOT have mutated the stored value.
    expect(getSetting("voice_speed", db)).toBe(1.0);
    expect(getSetting("aspect_ratio", db)).toBe("16:9");
    expect(getSetting("image_provider", db)).toBe("comfyui");
  });
});

describe("getAllSettings", () => {
  it("returns every key with its native-typed value", () => {
    const db = freshDb();
    const all = getAllSettings(db);

    expect(all).toEqual({
      openrouter_script_model: "",
      openrouter_visual_model: "",
      claude_cli_script_model: "claude-opus-4-7",
      claude_cli_visual_model: "claude-opus-4-7",
      image_provider: "comfyui",
      comfyui_base_url: "http://127.0.0.1:8188",
      comfyui_workflow_path: "prompts/comfyui/default-workflow.json",
      comfyui_hook_video_workflow_path:
        "prompts/comfyui/default-hook-video-workflow.json",
      google_flow_relogin_needed: false,
      flow_create_project_failed: "",
      flow_service_overload_until: "",
      google_flow_service_overload_cooldown_minutes: 15,
      google_flow_account_cooldown_hours: 4,
      google_flow_max_retries: 3,
      google_flow_image_model: "NARWHAL",
      google_flow_video_model: "veo_3_1_t2v_lite_low_priority",
      google_flow_aspect_ratio: "landscape",
      google_flow_image_aspect_ratio: "16:9",
      google_flow_hook_clip_seconds: "8",
      google_flow_dispatch_timeout_minutes: 30,
      aspect_ratio: "16:9",
      long_edge_px: 1920,
      framerate: 30,
      video_encoder: "libx264",
      hook_video_clip_seconds: 8,
      hook_length_seconds: 120,
      script_length_minutes: 90,
      voice_id: "",
      voiceover_model_id: "eleven_multilingual_v2",
      voice_stability: 0.75,
      voice_similarity: 0.5,
      voice_style: 0.0,
      voice_speed: 1.0,
      voice_use_speaker_boost: true,
      queue_state: "running",
      google_flow_content_moderation_enabled: true,
      google_flow_content_moderation_max_rounds: 2,
      google_flow_content_moderation_model: "",
      chatterbox_base_url: "http://127.0.0.1:8004",
      chatterbox_fast_base_url: "http://127.0.0.1:8005",
      chatterbox_voice_mode: "predefined",
      chatterbox_voice_filename: "",
      chatterbox_temperature: 0.8,
      chatterbox_exaggeration: 0.5,
      chatterbox_cfg_weight: 0.5,
      chatterbox_speed_factor: 1.0,
      chatterbox_fast_max_chunk_chars: 300,
      chatterbox_fast_silence_ms: 150,
      chatterbox_fast_workers: 2,
      visual_prompts_batch_size: 8,
      claude_cli_visual_prompts_concurrency: 2,
      openrouter_visual_prompts_concurrency: 8,
      image_chunk_target_seconds: 8,
      image_chunk_min_seconds: 4,
      image_chunk_max_seconds: 12,
      step_09_examples_json: "",
      magnific_token: "",
      magnific_dispatch_timeout_minutes: 30,
      magnific_image_model: "flux-realism",
      magnific_video_model: "seedance",
      magnific_relogin_needed: false,
      music_video_loop_trim_tail_seconds: 0.3,
      music_video_loop_xfade_seconds: 0.2,
      style_lock_description:
        "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.",
      character_lock_negative:
        "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression",
      magnific_runtime_enabled: false,
      magnific_runtime_user_data_dir: "data/magnific-userdata",
      magnific_runtime_window_visible: false,
      magnific_runtime_extension_path: "extensions/magnific-ext",
      auto_cleanup_after_render: false,
      histforge_base_url: "http://localhost:3000",
    });
  });
});

describe("magnific runtime settings", () => {
  // Foundation-layer keys for the HistForge-managed Playwright Chromium
  // runtime that boots the magnific-ext extension in a persistent context.
  // The runtime itself is a noop in S1 — these keys just configure the
  // future lifecycle: whether to auto-boot, where to persist cookies, and
  // where the extension lives on disk. The window-visible boolean lets the
  // operator flip the off-screen-by-default window into view for debugging.

  it("seeds magnific_runtime_enabled=false as default", () => {
    const db = freshDb();
    expect(getSetting("magnific_runtime_enabled", db)).toBe(false);
    expect(typeof getSetting("magnific_runtime_enabled", db)).toBe("boolean");
  });

  it("seeds magnific_runtime_window_visible=false as default", () => {
    const db = freshDb();
    expect(getSetting("magnific_runtime_window_visible", db)).toBe(false);
    expect(typeof getSetting("magnific_runtime_window_visible", db)).toBe(
      "boolean"
    );
  });

  it("seeds magnific_runtime_user_data_dir='data/magnific-userdata' as default", () => {
    const db = freshDb();
    expect(getSetting("magnific_runtime_user_data_dir", db)).toBe(
      "data/magnific-userdata"
    );
    expect(typeof getSetting("magnific_runtime_user_data_dir", db)).toBe(
      "string"
    );
  });

  it("seeds magnific_runtime_extension_path='extensions/magnific-ext' as default", () => {
    const db = freshDb();
    expect(getSetting("magnific_runtime_extension_path", db)).toBe(
      "extensions/magnific-ext"
    );
    expect(typeof getSetting("magnific_runtime_extension_path", db)).toBe(
      "string"
    );
  });

  it("both bool keys round-trip true/false through setSetting", () => {
    const db = freshDb();
    setSetting("magnific_runtime_enabled", true, db);
    expect(getSetting("magnific_runtime_enabled", db)).toBe(true);
    setSetting("magnific_runtime_enabled", false, db);
    expect(getSetting("magnific_runtime_enabled", db)).toBe(false);
    setSetting("magnific_runtime_window_visible", true, db);
    expect(getSetting("magnific_runtime_window_visible", db)).toBe(true);
  });

  it("both bool keys throw on a corrupted non-'true'/'false' stored value", () => {
    // Same defense as voice_use_speaker_boost: a "garbage" row must surface
    // as a parse error rather than silently coerce to false.
    const db = freshDb();
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "garbage",
      "magnific_runtime_enabled"
    );
    expect(() => getSetting("magnific_runtime_enabled", db)).toThrow();

    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "yes",
      "magnific_runtime_window_visible"
    );
    expect(() => getSetting("magnific_runtime_window_visible", db)).toThrow();
  });

  it("both string keys round-trip arbitrary operator-supplied paths", () => {
    const db = freshDb();
    setSetting(
      "magnific_runtime_user_data_dir",
      "C:/HistForge/magnific-data",
      db
    );
    expect(getSetting("magnific_runtime_user_data_dir", db)).toBe(
      "C:/HistForge/magnific-data"
    );
    setSetting(
      "magnific_runtime_extension_path",
      "custom/magnific-ext-dev",
      db
    );
    expect(getSetting("magnific_runtime_extension_path", db)).toBe(
      "custom/magnific-ext-dev"
    );
  });
});

describe("auto_cleanup_after_render setting", () => {
  // Operator-gated cleanup: step 15 reads this and returns early when
  // false, so a failed image batch leaves intermediates on disk for
  // recovery instead of being silently wiped. Default false intentionally
  // changes the historical "cleanup always runs" behavior — operators who
  // want the old behavior opt in via the Render tab.

  it("seeds auto_cleanup_after_render=false as default (intermediates preserved by default)", () => {
    const db = freshDb();
    expect(getSetting("auto_cleanup_after_render", db)).toBe(false);
    expect(typeof getSetting("auto_cleanup_after_render", db)).toBe("boolean");
  });

  it("round-trips true/false through setSetting", () => {
    const db = freshDb();
    setSetting("auto_cleanup_after_render", true, db);
    expect(getSetting("auto_cleanup_after_render", db)).toBe(true);
    setSetting("auto_cleanup_after_render", false, db);
    expect(getSetting("auto_cleanup_after_render", db)).toBe(false);
  });

  it("throws on a corrupted non-'true'/'false' stored value", () => {
    // Same defense as voice_use_speaker_boost / magnific_runtime_enabled:
    // a "garbage" row must surface as a parse error rather than silently
    // coerce to false (which would re-arm the destructive wipe).
    const db = freshDb();
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "garbage",
      "auto_cleanup_after_render"
    );
    expect(() => getSetting("auto_cleanup_after_render", db)).toThrow();
  });
});

describe("hook chunking settings", () => {
  it("seeds hook_video_clip_seconds=8 and hook_length_seconds=120 as defaults", () => {
    const db = freshDb();
    expect(getSetting("hook_video_clip_seconds", db)).toBe(8);
    expect(typeof getSetting("hook_video_clip_seconds", db)).toBe("number");
    expect(getSetting("hook_length_seconds", db)).toBe(120);
    expect(typeof getSetting("hook_length_seconds", db)).toBe("number");
    expect(Number.isInteger(getSetting("hook_length_seconds", db))).toBe(true);
  });

  it("hook_video_clip_seconds accepts fractional values within 1..60", () => {
    const db = freshDb();
    setSetting("hook_video_clip_seconds", 1, db);
    expect(getSetting("hook_video_clip_seconds", db)).toBe(1);
    setSetting("hook_video_clip_seconds", 60, db);
    expect(getSetting("hook_video_clip_seconds", db)).toBe(60);
    setSetting("hook_video_clip_seconds", 7.5, db);
    expect(getSetting("hook_video_clip_seconds", db)).toBe(7.5);
  });

  it("hook_video_clip_seconds enforces 1..60 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("hook_video_clip_seconds", 0, db)).toThrow();
    expect(() => setSetting("hook_video_clip_seconds", 61, db)).toThrow();
    // prior value preserved
    expect(getSetting("hook_video_clip_seconds", db)).toBe(8);
  });

  it("hook_length_seconds enforces integer 4..400 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("hook_length_seconds", 3, db)).toThrow();
    expect(() => setSetting("hook_length_seconds", 401, db)).toThrow();
    expect(() => setSetting("hook_length_seconds", 120.5, db)).toThrow();
    setSetting("hook_length_seconds", 4, db);
    expect(getSetting("hook_length_seconds", db)).toBe(4);
    setSetting("hook_length_seconds", 400, db);
    expect(getSetting("hook_length_seconds", db)).toBe(400);
  });

  it("hook_chunk_count is no longer a known key (replaced by hook_length_seconds)", () => {
    const db = freshDb();
    expect(() => getSetting("hook_chunk_count" as never, db)).toThrow(
      /unknown setting key/i
    );
  });

  it("getHookClipSeconds reads hook_video_clip_seconds for non-Flow providers", () => {
    // Non-google_flow snapshots (null, "comfyui") read the ComfyUI float —
    // this is the path the chunker takes for ComfyUI workflows and the
    // FALLBACK_SNAPSHOT path for ad-hoc test invocations.
    const db = freshDb();
    setSetting("hook_video_clip_seconds", 8, db);
    expect(getHookClipSeconds(NULL_SNAPSHOT, db)).toBe(8);
    expect(
      getHookClipSeconds({ ...NULL_SNAPSHOT, video_provider: "comfyui" }, db)
    ).toBe(8);
    setSetting("hook_video_clip_seconds", 4, db);
    expect(getHookClipSeconds(NULL_SNAPSHOT, db)).toBe(4);
  });

  it("getHookClipSeconds reads google_flow_hook_clip_seconds (as a number) when video_provider is google_flow", () => {
    // Phase 2 branch: the chunker's per-clip target flips to the Flow enum
    // when the workflow snapshot's video_provider is google_flow. The
    // storage form is the string "4"/"6"/"8"; the helper coerces via
    // Number(...) so callers get the same numeric shape as the ComfyUI
    // path returns.
    const db = freshDb();
    const flowSnap = { ...NULL_SNAPSHOT, video_provider: "google_flow" };

    setSetting("google_flow_hook_clip_seconds", "8", db);
    expect(getHookClipSeconds(flowSnap, db)).toBe(8);

    setSetting("google_flow_hook_clip_seconds", "4", db);
    expect(getHookClipSeconds(flowSnap, db)).toBe(4);

    setSetting("google_flow_hook_clip_seconds", "6", db);
    expect(getHookClipSeconds(flowSnap, db)).toBe(6);

    // Mutating hook_video_clip_seconds doesn't bleed into the Flow path.
    setSetting("hook_video_clip_seconds", 60, db);
    expect(getHookClipSeconds(flowSnap, db)).toBe(6);
  });

  it("getDerivedHookChunkCount uses the provider-resolved clipSeconds", () => {
    // The pair-helper invariant: count and per-chunk target stay in lockstep.
    // With hook_length_seconds=120 and google_flow_hook_clip_seconds="4",
    // count = round(120/4) = 30.
    const db = freshDb();
    setSetting("hook_length_seconds", 120, db);
    setSetting("google_flow_hook_clip_seconds", "4", db);
    setSetting("hook_video_clip_seconds", 8, db);

    const flowSnap = { ...NULL_SNAPSHOT, video_provider: "google_flow" };
    expect(getDerivedHookChunkCount(flowSnap, db)).toBe(30);
    // Same DB, ComfyUI snapshot — uses hook_video_clip_seconds=8 → 15.
    expect(getDerivedHookChunkCount(NULL_SNAPSHOT, db)).toBe(15);
  });

  it("getDerivedHookChunkCount returns Math.round(seconds / clipSeconds)", () => {
    const db = freshDb();
    // Default: 120 / 8 = 15 — preserves the prior hook_chunk_count default
    // (so the post-migration chunk count is unchanged for an unedited DB).
    expect(getDerivedHookChunkCount(NULL_SNAPSHOT, db)).toBe(15);

    // 60 / 8 = 7.5 → rounds to 8 under banker-free Math.round.
    setSetting("hook_length_seconds", 60, db);
    expect(getDerivedHookChunkCount(NULL_SNAPSHOT, db)).toBe(8);

    // Minimum useful count: 4 / 8 = 0.5 → rounds to 1.
    setSetting("hook_length_seconds", 4, db);
    expect(getDerivedHookChunkCount(NULL_SNAPSHOT, db)).toBe(1);

    // Custom clip seconds: 50 / 10 = 5 hook chunks.
    setSetting("hook_length_seconds", 50, db);
    setSetting("hook_video_clip_seconds", 10, db);
    expect(getDerivedHookChunkCount(NULL_SNAPSHOT, db)).toBe(5);
  });
});

describe("script_length_minutes + getDerivedChapterCount", () => {
  it("seeds script_length_minutes=90 by default (= 15 chapters at 6 min each)", () => {
    const db = freshDb();
    expect(getSetting("script_length_minutes", db)).toBe(90);
    expect(typeof getSetting("script_length_minutes", db)).toBe("number");
  });

  it("enforces integer 6..600 bounds (6 = floor of 1 chapter)", () => {
    const db = freshDb();
    expect(() => setSetting("script_length_minutes", 5, db)).toThrow();
    expect(() => setSetting("script_length_minutes", 601, db)).toThrow();
    expect(() => setSetting("script_length_minutes", 30.5, db)).toThrow();
    setSetting("script_length_minutes", 6, db);
    expect(getSetting("script_length_minutes", db)).toBe(6);
    setSetting("script_length_minutes", 600, db);
    expect(getSetting("script_length_minutes", db)).toBe(600);
  });

  it("getDerivedChapterCount returns Math.round(minutes / 6)", () => {
    const db = freshDb();
    setSetting("script_length_minutes", 6, db);
    expect(getDerivedChapterCount(db)).toBe(1);
    setSetting("script_length_minutes", 90, db);
    expect(getDerivedChapterCount(db)).toBe(15);
    setSetting("script_length_minutes", 120, db);
    expect(getDerivedChapterCount(db)).toBe(20);
    // Locks in rounding semantics for unaligned values.
    setSetting("script_length_minutes", 91, db);
    expect(getDerivedChapterCount(db)).toBe(15);
  });
});

describe("tts_provider global setting", () => {
  it("is no longer a known key (moved to workflow snapshot)", () => {
    // tts_provider used to be a global setting; it now lives on the
    // workflow row and is snapshot-pinned per video. Keep this guard so
    // the global doesn't slip back in alongside its workflow-row peer.
    const db = freshDb();
    expect(() => getSetting("tts_provider" as never, db)).toThrow(
      /unknown setting key/i
    );
  });
});

describe("LLM settings restructure (Phase 2)", () => {
  // Legacy single-model keys (`model_name`, `claude_cli_model`) and the
  // global `enrich_chunks_llm_provider` were removed when LLM provider
  // settings split into per-purpose pairs (script + visual) per provider
  // and the script-llm-provider became fully snapshot-pinned. The
  // `claude_cli_path` + `claude_cli_extra_args` knobs were dropped at
  // the same time — the binary is hardcoded to `claude`. Guard against
  // any of them slipping back into the schema.
  const REMOVED_KEYS = [
    "model_name",
    "claude_cli_path",
    "claude_cli_model",
    "claude_cli_extra_args",
    "enrich_chunks_llm_provider",
  ] as const;

  it.each(REMOVED_KEYS)("%s is no longer a known key", (key) => {
    const db = freshDb();
    expect(() => getSetting(key as never, db)).toThrow(/unknown setting key/i);
  });

  it("seeds the four new per-purpose model keys with sensible defaults", () => {
    const db = freshDb();
    expect(getSetting("openrouter_script_model", db)).toBe("");
    expect(getSetting("openrouter_visual_model", db)).toBe("");
    expect(getSetting("claude_cli_script_model", db)).toBe("claude-opus-4-7");
    expect(getSetting("claude_cli_visual_model", db)).toBe("claude-opus-4-7");
  });
});

describe("queue_state setting", () => {
  it("defaults to 'running' after seedDefaultSettings", () => {
    const db = freshDb();
    expect(getSetting("queue_state", db)).toBe("running");
  });

  it("round-trips 'paused' through setSetting", () => {
    const db = freshDb();
    setSetting("queue_state", "paused", db);
    expect(getSetting("queue_state", db)).toBe("paused");
  });

  it("rejects invalid values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("queue_state", "stopped" as never, db)
    ).toThrow();
    // prior value preserved
    expect(getSetting("queue_state", db)).toBe("running");
  });
});

describe("google flow settings", () => {
  it("google_flow_profile_path is no longer a known key", () => {
    const db = freshDb();
    expect(() => getSetting("google_flow_profile_path" as never, db)).toThrow(
      /unknown setting key/i
    );
  });

  it("google_flow_relogin_needed reads as boolean false by default", () => {
    const db = freshDb();
    expect(getSetting("google_flow_relogin_needed", db)).toBe(false);
    expect(typeof getSetting("google_flow_relogin_needed", db)).toBe(
      "boolean"
    );
  });

  it("google_flow_relogin_needed round-trips through setSetting", () => {
    const db = freshDb();
    setSetting("google_flow_relogin_needed", true, db);
    expect(getSetting("google_flow_relogin_needed", db)).toBe(true);
  });

  it("seeds image/video/aspect/dispatch-timeout defaults", () => {
    const db = freshDb();
    expect(getSetting("google_flow_image_model", db)).toBe("NARWHAL");
    expect(getSetting("google_flow_video_model", db)).toBe(
      "veo_3_1_t2v_lite_low_priority"
    );
    expect(getSetting("google_flow_aspect_ratio", db)).toBe("landscape");
    expect(getSetting("google_flow_dispatch_timeout_minutes", db)).toBe(30);
  });

  it("video_model enum rejects unknown values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_video_model", "not_a_real_key" as never, db)
    ).toThrow();
  });

  it("image_model enum rejects values outside the three-model set", () => {
    // image_model used to be free-form text; the new enum locks it down so
    // a typo or stale value can't slip through to the dispatch payload.
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_image_model", "GEM_PIX" as never, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_image_model", "" as never, db)
    ).toThrow();
  });

  it("video_model round-trips every enum value through setSetting", () => {
    const db = freshDb();
    const values = [
      "veo_3_1_t2v_lite",
      "veo_3_1_t2v_fast_ultra",
      "veo_3_1_t2v",
      "veo_3_1_t2v_lite_low_priority",
    ] as const;
    for (const v of values) {
      setSetting("google_flow_video_model", v, db);
      expect(getSetting("google_flow_video_model", db)).toBe(v);
    }
  });

  it("google_flow_video_quality is no longer a known key", () => {
    const db = freshDb();
    expect(() =>
      getSetting("google_flow_video_quality" as never, db)
    ).toThrow(/unknown setting key/i);
  });

  it("aspect_ratio enum rejects unknown values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_aspect_ratio", "square" as never, db)
    ).toThrow();
  });

  it("dispatch_timeout_minutes enforces 5..240 bounds", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_dispatch_timeout_minutes", 4, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_dispatch_timeout_minutes", 241, db)
    ).toThrow();
    setSetting("google_flow_dispatch_timeout_minutes", 60, db);
    expect(getSetting("google_flow_dispatch_timeout_minutes", db)).toBe(60);
  });

  it("google_flow_hook_clip_seconds defaults to '8'", () => {
    const db = freshDb();
    expect(getSetting("google_flow_hook_clip_seconds", db)).toBe("8");
  });

  it("google_flow_hook_clip_seconds round-trips '4', '6', '8' through setSetting", () => {
    const db = freshDb();
    for (const v of ["4", "6", "8"] as const) {
      setSetting("google_flow_hook_clip_seconds", v, db);
      expect(getSetting("google_flow_hook_clip_seconds", db)).toBe(v);
    }
  });

  it("google_flow_hook_clip_seconds rejects values outside the 4/6/8 enum", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_hook_clip_seconds", "5" as never, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_hook_clip_seconds", "10" as never, db)
    ).toThrow();
    // prior value preserved
    expect(getSetting("google_flow_hook_clip_seconds", db)).toBe("8");
  });
});

describe("service_overload settings", () => {
  it("flow_service_overload_until defaults to empty string (banner-flag pattern)", () => {
    const db = freshDb();
    expect(getSetting("flow_service_overload_until", db)).toBe("");
    expect(typeof getSetting("flow_service_overload_until", db)).toBe(
      "string"
    );
  });

  it("flow_service_overload_until round-trips a Unix-seconds string through setSetting", () => {
    const db = freshDb();
    setSetting("flow_service_overload_until", "1747200000", db);
    expect(getSetting("flow_service_overload_until", db)).toBe("1747200000");
  });

  it("google_flow_service_overload_cooldown_minutes defaults to 15", () => {
    const db = freshDb();
    expect(getSetting("google_flow_service_overload_cooldown_minutes", db)).toBe(
      15
    );
    expect(
      typeof getSetting("google_flow_service_overload_cooldown_minutes", db)
    ).toBe("number");
  });

  it("google_flow_service_overload_cooldown_minutes enforces integer 1..60 bounds (>60 crosses into quota territory)", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_service_overload_cooldown_minutes", 0, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_service_overload_cooldown_minutes", 61, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_service_overload_cooldown_minutes", 15.5, db)
    ).toThrow();
    setSetting("google_flow_service_overload_cooldown_minutes", 1, db);
    expect(getSetting("google_flow_service_overload_cooldown_minutes", db)).toBe(
      1
    );
    setSetting("google_flow_service_overload_cooldown_minutes", 60, db);
    expect(getSetting("google_flow_service_overload_cooldown_minutes", db)).toBe(
      60
    );
  });
});

describe("chatterbox settings", () => {
  it("seeds chatterbox_base_url, chatterbox_voice_mode, chatterbox_voice_filename defaults", () => {
    const db = freshDb();
    expect(getSetting("chatterbox_base_url", db)).toBe("http://127.0.0.1:8004");
    expect(getSetting("chatterbox_voice_mode", db)).toBe("predefined");
    expect(getSetting("chatterbox_voice_filename", db)).toBe("");
  });

  it("voice_mode enum rejects unknown values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("chatterbox_voice_mode", "default" as never, db)
    ).toThrow();
  });

  it("voice_mode round-trips both enum values through setSetting", () => {
    const db = freshDb();
    setSetting("chatterbox_voice_mode", "clone", db);
    expect(getSetting("chatterbox_voice_mode", db)).toBe("clone");
    setSetting("chatterbox_voice_mode", "predefined", db);
    expect(getSetting("chatterbox_voice_mode", db)).toBe("predefined");
  });

  it("base_url and voice_filename are free-form strings (round-trip)", () => {
    const db = freshDb();
    setSetting("chatterbox_base_url", "http://192.168.1.50:8004", db);
    expect(getSetting("chatterbox_base_url", db)).toBe(
      "http://192.168.1.50:8004"
    );
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    expect(getSetting("chatterbox_voice_filename", db)).toBe("Abigail.wav");
  });

  it("fast: seeds chatterbox_fast_base_url to http://127.0.0.1:8005 (parallel sidecar)", () => {
    const db = freshDb();
    expect(getSetting("chatterbox_fast_base_url", db)).toBe(
      "http://127.0.0.1:8005"
    );
    expect(typeof getSetting("chatterbox_fast_base_url", db)).toBe("string");
  });

  it("fast: chatterbox_fast_base_url round-trips through setSetting (operator override)", () => {
    const db = freshDb();
    setSetting(
      "chatterbox_fast_base_url",
      "http://192.168.1.50:9005",
      db
    );
    expect(getSetting("chatterbox_fast_base_url", db)).toBe(
      "http://192.168.1.50:9005"
    );
  });

  it("seeds tuning defaults that mirror the wrapper's config.yaml (temperature 0.8, exaggeration 0.5, cfg_weight 0.5)", () => {
    const db = freshDb();
    expect(getSetting("chatterbox_temperature", db)).toBe(0.8);
    expect(getSetting("chatterbox_exaggeration", db)).toBe(0.5);
    expect(getSetting("chatterbox_cfg_weight", db)).toBe(0.5);
    expect(typeof getSetting("chatterbox_temperature", db)).toBe("number");
    expect(typeof getSetting("chatterbox_exaggeration", db)).toBe("number");
    expect(typeof getSetting("chatterbox_cfg_weight", db)).toBe("number");
  });

  it("temperature enforces 0..1.5 bounds (operator-useful subset of the wrapper's API range)", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_temperature", -0.01, db)).toThrow();
    expect(() => setSetting("chatterbox_temperature", 1.51, db)).toThrow();
    setSetting("chatterbox_temperature", 0, db);
    expect(getSetting("chatterbox_temperature", db)).toBe(0);
    setSetting("chatterbox_temperature", 1.5, db);
    expect(getSetting("chatterbox_temperature", db)).toBe(1.5);
    setSetting("chatterbox_temperature", 0.8, db);
    expect(getSetting("chatterbox_temperature", db)).toBe(0.8);
  });

  it("exaggeration enforces 0..2 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_exaggeration", -0.01, db)).toThrow();
    expect(() => setSetting("chatterbox_exaggeration", 2.01, db)).toThrow();
    setSetting("chatterbox_exaggeration", 0, db);
    expect(getSetting("chatterbox_exaggeration", db)).toBe(0);
    setSetting("chatterbox_exaggeration", 2, db);
    expect(getSetting("chatterbox_exaggeration", db)).toBe(2);
  });

  it("cfg_weight enforces 0..2 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_cfg_weight", -0.01, db)).toThrow();
    expect(() => setSetting("chatterbox_cfg_weight", 2.01, db)).toThrow();
    setSetting("chatterbox_cfg_weight", 0, db);
    expect(getSetting("chatterbox_cfg_weight", db)).toBe(0);
    setSetting("chatterbox_cfg_weight", 2, db);
    expect(getSetting("chatterbox_cfg_weight", db)).toBe(2);
  });

  it("fast: seeds parallelism/chunking defaults (max_chunk_chars 300, silence_ms 150, workers 2)", () => {
    const db = freshDb();
    expect(getSetting("chatterbox_fast_max_chunk_chars", db)).toBe(300);
    expect(getSetting("chatterbox_fast_silence_ms", db)).toBe(150);
    expect(getSetting("chatterbox_fast_workers", db)).toBe(2);
    expect(typeof getSetting("chatterbox_fast_max_chunk_chars", db)).toBe(
      "number"
    );
    expect(Number.isInteger(getSetting("chatterbox_fast_max_chunk_chars", db))).toBe(
      true
    );
    expect(typeof getSetting("chatterbox_fast_silence_ms", db)).toBe("number");
    expect(typeof getSetting("chatterbox_fast_workers", db)).toBe("number");
  });

  it("fast: max_chunk_chars enforces 100..2000 integer bounds", () => {
    const db = freshDb();
    expect(() =>
      setSetting("chatterbox_fast_max_chunk_chars", 99, db)
    ).toThrow();
    expect(() =>
      setSetting("chatterbox_fast_max_chunk_chars", 2001, db)
    ).toThrow();
    expect(() =>
      setSetting("chatterbox_fast_max_chunk_chars", 250.5, db)
    ).toThrow();
    setSetting("chatterbox_fast_max_chunk_chars", 100, db);
    expect(getSetting("chatterbox_fast_max_chunk_chars", db)).toBe(100);
    setSetting("chatterbox_fast_max_chunk_chars", 2000, db);
    expect(getSetting("chatterbox_fast_max_chunk_chars", db)).toBe(2000);
  });

  it("fast: silence_ms enforces 0..1000 integer bounds", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_fast_silence_ms", -1, db)).toThrow();
    expect(() =>
      setSetting("chatterbox_fast_silence_ms", 1001, db)
    ).toThrow();
    expect(() =>
      setSetting("chatterbox_fast_silence_ms", 50.5, db)
    ).toThrow();
    setSetting("chatterbox_fast_silence_ms", 0, db);
    expect(getSetting("chatterbox_fast_silence_ms", db)).toBe(0);
    setSetting("chatterbox_fast_silence_ms", 1000, db);
    expect(getSetting("chatterbox_fast_silence_ms", db)).toBe(1000);
  });

  it("fast: workers enforces 1..4 integer bounds (client-side cap on sidecar pool size)", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_fast_workers", 0, db)).toThrow();
    expect(() => setSetting("chatterbox_fast_workers", 5, db)).toThrow();
    expect(() => setSetting("chatterbox_fast_workers", 2.5, db)).toThrow();
    setSetting("chatterbox_fast_workers", 1, db);
    expect(getSetting("chatterbox_fast_workers", db)).toBe(1);
    setSetting("chatterbox_fast_workers", 4, db);
    expect(getSetting("chatterbox_fast_workers", db)).toBe(4);
  });

  it("rejected tuning writes leave the prior value intact", () => {
    const db = freshDb();
    expect(() => setSetting("chatterbox_temperature", 99, db)).toThrow();
    expect(() => setSetting("chatterbox_exaggeration", -1, db)).toThrow();
    expect(() => setSetting("chatterbox_cfg_weight", 5, db)).toThrow();
    expect(getSetting("chatterbox_temperature", db)).toBe(0.8);
    expect(getSetting("chatterbox_exaggeration", db)).toBe(0.5);
    expect(getSetting("chatterbox_cfg_weight", db)).toBe(0.5);
  });
});

describe("visual_prompts settings (batched generate_visual_prompts step)", () => {
  it("seeds batch_size=8, claude_cli_concurrency=2, openrouter_concurrency=8 as defaults", () => {
    const db = freshDb();
    expect(getSetting("visual_prompts_batch_size", db)).toBe(8);
    expect(getSetting("claude_cli_visual_prompts_concurrency", db)).toBe(2);
    expect(getSetting("openrouter_visual_prompts_concurrency", db)).toBe(8);
    expect(typeof getSetting("visual_prompts_batch_size", db)).toBe("number");
    expect(typeof getSetting("claude_cli_visual_prompts_concurrency", db)).toBe(
      "number"
    );
    expect(
      typeof getSetting("openrouter_visual_prompts_concurrency", db)
    ).toBe("number");
  });

  it("batch_size enforces integer 1..16 bounds (K=1 escape hatch up to a 16-chunk batch)", () => {
    const db = freshDb();
    expect(() => setSetting("visual_prompts_batch_size", 0, db)).toThrow();
    expect(() => setSetting("visual_prompts_batch_size", 17, db)).toThrow();
    expect(() => setSetting("visual_prompts_batch_size", 4.5, db)).toThrow();
    setSetting("visual_prompts_batch_size", 1, db);
    expect(getSetting("visual_prompts_batch_size", db)).toBe(1);
    setSetting("visual_prompts_batch_size", 16, db);
    expect(getSetting("visual_prompts_batch_size", db)).toBe(16);
  });

  it("claude_cli_concurrency enforces integer 1..8 bounds (process-spawn-bound)", () => {
    const db = freshDb();
    expect(() =>
      setSetting("claude_cli_visual_prompts_concurrency", 0, db)
    ).toThrow();
    expect(() =>
      setSetting("claude_cli_visual_prompts_concurrency", 9, db)
    ).toThrow();
    expect(() =>
      setSetting("claude_cli_visual_prompts_concurrency", 2.5, db)
    ).toThrow();
    setSetting("claude_cli_visual_prompts_concurrency", 1, db);
    expect(getSetting("claude_cli_visual_prompts_concurrency", db)).toBe(1);
    setSetting("claude_cli_visual_prompts_concurrency", 8, db);
    expect(getSetting("claude_cli_visual_prompts_concurrency", db)).toBe(8);
  });

  it("openrouter_concurrency enforces integer 1..32 bounds (HTTP-bound)", () => {
    const db = freshDb();
    expect(() =>
      setSetting("openrouter_visual_prompts_concurrency", 0, db)
    ).toThrow();
    expect(() =>
      setSetting("openrouter_visual_prompts_concurrency", 33, db)
    ).toThrow();
    expect(() =>
      setSetting("openrouter_visual_prompts_concurrency", 8.5, db)
    ).toThrow();
    setSetting("openrouter_visual_prompts_concurrency", 1, db);
    expect(getSetting("openrouter_visual_prompts_concurrency", db)).toBe(1);
    setSetting("openrouter_visual_prompts_concurrency", 32, db);
    expect(getSetting("openrouter_visual_prompts_concurrency", db)).toBe(32);
  });
});

describe("music_video loop seam mitigation settings", () => {
  it("seeds music_video_loop_trim_tail_seconds=0.3 and music_video_loop_xfade_seconds=0.2 as defaults", () => {
    // Defaults match the prior module-level constants in
    // src/worker/steps/render-music-video.ts so a fresh DB renders the
    // same way the hard-coded constants did.
    const db = freshDb();
    expect(getSetting("music_video_loop_trim_tail_seconds", db)).toBe(0.3);
    expect(typeof getSetting("music_video_loop_trim_tail_seconds", db)).toBe(
      "number"
    );
    expect(getSetting("music_video_loop_xfade_seconds", db)).toBe(0.2);
    expect(typeof getSetting("music_video_loop_xfade_seconds", db)).toBe(
      "number"
    );
  });

  it("trim_tail enforces 0..5 bounds and accepts fractional values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("music_video_loop_trim_tail_seconds", -0.01, db)
    ).toThrow();
    expect(() =>
      setSetting("music_video_loop_trim_tail_seconds", 5.01, db)
    ).toThrow();
    setSetting("music_video_loop_trim_tail_seconds", 0, db);
    expect(getSetting("music_video_loop_trim_tail_seconds", db)).toBe(0);
    setSetting("music_video_loop_trim_tail_seconds", 5, db);
    expect(getSetting("music_video_loop_trim_tail_seconds", db)).toBe(5);
    setSetting("music_video_loop_trim_tail_seconds", 1.25, db);
    expect(getSetting("music_video_loop_trim_tail_seconds", db)).toBe(1.25);
  });

  it("xfade enforces 0..2 bounds and accepts fractional values", () => {
    const db = freshDb();
    expect(() =>
      setSetting("music_video_loop_xfade_seconds", -0.01, db)
    ).toThrow();
    expect(() =>
      setSetting("music_video_loop_xfade_seconds", 2.01, db)
    ).toThrow();
    setSetting("music_video_loop_xfade_seconds", 0, db);
    expect(getSetting("music_video_loop_xfade_seconds", db)).toBe(0);
    setSetting("music_video_loop_xfade_seconds", 2, db);
    expect(getSetting("music_video_loop_xfade_seconds", db)).toBe(2);
    setSetting("music_video_loop_xfade_seconds", 0.5, db);
    expect(getSetting("music_video_loop_xfade_seconds", db)).toBe(0.5);
  });
});

describe("google flow content moderation settings", () => {
  it("seeds enabled=true, max_rounds=2, model='' as defaults", () => {
    const db = freshDb();
    expect(getSetting("google_flow_content_moderation_enabled", db)).toBe(true);
    expect(typeof getSetting("google_flow_content_moderation_enabled", db)).toBe(
      "boolean"
    );

    expect(getSetting("google_flow_content_moderation_max_rounds", db)).toBe(2);
    expect(
      typeof getSetting("google_flow_content_moderation_max_rounds", db)
    ).toBe("number");

    expect(getSetting("google_flow_content_moderation_model", db)).toBe("");
  });

  it("enabled round-trips boolean values through setSetting", () => {
    const db = freshDb();
    setSetting("google_flow_content_moderation_enabled", false, db);
    expect(getSetting("google_flow_content_moderation_enabled", db)).toBe(
      false
    );
    setSetting("google_flow_content_moderation_enabled", true, db);
    expect(getSetting("google_flow_content_moderation_enabled", db)).toBe(true);
  });

  it("max_rounds enforces 0..10 integer bounds", () => {
    const db = freshDb();
    expect(() =>
      setSetting("google_flow_content_moderation_max_rounds", -1, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_content_moderation_max_rounds", 11, db)
    ).toThrow();
    expect(() =>
      setSetting("google_flow_content_moderation_max_rounds", 1.5, db)
    ).toThrow();
    setSetting("google_flow_content_moderation_max_rounds", 0, db);
    expect(getSetting("google_flow_content_moderation_max_rounds", db)).toBe(0);
    setSetting("google_flow_content_moderation_max_rounds", 10, db);
    expect(getSetting("google_flow_content_moderation_max_rounds", db)).toBe(
      10
    );
  });

  it("model is a free-form string (empty = use provider's visual model)", () => {
    const db = freshDb();
    setSetting(
      "google_flow_content_moderation_model",
      "anthropic/claude-opus-4",
      db
    );
    expect(getSetting("google_flow_content_moderation_model", db)).toBe(
      "anthropic/claude-opus-4"
    );
    setSetting("google_flow_content_moderation_model", "", db);
    expect(getSetting("google_flow_content_moderation_model", db)).toBe("");
  });
});

describe("image chunk pacing settings", () => {
  // Per-video pacing override defaults — paired with image_chunk_target_seconds
  // (already seeded). These three plus the existing target seed are the
  // global fallback for chunk_images_only when a video row's per-column
  // override is NULL.

  it("seeds image_chunk_min_seconds=4 and image_chunk_max_seconds=12 as defaults", () => {
    const db = freshDb();
    expect(getSetting("image_chunk_min_seconds", db)).toBe(4);
    expect(typeof getSetting("image_chunk_min_seconds", db)).toBe("number");
    expect(Number.isInteger(getSetting("image_chunk_min_seconds", db))).toBe(
      true
    );
    expect(getSetting("image_chunk_max_seconds", db)).toBe(12);
    expect(typeof getSetting("image_chunk_max_seconds", db)).toBe("number");
    expect(Number.isInteger(getSetting("image_chunk_max_seconds", db))).toBe(
      true
    );
  });

  it("image_chunk_min_seconds enforces integer 2..20 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("image_chunk_min_seconds", 1, db)).toThrow();
    expect(() => setSetting("image_chunk_min_seconds", 21, db)).toThrow();
    expect(() => setSetting("image_chunk_min_seconds", 4.5, db)).toThrow();
    setSetting("image_chunk_min_seconds", 2, db);
    expect(getSetting("image_chunk_min_seconds", db)).toBe(2);
    setSetting("image_chunk_min_seconds", 20, db);
    expect(getSetting("image_chunk_min_seconds", db)).toBe(20);
  });

  it("image_chunk_max_seconds enforces integer 4..60 bounds", () => {
    const db = freshDb();
    expect(() => setSetting("image_chunk_max_seconds", 3, db)).toThrow();
    expect(() => setSetting("image_chunk_max_seconds", 61, db)).toThrow();
    expect(() => setSetting("image_chunk_max_seconds", 8.5, db)).toThrow();
    setSetting("image_chunk_max_seconds", 4, db);
    expect(getSetting("image_chunk_max_seconds", db)).toBe(4);
    setSetting("image_chunk_max_seconds", 60, db);
    expect(getSetting("image_chunk_max_seconds", db)).toBe(60);
  });
});

describe("step_09_examples_json setting", () => {
  // Few-shot example block injected into prompts/09_generate_visual_prompts.md
  // when non-empty. The Zod schema is plain z.string() — JSON validity is
  // checked at the consumer (step 09) rather than at write time so an
  // operator iterating on the JSON can save partial progress without
  // having to hand-validate every keystroke.

  it("seeds step_09_examples_json='' as default", () => {
    const db = freshDb();
    expect(getSetting("step_09_examples_json", db)).toBe("");
    expect(typeof getSetting("step_09_examples_json", db)).toBe("string");
  });

  it("round-trips a JSON-encoded array of exemplar objects", () => {
    const db = freshDb();
    const examples = JSON.stringify([
      { scene: "test", camera: "wide", beat_type: "establishing" },
    ]);
    setSetting("step_09_examples_json", examples, db);
    expect(getSetting("step_09_examples_json", db)).toBe(examples);
  });
});

describe("getImageChunkPacing resolver", () => {
  // Per-video pacing resolver: for each of (target, min, max), the video
  // row's column overrides take precedence; NULL falls through to the
  // global setting. The resolver validates the resolved triple against
  // the invariant min ≤ target ≤ max and throws
  // ImageChunkPacingInvariantError otherwise — chunker entry should fail
  // loudly rather than emit garbage chunks.

  it("falls through to globals when every video column is NULL", () => {
    const db = freshDb();
    expect(
      getImageChunkPacing(
        {
          image_chunk_target_seconds: null,
          image_chunk_min_seconds: null,
          image_chunk_max_seconds: null,
        },
        db
      )
    ).toEqual({ target: 8, min: 4, max: 12 });
  });

  it("returns typed numbers, not strings, from getSetting", () => {
    // Defends against forgetting z.coerce on the new SETTING_SCHEMAS
    // entries — without coerce, getSetting returns the raw string form
    // and the resolver would silently emit string targets.
    const db = freshDb();
    const pacing = getImageChunkPacing(
      {
        image_chunk_target_seconds: null,
        image_chunk_min_seconds: null,
        image_chunk_max_seconds: null,
      },
      db
    );
    expect(typeof pacing.target).toBe("number");
    expect(typeof pacing.min).toBe("number");
    expect(typeof pacing.max).toBe("number");
  });

  it("uses the video column override when non-NULL on every field", () => {
    const db = freshDb();
    expect(
      getImageChunkPacing(
        {
          image_chunk_target_seconds: 5,
          image_chunk_min_seconds: 3,
          image_chunk_max_seconds: 10,
        },
        db
      )
    ).toEqual({ target: 5, min: 3, max: 10 });
  });

  it("mixes column override with global fallthrough per field", () => {
    const db = freshDb();
    expect(
      getImageChunkPacing(
        {
          image_chunk_target_seconds: 5,
          image_chunk_min_seconds: null,
          image_chunk_max_seconds: null,
        },
        db
      )
    ).toEqual({ target: 5, min: 4, max: 12 });
  });

  it("throws ImageChunkPacingInvariantError when resolved min > target", () => {
    const db = freshDb();
    expect(() =>
      getImageChunkPacing(
        {
          image_chunk_target_seconds: 5,
          image_chunk_min_seconds: 10,
          image_chunk_max_seconds: 12,
        },
        db
      )
    ).toThrow(ImageChunkPacingInvariantError);
  });

  it("throws ImageChunkPacingInvariantError when resolved target > max", () => {
    const db = freshDb();
    expect(() =>
      getImageChunkPacing(
        {
          image_chunk_target_seconds: 20,
          image_chunk_min_seconds: 4,
          image_chunk_max_seconds: 12,
        },
        db
      )
    ).toThrow(ImageChunkPacingInvariantError);
  });

  it("error message names every component so the operator can see which knob to adjust", () => {
    const db = freshDb();
    try {
      getImageChunkPacing(
        {
          image_chunk_target_seconds: 5,
          image_chunk_min_seconds: 10,
          image_chunk_max_seconds: 12,
        },
        db
      );
      throw new Error("expected ImageChunkPacingInvariantError");
    } catch (err) {
      expect(err).toBeInstanceOf(ImageChunkPacingInvariantError);
      const msg = (err as Error).message;
      expect(msg).toContain("min=10");
      expect(msg).toContain("target=5");
      expect(msg).toContain("max=12");
    }
  });
});

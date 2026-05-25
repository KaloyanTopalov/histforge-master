import type { SettingKey } from "./settings";

export const TABS = [
  { id: "script", label: "Script" },
  { id: "visual-style", label: "Visual Style" },
  { id: "tts", label: "TTS" },
  { id: "google-flow", label: "Google Flow" },
  { id: "magnific", label: "Magnific" },
  { id: "comfyui", label: "ComfyUI" },
  { id: "render", label: "Render" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

const TAB_IDS = TABS.map((t) => t.id) as readonly TabId[];

export function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

// Each setting key is owned by exactly one tab. Drives which panel a
// field renders into and where the unsaved-change dot appears.
export const TAB_FIELDS: Record<TabId, readonly SettingKey[]> = {
  comfyui: [
    "image_provider",
    "comfyui_base_url",
    "comfyui_workflow_path",
    "comfyui_hook_video_workflow_path",
  ],
  "google-flow": [
    "google_flow_relogin_needed",
    "google_flow_image_model",
    "google_flow_video_model",
    "google_flow_aspect_ratio",
    "google_flow_hook_clip_seconds",
    "google_flow_account_cooldown_hours",
    "google_flow_max_retries",
    "google_flow_dispatch_timeout_minutes",
    "google_flow_content_moderation_enabled",
    "google_flow_content_moderation_max_rounds",
    "google_flow_content_moderation_model",
  ],
  // Per plan §Phase 2.1 Task 9: token + the two model slugs + the
  // dispatch-timeout sit on the Magnific tab. magnific_relogin_needed
  // is intentionally absent — the operator clears it by re-logging-in
  // the magnific.ai tab and the banner stops rendering on the next
  // poll, no settings round-trip needed.
  magnific: [
    "magnific_token",
    "magnific_image_model",
    "magnific_video_model",
    "magnific_dispatch_timeout_minutes",
    "music_video_loop_trim_tail_seconds",
    "music_video_loop_xfade_seconds",
  ],
  // Visual-style settings live in their own `visual_styles` table —
  // the tab renders a master-detail gallery that owns its own REST
  // round-trips and surfaces dirt via the SettingsForm external dirty
  // channel. The two character-lock / style-lock textareas (provider-
  // agnostic; consumed by step 09's prompt-assembly post-processing)
  // are settings-table keys and round-trip through the normal PATCH
  // /api/settings path, so they sit alongside the gallery on this tab.
  "visual-style": ["style_lock_description", "character_lock_negative"],
  tts: [
    "voice_id",
    "voiceover_model_id",
    "voice_stability",
    "voice_similarity",
    "voice_style",
    "voice_speed",
    "voice_use_speaker_boost",
    "chatterbox_base_url",
    "chatterbox_fast_base_url",
    "chatterbox_voice_mode",
    "chatterbox_voice_filename",
    "chatterbox_temperature",
    "chatterbox_exaggeration",
    "chatterbox_cfg_weight",
    "chatterbox_speed_factor",
    "chatterbox_fast_max_chunk_chars",
    "chatterbox_fast_silence_ms",
    "chatterbox_fast_workers",
  ],
  render: [
    "aspect_ratio",
    "long_edge_px",
    "framerate",
    "video_encoder",
  ],
  script: [
    "script_length_minutes",
    "hook_length_seconds",
    "hook_video_clip_seconds",
    "openrouter_script_model",
    "openrouter_visual_model",
    "claude_cli_script_model",
    "claude_cli_visual_model",
  ],
};

import type { SettingKey } from "./settings";

// Source of truth for the allowed values of every Select-rendered
// enum-typed setting key. `lib/settings.ts` references entries of
// `ENUM_VALUES` in its `z.enum(...)` schemas, and the per-tab Settings
// panels render them through `enumOptions(key)` — keeping the rendered
// options and the schema's accepted values in lockstep.
//
// Sibling-module pattern mirrors `lib/settings-tabs.ts`: client-safe (no
// `db` / `node:` imports), only `import type` from `./settings`.

// Single registry that pins the EnumSettingKey union, feeds z.enum in
// `lib/settings.ts`, and feeds enumOptions for the per-tab panels.
// Adding a tenth enum-typed setting only needs: a new entry here plus
// the corresponding schema reference in `lib/settings.ts`.
//
// Not constrained by `satisfies Record<SettingKey, …>` here: `settings.ts`
// consumes `ENUM_VALUES.<key>` to type its schemas, so `SettingKey` ends
// up depending on `ENUM_VALUES`. Forcing the constraint inline would form
// a circular type reference. The `_assertEnumKeysAreSettingKeys` block
// below catches outer-key drift without entering the cycle.
export const ENUM_VALUES = {
  image_provider: ["comfyui"],
  google_flow_image_model: ["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"],
  google_flow_video_model: [
    "veo_3_1_t2v_lite",
    "veo_3_1_t2v_fast_ultra",
    "veo_3_1_t2v",
    "veo_3_1_t2v_lite_low_priority",
  ],
  google_flow_aspect_ratio: ["landscape", "portrait"],
  // Per-clip duration for the Google Flow hook video provider. Storage
  // form is the string `"4"`/`"6"`/`"8"` so the Zod schema can use a
  // simple `z.enum(...)` mirror; the dispatch route uses the storage
  // string verbatim as the lookup key into `VEO_MODEL_BY_SECONDS`, while
  // `getHookClipSeconds` coerces via `Number(...)` for the chunker.
  google_flow_hook_clip_seconds: ["4", "6", "8"],
  voiceover_model_id: [
    "eleven_multilingual_v2",
    "eleven_turbo_v2_5",
    "eleven_flash_v2_5",
    "eleven_v3",
  ],
  aspect_ratio: ["16:9", "9:16", "1:1", "4:5"],
  // Storage form is "30"/"60" (matches the Zod enum); the .transform(Number)
  // in `lib/settings.ts` lifts it to `30 | 60` only on read. The form's
  // onChange casts back via Number(v).
  framerate: ["30", "60"],
  // Stage CD H.264 encoder selection (ADR-0004). Storage values match the
  // ffmpeg encoder names so `getEncoderArgs` in `lib/render.ts` can pass
  // them through directly. The `VideoEncoder` union in `lib/render.ts`
  // is the parallel source of truth for the renderer side — structural
  // alignment between the two is the self-correcting trip wire if a
  // future encoder is added on one side and not the other.
  video_encoder: ["libx264", "h264_nvenc", "h264_amf", "av1_nvenc"],
  chatterbox_voice_mode: ["predefined", "clone"],
} as const;

export type EnumSettingKey = keyof typeof ENUM_VALUES;

// Compile-time guard: every outer key in ENUM_VALUES must be a real
// SettingKey. Catches a typo or stale entry left over after a setting
// is removed from `SETTING_SCHEMAS`.
type _AssertEnumKeysAreSettingKeys = EnumSettingKey extends SettingKey
  ? true
  : never;
const _assertEnumKeysAreSettingKeys: _AssertEnumKeysAreSettingKeys = true;
void _assertEnumKeysAreSettingKeys;

// Operator-friendly labels keyed by enum setting key, then by storage
// value. Only populated for keys whose storage values aren't human-
// readable; other keys fall back to value === label in `enumOptions`.
// The inner key type is the value-union of the corresponding const
// array, so a typo on a storage value (e.g. NARWAL vs NARWHAL) fails
// to compile.
type LabelOverrides = {
  [K in EnumSettingKey]?: Partial<
    Record<(typeof ENUM_VALUES)[K][number], string>
  >;
};

export const SETTING_OPTION_LABELS: LabelOverrides = {
  google_flow_image_model: {
    NARWHAL: "Nano Banana 2",
    GEM_PIX_2: "Nano Banana Pro",
    IMAGEN_3_5: "Imagen 4",
  },
  google_flow_video_model: {
    veo_3_1_t2v_lite: "Veo 3.1 - Lite",
    veo_3_1_t2v_fast_ultra: "Veo 3.1 - Fast",
    veo_3_1_t2v: "Veo 3.1 - Quality",
    veo_3_1_t2v_lite_low_priority: "Veo 3.1 - Lite [Lower Priority]",
  },
  chatterbox_voice_mode: {
    predefined: "Predefined voice",
    clone: "Clone reference",
  },
  video_encoder: {
    libx264: "Software (libx264) (CPU)",
    h264_nvenc: "NVIDIA NVENC (GPU)",
    h264_amf: "AMD AMF (GPU)",
    av1_nvenc: "NVIDIA NVENC AV1 (GPU) (RTX 40-series and newer)",
  },
};

export interface EnumOption {
  readonly value: string;
  readonly label: string;
}

// Returns the {value, label} options for a given enum-typed setting key.
// Label falls back to value when no override is registered. Consumed by
// the SelectField primitive so the rendered options stay in lockstep
// with the Zod schema's accepted values.
export function enumOptions(
  key: EnumSettingKey
): ReadonlyArray<EnumOption> {
  const values = ENUM_VALUES[key];
  const labels = SETTING_OPTION_LABELS[key] as
    | Record<string, string>
    | undefined;
  return values.map((value) => ({
    value,
    label: labels?.[value] ?? value,
  }));
}

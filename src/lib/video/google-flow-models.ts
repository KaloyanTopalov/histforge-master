import type { SettingValue } from "@/lib/settings";

/**
 * Resolve the effective Veo `videoModelKey` for a hook task from the
 * (base model, clip seconds) pair. The dispatch route calls this at claim
 * time so the SW receives the variant model directly — Veo's clip
 * duration is encoded into the model key itself, not a separate field on
 * `video:batchAsyncGenerateVideoText`.
 *
 * Source of truth for the variant strings: `docs/google-flow/clips-
 * length-seconds.md`. The mapping is irregular (base → variant drops
 * `_ultra`, inserts `_quality_`, or splits around `_low_priority`), so a
 * lookup table is the right shape — a suffix concat would silently emit
 * non-existent keys for some bases.
 */

type BaseVideoModel = SettingValue<"google_flow_video_model">;
type ClipSeconds = SettingValue<"google_flow_hook_clip_seconds">;

const VEO_MODEL_BY_SECONDS: Record<
  BaseVideoModel,
  Record<ClipSeconds, string>
> = {
  veo_3_1_t2v_lite: {
    "4": "veo_3_1_t2v_lite_4s",
    "6": "veo_3_1_t2v_lite_6s",
    "8": "veo_3_1_t2v_lite",
  },
  veo_3_1_t2v_fast_ultra: {
    "4": "veo_3_1_t2v_fast_4s",
    "6": "veo_3_1_t2v_fast_6s",
    "8": "veo_3_1_t2v_fast_ultra",
  },
  veo_3_1_t2v: {
    "4": "veo_3_1_t2v_quality_4s",
    "6": "veo_3_1_t2v_quality_6s",
    "8": "veo_3_1_t2v",
  },
  veo_3_1_t2v_lite_low_priority: {
    "4": "veo_3_1_t2v_lite_4s_low_priority",
    "6": "veo_3_1_t2v_lite_6s_low_priority",
    "8": "veo_3_1_t2v_lite_low_priority",
  },
};

export function resolveHookVideoModelKey(
  baseModel: BaseVideoModel,
  clipSeconds: ClipSeconds
): string {
  return VEO_MODEL_BY_SECONDS[baseModel][clipSeconds];
}

/**
 * No-op `PromptModerator` for step tests that exercise `runGoogleFlowStep`
 * without driving the moderation-rewrite loop. After Phase 2 deletes the
 * "missing-deps = moderation off" gate in `google-flow-common.ts`,
 * `GoogleFlowStepDeps.moderator` becomes required — tests that don't care
 * about the rewrite path inject this stub instead of building a real one.
 */
import type { PromptModerator } from "@/lib/moderator";

export const noOpModerator: PromptModerator = {
  moderate: async () => new Map(),
};

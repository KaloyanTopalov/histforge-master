import { step07AudioConcat } from '../steps/07-audio-concat';
import { step08LoopTo2h } from '../steps/08-loop-to-2h';
import { step09MuxVideo } from '../steps/09-mux-video';
import { requireSunoStylePromptSource } from './checks';
import type { PipelineStep } from '../pipeline';
import type { WorkflowDefinition } from './types';

/** Branch B for the ambient pipeline: sequential 07 → 08 → 09. */
const branchBAmbient: PipelineStep = async (album, log) => {
  await step07AudioConcat(album, log);
  await step08LoopTo2h(album, log);
  await step09MuxVideo(album, log);
};

export const ambientWorkflow: WorkflowDefinition = {
  name: 'ambient',
  defaultTracksPerAlbum: 30,
  branchB: branchBAmbient,
  // v7: at least one source for the suno style prompt is required (either an
  // active row in channel_suno_prompts OR the legacy channel.suno_style_prompt
  // column). Step 01's LLM no longer generates sunoStylePrompt; step 03 picks
  // from the channel collection at submit time.
  preflightChecks: [requireSunoStylePromptSource],
  // Nothing is structurally required as a separate API-surface field.
  requiredChannelFields: [],
};

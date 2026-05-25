// YouForge Flow - text-to-video executor
// Thin config over runVideoGeneration (src/executors/shared.js). Picks
// the text-to-video endpoint and t2v model key, then delegates the body
// wrapping, pageCall, polling, and upscale to the shared helper. Used
// for `text` mode and as the fallback for any unrecognised mode or an
// image/ingredients/frames task that arrived without images (compound
// missing-images guard lives in src/executors/index.js).
//
// Runtime deps (resolved at call time): safeLog, AISANDBOX_BASE,
// runVideoGeneration (src/executors/shared.js).

async function runTextToVideo(task, ctx) {
  const t2vModelKey = ctx.modelKeys.t2v;
  safeLog('Text-to-video mode, model:', t2vModelKey);
  return await runVideoGeneration(task, ctx, {
    endpoint: `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoText`,
    videoModelKey: t2vModelKey,
    perRequestExtras: {},
    mode: (task.mode || 'text').toLowerCase() || 'text',
  });
}

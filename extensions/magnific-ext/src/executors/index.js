// Magnific HITL - executor dispatcher
// Splits the per-task work into a mode-keyed registry. Adding a new
// mode means adding an entry to EXECUTORS — the dispatcher stays
// mode-agnostic.
//
// Runtime deps (resolved at call time): runImageHitl
// (src/executors/image-hitl.js), runImageToVideo
// (src/executors/image-to-video.js), runImageBatch
// (src/executors/image-batch.js), safeLog (src/logger.js).

const EXECUTORS = {
  'image-hitl': { run: (task) => runImageHitl(task) },
  'image-to-video': { run: (task) => runImageToVideo(task) },
  'image-batch': { run: (task) => runImageBatch(task) },
};

async function executeTaskViaExtension(task) {
  const mode = task && typeof task.mode === 'string' ? task.mode : '';
  const entry = EXECUTORS[mode];
  if (!entry) {
    safeLog(`[executors] Unknown mode: ${mode} — task ${task && task.id} not dispatched`);
    return { unknownMode: true, mode };
  }
  safeLog(`[executors] Dispatching task ${task.id} mode=${mode}`);
  return entry.run(task);
}

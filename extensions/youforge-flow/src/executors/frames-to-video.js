// YouForge Flow - frames-to-video executor
// Handles `frames` mode. Uploads a start frame (required) and optionally
// an end frame, then picks the right Flow endpoint based on (a) whether
// an end frame is present and (b) whether the account is on VEO Lite:
//   - start + end            → StartAndEndImage + i2v_fl model
//   - start-only, Lite       → StartImage + i2v model
//   - start-only, non-Lite   → ReferenceImages + r2v model
// Delegates body wrapping, pageCall, polling, and upscale to
// runVideoGeneration (src/executors/shared.js).
//
// Runtime deps (resolved at call time): safeLog, AISANDBOX_BASE,
// runVideoGeneration (src/executors/shared.js).

async function runFramesToVideo(task, ctx) {
  const { modelKeys, uploadImage } = ctx;
  const log = ctx.log || { safeLog };

  const startFrameUrl = task.startFrame || task['Start Frame'];
  const endFrameUrl = task.endFrame || task['End Frame'];
  log.safeLog('Frames task - start:', startFrameUrl?.substring(0, 80), 'end:', endFrameUrl?.substring(0, 80));

  let startImageId = null;
  let endImageId = null;
  if (startFrameUrl && startFrameUrl.trim()) {
    try { startImageId = await uploadImage(startFrameUrl, 'start_frame.png'); }
    catch (e) { log.safeLog('Start frame upload failed:', e.message); }
  }
  if (endFrameUrl && endFrameUrl.trim()) {
    try { endImageId = await uploadImage(endFrameUrl, 'end_frame.png'); }
    catch (e) { log.safeLog('End frame upload failed:', e.message); }
  }

  const hasEndFrame = !!endImageId;
  let endpoint;
  let videoModelKey;
  let perRequestExtras;
  if (hasEndFrame) {
    endpoint = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoStartAndEndImage`;
    videoModelKey = modelKeys.i2v_fl;
    perRequestExtras = {
      startImage: {
        mediaId: startImageId,
        cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
      },
      endImage: { mediaId: endImageId },
    };
  } else if (modelKeys.isLite) {
    log.safeLog('VEO Lite frames, using StartImage endpoint');
    endpoint = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoStartImage`;
    videoModelKey = modelKeys.i2v;
    perRequestExtras = {
      startImage: {
        mediaId: startImageId,
        cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
      },
    };
  } else {
    log.safeLog('Only start frame, using ReferenceImages endpoint');
    endpoint = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoReferenceImages`;
    videoModelKey = modelKeys.r2v;
    perRequestExtras = {
      referenceImages: [{ mediaId: startImageId, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }],
    };
  }
  log.safeLog('Frames-to-video, start:', startImageId, 'end:', endImageId, 'model:', videoModelKey);

  return await runVideoGeneration(task, ctx, {
    endpoint,
    videoModelKey,
    perRequestExtras,
    mode: (task.mode || 'frames').toLowerCase(),
  });
}

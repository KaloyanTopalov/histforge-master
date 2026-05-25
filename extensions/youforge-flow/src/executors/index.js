// YouForge Flow - executor dispatcher
// Splits the per-task setup (token fetching, storage reads, account-tier
// detection, ctx assembly) from the mode-routing decision. The prelude
// lives in buildExecutorContext; executeTaskViaAPI looks up a mode in
// the EXECUTORS registry and invokes the matched executor.
//
// EXECUTORS entry shape: { run, recaptchaAction, isImageGen? }. Adding
// a new Flow mode means adding an entry here — the dispatcher stays
// mode-agnostic. `isImageGen: true` opts an entry out of the
// missing-images guard (image-gen modes don't require task images).
//
// Dispatch rules (preserve historical behaviour):
//   1. Unknown-mode fallback: EXECUTORS[taskMode] lookup. If missing,
//      log "Unknown mode: <taskMode> - falling back to text-to-video"
//      and use EXECUTORS.text.
//   2. Build ctx using the chosen entry's recaptchaAction.
//   3. No-images fallback (non-image-gen entries only): if the task has
//      no referenceImage / startFrame / 'Start Frame' / 'Image URL',
//      log "No images on non-image-gen task, routing to text-to-video"
//      and re-route to EXECUTORS.text.
//   4. Invoke entry.run(task, ctx).
//
// The two fallbacks remain distinct: unknown-mode is applied before ctx
// is built; no-images is a separate guard applied afterwards only when
// the matched entry isn't an image-gen executor.
//
// Runtime deps (resolved at call time): getRecaptchaTokenFromPage /
// getSessionTokenFromPage (src/auth.js), getOrCreateProjectId
// (src/project-mgmt.js — per-(video, account) project mapping; see
// docs/plans/2026-04-25-per-video-flow-projects.md),
// detectAccountTier / getVideoModelKeys (src/account-tier.js),
// apiCallViaPage / uploadImageViaPage (src/page-call.js),
// pollVideoUntilDone (src/poll-video.js), runImageGen / runTextToVideo /
// runImageToVideo / runFramesToVideo (sibling executor files),
// getOutputCount / getAspectRatio / getImageModel / getVideoModel /
// getImgUpscale / getVidUpscale / getCharacterLockReference
// (src/settings.js), safeLog,
// assertNotStopped.

async function buildExecutorContext(task, tabId, recaptchaAction, correlationId) {
  const taskId = task.id;

  const recaptchaToken = await getRecaptchaTokenFromPage(tabId, recaptchaAction);
  if (!recaptchaToken) {
    throw new Error('Failed to get reCAPTCHA token - is labs.google/fx open?');
  }

  const authToken = await getSessionTokenFromPage(tabId);
  if (!authToken) {
    throw new Error('Failed to get session/bearer token');
  }

  const projectId = await getOrCreateProjectId(task, { tabId });
  if (!projectId) {
    throw new Error('Failed to get project ID');
  }

  const sessionId = ';' + Date.now();

  const settings = {
    outputCount: getOutputCount(),
    aspectRatioSetting: getAspectRatio(),
    imageModelSetting: getImageModel(),
    videoModelQuality: getVideoModel(),
    imgUpscale: getImgUpscale(),
    vidUpscale: getVidUpscale(),
    characterLockReference: getCharacterLockReference(),
  };

  if (settings.imgUpscale !== 'none' || settings.vidUpscale !== 'none') {
    safeLog(`[api] Upscale: img=${settings.imgUpscale}, vid=${settings.vidUpscale}`);
  }


  const accountTier = await detectAccountTier(tabId);
  const modelKeys = getVideoModelKeys(accountTier, settings.videoModelQuality, settings.aspectRatioSetting);
  // Per-task logger — tags every line with [cid=<8>] so a single task's
  // logs survive a grep against the service-worker console. Executors
  // and shared helpers prefer ctx.log over the global safeLog.
  const log = forTask(correlationId);
  log.safeLog(`[api] Account: ${accountTier}, quality: ${settings.videoModelQuality}, paygate: ${modelKeys.paygateTier}`);

  // Per-task perf trace populated by sibling helpers (runVideoGeneration
  // sets submitMs/pollMs/upscaleMs; uploadImage wrapper pushes uploadMs;
  // poll-video bumps pollCount; handlers stamps fetchMediaMs). Mirrors
  // flow2api's perf_trace at flow_client.py:537-567.
  const timings = {
    submitMs: 0,
    uploadMs: [],
    pollCount: 0,
    pollMs: 0,
    upscaleMs: 0,
    fetchMediaMs: 0,
  };

  const pageCall = (url, body) => apiCallViaPage({ tabId, authToken, url, body });
  const uploadImage = async (imageUrl, filename) => {
    const start = Date.now();
    try {
      return await uploadImageViaPage({ tabId, authToken, projectId, imageUrl, filename });
    } finally {
      timings.uploadMs.push(Date.now() - start);
    }
  };
  const getRecaptcha = (action) => getRecaptchaTokenFromPage(tabId, action);
  const pollVideo = (at, mediaIds, tid) => pollVideoUntilDone(at, mediaIds, tid, tabId, timings, correlationId);

  return {
    tabId,
    authToken,
    projectId,
    sessionId,
    recaptchaToken,
    modelKeys,
    settings,
    pageCall,
    uploadImage,
    getRecaptcha,
    pollVideo,
    taskId,
    correlationId: correlationId || null,
    timings,
    log,
  };
}

const EXECUTORS = {
  createimage: { run: runImageGen, recaptchaAction: 'IMAGE_GENERATION', isImageGen: true },
  imagegen: { run: runImageGen, recaptchaAction: 'IMAGE_GENERATION', isImageGen: true },
  text: { run: runTextToVideo, recaptchaAction: 'VIDEO_GENERATION' },
  image: { run: runImageToVideo, recaptchaAction: 'VIDEO_GENERATION' },
  ingredients: { run: runImageToVideo, recaptchaAction: 'VIDEO_GENERATION' },
  frames: { run: runFramesToVideo, recaptchaAction: 'VIDEO_GENERATION' },
};

async function executeTaskViaAPI(task, tabId, correlationId) {
  assertNotStopped();
  const taskMode = (task.mode || '').toLowerCase();
  safeLog('Executing task via API:', task.id, 'mode:', taskMode);

  let entry = EXECUTORS[taskMode];
  if (!entry) {
    safeLog('Unknown mode:', taskMode, '- falling back to text-to-video');
    entry = EXECUTORS.text;
  }

  const ctx = await buildExecutorContext(task, tabId, entry.recaptchaAction, correlationId);

  // Log the in-use model under its Settings > Google Flow display name so
  // the service-worker console matches what operators see in the
  // dashboard. For video tasks, prefer the server-provided task.videoModel
  // (the dashboard's google_flow_video_model selection); fall back to the
  // resolved t2v key when the task didn't carry one. Image-to-video and
  // frames-to-video submit a sub-variant key (i2v/r2v/i2v_fl), but the
  // family the user picked is what t2v reflects, so that's what we name.
  if (entry.isImageGen) {
    const imageModelKey = task.imageModel || ctx.settings.imageModelSetting;
    ctx.log.safeLog(`[api] Image model: ${imageModelDisplay(imageModelKey)}`);
  } else {
    const videoModelKey = task.videoModel || ctx.modelKeys.t2v;
    ctx.log.safeLog(`[api] Video model: ${videoModelDisplay(videoModelKey)}`);
  }

  if (!entry.isImageGen) {
    const hasImages =
      !!task.referenceImage ||
      !!task.startFrame ||
      !!task['Start Frame'] ||
      !!task['Image URL'];
    if (!hasImages) {
      safeLog('No images on non-image-gen task, routing to text-to-video');
      entry = EXECUTORS.text;
    }
  }

  const result = await entry.run(task, ctx);
  // Stitch perf trace + cid onto the result so handlers/webhook see the
  // per-attempt timings without each executor having to remember.
  return {
    ...result,
    correlationId: ctx.correlationId,
    timings: ctx.timings,
  };
}

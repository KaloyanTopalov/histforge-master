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
// getSessionTokenFromPage / getProjectIdCached (src/auth.js),
// detectAccountTier / getVideoModelKeys (src/account-tier.js),
// apiCallViaPage / uploadImageViaPage (src/page-call.js),
// pollVideoUntilDone (src/poll-video.js), runImageGen / runTextToVideo /
// runImageToVideo / runFramesToVideo (sibling executor files),
// getOutputCount / getAspectRatio / getImageModel / getVideoModel /
// getImgUpscale / getVidUpscale (src/settings.js), safeLog,
// assertNotStopped.

async function buildExecutorContext(task, tabId, recaptchaAction) {
  const taskId = task.id;

  const recaptchaToken = await getRecaptchaTokenFromPage(tabId, recaptchaAction);
  if (!recaptchaToken) {
    throw new Error('Failed to get reCAPTCHA token - is labs.google/fx open?');
  }

  const authToken = await getSessionTokenFromPage(tabId);
  if (!authToken) {
    throw new Error('Failed to get session/bearer token');
  }

  const projectId = await getProjectIdCached(tabId);
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
  };

  if (settings.imgUpscale !== 'none' || settings.vidUpscale !== 'none') {
    safeLog(`[api] Upscale: img=${settings.imgUpscale}, vid=${settings.vidUpscale}`);
  }

  const accountTier = await detectAccountTier(tabId);
  const modelKeys = getVideoModelKeys(accountTier, settings.videoModelQuality, settings.aspectRatioSetting);
  safeLog(`[api] Account: ${accountTier}, quality: ${settings.videoModelQuality}, paygate: ${modelKeys.paygateTier}`);

  const pageCall = (url, body) => apiCallViaPage({ tabId, authToken, url, body });
  const uploadImage = (imageUrl, filename) =>
    uploadImageViaPage({ tabId, authToken, projectId, imageUrl, filename });
  const getRecaptcha = (action) => getRecaptchaTokenFromPage(tabId, action);
  const pollVideo = (at, mediaIds, tid) => pollVideoUntilDone(at, mediaIds, tid, tabId);

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

async function executeTaskViaAPI(task, tabId) {
  assertNotStopped();
  const taskMode = (task.mode || '').toLowerCase();
  safeLog('Executing task via API:', task.id, 'mode:', taskMode);

  let entry = EXECUTORS[taskMode];
  if (!entry) {
    safeLog('Unknown mode:', taskMode, '- falling back to text-to-video');
    entry = EXECUTORS.text;
  }

  const ctx = await buildExecutorContext(task, tabId, entry.recaptchaAction);

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

  return await entry.run(task, ctx);
}

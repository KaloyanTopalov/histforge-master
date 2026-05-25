// YouForge Flow - cross-executor helpers
// Utilities reused by the per-mode executors (text-to-video,
// image-to-video, frames-to-video, image). Kept as plain top-level
// functions in a classic service-worker script.
//
// Exposes:
//   - toMediaIds            : normalises async-API `media` → pollable ids
//   - runVideoGeneration    : full video pipeline (resolve startResult →
//                             poll (with NOT_FOUND-retry) → upscale)
//                             driven by a per-executor config; the three
//                             video executors call this and only supply
//                             the parts that differ. Resolves
//                             startResult by either resuming a stored
//                             Google operation (task.googleOperationId,
//                             persisted by HistForge on a prior dispatch)
//                             or by submitting fresh via
//                             submitFreshOperation.
//   - submitFreshOperation  : body-build → pageCall → persist op via
//                             postOperationStarted (one-shot). Internal
//                             helper for runVideoGeneration's
//                             fresh-submit + NOT_FOUND-retry paths.
//   - pollAndCheck          : polls one set of mediaIds, records
//                             timings.pollMs, throws when the poll
//                             returns no resolvable URLs.
//   - upscaleImages         : in-place image-URL upgrade via upsampleImage
//   - upscaleVideos         : in-place video-URL upgrade via upsampler;
//                             calls runner.markVideoSlotFreedForUpscale()
//                             once so the runner can fill the freed video
//                             slot while upscale runs
//
// Runtime deps (resolved at call time): buildClientContext
// (src/client-context.js), upscaleWithFallback (src/executors/upscale.js),
// markVideoSlotFreedForUpscale (src/runner.js), safeLog (src/logger.js),
// AISANDBOX_BASE (flow-api.js).

// Normalises an async API response's `media` array into the
// `[{ name, projectId }]` shape that pollVideoUntilDone and the
// video-upscale loop consume.
function toMediaIds(result, projectId) {
  return (result?.media || []).map((m) => ({ name: m.name, projectId }));
}

// Runs a full video-generation lifecycle: build request body, call Flow,
// poll for completion, and upscale if configured. The three video
// executors (text-to-video, image-to-video, frames-to-video) are each a
// thin config over this helper — caller supplies the parts that differ
// (endpoint, videoModelKey, per-request extras, mode label), helper owns
// the scaffolding shared by all three. Mirrors the design of
// upscaleWithFallback in src/executors/upscale.js.
//
// config:
//   endpoint           absolute URL for pageCall
//   videoModelKey      model key for the single request entry
//   perRequestExtras   object spread into requests[0] (e.g. startImage,
//                      referenceImages); {} for text-only
//   mode               lowercased mode string returned to the caller
async function runVideoGeneration(task, ctx, config) {
  const log = ctx.log || { safeLog };
  const taskId = task.id;

  // Resolve startResult by either resuming a stored operation (HistForge
  // persisted it on a prior dispatch — post-submit, pre-success) or by
  // submitting fresh.
  let startResult;
  if (task.googleOperationId) {
    const opProjectId = task.googleOperationProjectId || ctx.projectId;
    // raw = {} on resume means upscaleVideos can't recover workflowId
    // from raw.workflows[0].name; the upscale falls back to '' and may
    // fail server-side. Acceptable degraded state — the original
    // (non-upscaled) videoUrl is still returned.
    startResult = {
      mediaIds: [{ name: task.googleOperationId, projectId: opProjectId }],
      raw: {},
    };
    log.safeLog('Resuming poll for stored operation:', task.googleOperationId);
  } else {
    startResult = await submitFreshOperation(task, ctx, config);
  }

  // Poll; on NOT_FOUND from a resumed op, clear the in-memory id (so we
  // don't re-enter the resume branch) and retry once via fresh submit.
  // Any other error propagates.
  let videoUrls;
  try {
    videoUrls = await pollAndCheck(startResult.mediaIds, taskId, ctx);
  } catch (e) {
    if (e && e.category === 'not_found' && task.googleOperationId) {
      log.safeLog('Stored operation NOT_FOUND, falling back to fresh submit:', task.googleOperationId);
      task.googleOperationId = null;
      startResult = await submitFreshOperation(task, ctx, config);
      videoUrls = await pollAndCheck(startResult.mediaIds, taskId, ctx);
    } else {
      throw e;
    }
  }
  log.safeLog('Video generation complete:', videoUrls.length, 'videos');

  const upscaleStart = Date.now();
  await upscaleVideos(videoUrls, startResult, ctx);
  if (ctx.timings) ctx.timings.upscaleMs = Date.now() - upscaleStart;

  return { taskId, resultUrl: videoUrls.join(','), mode: config.mode };
}

// Builds the request body, posts to Flow, persists the resulting Google
// operation on HistForge, and returns the startResult (mediaIds + raw)
// shape that pollAndCheck and upscaleVideos consume.
async function submitFreshOperation(task, ctx, config) {
  const {
    projectId, sessionId, recaptchaToken, modelKeys, settings, pageCall,
  } = ctx;
  const log = ctx.log || { safeLog };
  const videoAspect = settings.aspectRatioSetting === 'portrait'
    ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
    : 'VIDEO_ASPECT_RATIO_LANDSCAPE';

  const body = {
    mediaGenerationContext: { batchId: crypto.randomUUID() },
    clientContext: buildClientContext({
      projectId, recaptchaToken, sessionId, paygateTier: modelKeys.paygateTier,
    }),
    requests: [{
      aspectRatio: videoAspect,
      seed: Math.floor(Math.random() * 100000),
      textInput: { structuredPrompt: { parts: [{ text: task.prompt }] } },
      videoModelKey: config.videoModelKey,
      metadata: {},
      ...config.perRequestExtras,
    }],
    useV2ModelConfig: true,
  };

  const submitStart = Date.now();
  const result = await pageCall(config.endpoint, body);
  if (ctx.timings) ctx.timings.submitMs = Date.now() - submitStart;
  const startResult = { mediaIds: toMediaIds(result, projectId), raw: result };
  if (!startResult.mediaIds.length) {
    throw new Error('Video generation returned no media IDs. Raw: ' + JSON.stringify(startResult.raw)?.substring(0, 300));
  }

  // Persist the op on HistForge before polling so a poll-side failure
  // (e.g. anti-abuse 403) doesn't lose the reference — the next dispatch
  // can resume instead of submitting a duplicate. Fire-and-forget;
  // postOperationStarted already swallows its own errors, the .catch is
  // defense against future shape changes.
  postOperationStarted({
    taskId: task.id,
    operationName: startResult.mediaIds[0].name,
    projectId,
  }).catch(() => {});

  log.safeLog('Video started, mediaIds:', startResult.mediaIds.map((m) => m.name));
  log.safeLog('Polling for video completion...');
  return startResult;
}

// Polls one set of mediaIds, records pollMs, and throws when the poll
// finishes with no resolvable URLs. Used by both the fresh-submit and
// resume paths in runVideoGeneration.
async function pollAndCheck(mediaIds, taskId, ctx) {
  const pollStart = Date.now();
  const videoUrls = await ctx.pollVideo(ctx.authToken, mediaIds, taskId);
  if (ctx.timings) ctx.timings.pollMs = Date.now() - pollStart;
  if (videoUrls.length === 0) {
    throw new Error('Video generation failed - no results after polling');
  }
  return videoUrls;
}

// Replaces entries in `urls` with their upscaled equivalents. Mutates in
// place. `result.media[i]` corresponds to `urls[i]` by fifeUrl match, not
// index — the image API may reorder. `ctx.settings.imgUpscale` controls
// resolution; 'none' short-circuits without any network activity.
async function upscaleImages(urls, result, ctx) {
  const { pageCall, getRecaptcha, projectId, sessionId, modelKeys, settings } = ctx;
  const log = ctx.log || { safeLog };
  const imgUpscale = settings?.imgUpscale || 'none';
  if (imgUpscale === 'none') return;
  if (!result?.media?.length) return;

  let resolution = imgUpscale === '4k'
    ? 'UPSAMPLE_IMAGE_RESOLUTION_4K'
    : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
  log.safeLog(`[upscale] Upscaling ${result.media.length} image(s) to ${imgUpscale}`);

  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let mi = 0; mi < result.media.length; mi++) {
    const media = result.media[mi];
    const mediaId = media.name;
    if (!mediaId) { log.safeLog('Image upscale skipped - no mediaId'); continue; }
    const upscaled = await upscaleWithFallback({
      attempt: async () => {
        const upscaleRecaptcha = await getRecaptcha('IMAGE_GENERATION');
        const upscaleBody = {
          mediaId,
          targetResolution: resolution,
          clientContext: buildClientContext({
            projectId,
            recaptchaToken: upscaleRecaptcha,
            sessionId,
            paygateTier: modelKeys?.paygateTier,
          }),
        };
        const upscaleResult = await pageCall(`${AISANDBOX_BASE}/flow/upsampleImage`, upscaleBody);
        if (upscaleResult?.error) {
          throw new Error(typeof upscaleResult.error === 'string'
            ? upscaleResult.error
            : JSON.stringify(upscaleResult.error).substring(0, 200));
        }
        const upscaledUrl = upscaleResult?.media?.image?.generatedImage?.fifeUrl;
        const encodedImage = upscaleResult?.encodedImage;
        if (upscaledUrl) {
          const originalUrl = media.image?.generatedImage?.fifeUrl;
          const idx = urls.indexOf(originalUrl);
          if (idx >= 0) urls[idx] = upscaledUrl;
          log.safeLog('Image upscaled via URL');
          return true;
        }
        if (encodedImage) {
          const dataUrl = 'data:image/jpeg;base64,' + encodedImage;
          const originalUrl = media.image?.generatedImage?.fifeUrl;
          const idx = urls.indexOf(originalUrl);
          if (idx >= 0) urls[idx] = dataUrl;
          log.safeLog(`[upscale] Image upscaled via encodedImage (${(encodedImage.length / 1024).toFixed(0)}KB)`);
          return true;
        }
        log.safeLog('Image upscale - no URL or encodedImage in response');
        return false;
      },
      on403Fallback: () => {
        if (resolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K') {
          log.safeLog('4K denied - falling back to 2K');
          resolution = 'UPSAMPLE_IMAGE_RESOLUTION_2K';
          return true;
        }
        return false;
      },
      baseMs: 3000,
      logLabel: 'Image',
      log: log.safeLog,
      sleep,
    });
    if (!upscaled) {
      log.safeLog('Image upscale failed after 3 attempts - sending original resolution');
    }
  }
}

// Replaces entries in `videoUrls` with upscaled video URLs. Mutates in
// place. Calls `markVideoSlotFreedForUpscale()` on the runner once before
// the first attempt so the runner can free a video slot for the next
// generation while upscale runs.
async function upscaleVideos(videoUrls, startResult, ctx) {
  const {
    pageCall, pollVideo, getRecaptcha, authToken, projectId, sessionId, taskId,
    modelKeys, settings,
  } = ctx;
  const log = ctx.log || { safeLog };
  const vidUpscale = settings?.vidUpscale || 'none';
  if (vidUpscale === 'none') return;
  if (!startResult?.mediaIds?.length) return;

  const videoAspect = settings?.aspectRatioSetting === 'portrait'
    ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
    : 'VIDEO_ASPECT_RATIO_LANDSCAPE';

  let resolution = vidUpscale === '4k' ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
  let upscaleModel = vidUpscale === '4k' ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
  log.safeLog(`[upscale] Upscaling ${startResult.mediaIds.length} video(s) to ${vidUpscale}`);

  markVideoSlotFreedForUpscale();

  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let vi = 0; vi < startResult.mediaIds.length; vi++) {
    const media = startResult.mediaIds[vi];
    const upscaled = await upscaleWithFallback({
      attempt: async () => {
        const upscaleRecaptcha = await getRecaptcha('VIDEO_GENERATION');
        const workflowId = startResult.raw?.workflows?.[0]?.name || '';
        const upBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID() },
          clientContext: buildClientContext({
            projectId, recaptchaToken: upscaleRecaptcha, sessionId,
            paygateTier: modelKeys?.paygateTier,
          }),
          requests: [{
            resolution, aspectRatio: videoAspect,
            seed: Math.floor(Math.random() * 100000),
            videoModelKey: upscaleModel,
            metadata: { workflowId },
            videoInput: { mediaId: media.name },
          }],
          useV2ModelConfig: true,
        };
        const upResult = await pageCall(
          `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoUpsampleVideo`,
          upBody,
        );
        if (upResult?.error) {
          throw new Error(typeof upResult.error === 'string'
            ? upResult.error
            : JSON.stringify(upResult.error).substring(0, 200));
        }
        const upMediaIds = (upResult.media || []).map((m) => ({ name: m.name, projectId }));
        if (upMediaIds.length === 0) return false;
        const upUrls = await pollVideo(authToken, upMediaIds, (taskId || '') + '_upscale');
        if (upUrls.length === 0) return false;
        videoUrls.splice(0, videoUrls.length, ...upUrls);
        log.safeLog(`[upscale] Video upscaled to ${vidUpscale}`);
        return true;
      },
      on403Fallback: () => {
        if (resolution === 'VIDEO_RESOLUTION_4K') {
          log.safeLog('4K denied - falling back to 1080p');
          resolution = 'VIDEO_RESOLUTION_1080P';
          upscaleModel = 'veo_3_1_upsampler_1080p';
          return true;
        }
        return false;
      },
      baseMs: 5000,
      logLabel: 'Video',
      log: log.safeLog,
      sleep,
    });
    if (!upscaled) {
      log.safeLog('Video upscale failed after 3 attempts - sending original resolution');
    }
  }
}

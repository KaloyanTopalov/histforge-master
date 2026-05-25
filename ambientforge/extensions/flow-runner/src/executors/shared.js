// YouForge Flow - cross-executor helpers
// Utilities reused by the per-mode executors (text-to-video,
// image-to-video, frames-to-video, image). Kept as plain top-level
// functions in a classic service-worker script.
//
// Exposes:
//   - toMediaIds            : normalises async-API `media` → pollable ids
//   - runVideoGeneration    : full video pipeline (body → pageCall →
//                             poll → upscale) driven by a per-executor
//                             config; the three video executors call
//                             this and only supply the parts that differ
//   - upscaleImages         : in-place image-URL upgrade via upsampleImage
//   - upscaleVideos         : in-place video-URL upgrade via upsampler;
//                             calls runner.markSlotFreedForUpscale() once
//                             so the runner can fill the freed slot while
//                             upscale runs
//
// Runtime deps (resolved at call time): buildClientContext
// (src/client-context.js), upscaleWithFallback (src/executors/upscale.js),
// markSlotFreedForUpscale (src/runner.js), safeLog (src/logger.js),
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
  const {
    projectId, sessionId, recaptchaToken, modelKeys, settings,
    pageCall, pollVideo, authToken,
  } = ctx;
  const taskId = task.id;
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

  const result = await pageCall(config.endpoint, body);
  const startResult = { mediaIds: toMediaIds(result, projectId), raw: result };
  if (!startResult.mediaIds.length) {
    throw new Error('Video generation returned no media IDs. Raw: ' + JSON.stringify(startResult.raw)?.substring(0, 300));
  }

  safeLog('Video started, mediaIds:', startResult.mediaIds.map((m) => m.name));
  safeLog('Polling for video completion...');
  const videoUrls = await pollVideo(authToken, startResult.mediaIds, taskId);
  if (videoUrls.length === 0) {
    throw new Error('Video generation failed - no results after polling');
  }
  safeLog('Video generation complete:', videoUrls.length, 'videos');

  await upscaleVideos(videoUrls, startResult, ctx);

  return {
    taskId,
    resultUrl: videoUrls.join(','),
    mode: config.mode,
  };
}

// Replaces entries in `urls` with their upscaled equivalents. Mutates in
// place. `result.media[i]` corresponds to `urls[i]` by fifeUrl match, not
// index — the image API may reorder. `ctx.settings.imgUpscale` controls
// resolution; 'none' short-circuits without any network activity.
async function upscaleImages(urls, result, ctx) {
  const { pageCall, getRecaptcha, projectId, sessionId, modelKeys, settings } = ctx;
  const imgUpscale = settings?.imgUpscale || 'none';
  if (imgUpscale === 'none') return;
  if (!result?.media?.length) return;

  let resolution = imgUpscale === '4k'
    ? 'UPSAMPLE_IMAGE_RESOLUTION_4K'
    : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
  safeLog(`[upscale] Upscaling ${result.media.length} image(s) to ${imgUpscale}`);

  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let mi = 0; mi < result.media.length; mi++) {
    const media = result.media[mi];
    const mediaId = media.name;
    if (!mediaId) { safeLog('Image upscale skipped - no mediaId'); continue; }
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
          safeLog('Image upscaled via URL');
          return true;
        }
        if (encodedImage) {
          const dataUrl = 'data:image/jpeg;base64,' + encodedImage;
          const originalUrl = media.image?.generatedImage?.fifeUrl;
          const idx = urls.indexOf(originalUrl);
          if (idx >= 0) urls[idx] = dataUrl;
          safeLog(`[upscale] Image upscaled via encodedImage (${(encodedImage.length / 1024).toFixed(0)}KB)`);
          return true;
        }
        safeLog('Image upscale - no URL or encodedImage in response');
        return false;
      },
      on403Fallback: () => {
        if (resolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K') {
          safeLog('4K denied - falling back to 2K');
          resolution = 'UPSAMPLE_IMAGE_RESOLUTION_2K';
          return true;
        }
        return false;
      },
      delayMs: 3000,
      logLabel: 'Image',
      log: safeLog,
      sleep,
    });
    if (!upscaled) {
      safeLog('Image upscale failed after 3 attempts - sending original resolution');
    }
  }
}

// Replaces entries in `videoUrls` with upscaled video URLs. Mutates in
// place. Calls `markSlotFreedForUpscale()` on the runner once before the
// first attempt so the runner can free a slot for the next generation
// while upscale runs.
async function upscaleVideos(videoUrls, startResult, ctx) {
  const {
    pageCall, pollVideo, getRecaptcha, authToken, projectId, sessionId, taskId,
    modelKeys, settings,
  } = ctx;
  const vidUpscale = settings?.vidUpscale || 'none';
  if (vidUpscale === 'none') return;
  if (!startResult?.mediaIds?.length) return;

  const videoAspect = settings?.aspectRatioSetting === 'portrait'
    ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
    : 'VIDEO_ASPECT_RATIO_LANDSCAPE';

  let resolution = vidUpscale === '4k' ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
  let upscaleModel = vidUpscale === '4k' ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
  safeLog(`[upscale] Upscaling ${startResult.mediaIds.length} video(s) to ${vidUpscale}`);

  markSlotFreedForUpscale();

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
        safeLog(`[upscale] Video upscaled to ${vidUpscale}`);
        return true;
      },
      on403Fallback: () => {
        if (resolution === 'VIDEO_RESOLUTION_4K') {
          safeLog('4K denied - falling back to 1080p');
          resolution = 'VIDEO_RESOLUTION_1080P';
          upscaleModel = 'veo_3_1_upsampler_1080p';
          return true;
        }
        return false;
      },
      delayMs: 5000,
      logLabel: 'Video',
      log: safeLog,
      sleep,
    });
    if (!upscaled) {
      safeLog('Video upscale failed after 3 attempts - sending original resolution');
    }
  }
}

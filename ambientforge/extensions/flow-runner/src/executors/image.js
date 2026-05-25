// YouForge Flow - image generation executor
// Handles `createimage` / `imagegen` modes. Uploads any reference images
// (comma-separated list supported), then calls flowMedia:batchGenerateImages
// with N request entries (settings.outputCount). After generation, runs
// optional upscaling per settings.imgUpscale.
//
// Runtime deps (resolved at call time): buildClientContext, safeLog,
// crypto.randomUUID, AISANDBOX_BASE, upscaleImages (src/executors/shared.js).

async function runImageGen(task, ctx) {
  const { projectId, sessionId, recaptchaToken, settings, pageCall, uploadImage } = ctx;
  const taskId = task.id;
  const prompt = task.imagePrompt || task.prompt;
  // AmbientForge patch: honor per-task aspect ratio when present, fall back
  // to popup setting otherwise. AmbientForge needs square 1:1 covers and
  // 16:9 thumbnails; YouForge's popup-only setting is too coarse.
  const taskAspect = (task.aspectRatio || '').toLowerCase();
  let imageAspect;
  if (taskAspect === '1:1' || taskAspect === 'square') {
    imageAspect = 'IMAGE_ASPECT_RATIO_SQUARE';
  } else if (taskAspect === '9:16' || taskAspect === 'portrait') {
    imageAspect = 'IMAGE_ASPECT_RATIO_PORTRAIT';
  } else if (taskAspect === '16:9' || taskAspect === 'landscape') {
    imageAspect = 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  } else {
    imageAspect = settings.aspectRatioSetting === 'portrait'
      ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
      : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  }
  const modelName = settings.imageModelSetting;
  const outputCount = settings.outputCount || 1;

  const referenceImageIds = [];
  const refUrl = task.imagegenReference || task.referenceImage;
  if (refUrl && refUrl.trim()) {
    const refUrls = refUrl.split(',').map((u) => u.trim()).filter((u) => u);
    safeLog('Uploading', refUrls.length, 'reference image(s)...');
    for (let i = 0; i < refUrls.length; i++) {
      try {
        const mediaId = await uploadImage(refUrls[i], `reference_${i + 1}.png`);
        if (mediaId) referenceImageIds.push(mediaId);
      } catch (e) {
        safeLog(`[api] Reference image ${i + 1} upload failed:`, e.message);
      }
    }
    safeLog('Uploaded', referenceImageIds.length, 'reference images');
  }

  safeLog('Generating image:', prompt?.substring(0, 80));

  const batchId = crypto.randomUUID();
  const imageInputs = referenceImageIds.map((id) => ({
    imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: id,
  }));
  const imgRequests = [];
  for (let i = 0; i < outputCount; i++) {
    imgRequests.push({
      clientContext: buildClientContext({ projectId, recaptchaToken, sessionId }),
      imageModelName: modelName,
      imageAspectRatio: imageAspect,
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: Math.floor(Math.random() * 100000),
      imageInputs,
    });
  }
  const imgBody = {
    clientContext: buildClientContext({ projectId, recaptchaToken, sessionId }),
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests: imgRequests,
  };

  const result = await pageCall(
    `${AISANDBOX_BASE}/projects/${projectId}/flowMedia:batchGenerateImages`,
    imgBody,
  );

  const urls = (result.media || [])
    .map((m) => m.image?.generatedImage?.fifeUrl)
    .filter((u) => u);

  if (urls.length === 0) {
    throw new Error('Image generation returned no results. Raw: ' + JSON.stringify(result).substring(0, 300));
  }
  safeLog('Image generation complete:', urls.length, 'images');

  await upscaleImages(urls, result, ctx);

  return {
    taskId,
    resultUrl: urls.join(','),
    mode: 'createImage',
    isGeneratedImage: true,
  };
}

// YouForge Flow - image generation executor
// Handles `createimage` / `imagegen` modes. Uploads any task-supplied
// reference images (comma-separated list supported), then calls
// flowMedia:batchGenerateImages with N request entries
// (settings.outputCount). After generation, runs optional upscaling per
// settings.imgUpscale.
//
// Character lock: when settings.characterLockReference is a valid Flow
// media ID UUID, it is prepended to imageInputs as the first
// IMAGE_INPUT_TYPE_REFERENCE — no upload step, the ID is used verbatim.
// Malformed lock values throw BadCharacterLockError before any Flow API
// call; the popup validates on save, this is a defensive belt for
// corrupt-storage / direct-write paths.
//
// Runtime deps (resolved at call time): buildClientContext, safeLog,
// crypto.randomUUID, AISANDBOX_BASE, upscaleImages (src/executors/shared.js),
// makeBadCharacterLockError (src/flow-error.js).

const CHARACTER_LOCK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function runImageGen(task, ctx) {
  const { projectId, sessionId, recaptchaToken, settings, pageCall, uploadImage } = ctx;
  const log = ctx.log || { safeLog };
  const taskId = task.id;
  const prompt = task.imagePrompt || task.prompt;
  const imageAspect = settings.aspectRatioSetting === 'portrait'
    ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
    : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  const modelName = task.imageModel || settings.imageModelSetting;
  const modelSource = task.imageModel ? 'task' : 'settings';
  const outputCount = settings.outputCount || 1;

  const characterLockReference = (settings.characterLockReference || '').trim();
  if (characterLockReference && !CHARACTER_LOCK_UUID_RE.test(characterLockReference)) {
    throw makeBadCharacterLockError(characterLockReference);
  }

  const referenceImageIds = [];
  const refUrl = task.imagegenReference || task.referenceImage;
  if (refUrl && refUrl.trim()) {
    const refUrls = refUrl.split(',').map((u) => u.trim()).filter((u) => u);
    log.safeLog('Uploading', refUrls.length, 'reference image(s)...');
    for (let i = 0; i < refUrls.length; i++) {
      try {
        const mediaId = await uploadImage(refUrls[i], `reference_${i + 1}.png`);
        if (mediaId) referenceImageIds.push(mediaId);
      } catch (e) {
        log.safeLog(`[api] Reference image ${i + 1} upload failed:`, e.message);
      }
    }
    log.safeLog('Uploaded', referenceImageIds.length, 'reference images');
  }

  log.safeLog(`[api] Task ${taskId} ingredient=${characterLockReference || 'none'}`);
  log.safeLog('Generating image:', prompt?.substring(0, 80), `model: ${modelName} (from ${modelSource})`);

  const batchId = crypto.randomUUID();
  const imageInputs = [];
  if (characterLockReference) {
    imageInputs.push({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: characterLockReference });
  }
  for (const id of referenceImageIds) {
    imageInputs.push({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: id });
  }
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
  log.safeLog('Image generation complete:', urls.length, 'images');

  await upscaleImages(urls, result, ctx);

  return {
    taskId,
    resultUrl: urls.join(','),
    mode: 'createImage',
    isGeneratedImage: true,
  };
}

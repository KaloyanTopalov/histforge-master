// YouForge Flow - image-to-video executor
// Handles `image` and `ingredients` modes. Uploads one or more reference
// images (comma-separated URL list), picks the right endpoint + model
// based on tier (Lite uses single-start-image; non-Lite uses
// multi-reference), then delegates body wrapping, pageCall, polling,
// and upscale to runVideoGeneration (src/executors/shared.js).
//
// Runtime deps (resolved at call time): safeLog, AISANDBOX_BASE,
// runVideoGeneration (src/executors/shared.js).

async function runImageToVideo(task, ctx) {
  const { modelKeys, settings, uploadImage } = ctx;

  const imageUrl = task.referenceImage || task['Image URL'];
  const refImageIds = [];
  if (imageUrl && imageUrl.trim()) {
    const imageUrls = imageUrl.split(',').map((u) => u.trim()).filter((u) => u);
    safeLog('Uploading', imageUrls.length, 'reference image(s) for i2v...');
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const mediaId = await uploadImage(imageUrls[i], `ref_image_${i + 1}.png`);
        if (mediaId) refImageIds.push(mediaId);
      } catch (e) {
        safeLog(`[api] Ref image ${i + 1} upload failed:`, e.message);
      }
    }
  }

  if (settings.videoModelQuality === 'quality' && !modelKeys.isLite) {
    safeLog('Note: Ingredients mode does not support Veo 3.1 Quality, using Fast');
  }

  let endpoint;
  let videoModelKey;
  let perRequestExtras;
  if (modelKeys.isLite) {
    videoModelKey = modelKeys.i2v;
    safeLog('VEO Lite image-to-video, image:', refImageIds[0], 'model:', videoModelKey);
    endpoint = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoStartImage`;
    perRequestExtras = {
      startImage: {
        mediaId: refImageIds[0],
        cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
      },
    };
  } else {
    videoModelKey = modelKeys.r2v;
    safeLog('Image-to-video, refs:', refImageIds.length, 'model:', videoModelKey);
    endpoint = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoReferenceImages`;
    perRequestExtras = {
      referenceImages: refImageIds.map((id) => ({
        mediaId: id, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
      })),
    };
  }

  return await runVideoGeneration(task, ctx, {
    endpoint,
    videoModelKey,
    perRequestExtras,
    mode: (task.mode || 'image').toLowerCase(),
  });
}

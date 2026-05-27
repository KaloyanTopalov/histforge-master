// VEO Flow API - Google Flow API Wrapper v2
// Based on click-tracker recon data (2026-03-15)
// All direct API calls to aisandbox-pa.googleapis.com

const AISANDBOX_BASE = 'https://aisandbox-pa.googleapis.com/v1';

function apiHeaders(authToken) {
  return {
    'authorization': `Bearer ${authToken}`,
    'content-type': 'text/plain;charset=UTF-8',
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/'
  };
}

// ============================================================
// IMAGE GENERATION (Synchronous - result in response)
// Endpoint: projects/{projectId}/flowMedia:batchGenerateImages
// ============================================================

async function generateImage(params) {
  const {
    authToken, projectId, prompt, recaptchaToken, sessionId,
    aspectRatio = 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    seed, modelName = 'NARWHAL',
    referenceImageId = null, outputCount = 1
  } = params;

  const batchId = crypto.randomUUID();
  const requests = [];

  for (let i = 0; i < outputCount; i++) {
    const request = {
      clientContext: {
        recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
        projectId, tool: 'PINHOLE', sessionId
      },
      imageModelName: modelName,
      imageAspectRatio: aspectRatio,
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: seed || Math.floor(Math.random() * 100000),
      imageInputs: referenceImageId
        ? [{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: referenceImageId }]
        : []
    };
    requests.push(request);
  }

  const body = {
    clientContext: {
      recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
      projectId, tool: 'PINHOLE', sessionId
    },
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests
  };

  const url = `${AISANDBOX_BASE}/projects/${projectId}/flowMedia:batchGenerateImages`;
  console.log('[FlowAPI] Generating image, model:', modelName, 'prompt:', prompt.substring(0, 60));

  const response = await fetch(url, { method: 'POST', headers: apiHeaders(authToken), body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image generation failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();
  const images = (result.media || []).map(m => ({
    name: m.name,
    url: m.image?.generatedImage?.fifeUrl || null,
    seed: m.image?.generatedImage?.seed,
    width: m.image?.dimensions?.width,
    height: m.image?.dimensions?.height
  }));

  console.log('[FlowAPI] Image generation complete:', images.length, 'images');
  return { images, batchId, raw: result };
}


// ============================================================
// TEXT-TO-VIDEO (Asynchronous)
// Endpoint: video:batchAsyncGenerateVideoText
// ============================================================

async function startTextToVideo(params) {
  const {
    authToken, projectId, prompt, recaptchaToken, sessionId,
    aspectRatio = 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    modelKey = 'veo_3_1_t2v_fast_ultra',
    seed
  } = params;

  const body = {
    mediaGenerationContext: { batchId: crypto.randomUUID() },
    clientContext: {
      projectId, tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO',
      sessionId,
      recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
    },
    requests: [{
      aspectRatio,
      seed: seed || Math.floor(Math.random() * 100000),
      textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
      videoModelKey: modelKey,
      metadata: {}
    }],
    useV2ModelConfig: true
  };

  const url = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoText`;
  console.log('[FlowAPI] Starting text-to-video, model:', modelKey);

  const response = await fetch(url, { method: 'POST', headers: apiHeaders(authToken), body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Text-to-video failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();
  const mediaIds = (result.media || []).map(m => ({ name: m.name, projectId }));
  console.log('[FlowAPI] Text-to-video started, mediaIds:', mediaIds.map(m => m.name));
  return { mediaIds, raw: result };
}


// ============================================================
// FRAMES-TO-VIDEO / IMAGE-TO-VIDEO (Asynchronous)
// Endpoint: video:batchAsyncGenerateVideoStartAndEndImage
// ============================================================

async function startFramesToVideo(params) {
  const {
    authToken, projectId, prompt, recaptchaToken, sessionId,
    aspectRatio = 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    modelKey = 'veo_3_1_i2v_s_fast_ultra_fl',
    startImageId, endImageId, seed
  } = params;

  const request = {
    aspectRatio,
    seed: seed || Math.floor(Math.random() * 100000),
    textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
    videoModelKey: modelKey,
    metadata: {}
  };

  if (startImageId) {
    request.startImage = { mediaId: startImageId, cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } };
  }
  if (endImageId) {
    request.endImage = { mediaId: endImageId };
  }

  const body = {
    mediaGenerationContext: { batchId: crypto.randomUUID() },
    clientContext: {
      projectId, tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO',
      sessionId,
      recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
    },
    requests: [request],
    useV2ModelConfig: true
  };

  const url = `${AISANDBOX_BASE}/video:batchAsyncGenerateVideoStartAndEndImage`;
  console.log('[FlowAPI] Starting frames-to-video, model:', modelKey, 'start:', startImageId, 'end:', endImageId);

  const response = await fetch(url, { method: 'POST', headers: apiHeaders(authToken), body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Frames-to-video failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();
  const mediaIds = (result.media || []).map(m => ({ name: m.name, projectId }));
  console.log('[FlowAPI] Frames-to-video started, mediaIds:', mediaIds.map(m => m.name));
  return { mediaIds, raw: result };
}


// ============================================================
// VIDEO STATUS POLLING
// Endpoint: video:batchCheckAsyncVideoGenerationStatus
// States: MEDIA_GENERATION_STATUS_PENDING / _SUCCESSFUL / _FAILED
// ============================================================

async function checkVideoStatus(authToken, mediaIds) {
  const url = `${AISANDBOX_BASE}/video:batchCheckAsyncVideoGenerationStatus`;
  const response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(authToken),
    body: JSON.stringify({ media: mediaIds })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video status check failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();

  // Log raw response on first successful result to find URL location
  const rawStr = JSON.stringify(result);
  if (rawStr.includes('SUCCESSFUL')) {
    console.log('[FlowAPI] Video status raw (SUCCESSFUL):', rawStr.substring(0, 1500));
  }

  return (result.media || []).map(m => {
    const video = m.video || {};
    const gen = video.generatedVideo || {};
    const meta = m.mediaMetadata || {};
    const status = meta.mediaStatus?.mediaGenerationStatus || 'UNKNOWN';

    // Try multiple paths for the URL
    const url = gen.fifeUrl
      || gen.videoUrl
      || gen.url
      || video.fifeUrl
      || m.fifeUrl
      || null;

    // Also try to build URL from media name using getMediaUrlRedirect
    const mediaName = m.name;

    return {
      name: mediaName,
      state: status,
      url: url,
      seed: gen.seed,
      model: gen.model,
      hasAudio: gen.hasAudio || false,
      error: meta.mediaStatus?.error || null,
      failureReasons: meta.mediaStatus?.failureReasons || [],
      visibility: meta.visibility || null
    };
  });
}


// ============================================================
// IMAGE UPLOAD
// Endpoint: flow/uploadImage
// ============================================================

async function uploadImage(authToken, projectId, base64Data, mimeType, fileName) {
  const url = `${AISANDBOX_BASE}/flow/uploadImage`;
  const body = {
    clientContext: { projectId, tool: 'PINHOLE' },
    imageBytes: base64Data,
    isUserUploaded: true,
    isHidden: false,
    mimeType: mimeType || 'image/png',
    fileName: fileName || 'image.png'
  };

  const response = await fetch(url, { method: 'POST', headers: apiHeaders(authToken), body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image upload failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();
  const mediaId = result.media?.name;
  console.log('[FlowAPI] Image uploaded, mediaId:', mediaId);
  return { mediaId, raw: result };
}


// ============================================================
// IMAGE UPSAMPLE (4K)
// Endpoint: flow/upsampleImage
// ============================================================

async function upsampleImage(authToken, projectId, mediaId, recaptchaToken, sessionId, resolution = 'UPSAMPLE_IMAGE_RESOLUTION_4K') {
  const url = `${AISANDBOX_BASE}/flow/upsampleImage`;
  const body = {
    mediaId,
    targetResolution: resolution,
    clientContext: {
      recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
      projectId, tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO',
      sessionId
    }
  };

  const response = await fetch(url, { method: 'POST', headers: apiHeaders(authToken), body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upsample failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  return await response.json();
}


// ============================================================
// CREDITS
// ============================================================

async function getCredits(authToken) {
  const url = `${AISANDBOX_BASE}/credits?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY`;
  const response = await fetch(url, { headers: apiHeaders(authToken) });
  if (!response.ok) return null;
  const result = await response.json();
  return { credits: result.credits, tier: result.userPaygateTier, sku: result.sku, serviceTier: result.serviceTier };
}

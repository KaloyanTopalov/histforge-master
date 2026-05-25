// YouForge Flow - account-tier detection + per-mode model keys
// Detects whether the signed-in account is Pro (PAYGATE_TIER_ONE) or Ultra
// (PAYGATE_TIER_TWO) by calling the credits endpoint from the tab's MAIN
// world with the cached session Bearer. The result is cached in state.js
// (the durable home, survives service-worker wake) until clearCachedTier()
// is called (after stopAllProcessing / autoStopped).
//
// getVideoModelKeys resolves (tier, quality, aspect) → model keys through
// a MODEL_MATRIX lookup: a flat table keyed by one of "lite" | "pro" |
// "ultra.fast" | "ultra.quality", with each entry holding per-aspect r2v
// variants that collapse to a single r2v field on return.
//
// Runtime deps (resolved at call time): getSessionTokenFromPage
// (src/auth.js), GOOGLE_LABS_API_KEY (src/constants.js), loadState /
// getCachedAccountTier / setCachedAccountTier / clearCachedAccountTier
// (src/state.js), safeLog.

async function detectAccountTier(tabId) {
  // Block on loadState so a service-worker wake-up hits the persisted tier
  // instead of firing a redundant credits-API call while the cache warms.
  await loadState();
  const cached = getCachedAccountTier();
  if (cached) return cached;

  // Method 1: Use session token + credits API with Bearer auth
  try {
    const sessionToken = await getSessionTokenFromPage(tabId);
    if (sessionToken) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (bearer, apiKey) => {
          try {
            const resp = await fetch(`https://aisandbox-pa.googleapis.com/v1/credits?key=${apiKey}`, {
              headers: { 'authorization': 'Bearer ' + bearer }
            });
            const text = await resp.text();
            if (!resp.ok) return { error: 'HTTP ' + resp.status };
            return { data: JSON.parse(text) };
          } catch (e) {
            return { error: e.message };
          }
        },
        args: [sessionToken, GOOGLE_LABS_API_KEY]
      });
      const result = results?.[0]?.result;
      if (result?.data?.userPaygateTier) {
        const credits = result.data;
        const tier = credits.userPaygateTier === 'PAYGATE_TIER_TWO' ? 'ultra' : 'pro';
        safeLog(`[tier] Account tier detected: ${tier} (${credits.userPaygateTier}, ${credits.sku}, ${credits.credits} credits)`);
        await setCachedAccountTier(tier);
        return tier;
      }
      if (result?.error) {
        safeLog('Credits API error:', result.error);
      }
    }
  } catch (e) {
    safeLog('Failed to detect account tier:', e.message);
  }

  // Default to ultra if detection fails
  await setCachedAccountTier('ultra');
  safeLog('Account tier detection failed, defaulting to ultra');
  return 'ultra';
}

async function clearCachedTier() {
  await clearCachedAccountTier();
}

// (tier, quality) → matrix key. Lite applies to every tier; pro short-
// circuits to the pro row; everything else is an ultra.{quality} entry,
// defaulting to ultra.fast for unknown qualities so the detection-failure
// fallback at line 60 still lands on the same row it did pre-refactor.
const MODEL_MATRIX = {
  'lite': {
    t2v: 'veo_3_1_t2v_lite',
    r2v_portrait: 'veo_3_1_i2v_lite',
    r2v_landscape: 'veo_3_1_i2v_lite',
    i2v: 'veo_3_1_i2v_lite',
    i2v_fl: 'veo_3_1_i2v_lite',
    isLite: true
  },
  'pro': {
    t2v: 'veo_3_1_t2v',
    r2v_portrait: 'veo_3_1_r2v_fast_portrait',
    r2v_landscape: 'veo_3_1_r2v_fast_landscape',
    i2v: 'veo_3_1_i2v_s',
    i2v_fl: 'veo_3_1_i2v_s',
    paygateTier: 'PAYGATE_TIER_ONE'
  },
  'ultra.fast': {
    t2v: 'veo_3_1_t2v_fast_ultra',
    r2v_portrait: 'veo_3_1_r2v_fast_portrait_ultra',
    r2v_landscape: 'veo_3_1_r2v_fast_landscape_ultra',
    i2v: 'veo_3_1_i2v_s_fast_ultra',
    i2v_fl: 'veo_3_1_i2v_s_fast_ultra_fl',
    paygateTier: 'PAYGATE_TIER_TWO'
  },
  'ultra.quality': {
    t2v: 'veo_3_1_t2v_quality_ultra',
    r2v_portrait: 'veo_3_1_r2v_fast_portrait_ultra',
    r2v_landscape: 'veo_3_1_r2v_fast_landscape_ultra',
    i2v: 'veo_3_1_i2v_s_quality_ultra',
    i2v_fl: 'veo_3_1_i2v_s_quality_ultra_fl',
    paygateTier: 'PAYGATE_TIER_TWO'
  }
};

function resolveModelMatrixKey(accountTier, qualitySetting) {
  // Surface unknown quality strings (Task 4.3) — silent fallback to
  // ultra.fast hid mis-configured callers; mirrors flow2api's
  // model_resolver.py:479-496 visibility pattern.
  if (qualitySetting && !['lite', 'quality', 'fast'].includes(qualitySetting)) {
    safeLog('[account-tier] Unknown quality setting:', qualitySetting, '— defaulting to fast');
  }
  if (qualitySetting === 'lite') return 'lite';
  if (accountTier === 'pro') return 'pro';
  if (qualitySetting === 'quality') return 'ultra.quality';
  return 'ultra.fast';
}

// Get model keys based on account tier + user quality setting.
// Returns { t2v, r2v, i2v, i2v_fl, paygateTier } (plus isLite when on the
// lite row). Does a MODEL_MATRIX lookup and collapses the per-aspect r2v
// variants into a single r2v field based on aspectRatio.
function getVideoModelKeys(accountTier, qualitySetting, aspectRatio) {
  // Aspect-ratio fallback warning (Task 4.3) — every MODEL_MATRIX row
  // collapses unknown aspect to landscape; without this log line, a
  // typo (e.g. '1:1', 'square') silently degrades.
  if (aspectRatio && aspectRatio !== 'portrait' && aspectRatio !== 'landscape') {
    safeLog('[account-tier] Unknown aspect ratio:', aspectRatio, '— defaulting to landscape');
  }
  const isPortrait = aspectRatio === 'portrait';
  const key = resolveModelMatrixKey(accountTier, qualitySetting);
  const { r2v_portrait, r2v_landscape, ...rest } = MODEL_MATRIX[key];
  const result = {
    ...rest,
    r2v: isPortrait ? r2v_portrait : r2v_landscape
  };
  if (key === 'lite') {
    result.paygateTier = accountTier === 'pro' ? 'PAYGATE_TIER_ONE' : 'PAYGATE_TIER_TWO';
  }
  return result;
}

// YouForge Flow - clientContext builder
// Single source of truth for the `clientContext` object literal that
// accompanies every aisandbox-pa.googleapis.com request. Replaces the 12
// inline copies that previously lived in background.js.
//
// Shape variants covered (all produced by omitting optional inputs):
//   - Minimal (uploadImage)        : { projectId, tool }
//   - Image-gen (batchGenerateImages): + recaptchaContext + sessionId
//   - Full (video + upscale)       : + userPaygateTier
//
// Classic service-worker script — relies on importScripts() to attach
// buildClientContext to the worker's global scope.

function buildClientContext({
  projectId,
  recaptchaToken,
  sessionId,
  paygateTier,
} = {}) {
  const ctx = { projectId, tool: 'PINHOLE' };
  if (recaptchaToken) {
    ctx.recaptchaContext = {
      token: recaptchaToken,
      applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
    };
  }
  if (sessionId) ctx.sessionId = sessionId;
  if (paygateTier) ctx.userPaygateTier = paygateTier;
  return ctx;
}

// YouForge Flow - upscale retry helper
// Generic 3-attempt retry with 4K → fallback-resolution on 403. The two
// concrete callers (upscaleImages and upscaleVideos in
// src/executors/shared.js) each collapse into one call of this helper.
//
// Contract:
//   attempt()         → async; resolves true on success, false to retry,
//                       throws on HTTP / transport errors
//   on403Fallback()   → called when attempt throws a 403; returns true if
//                       a lower-resolution fallback was applied (so we
//                       retry without consuming this attempt), or false
//                       if we're already on the minimum and the 403
//                       should count as a normal failed attempt
//   sleep(ms)         → awaited between failed attempts; caller supplies
//                       (defaults to setTimeout-based wait in prod)

async function upscaleWithFallback({
  attempt,
  on403Fallback = () => false,
  // Default reads from settings (Task 4.1) so the popup-driven knob takes
  // effect without requiring callers to thread it through.
  maxAttempts = getUpscaleMaxAttempts(),
  baseMs = 2000,
  capMs = 15000,
  logLabel = 'Upscale',
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      if (await attempt()) return true;
    } catch (e) {
      log(`[upscale] ${logLabel} upscale attempt ${i}/${maxAttempts} failed:`, e.message);
      if (e.message && e.message.includes('403') && on403Fallback()) {
        i--; // retry without consuming this attempt
        continue;
      }
    }
    if (i < maxAttempts) {
      const delay = computeBackoff(i - 1, { baseMs, capMs, jitter: true });
      await sleep(delay);
    }
  }
  return false;
}

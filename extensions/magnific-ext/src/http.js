// Magnific HITL - HTTP primitives
// fetchWithTimeout: wraps fetch with an AbortController + setTimeout so a
// hung upstream request can't park a slot indefinitely. On timeout the
// AbortController.abort fires; the fetch rejects with an AbortError,
// which we rewrap as `TIMEOUT: <url>` so call sites and the retry helper
// can detect it from the error message alone.
//
// computeBackoff / retryWithBackoff: exponential + jittered retry loop.
// Default shouldRetry reads err.retryable; call sites whose errors don't
// flag retryability pass an explicit shouldRetry. STOP_REQUESTED is
// never retried.
//
// Loaded right after src/logger.js in background.js — no module deps.

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const opts = { ...(options || {}), signal: controller.signal };
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`TIMEOUT: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function computeBackoff(attempt, opts) {
  const baseMs = (opts && typeof opts.baseMs === 'number') ? opts.baseMs : 1000;
  const capMs = (opts && typeof opts.capMs === 'number') ? opts.capMs : 15000;
  const jitter = !opts || opts.jitter !== false;
  const raw = Math.min(capMs, baseMs * Math.pow(2, attempt));
  if (!jitter) return raw;
  return raw * (0.5 + Math.random());
}

async function retryWithBackoff(fn, opts) {
  const retries = (opts && typeof opts.retries === 'number') ? opts.retries : 3;
  const baseMs = (opts && typeof opts.baseMs === 'number') ? opts.baseMs : 1000;
  const capMs = (opts && typeof opts.capMs === 'number') ? opts.capMs : 15000;
  const jitter = !opts || opts.jitter !== false;
  const sleep = (opts && opts.sleep)
    || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const shouldRetry = (opts && opts.shouldRetry)
    || ((err) => err && err.retryable === true);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (e && e.message === 'STOP_REQUESTED') throw e;
      if (attempt >= retries) throw e;
      if (!shouldRetry(e)) throw e;
      await sleep(computeBackoff(attempt, { baseMs, capMs, jitter }));
    }
  }
  throw lastErr;
}

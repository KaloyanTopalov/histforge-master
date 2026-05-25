// YouForge Flow - logger
// safeLog scrubs Bearer tokens, reCAPTCHA tokens, and the configured
// ACCOUNT_TOKEN from any string argument before forwarding to console.log.
// Loaded first via importScripts so every downstream module can call it.
// The saved _rawLog reference keeps safeLog non-recursive under a future
// global sed pass that rewrites console.log/error/warn to safeLog.

const _rawLog = console.log.bind(console);

function safeLog(...args) {
  const token = typeof ACCOUNT_TOKEN !== 'undefined' ? ACCOUNT_TOKEN : '';
  const scrubbed = args.map((a) => {
    if (typeof a !== 'string') return a;
    let s = a.replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer <redacted>');
    s = s.replace(/(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]{40,}/gi, '$1<redacted>');
    if (token && s.includes(token)) s = s.split(token).join('<redacted>');
    return s;
  });
  _rawLog('[YouForge Flow]', ...scrubbed);
}

// Verbose-logging gate. Off by default — flip via the popup
// `verboseLogging` checkbox (settings.js). When on, callers can sprinkle
// `verboseLog(...)` calls at choke points (page-call, webhook, poll) to
// surface request URL, body size, response status, etc. without noise
// on the default install. Redaction stays on in both modes (the call
// reuses safeLog's scrubbing pipeline).
function verboseLog(...args) {
  if (getVerboseLogging()) {
    safeLog('[verbose]', ...args);
  }
}

// Returns a logger bound to a correlation id. Each call to taskLog.safeLog
// emits an extra `[cid=<8chars>]` arg before the user message so log lines
// from a single task can be filtered with `grep [cid=abcdef12]`. Empty cid
// → no prefix (acts identically to the global safeLog).
function forTask(correlationId) {
  const cid = typeof correlationId === 'string' ? correlationId : '';
  if (!cid) {
    return { safeLog: (...args) => safeLog(...args) };
  }
  const prefix = `[cid=${cid.length > 8 ? cid.slice(0, 8) : cid}]`;
  return {
    safeLog: (...args) => safeLog(prefix, ...args),
  };
}

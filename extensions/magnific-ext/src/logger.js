// Magnific HITL - logger
// safeLog scrubs Bearer tokens, generic token: / token= values, and the
// configured MAGNIFIC_TOKEN value from any string argument before
// forwarding to console.log. Loaded first via importScripts so every
// downstream module can call it.

const _rawLog = console.log.bind(console);

function safeLog(...args) {
  const token = typeof MAGNIFIC_TOKEN !== 'undefined' ? MAGNIFIC_TOKEN : '';
  const scrubbed = args.map((a) => {
    if (typeof a !== 'string') return a;
    let s = a.replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer <redacted>');
    s = s.replace(/(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]{40,}/gi, '$1<redacted>');
    if (token && s.includes(token)) s = s.split(token).join('<redacted>');
    return s;
  });
  _rawLog('[Magnific HITL]', ...scrubbed);
}

// Verbose-logging gate. Off by default — flip via the popup
// `verboseLogging` checkbox. When on, callers can sprinkle
// `verboseLog(...)` calls at choke points (poll, webhook) to surface
// request URLs, body sizes, etc. without noise on the default install.
// Redaction stays on in both modes (same safeLog scrubbing pipeline).
function verboseLog(...args) {
  if (typeof getVerboseLogging === 'function' && getVerboseLogging()) {
    safeLog('[verbose]', ...args);
  }
}

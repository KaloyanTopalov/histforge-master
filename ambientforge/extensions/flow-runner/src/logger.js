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

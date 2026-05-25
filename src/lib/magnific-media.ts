/**
 * Hosts we accept as Magnific result URLs. SSRF defense — anything off
 * this list is rejected before the submit-result route fetches, so a
 * compromised or confused extension can't steer HistForge at internal
 * hosts. Mirror of `isAllowedResultHost` in flow-media.ts, with the
 * Magnific-specific delivery domain(s) instead of Google's.
 *
 * `cdnpk.net` is the verified Magnific result-delivery CDN (image PNGs
 * and video MP4s land under `*.cdnpk.net`); `.freepikcdn.com` is kept
 * for historical parity since the same CDN has served results under
 * both parent hosts at different points.
 *
 * NB: data: URLs are NOT accepted here — Magnific result delivery uses
 * direct CDN URLs in v1; allowing data: would widen the attack surface
 * for no benefit.
 */
const ALLOWED_SUFFIXES = [".cdnpk.net", ".freepikcdn.com"] as const;

function isAllowedHttpHost(host: string): boolean {
  for (const suffix of ALLOWED_SUFFIXES) {
    if (host.endsWith(suffix) && host.length > suffix.length) return true;
  }
  return false;
}

export function isAllowedMagnificHost(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return isAllowedHttpHost(parsed.hostname);
}

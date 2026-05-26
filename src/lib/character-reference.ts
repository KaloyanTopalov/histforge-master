import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-video character reference image always lives at this stable
 * basename inside `projects/<videoId>/`. The upload route transcodes
 * non-PNG inputs (JPEG, WebP) to PNG via ffmpeg before writing, so
 * there is exactly one file path that ever holds a reference — pending
 * Flow queue rows that capture this basename at enqueue time can never
 * be invalidated by a re-upload with a different format.
 */
export const CHARACTER_REFERENCE_BASENAME = "character_reference.png";

/**
 * Mime types the upload route accepts. All are normalized to a single
 * `character_reference.png` on disk; the row above documents the rule
 * the upload route enforces via ffmpeg transcoding.
 */
export const CHARACTER_REFERENCE_ACCEPTED_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

/**
 * Locate the per-video character reference image, if uploaded.
 * Returns the basename (relative to the project dir, always
 * `"character_reference.png"`) or `null` if no reference is set.
 *
 * Returning a relative path keeps the caller free to choose how to
 * compose absolute paths (the worker reads from disk; the dispatch
 * route projects into the artifact-URL query string).
 */
export function findCharacterReference(projectDir: string): string | null {
  if (existsSync(join(projectDir, CHARACTER_REFERENCE_BASENAME))) {
    return CHARACTER_REFERENCE_BASENAME;
  }
  return null;
}

/**
 * Format a track filename in the canonical "NN - Title.wav" form expected by
 * DistroKid's bulk uploader and Suno-runner downloads.
 *
 *   formatTrackFilename(1, "Eclipse Whispers")          -> "01 - Eclipse Whispers.wav"
 *   formatTrackFilename(12, "Pt. 1 / Drift")            -> "12 - Pt. 1 Drift.wav"
 *   formatTrackFilename(7, "  Soft\tWind  ")            -> "07 - Soft Wind.wav"
 *
 * Throws on empty/whitespace-only titles so an LLM bug surfaces immediately
 * rather than producing malformed filesystem names.
 */
export function formatTrackFilename(trackNumber: number, title: string): string {
  if (!Number.isInteger(trackNumber) || trackNumber < 1 || trackNumber > 99) {
    throw new Error(`INVALID_TRACK_NUMBER: ${trackNumber}`);
  }
  const cleaned = sanitizeTitle(title);
  if (cleaned.length === 0) {
    throw new Error('EMPTY_TRACK_TITLE');
  }
  const padded = String(trackNumber).padStart(2, '0');
  return `${padded} - ${cleaned}.wav`;
}

function sanitizeTitle(title: string): string {
  // Strip filesystem-illegal chars on Windows + control chars; collapse whitespace.
  // eslint-disable-next-line no-control-regex
  const stripped = title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ');
  return stripped.replace(/\s+/g, ' ').trim();
}

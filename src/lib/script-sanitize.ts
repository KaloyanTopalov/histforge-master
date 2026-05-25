const EM_DASH = "—";

/**
 * Normalize prose for downstream TTS + alignment. AI33's internal
 * chunker fails with `tts_chunk_error` on em-dashes; a comma+space
 * preserves the prose pause. Applied at script-assembly time (or at
 * ready-script ingestion time) so `full_script.md` on disk is the single
 * source of truth — alignment (step 07) and the TTS step both see the
 * same text.
 */
export function sanitizeScript(text: string): {
  text: string;
  emDashCount: number;
} {
  const emDashCount = (text.match(/—/g) ?? []).length;
  return { text: text.split(EM_DASH).join(", "), emDashCount };
}

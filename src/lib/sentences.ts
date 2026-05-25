import tokenizer from "sbd";

/**
 * Split text into sentences using sbd (Sentence Boundary Detection).
 * Returns an array of trimmed, non-empty sentence strings.
 *
 * Used by step 7 (align) to produce `alignment/sentences.txt` —
 * one sentence per line — which aeneas uses for forced alignment.
 */
export function splitSentences(text: string): string[] {
  const raw: string[] = tokenizer.sentences(text, {});
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

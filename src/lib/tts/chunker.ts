/**
 * Sentence-aware text splitter for the chatterbox-fast batch path.
 *
 * Pipeline:
 *   1. Sentence-tokenize on `[.!?]` + whitespace + capital-or-quote,
 *      with an abbreviation guard so "Mr. Smith" / "U.S. Marines" /
 *      "e.g. apples" don't get cut at the abbreviation period.
 *   2. Greedy-pack sentences into chunks ≤ `maxChars`.
 *   3. Any single sentence > `maxChars` falls back to splitting on
 *      `; : — ,` in priority order, then on word boundaries.
 *
 * Pure function — no I/O, no DI, no external deps.
 *
 * Plain ASCII hyphen `-` is intentionally NOT a secondary splitter:
 * splitting on it tears compound words ("well-being" → "well-" / "being"),
 * which is worse than packing the sentence into one slightly-over-budget
 * chunk via the word-boundary fallback. Em-dash `—` covers the legitimate
 * long-pause case.
 */

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "etc",
  "no",
  "jr",
  "sr",
  "e.g",
  "i.e",
  "u.s",
  "u.k",
  "ph.d",
]);

const SECONDARY_SPLITTERS = [";", ":", "—", ","] as const;

export interface ChunkScriptOpts {
  /** Maximum characters per chunk after packing. */
  maxChars: number;
}

export function chunkScript(text: string, opts: ChunkScriptOpts): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const sentences = splitIntoSentences(trimmed);
  return packChunks(sentences, opts.maxChars);
}

function splitIntoSentences(text: string): string[] {
  // Candidate boundary: any [.!?] followed by 1+ whitespace and an
  // optional opening quote then a capital letter. Abbreviations are
  // filtered after the regex match.
  const re = /([.!?])(\s+)(?=["'“”]?[A-Z])/g;
  const result: string[] = [];
  let lastStart = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const beforePunct = m.index;
    if (isAbbreviationBoundary(text, beforePunct)) continue;
    const sentenceEnd = beforePunct + 1;
    result.push(text.slice(lastStart, sentenceEnd));
    lastStart = beforePunct + m[0].length;
  }
  if (lastStart < text.length) {
    result.push(text.slice(lastStart));
  }
  return result.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isAbbreviationBoundary(text: string, periodIdx: number): boolean {
  // Walk back to the start of the token containing the period, then
  // strip the trailing punctuation. Multi-period abbreviations like
  // "U.S." resolve to "u.s" via this walk because we stop only at
  // whitespace, not at internal periods.
  let i = periodIdx;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  const token = text.slice(i, periodIdx + 1).toLowerCase();
  const stripped = token.replace(/[.!?]+$/, "");
  return ABBREVIATIONS.has(stripped);
}

function packChunks(sentences: string[], maxChars: number): string[] {
  const result: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (current.length > 0) {
        result.push(current);
        current = "";
      }
      for (const piece of subdivide(s, maxChars)) result.push(piece);
      continue;
    }
    if (current.length === 0) {
      current = s;
    } else if (current.length + 1 + s.length <= maxChars) {
      current = `${current} ${s}`;
    } else {
      result.push(current);
      current = s;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function subdivide(text: string, maxChars: number): string[] {
  for (const sep of SECONDARY_SPLITTERS) {
    if (!text.includes(sep)) continue;
    const pieces = splitKeepDelim(text, sep)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (pieces.length < 2) continue;
    const packed = packChunks(pieces, maxChars);
    const longest = packed.reduce((m, p) => Math.max(m, p.length), 0);
    if (longest < text.length) return packed;
  }
  return wordBoundarySplit(text, maxChars);
}

function splitKeepDelim(text: string, delim: string): string[] {
  const result: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(delim, i)) {
      result.push(text.slice(start, i + delim.length));
      start = i + delim.length;
      i = start;
    } else {
      i++;
    }
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

function wordBoundarySplit(text: string, maxChars: number): string[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const result: string[] = [];
  let current = "";
  for (const tok of tokens) {
    if (tok.length > maxChars) {
      // Single token over budget: invariant says never split mid-word,
      // so emit the long token alone (over budget by design — operator
      // can raise maxChars if this matters for them).
      if (current.length > 0) {
        result.push(current);
        current = "";
      }
      result.push(tok);
      continue;
    }
    if (current.length === 0) {
      current = tok;
    } else if (current.length + 1 + tok.length <= maxChars) {
      current = `${current} ${tok}`;
    } else {
      result.push(current);
      current = tok;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

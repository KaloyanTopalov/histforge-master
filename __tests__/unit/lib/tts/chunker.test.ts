import { describe, it, expect } from "vitest";
import { chunkScript } from "@/lib/tts/chunker";

/**
 * Pure function under test — no DI, no mocks. Each test asserts a
 * single behavior of `chunkScript(text, { maxChars })`. Behaviors are
 * described in docs/plans/2026-05-08-chatterbox-parallelism.md
 * Task 2.2.
 */

describe("chunkScript", () => {
  it("returns a single chunk when text fits in maxChars", () => {
    const text = "Hello world. This is short.";
    expect(chunkScript(text, { maxChars: 100 })).toEqual([
      "Hello world. This is short.",
    ]);
  });

  it("greedy-packs multiple sentences into chunks ≤ maxChars", () => {
    // Three sentences, each ~40 chars; budget 90 → first two fit, third
    // starts a new chunk.
    const text =
      "The first sentence runs about forty chars. The second sentence runs about forty chars. Third sentence stands alone.";
    const chunks = chunkScript(text, { maxChars: 90 });
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(90);
    }
    // Concatenating chunks should reproduce every sentence (whitespace
    // between joins may be lost — that's fine).
    expect(chunks.join(" ")).toContain("first sentence");
    expect(chunks.join(" ")).toContain("second sentence");
    expect(chunks.join(" ")).toContain("Third sentence");
  });

  it("does not split inside common abbreviations (Mr., Dr., e.g., U.S.)", () => {
    // If the splitter naively cut on `[.!?] + space + capital`, "Mr.
    // Smith" would split. The abbreviation guard must keep it together.
    const cases = [
      "Mr. Smith arrived early. He looked tired.",
      "Dr. Jones spoke first. Then he left.",
      "Mrs. Doyle baked a cake. It was good.",
      "We use e.g. apples. Oranges work too.",
      "The U.S. is large. So is Canada.",
      "He travelled vs. her route. Both worked.",
    ];
    for (const text of cases) {
      const chunks = chunkScript(text, { maxChars: 200 });
      // Whichever chunk the abbreviation lands in, it must be intact —
      // never split such that the period is the chunk boundary.
      const joined = chunks.join("|");
      expect(joined).toMatch(
        /(Mr\. Smith|Dr\. Jones|Mrs\. Doyle|e\.g\. apples|U\.S\. is|vs\. her)/
      );
      // And the second sentence must still get separated when the
      // budget is small enough. 25 chars is tight enough to force a
      // 2-chunk split across all six abbreviation fixtures (the
      // shortest-combined pair is "The U.S. is large." + "So is
      // Canada." at 32 chars including the separator).
      const tight = chunkScript(text, { maxChars: 25 });
      expect(tight.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("falls back to splitting on ;:—-, in priority order when a sentence exceeds maxChars", () => {
    // Single sentence over 50 chars with one semicolon halfway.
    const text =
      "this clause runs over budget; and the next clause also runs.";
    const chunks = chunkScript(text, { maxChars: 35 });
    // Both halves must appear, neither chunk over budget.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(35);
    expect(chunks.join(" ")).toContain("this clause");
    expect(chunks.join(" ")).toContain("next clause");
  });

  it("uses comma as last-resort punctuation split when only commas exist", () => {
    const text =
      "alpha beta gamma delta, epsilon zeta eta theta, iota kappa lambda mu";
    const chunks = chunkScript(text, { maxChars: 25 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(25);
  });

  it("falls back to word-boundary split when no usable punctuation exists", () => {
    // No `.!?;:—-,` — must split on whitespace.
    const text = "alpha beta gamma delta epsilon zeta eta theta iota";
    const chunks = chunkScript(text, { maxChars: 18 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(18);
      // Never mid-word — every chunk must be whitespace-delimited
      // tokens reassembled with single spaces.
      for (const tok of c.split(/\s+/)) {
        expect(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"]).toContain(tok);
      }
    }
  });

  it("never splits mid-word — even when a single word exceeds maxChars", () => {
    // One token longer than maxChars. Spec says "never mid-word", so
    // that one token must come out intact (its own chunk, over budget).
    const text = "supercalifragilisticexpialidocious now";
    const chunks = chunkScript(text, { maxChars: 10 });
    // The long word must be in its own chunk, intact.
    expect(chunks).toContain("supercalifragilisticexpialidocious");
  });

  it("trims leading/trailing whitespace from chunks", () => {
    const text = "   first sentence here.   second sentence here.   ";
    const chunks = chunkScript(text, { maxChars: 25 });
    for (const c of chunks) {
      expect(c).toBe(c.trim());
    }
  });

  it("preserves internal whitespace within a chunk", () => {
    // Two spaces between words → preserved in output.
    const text = "hello  world friend.";
    const chunks = chunkScript(text, { maxChars: 100 });
    expect(chunks).toEqual(["hello  world friend."]);
  });

  it("returns an empty array on empty/whitespace-only input", () => {
    expect(chunkScript("", { maxChars: 100 })).toEqual([]);
    expect(chunkScript("   \n\t  ", { maxChars: 100 })).toEqual([]);
  });

  it("handles ! and ? as sentence boundaries", () => {
    const text = "Wait! Are you sure? Yes I am.";
    const chunks = chunkScript(text, { maxChars: 12 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join(" ")).toContain("Wait");
    expect(chunks.join(" ")).toContain("Are you sure");
    expect(chunks.join(" ")).toContain("Yes I am");
  });

  it("does not split compound words on the plain hyphen — em-dash is the only dash splitter", () => {
    // "well-being" must stay intact even when the sentence is over
    // budget and the only dash-like character is the plain hyphen.
    // Plan listed `-` as a secondary splitter, but splitting there
    // tears compound words, which is worse than the word-boundary
    // fallback packing the sentence intact.
    const text =
      "the well-being of the people, when threatened, requires immediate action.";
    const chunks = chunkScript(text, { maxChars: 30 });
    const joined = chunks.join("|");
    expect(joined).toContain("well-being");
    // Sanity: the comma fallback still runs, so we still get >1 chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on em-dash before falling through to comma", () => {
    // ; and : absent, em-dash present → must split there before
    // resorting to commas.
    const text =
      "this very long clause goes on — and then continues, with a comma";
    const chunks = chunkScript(text, { maxChars: 40 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Em-dash should be the chosen split point — first chunk shouldn't
    // include text past the em-dash.
    expect(chunks[0]).not.toContain("and then continues");
  });
});

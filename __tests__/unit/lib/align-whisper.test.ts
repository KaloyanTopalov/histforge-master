import { describe, it, expect } from "vitest";
import {
  buildAlignmentEntries,
  buildWordTimeline,
} from "@/lib/align-whisper";

describe("buildWordTimeline", () => {
  it("returns an empty array when there are no segments", () => {
    expect(buildWordTimeline([])).toEqual([]);
  });

  it("interpolates per-word start times linearly within a segment", () => {
    // Segment 0..6000 ms with 3 words → 0s, 2s, 4s.
    const timeline = buildWordTimeline([
      { offsets: { from: 0, to: 6000 }, text: " one two three" },
    ]);
    expect(timeline).toEqual([
      { word: "one", start_sec: 0 },
      { word: "two", start_sec: 2 },
      { word: "three", start_sec: 4 },
    ]);
  });

  it("normalizes punctuation away so downstream matching is robust", () => {
    const timeline = buildWordTimeline([
      { offsets: { from: 0, to: 4000 }, text: " 1. Hello, World!" },
    ]);
    // "1. Hello, World!" → tokens after normalize: ["1", "hello", "world"]
    expect(timeline.map((t) => t.word)).toEqual(["1", "hello", "world"]);
  });

  it("concatenates segment word timelines end-to-end across multiple segments", () => {
    const timeline = buildWordTimeline([
      { offsets: { from: 0, to: 4000 }, text: " one two" },
      { offsets: { from: 4000, to: 8000 }, text: " three four" },
    ]);
    expect(timeline.map((t) => t.word)).toEqual(["one", "two", "three", "four"]);
    expect(timeline[0].start_sec).toBe(0);
    expect(timeline[2].start_sec).toBe(4);
  });

  it("skips segments whose normalized text is empty", () => {
    const timeline = buildWordTimeline([
      { offsets: { from: 0, to: 1000 }, text: " ... " },
      { offsets: { from: 1000, to: 2000 }, text: " hello" },
    ]);
    expect(timeline.map((t) => t.word)).toEqual(["hello"]);
  });
});

describe("buildAlignmentEntries", () => {
  it("maps each script sentence to a time range by finding its first words in the whisper transcript", () => {
    const entries = buildAlignmentEntries(
      ["Hello world.", "Goodbye cruel world."],
      {
        transcription: [
          {
            offsets: { from: 0, to: 4000 },
            text: " Hello world. Goodbye cruel world.",
          },
        ],
      }
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "f000001",
      text: "Hello world.",
      begin: 0,
    });
    expect(entries[1].id).toBe("f000002");
    expect(entries[1].text).toBe("Goodbye cruel world.");
    expect(entries[1].begin).toBeGreaterThan(0);
    expect(entries[1].end).toBeGreaterThanOrEqual(entries[1].begin);
  });

  it("anchors the last sentence's end to the audio duration (final whisper segment's end)", () => {
    const entries = buildAlignmentEntries(["One.", "Two.", "Three."], {
      transcription: [
        { offsets: { from: 0, to: 9000 }, text: " one two three" },
      ],
    });
    expect(entries).toHaveLength(3);
    expect(entries[entries.length - 1].end).toBe(9);
  });

  it("zero-pads sentence ids to 6 digits with an `f` prefix", () => {
    const entries = buildAlignmentEntries(
      Array.from({ length: 3 }, (_, i) => `Sentence ${i + 1}.`),
      {
        transcription: [
          {
            offsets: { from: 0, to: 6000 },
            text: " sentence 1 sentence 2 sentence 3",
          },
        ],
      }
    );
    expect(entries.map((e) => e.id)).toEqual(["f000001", "f000002", "f000003"]);
  });

  it("clamps begins to monotonic non-decreasing order even when the matcher returns out-of-order hits", () => {
    // Forge a transcript where the second sentence's needle appears
    // EARLIER than the first sentence's. The defensive clamp in
    // buildAlignmentEntries must preserve forward time order.
    const entries = buildAlignmentEntries(
      ["bravo charlie.", "alpha bravo."],
      {
        transcription: [
          {
            offsets: { from: 0, to: 8000 },
            text: " alpha bravo charlie delta",
          },
        ],
      }
    );
    expect(entries[0].begin).toBeLessThanOrEqual(entries[1].begin);
    expect(entries[1].end).toBeGreaterThanOrEqual(entries[1].begin);
  });

  it("falls back to proportional distribution when whisper transcription is wildly off (no probe-words match)", () => {
    // Script sentences share no normalized vocabulary with the
    // transcript. The matcher returns null, the fallback proportional
    // path kicks in, and every sentence still gets a begin/end span.
    const entries = buildAlignmentEntries(
      ["Apple banana.", "Cherry date.", "Eggfruit fig."],
      {
        transcription: [
          {
            offsets: { from: 0, to: 9000 },
            text: " xyz xyz xyz xyz xyz xyz",
          },
        ],
      }
    );
    expect(entries).toHaveLength(3);
    expect(entries[0].begin).toBe(0);
    expect(entries[entries.length - 1].end).toBe(9);
    // begins are strictly increasing
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].begin).toBeGreaterThan(entries[i - 1].begin);
    }
  });

  it("survives an empty whisper transcript without throwing (all entries collapse to t=0)", () => {
    // Degenerate input: whisper produced no segments. Don't crash —
    // emit entries with begin=end=0 so the orchestrator can surface
    // the underlying issue (likely a silent audio file) without the
    // step throwing at this layer.
    const entries = buildAlignmentEntries(["One.", "Two."], {
      transcription: [],
    });
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.begin).toBe(0);
      expect(e.end).toBe(0);
    }
  });
});

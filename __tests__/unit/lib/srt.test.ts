import { describe, expect, it } from "vitest";
import { isValidAlignmentArray, parseSrtToAlignment } from "@/lib/srt";

describe("parseSrtToAlignment", () => {
  it("parses a basic SRT with two cues", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "First sentence.",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,200",
      "Second sentence here.",
    ].join("\n");
    const out = parseSrtToAlignment(srt);
    expect(out).toEqual([
      { id: "f000001", text: "First sentence.", begin: 1.0, end: 3.5 },
      { id: "f000002", text: "Second sentence here.", begin: 4.0, end: 6.2 },
    ]);
  });

  it("accepts CRLF line endings and trims surrounding whitespace", () => {
    const srt =
      "  1\r\n00:00:00,500 --> 00:00:01,500\r\nHello world\r\n\r\n";
    const out = parseSrtToAlignment(srt);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "f000001",
      text: "Hello world",
      begin: 0.5,
      end: 1.5,
    });
  });

  it("collapses multi-line cue text into a single space-separated string", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:05,000",
      "First line",
      "second  line",
      "third\tline",
    ].join("\n");
    const out = parseSrtToAlignment(srt);
    expect(out[0].text).toBe("First line second line third line");
  });

  it("handles cue blocks without leading index numbers", () => {
    const srt = [
      "00:00:00,000 --> 00:00:02,000",
      "No index here",
      "",
      "00:00:02,000 --> 00:00:04,000",
      "Also no index",
    ].join("\n");
    const out = parseSrtToAlignment(srt);
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe("f000002");
  });

  it("accepts VTT-style dot fractional seconds and the WEBVTT header", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.250 --> 00:00:02.750",
      "VTT cue text",
    ].join("\n");
    const out = parseSrtToAlignment(vtt);
    expect(out).toEqual([
      { id: "f000001", text: "VTT cue text", begin: 1.25, end: 2.75 },
    ]);
  });

  it("right-pads 1-2 digit fractional seconds as milliseconds", () => {
    const srt = [
      "1",
      "00:00:00,5 --> 00:00:01,50",
      "Short fracs",
    ].join("\n");
    const out = parseSrtToAlignment(srt);
    // ",5"  → 500 ms;  ",50" → 500 ms
    expect(out[0].begin).toBe(0.5);
    expect(out[0].end).toBe(1.5);
  });

  it("zero-pads ids to 6 digits matching aeneas's default format", () => {
    const blocks: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const startSec = i;
      const endSec = i + 1;
      blocks.push(
        `${i}`,
        `00:00:${String(startSec).padStart(2, "0")},000 --> 00:00:${String(endSec).padStart(2, "0")},000`,
        `cue ${i}`,
        "",
      );
    }
    const out = parseSrtToAlignment(blocks.join("\n"));
    expect(out).toHaveLength(12);
    expect(out[0].id).toBe("f000001");
    expect(out[9].id).toBe("f000010");
    expect(out[11].id).toBe("f000012");
  });

  it("throws when the input is empty", () => {
    expect(() => parseSrtToAlignment("")).toThrow(/Empty/i);
    expect(() => parseSrtToAlignment("   \n\n  ")).toThrow(/Empty/i);
  });

  it("throws when no valid cue blocks were found (e.g. malformed timings)", () => {
    const garbage = "not\na\nvalid\nsrt\nfile\n";
    expect(() => parseSrtToAlignment(garbage)).toThrow(/no valid cue/i);
  });

  it("skips VTT NOTE blocks and other non-cue sections", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE",
      "This is a comment block, not a cue.",
      "",
      "1",
      "00:00:00.000 --> 00:00:01.000",
      "Real cue",
    ].join("\n");
    const out = parseSrtToAlignment(vtt);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Real cue");
  });

  it("rejects timing lines where end < begin (treats block as malformed and skips)", () => {
    const srt = [
      "1",
      "00:00:05,000 --> 00:00:03,000",
      "Backwards timing",
      "",
      "2",
      "00:00:06,000 --> 00:00:07,000",
      "Sane",
    ].join("\n");
    const out = parseSrtToAlignment(srt);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Sane");
  });
});

describe("isValidAlignmentArray", () => {
  it("returns true for a single-entry well-formed array", () => {
    expect(
      isValidAlignmentArray([{ id: "f000001", text: "hi", begin: 0, end: 1 }]),
    ).toBe(true);
  });

  it("returns false for empty arrays", () => {
    expect(isValidAlignmentArray([])).toBe(false);
  });

  it("returns false for non-arrays", () => {
    expect(isValidAlignmentArray(null)).toBe(false);
    expect(isValidAlignmentArray({})).toBe(false);
    expect(isValidAlignmentArray("string")).toBe(false);
  });

  it("returns false when any entry is missing a field", () => {
    expect(
      isValidAlignmentArray([{ id: "f000001", text: "hi", begin: 0 }]),
    ).toBe(false);
    expect(
      isValidAlignmentArray([{ id: "f000001", begin: 0, end: 1 }]),
    ).toBe(false);
  });

  it("returns false when types are wrong", () => {
    expect(
      isValidAlignmentArray([
        { id: "f000001", text: "hi", begin: "0", end: 1 },
      ]),
    ).toBe(false);
  });

  it("returns false when end < begin", () => {
    expect(
      isValidAlignmentArray([{ id: "f000001", text: "hi", begin: 5, end: 2 }]),
    ).toBe(false);
  });

  it("returns false for non-finite numbers", () => {
    expect(
      isValidAlignmentArray([
        { id: "f000001", text: "hi", begin: 0, end: Number.NaN },
      ]),
    ).toBe(false);
    expect(
      isValidAlignmentArray([
        { id: "f000001", text: "hi", begin: 0, end: Infinity },
      ]),
    ).toBe(false);
  });
});

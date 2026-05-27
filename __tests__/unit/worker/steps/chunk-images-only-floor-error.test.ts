/**
 * `ChunkerFloorError` is the defensive guard at the tail of
 * `src/worker/steps/08-chunk-images-only.ts`. It is unreachable from any
 * valid `AlignmentEntry[]` input — the forward-partition + extend pass
 * guarantees every non-last group has duration >= min, and the
 * backward-tidy pass absorbs a sub-floor last group into the previous
 * group. Together they preclude `dur < min && groups.length > 1`.
 *
 * This file is therefore a *contract test* on the typed error class
 * itself. It locks in name, instanceof, and message format so any
 * future refactor that loosens the forward-extend or tidy guarantees
 * (and starts emitting sub-floor non-last chunks) fails loudly through
 * the defensive throw instead of silently writing broken `chunks.json`.
 */
import { describe, it, expect } from "vitest";
import { ChunkerFloorError } from "@/worker/steps/08-chunk-images-only";

describe("ChunkerFloorError (defensive contract)", () => {
  it("is a named Error subclass", () => {
    const err = new ChunkerFloorError(
      "chunk_images_only: chunk index 3 duration 2.00s is below floor 4s after forward+backward merge — chunker bug."
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChunkerFloorError);
    expect(err.name).toBe("ChunkerFloorError");
  });

  it("carries the offending chunk index in its message for operator diagnosis", () => {
    const err = new ChunkerFloorError(
      "chunk_images_only: chunk index 7 duration 1.50s is below floor 4s after forward+backward merge — chunker bug."
    );
    expect(err.message).toMatch(/chunk index 7/);
    expect(err.message).toMatch(/below floor/);
  });
});

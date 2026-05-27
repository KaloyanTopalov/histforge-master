import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHARACTER_REFERENCE_ACCEPTED_MIMES,
  CHARACTER_REFERENCE_BASENAME,
  findCharacterReference,
} from "@/lib/character-reference";

const tmpDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "histforge-char-ref-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("findCharacterReference", () => {
  it("returns null when no reference file exists in the project dir", () => {
    const dir = tempDir();
    expect(findCharacterReference(dir)).toBeNull();
  });

  it("returns the stable basename when the canonical PNG is present", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, CHARACTER_REFERENCE_BASENAME),
      Buffer.from([0x89, 0x50])
    );
    expect(findCharacterReference(dir)).toBe(CHARACTER_REFERENCE_BASENAME);
    // Stability invariant: the upload route always normalizes to this
    // exact name, so the helper has nothing else to probe.
    expect(CHARACTER_REFERENCE_BASENAME).toBe("character_reference.png");
  });

  it("ignores legacy or hand-dropped files under other extensions", () => {
    // Step 3 originally probed multiple extensions; the design switched
    // to a single stable basename so pending Flow queue rows can't be
    // invalidated by a re-upload. Files under any other name are
    // ignored — only the transcoded PNG counts.
    const dir = tempDir();
    writeFileSync(join(dir, "character_reference.jpg"), Buffer.from([0xff]));
    writeFileSync(join(dir, "character_reference.webp"), Buffer.from([0x52]));
    expect(findCharacterReference(dir)).toBeNull();
  });

  it("ignores unrelated files in the project dir", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "narration.mp3"), Buffer.from([0]));
    writeFileSync(join(dir, "alignment.json"), "[]");
    expect(findCharacterReference(dir)).toBeNull();
  });
});

describe("CHARACTER_REFERENCE_ACCEPTED_MIMES", () => {
  it("accepts PNG, JPEG (both mime spellings), and WebP", () => {
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/png")).toBe(true);
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/jpeg")).toBe(true);
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/jpg")).toBe(true);
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/webp")).toBe(true);
  });

  it("rejects formats outside the supported set", () => {
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/gif")).toBe(false);
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("image/bmp")).toBe(false);
    expect(CHARACTER_REFERENCE_ACCEPTED_MIMES.has("application/pdf")).toBe(false);
  });
});

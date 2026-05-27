/**
 * Smoke test for the whisper.cpp aligner against a real narration
 * recording. Skipped unless `WHISPER_SMOKE=1` is set in the env, so the
 * regular unit suite stays fast (real whisper-cli runs take 5-15s).
 *
 * Run with:
 *   WHISPER_SMOKE=1 npx vitest run __tests__/integration/align-whisper-smoke.test.ts
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { align } from "@/lib/align-whisper";

const SMOKE = process.env.WHISPER_SMOKE === "1";

const REPO_ROOT = resolve(__dirname, "../..");
const AUDIO = join(REPO_ROOT, "projects/01KSFPH6BQRQYHQ31WCWZBYK5A/audio/narration.mp3");
const SCRIPT = join(REPO_ROOT, "projects/01KSFPH6BQRQYHQ31WCWZBYK5A/script/full_script.md");
const BIN = join(REPO_ROOT, "vendor/whisper/Release/whisper-cli.exe");
const MODEL = join(REPO_ROOT, "vendor/whisper/ggml-base.en.bin");

const fixturesReady =
  existsSync(AUDIO) && existsSync(SCRIPT) && existsSync(BIN) && existsSync(MODEL);

describe.skipIf(!SMOKE || !fixturesReady)(
  "align-whisper smoke (real whisper-cli)",
  () => {
    it("produces a sensible alignment.json from the bundled narration", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "histforge-align-smoke-"));
      const out = join(tmp, "alignment.json");
      try {
        await align(AUDIO, SCRIPT, out, {
          binPath: BIN,
          modelPath: MODEL,
          repoRoot: REPO_ROOT,
        });

        const entries = JSON.parse(readFileSync(out, "utf-8")) as Array<{
          id: string;
          text: string;
          begin: number;
          end: number;
        }>;

        // Shape invariants — the chunker downstream reads exactly these.
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
          expect(typeof e.id).toBe("string");
          expect(typeof e.text).toBe("string");
          expect(typeof e.begin).toBe("number");
          expect(typeof e.end).toBe("number");
          expect(e.end).toBeGreaterThanOrEqual(e.begin);
        }
        // Monotonic non-decreasing begins.
        for (let i = 1; i < entries.length; i++) {
          expect(entries[i].begin).toBeGreaterThanOrEqual(entries[i - 1].begin);
        }
        // Last entry's end should reach near the audio's total
        // duration (the bundled narration is ~60s).
        expect(entries[entries.length - 1].end).toBeGreaterThan(30);

        // eslint-disable-next-line no-console -- smoke test diagnostic
        console.log(
          `smoke: ${entries.length} entries, first=${entries[0].begin}-${entries[0].end} "${entries[0].text.slice(0, 40)}", last=${entries[entries.length - 1].begin}-${entries[entries.length - 1].end}`
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 60000); // generous timeout for real whisper-cli
  }
);

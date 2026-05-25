import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { synthesizeChatterboxFast } from "@/lib/tts/chatterbox-fast";
import {
  LIVENESS_FAILURE_REASON,
  startChatterboxLivenessWatcher,
} from "@/lib/tts/chatterbox-liveness";

/**
 * Mirrors __tests__/unit/lib/tts/chatterbox.test.ts — same DI shape.
 * Mock fetch (system boundary, HTTP to the local fast sidecar). Inject
 * the WAV→MP3 transcode helper so tests don't have to spawn ffmpeg.
 * Settings + db run real against in-memory SQLite.
 */

const originalFetch = global.fetch;
const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
});

beforeEach(() => {
  // no-op
});

describe("synthesizeChatterboxFast", () => {
  it("POSTs /tts/batch to chatterbox_fast_base_url with the sidecar batch body shape", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_mode", "predefined", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(wavBytes, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const transcode = vi.fn().mockResolvedValue(undefined);

    await synthesizeChatterboxFast("hello", outPath, { db, transcode });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8005/tts/batch");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      chunks: ["hello"],
      voice_mode: "predefined",
      voice_filename: "Abigail.wav",
      temperature: 0.8,
      exaggeration: 0.5,
      cfg_weight: 0.5,
      silence_ms: 150,
      workers: 2,
    });
    // Speed handling moved to the transcode stage — sidecar emits
    // unmodified-tempo WAV.
    expect(body.speed_factor).toBeUndefined();
    // Phase 1 single-`text` field is gone; everything ships as `chunks`.
    expect(body.text).toBeUndefined();
    // Devnen's single-voice fields must NOT be sent — sidecar uses
    // unified `voice_filename`.
    expect(body.predefined_voice_id).toBeUndefined();
    expect(body.reference_audio_filename).toBeUndefined();
  });

  it("splits a long script into multiple chunks via chunkScript and forwards them in order", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    setSetting("chatterbox_fast_max_chunk_chars", 100, db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    // Three sentences each ~70 chars — at maxChars=100 we expect
    // three separate chunks (no two pack together with a 1-char
    // separator below 100).
    const text =
      "The first sentence runs about seventy chars to force a separate chunk hereee. " +
      "The second sentence runs about seventy chars to force a separate chunk hereee. " +
      "The third sentence runs about seventy chars to force a separate chunk hereee.";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast(text, outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(Array.isArray(body.chunks)).toBe(true);
    expect(body.chunks.length).toBeGreaterThanOrEqual(3);
    // Order preservation: every chunk must appear in the original
    // text in the same order it appears in body.chunks.
    let cursor = 0;
    for (const chunk of body.chunks) {
      const idx = text.indexOf(chunk.split(" ").slice(0, 3).join(" "), cursor);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx + chunk.length;
    }
  });

  it("forwards chatterbox_fast_silence_ms and chatterbox_fast_workers verbatim to /tts/batch", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    setSetting("chatterbox_fast_silence_ms", 250, db);
    setSetting("chatterbox_fast_workers", 3, db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.silence_ms).toBe(250);
    expect(body.workers).toBe(3);
  });

  it("logs chunk count via opts.log so 06-voiceover surfaces it", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await synthesizeChatterboxFast("hello world.", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
      log,
    });

    const messages = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(messages).toMatch(/chunk/i);
  });

  it("forwards the same voice_filename in clone mode (sidecar honours voice_mode for the directory split)", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_mode", "clone", db);
    setSetting("chatterbox_voice_filename", "operator-clone.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.voice_mode).toBe("clone");
    expect(body.voice_filename).toBe("operator-clone.wav");
  });

  it("respects chatterbox_fast_base_url override (independent of devnen's chatterbox_base_url)", async () => {
    const db = freshDb();
    // Set the devnen URL to something else to prove it's not what we read.
    setSetting("chatterbox_base_url", "http://127.0.0.1:8004", db);
    setSetting("chatterbox_fast_base_url", "http://192.168.1.50:9005", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://192.168.1.50:9005/tts/batch"
    );
  });

  it("passes chatterbox_speed_factor to the transcode helper as the `speed` opt", async () => {
    // Speed handling lives in ffmpeg atempo, not in the sidecar — see
    // Task 0.2 in docs/plans/2026-05-08-chatterbox-parallelism.md.
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    setSetting("chatterbox_speed_factor", 1.25, db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const transcode = vi.fn().mockResolvedValue(undefined);
    await synthesizeChatterboxFast("hi", outPath, { db, transcode });

    expect(transcode).toHaveBeenCalledTimes(1);
    const transcodeOpts = transcode.mock.calls[0][2] as { speed?: number };
    expect(transcodeOpts.speed).toBe(1.25);
  });

  it("operator-tuned values reach the sidecar body verbatim", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    setSetting("chatterbox_temperature", 1.2, db);
    setSetting("chatterbox_exaggeration", 0.75, db);
    setSetting("chatterbox_cfg_weight", 0.3, db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.temperature).toBe(1.2);
    expect(body.exaggeration).toBe(0.75);
    expect(body.cfg_weight).toBe(0.3);
  });

  it("accepts scripts longer than the Phase 1 t3 ceiling — chunker handles arbitrary lengths now", async () => {
    // Phase 1's 1500-char guard was removed in Phase 2. The chunker
    // splits long scripts into batch chunks each well under the t3
    // text-encoder ceiling, so the sidecar never sees an oversized
    // single generation. Verify a long-script call goes through.
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    // Build a script over 1500 chars made of short sentences — the
    // chunker can split it cleanly.
    const longText =
      "This is one short sentence. ".repeat(80) /* ~2240 chars */;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterboxFast(longText, outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    // Every chunk must respect the configured maxChars (300 default).
    for (const chunk of body.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it("throws a clear error when chatterbox_voice_filename is empty — no HTTP call", async () => {
    const db = freshDb();
    // chatterbox_voice_filename defaults to ""
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const transcode = vi.fn();

    await expect(
      synthesizeChatterboxFast("hi", outPath, { db, transcode })
    ).rejects.toThrow(/Chatterbox.*voice filename.*Settings.*TTS/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });

  it("throws on non-2xx HTTP response (with status + body tail)", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server died", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const transcode = vi.fn();

    await expect(
      synthesizeChatterboxFast("hi", outPath, { db, transcode })
    ).rejects.toThrow(/Chatterbox.*fast.*500.*server died/i);

    expect(transcode).not.toHaveBeenCalled();
  });

  it("propagates AbortError when signal is aborted before fetch", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const transcode = vi.fn();

    const controller = new AbortController();
    controller.abort("user-cancel");

    await expect(
      synthesizeChatterboxFast("hi", outPath, {
        db,
        transcode,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });

  it("user-signal abort propagates to the in-flight fetch (via internal controller)", async () => {
    // Mirrors chatterbox.ts behaviour — the watcher wraps opts.signal in
    // an internal AbortController, so the contract is "fetch is aborted
    // whenever opts.signal aborts" (not "fetch sees opts.signal verbatim").
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          fetchSignal!.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    const promise = synthesizeChatterboxFast("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
      signal: controller.signal,
    });

    await Promise.resolve();
    await Promise.resolve();
    controller.abort("user-cancel");

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(true);
  });

  it("translates a liveness-driven abort into a clear server-down error (not AbortError)", async () => {
    const db = freshDb();
    setSetting("chatterbox_fast_base_url", "http://127.0.0.1:8005", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const startLivenessWatcher: typeof startChatterboxLivenessWatcher = (
      opts
    ) => {
      queueMicrotask(() => {
        opts.controller.abort(LIVENESS_FAILURE_REASON);
      });
      return { stop: () => {}, getFailureSummary: () => undefined };
    };

    await expect(
      synthesizeChatterboxFast("hi", outPath, {
        db,
        transcode: vi.fn().mockResolvedValue(undefined),
        startLivenessWatcher,
      })
    ).rejects.toThrow(
      /Chatterbox \(fast\) server unreachable.*127\.0\.0\.1:8005/i
    );
  });

  it("interpolates the watcher's failure summary into the thrown error", async () => {
    // Same contract as chatterbox.ts: the failure-mode summary (timeouts
    // vs ECONNREFUSED) must reach the dashboard error message.
    const db = freshDb();
    setSetting("chatterbox_fast_base_url", "http://127.0.0.1:8005", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const startLivenessWatcher: typeof startChatterboxLivenessWatcher = (
      opts
    ) => {
      queueMicrotask(() => {
        opts.controller.abort(LIVENESS_FAILURE_REASON);
      });
      return {
        stop: () => {},
        getFailureSummary: () =>
          "3 connection errors in a row (ECONNREFUSED) — server appears to have stopped",
      };
    };

    await expect(
      synthesizeChatterboxFast("hi", outPath, {
        db,
        transcode: vi.fn().mockResolvedValue(undefined),
        startLivenessWatcher,
      })
    ).rejects.toThrow(/ECONNREFUSED.*server appears to have stopped/i);
  });
});

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
import { synthesizeChatterbox } from "@/lib/tts/chatterbox";
import {
  LIVENESS_FAILURE_REASON,
  startChatterboxLivenessWatcher,
} from "@/lib/tts/chatterbox-liveness";

/**
 * Chatterbox provider tests. Mock `fetch` (system boundary — HTTP to
 * the local devnen wrapper). Inject the WAV→MP3 transcode helper so
 * tests don't have to spawn ffmpeg. Settings + db run real against
 * in-memory SQLite.
 *
 * Tests target `synthesizeChatterbox` directly so the `transcode`
 * injection point stays off the cross-provider `TtsProvider` opts
 * surface. The registry's `chatterboxProvider.synthesize` is just an
 * adapter around this function with the narrower contract.
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

describe("synthesizeChatterbox", () => {
  it("predefined mode: POSTs /tts with predefined_voice_id, no reference_audio_filename, transcodes WAV → MP3 with atempo speed", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_mode", "predefined", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);
    setSetting("chatterbox_speed_factor", 0.85, db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(wavBytes, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const transcode = vi.fn().mockResolvedValue(undefined);

    const result = await synthesizeChatterbox("hello", outPath, {
      db,
      transcode,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8004/tts");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      text: "hello",
      voice_mode: "predefined",
      predefined_voice_id: "Abigail.wav",
      output_format: "wav",
      temperature: 0.8,
      exaggeration: 0.5,
      cfg_weight: 0.5,
    });
    expect(body.speed_factor).toBeUndefined();
    expect(body.reference_audio_filename).toBeUndefined();

    expect(transcode).toHaveBeenCalledTimes(1);
    const [bytesArg, pathArg, transcodeOpts] = transcode.mock.calls[0];
    expect(new Uint8Array(bytesArg as Buffer)).toEqual(wavBytes);
    expect(pathArg).toBe(outPath);
    expect((transcodeOpts as { speed?: number }).speed).toBe(0.85);

    expect(result).toEqual({});
  });

  it("clone mode: POSTs /tts with reference_audio_filename, no predefined_voice_id", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_mode", "clone", db);
    setSetting("chatterbox_voice_filename", "operator-clone.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterbox("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.voice_mode).toBe("clone");
    expect(body.reference_audio_filename).toBe("operator-clone.wav");
    expect(body.predefined_voice_id).toBeUndefined();
  });

  it("body never includes seed (no HistForge setting → wrapper picks)", async () => {
    // Tuning params (temperature, exaggeration, cfg_weight) ARE sent
    // explicitly — see the predefined-mode test above and the operator-
    // override test below. `seed` has no HistForge equivalent yet, so
    // the wrapper still picks it.
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterbox("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.seed).toBeUndefined();
  });

  it("operator-tuned values reach the /tts body verbatim (temperature, exaggeration, cfg_weight)", async () => {
    // Locks the wrapper-side behavior we sell in the docs: what's in
    // Settings → TTS is what runs, regardless of any sliders in the
    // wrapper's web UI at localhost:8004.
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

    await synthesizeChatterbox("hi", outPath, {
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

  it("respects chatterbox_base_url override (e.g. operator changed port)", async () => {
    const db = freshDb();
    setSetting("chatterbox_base_url", "http://192.168.1.50:9000", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeChatterbox("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://192.168.1.50:9000/tts"
    );
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
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode,
      })
    ).rejects.toThrow(/Chatterbox voice filename.*Settings.*TTS/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });

  it("throws Chatterbox <verb> <status>: <body> on non-2xx HTTP response", async () => {
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
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode,
      })
    ).rejects.toThrow(/Chatterbox synthesize 500.*server died/);

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
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });

  it("propagates AbortError when fetch rejects with AbortError mid-flight", async () => {
    const db = freshDb();
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      const err = new Error("aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const transcode = vi.fn();

    const controller = new AbortController();

    await expect(
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(transcode).not.toHaveBeenCalled();
  });

  it("user-signal abort propagates to the in-flight fetch (via internal controller)", async () => {
    // Synthesize wraps opts.signal in an internal AbortController so the
    // liveness watcher can compose with user-cancel onto a single signal.
    // The contract is no longer "fetch sees opts.signal verbatim" — it's
    // "fetch is aborted whenever opts.signal aborts".
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
    const promise = synthesizeChatterbox("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
      signal: controller.signal,
    });

    // Let synthesize register its abort forwarder before we cancel.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort("user-cancel");

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(true);
  });

  it("translates a liveness-driven abort into a clear server-down error (not AbortError)", async () => {
    // When the liveness watcher trips (3 consecutive /health probe
    // failures), it aborts the internal controller. fetch then rejects
    // with AbortError. Synthesize must catch that and re-throw a clear
    // server-down Error so the worker doesn't mistake it for user
    // cancellation.
    const db = freshDb();
    setSetting("chatterbox_base_url", "http://127.0.0.1:9999", db);
    setSetting("chatterbox_voice_filename", "Abigail.wav", db);

    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    // fetch hangs until its signal aborts — gives the watcher time to
    // trigger and abort the internal controller.
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

    // Inject a watcher fake that aborts the controller immediately
    // with the LIVENESS_FAILURE_REASON. Mirrors what the real watcher
    // does after maxConsecutiveFailures probes fail.
    const startLivenessWatcher: typeof startChatterboxLivenessWatcher = (
      opts
    ) => {
      // Defer one microtask so the synthesize fetch is in flight before
      // we abort — exercises the catch path rather than a pre-fetch throw.
      queueMicrotask(() => {
        opts.controller.abort(LIVENESS_FAILURE_REASON);
      });
      return { stop: () => {}, getFailureSummary: () => undefined };
    };

    await expect(
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode: vi.fn().mockResolvedValue(undefined),
        startLivenessWatcher,
      })
    ).rejects.toThrow(/Chatterbox server unreachable.*127\.0\.0\.1:9999/i);
  });

  it("interpolates the watcher's failure summary into the thrown error", async () => {
    // Operators read the failed-step message in the dashboard before
    // they tail pipeline.log. The watcher's summary (e.g. how many
    // ECONNREFUSED in a row) must reach the error so the dashboard
    // surfaces the actionable signal.
    const db = freshDb();
    setSetting("chatterbox_base_url", "http://127.0.0.1:9999", db);
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
          "3 connection errors in a row (ECONNREFUSED) — server appears to have stopped or never started",
      };
    };

    await expect(
      synthesizeChatterbox("hi", outPath, {
        db,
        transcode: vi.fn().mockResolvedValue(undefined),
        startLivenessWatcher,
      })
    ).rejects.toThrow(/ECONNREFUSED.*stopped or never started/i);
  });

  it("user-cancel during a liveness-armed run still surfaces as AbortError, not server-down", async () => {
    // If the watcher is armed but the user cancels first, the internal
    // controller's reason becomes whatever the user set — never
    // LIVENESS_FAILURE_REASON. The original AbortError must propagate
    // verbatim so the worker treats it as cancellation.
    const db = freshDb();
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

    // Real-shaped watcher fake: never aborts the controller itself.
    const startLivenessWatcher: typeof startChatterboxLivenessWatcher = () => ({
      stop: () => {},
      getFailureSummary: () => undefined,
    });

    const controller = new AbortController();
    const promise = synthesizeChatterbox("hi", outPath, {
      db,
      transcode: vi.fn().mockResolvedValue(undefined),
      signal: controller.signal,
      startLivenessWatcher,
    });

    await Promise.resolve();
    await Promise.resolve();
    controller.abort("delete_requested");

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

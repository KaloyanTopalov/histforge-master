import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { genaiproProvider } from "@/lib/tts/genaipro";

/**
 * GenAIPro TTS client tests. Mock `fetch` (system boundary — HTTP to
 * genaipro.vn). Everything else (settings, db, filesystem) runs real
 * against in-memory SQLite and a tmp dir. Mirrors the AI33 test layout.
 */

const originalFetch = global.fetch;
const originalApiKey = process.env.GENAIPRO_API_KEY;
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

beforeEach(() => {
  process.env.GENAIPRO_API_KEY = "test-genaipro-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.GENAIPRO_API_KEY = originalApiKey;
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

describe("genaiproProvider.synthesize", () => {
  it("submits with flat body, polls until completed, downloads MP3, exports + downloads SRT", async () => {
    const db = freshDb();
    setSetting("voice_id", "alice-v1", db);
    setSetting("voiceover_model_id", "eleven_turbo_v2_5", db);
    setSetting("voice_stability", 0.65, db);
    setSetting("voice_similarity", 0.55, db);
    setSetting("voice_style", 0.1, db);
    setSetting("voice_speed", 1.05, db);
    setSetting("voice_use_speaker_boost", true, db);

    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    expect(existsSync(audioDir)).toBe(false);

    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    const srtContent = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";

    const fetchMock = vi
      .fn()
      // 1. submit
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_abc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      // 2. main poll: still processing
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_abc",
            status: "processing",
            result: null,
            subtitle: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // 3. main poll: completed with result
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_abc",
            status: "completed",
            result: "https://media.genaipro.vn/audio/abc.mp3",
            subtitle: "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // 4. download MP3
      .mockResolvedValueOnce(new Response(mp3Bytes, { status: 200 }))
      // 5. subtitle export
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      // 6. subtitle poll: subtitle URL populated
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_abc",
            status: "completed",
            result: "https://media.genaipro.vn/audio/abc.mp3",
            subtitle: "https://media.genaipro.vn/audio/abc.srt",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // 7. download SRT
      .mockResolvedValueOnce(new Response(srtContent, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await genaiproProvider.synthesize("the story", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(7);

    // Submit: POST /v1/labs/task with Bearer auth, flat body shape.
    const [submitUrl, submitInit] = fetchMock.mock.calls[0];
    expect(submitUrl).toBe("https://genaipro.vn/api/v1/labs/task");
    const submitInitTyped = submitInit as RequestInit;
    expect(submitInitTyped.method).toBe("POST");
    expect(submitInitTyped.headers).toMatchObject({
      Authorization: "Bearer test-genaipro-key",
      "Content-Type": "application/json",
    });
    const submitBody = JSON.parse(submitInitTyped.body as string);
    expect(submitBody).toEqual({
      input: "the story",
      model_id: "eleven_turbo_v2_5",
      voice_id: "alice-v1",
      similarity: 0.55,
      speed: 1.05,
      stability: 0.65,
      style: 0.1,
      use_speaker_boost: true,
    });

    // Poll: GET /v1/labs/task/{task_id}
    const [pollUrl1, pollInit1] = fetchMock.mock.calls[1];
    expect(pollUrl1).toBe("https://genaipro.vn/api/v1/labs/task/t_abc");
    expect((pollInit1 as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-genaipro-key",
    });

    // Download MP3.
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://media.genaipro.vn/audio/abc.mp3"
    );

    // Subtitle export: POST /v1/labs/task/subtitle/{task_id}
    const [exportUrl, exportInit] = fetchMock.mock.calls[4];
    expect(exportUrl).toBe(
      "https://genaipro.vn/api/v1/labs/task/subtitle/t_abc"
    );
    expect((exportInit as RequestInit).method).toBe("POST");
    expect((exportInit as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-genaipro-key",
    });
    const exportBody = JSON.parse((exportInit as RequestInit).body as string);
    expect(exportBody).toMatchObject({
      max_characters_per_line: expect.any(Number),
      max_lines_per_cue: expect.any(Number),
      max_seconds_per_cue: expect.any(Number),
    });

    // Subtitle poll: same task URL, returns subtitle URL.
    expect(fetchMock.mock.calls[5][0]).toBe(
      "https://genaipro.vn/api/v1/labs/task/t_abc"
    );

    // Download SRT.
    expect(fetchMock.mock.calls[6][0]).toBe(
      "https://media.genaipro.vn/audio/abc.srt"
    );

    // Files on disk.
    expect(new Uint8Array(readFileSync(outPath))).toEqual(mp3Bytes);
    expect(readFileSync(join(audioDir, "narration.srt"), "utf-8")).toBe(
      srtContent
    );
    // No JSON transcript — the LabTask shape doesn't expose one.
    expect(existsSync(join(audioDir, "narration.json"))).toBe(false);

    expect(result).toEqual({
      transcripts: { srtPath: join(audioDir, "narration.srt") },
    });
  });

  it("throws immediately when GENAIPRO_API_KEY is missing", async () => {
    const db = freshDb();
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");
    delete process.env.GENAIPRO_API_KEY;

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      genaiproProvider.synthesize("hello", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      } as never)
    ).rejects.toThrow(/GENAIPRO_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries submit on transient HTTP failures and proceeds once it succeeds", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      // submit attempt 1: transient 503
      .mockResolvedValueOnce(
        new Response("upstream unavailable", { status: 503 })
      )
      // submit attempt 2: transient 502
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      // submit attempt 3: succeeds
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_retry" }), { status: 200 })
      )
      // main poll: immediately completed
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/r.mp3",
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      )
      // subtitle export 500 — best-effort, swallowed
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await genaiproProvider.synthesize("hello", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    // Three submit attempts hitting the same URL.
    const submitUrl = "https://genaipro.vn/api/v1/labs/task";
    expect(fetchMock.mock.calls[0][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[1][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[2][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://genaipro.vn/api/v1/labs/task/t_retry"
    );
    expect(fetchMock.mock.calls[4][0]).toBe("https://cdn.example.com/r.mp3");
  });

  it("throws after exhausting submit retries (3 total attempts)", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      genaiproProvider.synthesize("hello", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      } as never)
    ).rejects.toThrow(/503/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("swallows transient poll failures and keeps polling until completed", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      // submit
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_flaky" }), { status: 200 })
      )
      // poll 1: 503 transient
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      // poll 2: network error
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      // poll 3: completed
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/ok.mp3",
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xaa, 0xbb]), { status: 200 })
      )
      // subtitle export 500 — swallowed
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    expect(readFileSync(outPath)).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it("throws after MAX_CONSECUTIVE_POLL_FAILURES consecutive non-fatal poll failures", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    // submit succeeds, every subsequent poll returns 503 forever.
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ task_id: "t_dead" }), {
          status: 200,
        });
      }
      return new Response("upstream down", { status: 503 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      genaiproProvider.synthesize("hi", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      } as never)
    ).rejects.toThrow(/consecutive poll failures/i);

    // 1 submit + exactly 60 poll attempts (the bound) before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(61);
  });

  it("logs once and keeps polling when poll response shape does not match schema", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_shape" }), { status: 200 })
      )
      // wrong shape: no `status` field
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "processing" }), { status: 200 })
      )
      // same wrong shape — must NOT produce a second log line
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "processing" }), { status: 200 })
      )
      // well-shaped completed response
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/s.mp3",
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
      // subtitle export 500 — swallowed
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    } as never);

    const schemaLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /schema/i.test(m));
    expect(schemaLogs).toHaveLength(1);
  });

  it("propagates AbortError when signal is aborted before submit", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort("test-cancel");

    await expect(
      genaiproProvider.synthesize("hi", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
        signal: controller.signal,
      } as never)
    ).rejects.toThrow(/Cancelled/);

    // Aborted before any network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates AbortError when signal is aborted mid-poll", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const controller = new AbortController();

    const fetchMock = vi
      .fn()
      // submit succeeds
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_cancel" }), { status: 200 })
      )
      // first poll: trigger abort, then return processing
      .mockImplementationOnce(async () => {
        controller.abort("user-cancel");
        const err = new Error("Cancelled: user-cancel");
        err.name = "AbortError";
        throw err;
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      genaiproProvider.synthesize("hi", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
        signal: controller.signal,
      } as never)
    ).rejects.toThrow(/Cancelled/);

    // Submit + one poll attempt; no download.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("writes the .tts_task_id sidecar after submit and deletes it after a successful download", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    const sidecarPath = join(audioDir, ".tts_task_id");

    let sidecarAtPoll: { exists: boolean; contents: string | null } = {
      exists: false,
      contents: null,
    };

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        // submit
        if (
          url === "https://genaipro.vn/api/v1/labs/task" &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ task_id: "t_persist" }),
            { status: 200 }
          );
        }
        // subtitle export
        if (url.includes("/subtitle/")) {
          return new Response("", { status: 500 });
        }
        // main task poll
        if (url.includes("/v1/labs/task/")) {
          sidecarAtPoll = {
            exists: existsSync(sidecarPath),
            contents: existsSync(sidecarPath)
              ? readFileSync(sidecarPath, "utf-8")
              : null,
          };
          return new Response(
            JSON.stringify({
              status: "completed",
              result: "https://cdn.example.com/p.mp3",
            }),
            { status: 200 }
          );
        }
        // download
        return new Response(new Uint8Array([0xab]), { status: 200 });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    expect(sidecarAtPoll.exists).toBe(true);
    expect(sidecarAtPoll.contents).toBe("t_persist");
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("resumes from an existing sidecar — skips submit, polls the existing task_id, deletes sidecar after success", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    const sidecarPath = join(audioDir, ".tts_task_id");

    mkdirSync(audioDir, { recursive: true });
    writeFileSync(sidecarPath, "t_resumed_42");

    const fetchMock = vi
      .fn()
      // poll: completed
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/r.mp3",
          }),
          { status: 200 }
        )
      )
      // download
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x10, 0x20]), { status: 200 })
      )
      // subtitle export 500 — swallowed
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    } as never);

    // First fetch is GET poll, not POST submit.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://genaipro.vn/api/v1/labs/task/t_resumed_42"
    );
    const pollInit = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(pollInit?.method ?? "GET").toBe("GET");

    const logLines = log.mock.calls.map((c) => c[0] as string);
    expect(logLines.some((m) => /resuming task t_resumed_42/i.test(m))).toBe(
      true
    );
    expect(logLines.some((m) => /GenAIPro task submitted/i.test(m))).toBe(false);

    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("treats a whitespace-only sidecar as missing — submits a fresh task", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    const sidecarPath = join(audioDir, ".tts_task_id");

    mkdirSync(audioDir, { recursive: true });
    writeFileSync(sidecarPath, "   \n");

    let sidecarAtPoll: string | null = null;

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (
          url === "https://genaipro.vn/api/v1/labs/task" &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ task_id: "t_fresh" }),
            { status: 200 }
          );
        }
        if (url.includes("/subtitle/")) {
          return new Response("", { status: 500 });
        }
        if (url.includes("/v1/labs/task/")) {
          sidecarAtPoll = existsSync(sidecarPath)
            ? readFileSync(sidecarPath, "utf-8")
            : null;
          return new Response(
            JSON.stringify({
              status: "completed",
              result: "https://cdn.example.com/f.mp3",
            }),
            { status: 200 }
          );
        }
        return new Response(new Uint8Array([0xff]), { status: 200 });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    // First call is the fresh submit POST.
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    // Poll uses the freshly-issued task_id.
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://genaipro.vn/api/v1/labs/task/t_fresh"
    );
    expect(sidecarAtPoll).toBe("t_fresh");
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("downloads MP3 even when subtitle export fails — TtsResult has no transcripts", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_no_sub" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/no_sub.mp3",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xfb]), { status: 200 })
      )
      // subtitle export: 500 — best-effort, swallowed
      .mockResolvedValueOnce(new Response("internal error", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    // submit + 1 poll + download + subtitle export = 4 calls. No subtitle poll
    // because export itself failed.
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(new Uint8Array(readFileSync(outPath))).toEqual(
      new Uint8Array([0xff, 0xfb])
    );
    expect(existsSync(join(audioDir, "narration.srt"))).toBe(false);

    expect(result).toEqual({});
  });

  it("downloads MP3 even when subtitle URL never populates within the cap", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      // submit
      if (
        url === "https://genaipro.vn/api/v1/labs/task" &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ task_id: "t_slow_sub" }), {
          status: 200,
        });
      }
      // subtitle export: 200 OK, but the field never populates
      if (url.includes("/subtitle/")) {
        return new Response("", { status: 200 });
      }
      // every poll returns completed, subtitle empty
      if (url.includes("/v1/labs/task/")) {
        return new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/slow.mp3",
            subtitle: "",
          }),
          { status: 200 }
        );
      }
      // download
      return new Response(new Uint8Array([0xab, 0xcd]), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    } as never);

    // MP3 downloaded; no SRT despite multiple polls.
    expect(new Uint8Array(readFileSync(outPath))).toEqual(
      new Uint8Array([0xab, 0xcd])
    );
    expect(existsSync(join(audioDir, "narration.srt"))).toBe(false);
    expect(result).toEqual({});
  });

  it("logs unknown poll status values once per distinct value and keeps polling", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "t_unk" }), { status: 200 })
      )
      // first unknown status
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "queued" }), { status: 200 })
      )
      // same unknown status — must NOT produce a second log line
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "queued" }), { status: 200 })
      )
      // different unknown status
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "retrying" }), { status: 200 })
      )
      // completed
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: "https://cdn.example.com/u.mp3",
          }),
          { status: 200 }
        )
      )
      // download
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      // subtitle export 500 — swallowed
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await genaiproProvider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    } as never);

    const unknownLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /unknown poll status/i.test(m));
    expect(unknownLogs).toHaveLength(2);
    expect(unknownLogs[0]).toMatch(/queued/);
    expect(unknownLogs[1]).toMatch(/retrying/);
  });
});

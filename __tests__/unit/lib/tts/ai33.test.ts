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
import { ai33Provider } from "@/lib/tts/ai33";

/**
 * AI33 TTS client tests. Mock `fetch` (system boundary — HTTP to
 * api.ai33.pro). Everything else (settings, db, filesystem) runs real
 * against in-memory SQLite and a tmp dir.
 */

const originalFetch = global.fetch;
const originalApiKey = process.env.AI33_API_KEY;
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
  process.env.AI33_API_KEY = "test-ai33-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.AI33_API_KEY = originalApiKey;
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

describe("ai33Provider.synthesize", () => {
  it("submits, polls until done, downloads MP3 + transcripts, returns TtsResult", async () => {
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
    // Audio subdir must NOT exist — the client creates it.
    expect(existsSync(audioDir)).toBe(false);

    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    const srtContent = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";
    const jsonContent = JSON.stringify({ words: [{ text: "Hello" }] });

    const fetchMock = vi
      .fn()
      // submit
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            task_id: "t_abc",
            ec_remain_credits: 100,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // poll 1: still doing
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_abc",
            status: "doing",
            error_message: null,
            metadata: {},
            progress: 50,
            type: "tts",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // poll 2: done with all URLs
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_abc",
            status: "done",
            error_message: null,
            metadata: {
              audio_url: "https://cdn.example.com/audio.mp3",
              srt_url: "https://cdn.example.com/audio.srt",
              json_url: "https://cdn.example.com/audio.json",
            },
            progress: 100,
            type: "tts",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(mp3Bytes, { status: 200 })
      )
      // download SRT
      .mockResolvedValueOnce(
        new Response(srtContent, { status: 200 })
      )
      // download JSON
      .mockResolvedValueOnce(
        new Response(jsonContent, { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await ai33Provider.synthesize("the story", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Submit: POST to /v1/text-to-speech/{voice_id} with ElevenLabs body.
    const [submitUrl, submitInit] = fetchMock.mock.calls[0];
    expect(submitUrl).toBe(
      "https://api.ai33.pro/v1/text-to-speech/alice-v1?output_format=mp3_44100_128"
    );
    expect((submitInit as RequestInit).method).toBe("POST");
    expect((submitInit as RequestInit).headers).toMatchObject({
      "xi-api-key": "test-ai33-key",
      "Content-Type": "application/json",
    });
    const submitBody = JSON.parse((submitInit as RequestInit).body as string);
    expect(submitBody).toEqual({
      text: "the story",
      model_id: "eleven_turbo_v2_5",
      with_transcript: true,
      voice_settings: {
        stability: 0.65,
        similarity_boost: 0.55,
        style: 0.1,
        use_speaker_boost: true,
        speed: 1.05,
      },
    });

    // Polls: GET /v1/task/{task_id} with xi-api-key header.
    const [pollUrl1, pollInit1] = fetchMock.mock.calls[1];
    expect(pollUrl1).toBe("https://api.ai33.pro/v1/task/t_abc");
    expect((pollInit1 as RequestInit).headers).toMatchObject({
      "xi-api-key": "test-ai33-key",
    });

    // Downloads: MP3 + SRT + JSON.
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://cdn.example.com/audio.mp3"
    );
    expect(fetchMock.mock.calls[4][0]).toBe(
      "https://cdn.example.com/audio.srt"
    );
    expect(fetchMock.mock.calls[5][0]).toBe(
      "https://cdn.example.com/audio.json"
    );

    // Files on disk.
    expect(new Uint8Array(readFileSync(outPath))).toEqual(mp3Bytes);
    expect(readFileSync(join(audioDir, "narration.srt"), "utf-8")).toBe(
      srtContent
    );
    expect(readFileSync(join(audioDir, "narration.json"), "utf-8")).toBe(
      jsonContent
    );

    // TtsResult includes transcript paths.
    expect(result).toEqual({
      transcripts: {
        srtPath: join(audioDir, "narration.srt"),
        jsonPath: join(audioDir, "narration.json"),
      },
    });
  });

  it("throws immediately when AI33_API_KEY is missing", async () => {
    const db = freshDb();
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");
    delete process.env.AI33_API_KEY;

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ai33Provider.synthesize("hello", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(/AI33_API_KEY/);

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
      .mockResolvedValueOnce(
        new Response("bad gateway", { status: 502 })
      )
      // submit attempt 3: succeeds
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, task_id: "t_retry" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      // poll: immediately done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/r.mp3" },
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ai33Provider.synthesize("hello", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

    // Two failed submits + successful submit + one poll + download.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // All three submit attempts hit the same URL.
    const submitUrl =
      "https://api.ai33.pro/v1/text-to-speech/v1?output_format=mp3_44100_128";
    expect(fetchMock.mock.calls[0][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[1][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[2][0]).toBe(submitUrl);
    // Poll.
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://api.ai33.pro/v1/task/t_retry"
    );
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
      ai33Provider.synthesize("hello", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(/503/);

    // Exactly 3 submit calls, no poll/download.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("swallows transient poll failures and keeps polling until done", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_flaky" }), {
          status: 200,
        })
      )
      // poll 1: 503 transient
      .mockResolvedValueOnce(
        new Response("upstream down", { status: 503 })
      )
      // poll 2: network error
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      // poll 3: done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/ok.mp3" },
          }),
          { status: 200 }
        )
      )
      // download
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xaa, 0xbb]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

    // submit + three polls (two transient + one success) + download.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(readFileSync(outPath)).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it("throws when poll returns status=error with error_message", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_fail" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "error",
            error_message: "Voice model not found",
          }),
          { status: 200 }
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ai33Provider.synthesize("hello", outPath, {
        db,
        retryDelayMs: 0,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(/Voice model not found/);

    // submit + one poll, no download.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs unknown poll status values once per distinct value and keeps polling", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_unk" }), {
          status: 200,
        })
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
      // done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/u.mp3" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // Two distinct unknown statuses → two "unknown" log lines, not four.
    const unknownLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /unknown poll status/i.test(m));
    expect(unknownLogs).toHaveLength(2);
    expect(unknownLogs[0]).toMatch(/queued/);
    expect(unknownLogs[1]).toMatch(/retrying/);
  });

  it("logs once and keeps polling when poll response shape does not match schema", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_shape" }), {
          status: 200,
        })
      )
      // wrong shape: no `status` field
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "processing" }), { status: 200 })
      )
      // same wrong shape — must NOT produce a second log line
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "processing" }), { status: 200 })
      )
      // well-shaped done response
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/s.mp3" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([2]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // One distinct shape problem → exactly one schema log line
    // (other diagnostic log lines may also be emitted — submit, completion, etc).
    const schemaLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /schema/i.test(m));
    expect(schemaLogs).toHaveLength(1);
  });

  it("accepts real AI33 in-progress poll shape where audio_url is null", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_null" }), {
          status: 200,
        })
      )
      // Real AI33 in-progress response: metadata.audio_url is null, not absent.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_null",
            created_at: "2026-04-23T10:11:55.794Z",
            status: "doing",
            credit_cost: 27966,
            metadata: {
              data: {
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                  speed: 1,
                  style: 0,
                  stability: 0.75,
                  similarity_boost: 0.5,
                  use_speaker_boost: true,
                },
                with_transcript: true,
              },
              query: { output_format: "mp3_44100_128" },
              voice_id: "G17SuINrv2H9FC6nvetn",
              audio_url: null,
            },
            progress: 10,
            type: "tts",
          }),
          { status: 200 }
        )
      )
      // done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/r.mp3" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // The null audio_url during "doing" must NOT trigger a schema warning.
    const schemaLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /schema|did not match/i.test(m));
    expect(schemaLogs).toHaveLength(0);
    // submit + two polls + download.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("accepts real AI33 in-progress poll shape where progress is null", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_pn" }), {
          status: 200,
        })
      )
      // Real AI33 in-progress response captured from production: progress is
      // null (not a number, not absent) while the task is "doing".
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "t_pn",
            created_at: "2026-04-30T18:04:19.156Z",
            status: "doing",
            credit_cost: 15374,
            metadata: {
              data: {
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                  speed: 1,
                  style: 0,
                  stability: 0.75,
                  similarity_boost: 0.5,
                  use_speaker_boost: true,
                },
                with_transcript: true,
              },
              query: { output_format: "mp3_44100_128" },
              voice_id: "G17SuINrv2H9FC6nvetn",
              audio_url: null,
            },
            progress: null,
            type: "tts",
          }),
          { status: 200 }
        )
      )
      // done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/p.mp3" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([7]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // The null progress during "doing" must NOT trigger a schema warning,
    // otherwise the poll loop spins forever without inspecting status.
    const schemaLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /schema|did not match/i.test(m));
    expect(schemaLogs).toHaveLength(0);
    // submit + two polls + download.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("handles missing transcript URLs gracefully — MP3 still downloads", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, task_id: "t_no_tx" }), {
          status: 200,
        })
      )
      // done with audio_url only — srt_url and json_url are null
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: {
              audio_url: "https://cdn.example.com/notx.mp3",
              srt_url: null,
              json_url: null,
            },
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xfb]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

    // Only 3 calls — no transcript downloads.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Uint8Array(readFileSync(outPath))).toEqual(
      new Uint8Array([0xff, 0xfb])
    );
    // No SRT/JSON on disk.
    expect(existsSync(join(projectDir, "audio", "narration.srt"))).toBe(false);
    expect(existsSync(join(projectDir, "audio", "narration.json"))).toBe(
      false
    );
    // TtsResult reflects no transcripts.
    expect(result).toEqual({});
  });

  it("writes the .tts_task_id sidecar after submit and deletes it after a successful download", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    const sidecarPath = join(audioDir, ".tts_task_id");

    // Snapshot sidecar state at the moment of polling — between submit and
    // the final download — to confirm it's persisted before any wait.
    let sidecarAtPoll: { exists: boolean; contents: string | null } = {
      exists: false,
      contents: null,
    };

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({ success: true, task_id: "t_persist" }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/task/")) {
          sidecarAtPoll = {
            exists: existsSync(sidecarPath),
            contents: existsSync(sidecarPath)
              ? readFileSync(sidecarPath, "utf-8")
              : null,
          };
          return new Response(
            JSON.stringify({
              status: "done",
              metadata: { audio_url: "https://cdn.example.com/p.mp3" },
            }),
            { status: 200 }
          );
        }
        return new Response(new Uint8Array([0xab]), { status: 200 });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

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

    // Pre-create the sidecar — simulates a worker that died mid-poll.
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(sidecarPath, "t_resumed_42");

    const fetchMock = vi
      .fn()
      // poll: immediately done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/r.mp3" },
          }),
          { status: 200 }
        )
      )
      // download MP3
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x10, 0x20]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // No POST — only GET poll + download.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.ai33.pro/v1/task/t_resumed_42"
    );
    const pollInit = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(pollInit?.method ?? "GET").toBe("GET");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example.com/r.mp3");

    // A resume log line was emitted, distinct from the "submitted" line.
    const logLines = log.mock.calls.map((c) => c[0] as string);
    expect(logLines.some((m) => /resuming task t_resumed_42/i.test(m))).toBe(
      true
    );
    expect(logLines.some((m) => /AI33 task submitted/i.test(m))).toBe(false);

    // Sidecar wiped after success.
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("treats a whitespace-only sidecar as missing — submits a fresh task and overwrites the file", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");
    const sidecarPath = join(audioDir, ".tts_task_id");

    // Pre-existing sidecar with only whitespace — torn write or hand-edit.
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(sidecarPath, "   \n");

    let sidecarAtPoll: string | null = null;

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({ success: true, task_id: "t_fresh" }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/task/")) {
          sidecarAtPoll = existsSync(sidecarPath)
            ? readFileSync(sidecarPath, "utf-8")
            : null;
          return new Response(
            JSON.stringify({
              status: "done",
              metadata: { audio_url: "https://cdn.example.com/f.mp3" },
            }),
            { status: 200 }
          );
        }
        return new Response(new Uint8Array([0xff]), { status: 200 });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
    });

    // submit + poll + download = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    // Poll uses the freshly-issued task_id, not the whitespace contents.
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.ai33.pro/v1/task/t_fresh"
    );
    // Sidecar was overwritten with the new task_id during the run.
    expect(sidecarAtPoll).toBe("t_fresh");
    // And cleaned up after success.
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("does not fail synthesize when the sidecar write throws — proceeds with the in-memory task_id", async () => {
    const db = freshDb();
    setSetting("voice_id", "v1", db);
    const projectDir = tempDir("project");
    const audioDir = join(projectDir, "audio");
    const outPath = join(audioDir, "narration.mp3");

    // Force the sidecar's atomic write to fail without resorting to fs
    // module mocks: pre-create `.tts_task_id.tmp` as a *directory* so the
    // production code's `writeFileSync(tmp, ...)` throws EISDIR.
    mkdirSync(audioDir, { recursive: true });
    mkdirSync(join(audioDir, ".tts_task_id.tmp"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, task_id: "t_inmem" }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { audio_url: "https://cdn.example.com/im.mp3" },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xc0, 0xde]), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const log = vi.fn();
    await ai33Provider.synthesize("hi", outPath, {
      db,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      log,
    });

    // Synthesize ran end-to-end on the in-memory task_id.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.ai33.pro/v1/task/t_inmem"
    );
    expect(new Uint8Array(readFileSync(outPath))).toEqual(
      new Uint8Array([0xc0, 0xde])
    );

    // A diagnostic line tells the operator the sidecar didn't land.
    const failureLogs = log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => /sidecar write failed/i.test(m));
    expect(failureLogs).toHaveLength(1);
  });
});

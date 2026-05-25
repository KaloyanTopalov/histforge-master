import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { chat } from "@/lib/llm/openrouter";

/**
 * OpenRouter client tests. We mock the `fetch` global — that's the system
 * boundary (HTTP to api.openrouter.ai) per mocking.md.
 *
 * Provider is a pure transport: callers must pass `opts.model` explicitly;
 * the pipeline boundary resolves the per-purpose model from settings. No
 * DB or settings imports here — provider has no awareness of either.
 */

const originalFetch = global.fetch;
const originalApiKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.OPENROUTER_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("chat", () => {
  it("posts messages to OpenRouter and returns choices[0].message.content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "the answer" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await chat(
      [{ role: "user", content: "hi" }],
      { model: "openai/gpt-4o", retryDelayMs: 0 }
    );

    expect(result).toBe("the answer");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
  });

  it("throws when opts.model is missing — provider is a pure transport", async () => {
    // Per-purpose model resolution moved to the pipeline boundary
    // (worker/pipeline.ts:resolveDeps). The provider must refuse to guess
    // a model so a missing wrapper surfaces as a clear error instead of
    // silently picking the wrong setting.
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], { retryDelayMs: 0 })
    ).rejects.toThrow(/opts\.model is required/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when opts.model is the empty string", async () => {
    // Belt-and-suspenders: the new openrouter_*_model defaults are `""`,
    // so a fresh install that hasn't been configured must surface a clear
    // error rather than POST `model: ""` to OpenRouter.
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], { model: "", retryDelayMs: 0 })
    ).rejects.toThrow(/opts\.model is required/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries on transient HTTP failures and returns once a call succeeds", async () => {
    // Plan: "3-retry exponential backoff". Transient 5xx / network blips
    // shouldn't fail a 2-hour video job. Verify retry + eventual success.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("server error", { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response("try again", { status: 502 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "finally" } }] }),
          { status: 200 }
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await chat(
      [{ role: "user", content: "hi" }],
      { model: "openai/gpt-4o", retryDelayMs: 0 }
    );

    expect(result).toBe("finally");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries (3 total attempts)", async () => {
    // If every retry fails, surface the failure so the orchestrator can
    // mark the step failed. Not retrying forever is critical — a dead key
    // shouldn't hang the worker.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "openai/gpt-4o",
        retryDelayMs: 0,
      })
    ).rejects.toThrow(/503/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "openai/gpt-4o",
        retryDelayMs: 0,
      })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects AbortError-shaped without calling fetch when signal is pre-aborted", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort("delete_requested");

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "openai/gpt-4o",
        retryDelayMs: 0,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards opts.signal into fetch's init.signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 }
        )
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    await chat([{ role: "user", content: "hi" }], {
      model: "openai/gpt-4o",
      retryDelayMs: 0,
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
  });

  it("rejects AbortError after a fetch-level abort and does not retry", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      controller.abort("delete_requested");
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "openai/gpt-4o",
        retryDelayMs: 0,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects AbortError-shaped when signal aborts but fetch threw a non-AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      controller.abort("delete_requested");
      return new Response("temporary failure", { status: 503 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "openai/gpt-4o",
        retryDelayMs: 0,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

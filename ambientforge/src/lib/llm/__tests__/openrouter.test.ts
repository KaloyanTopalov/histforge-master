import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { chatCompletionJSON, chatCompletionText, OpenRouterError } from '@/lib/llm/openrouter';

const SimpleSchema = z.object({ albumTitle: z.string() });

const RENDERED_WITH_MOCK =
  '<!-- mock-response: {"albumTitle":"Mock Title"} -->\n\nDoes not matter, mock returns the JSON above.';
const RENDERED_PLAIN = 'Plain prompt with no mock directive.';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chatCompletionJSON — mock mode', () => {
  it('returns parsed JSON from the mock-response comment without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await chatCompletionJSON({
      rendered: RENDERED_WITH_MOCK,
      schema: SimpleSchema,
      apiKey: 'mock',
    });
    expect(out).toEqual({ albumTitle: 'Mock Title' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws OPENROUTER_MOCK_DIRECTIVE_MISSING when comment is absent', async () => {
    await expect(
      chatCompletionJSON({ rendered: RENDERED_PLAIN, schema: SimpleSchema, apiKey: 'mock' }),
    ).rejects.toMatchObject({ code: 'OPENROUTER_MOCK_DIRECTIVE_MISSING' });
  });

  it('throws OPENROUTER_AUTH when no api key is set', async () => {
    await expect(
      chatCompletionJSON({ rendered: RENDERED_PLAIN, schema: SimpleSchema, apiKey: '' }),
    ).rejects.toMatchObject({ code: 'OPENROUTER_AUTH' });
  });
});

describe('chatCompletionJSON — real path', () => {
  function makeResponse(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function envelope(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it('throws OPENROUTER_AUTH on 401, no retry, fetch called once', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse(401, envelope('whatever')));
    await expect(
      chatCompletionJSON({
        rendered: RENDERED_PLAIN,
        schema: SimpleSchema,
        apiKey: 'sk-real',
        model: 'anthropic/claude-haiku-4.5',
      }),
    ).rejects.toMatchObject({ code: 'OPENROUTER_AUTH' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds (backoff fast-forwarded)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(429, { error: 'rate' }))
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"after retry"}')));

    const promise = chatCompletionJSON({
      rendered: RENDERED_PLAIN,
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });
    // advance through the 5s backoff
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect(out).toEqual({ albumTitle: 'after retry' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries malformed JSON once with a stricter reminder, then succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('not valid json')))
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"fixed"}')));

    const out = await chatCompletionJSON({
      rendered: RENDERED_PLAIN,
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });
    expect(out).toEqual({ albumTitle: 'fixed' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // second call should include the stricter reminder text
    const secondCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(secondCall[1]?.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toContain('IMPORTANT: Your previous response was not valid JSON');
  });

  it('strips mock-response directive before sending to the API', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"ok"}')));

    await chatCompletionJSON({
      rendered: RENDERED_WITH_MOCK,
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).not.toContain('mock-response');
    expect(body.messages[0].content).not.toContain('<!--');
  });

  it('throws OPENROUTER_MALFORMED_JSON after exhausting malformed retries', async () => {
    // Re-create the Response each call: a Response body can only be consumed once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      makeResponse(200, envelope('still not json')),
    );
    await expect(
      chatCompletionJSON({
        rendered: RENDERED_PLAIN,
        schema: SimpleSchema,
        apiKey: 'sk-real',
        model: 'm',
        malformedRetries: 1,
      }),
    ).rejects.toMatchObject({ code: 'OPENROUTER_MALFORMED_JSON' });
  });
});

describe('chatCompletionJSON — new options', () => {
  function makeResponse(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  function envelope(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it('sends system + user messages when system is set, strips mock directive from both', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"sys-user"}')));
    await chatCompletionJSON({
      rendered: 'the user message',
      system:
        '<!-- mock-response: {"albumTitle":"ignored on real path"} -->\nYou are a creative director.',
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('You are a creative director.');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('the user message');
  });

  it('omits system message when system is undefined', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"single"}')));
    await chatCompletionJSON({
      rendered: 'only user',
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('passes temperature, max_tokens, response_format through to the request body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"with-knobs"}')));
    await chatCompletionJSON({
      rendered: 'user',
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
      temperature: 0.9,
      maxTokens: 600,
      responseFormat: { type: 'json_object' },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(600);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits temperature/max_tokens/response_format keys when not provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('{"albumTitle":"defaults"}')));
    await chatCompletionJSON({
      rendered: 'user',
      schema: SimpleSchema,
      apiKey: 'sk-real',
      model: 'm',
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('response_format');
  });

  it('mock mode reads mock-response directive from system content when rendered has none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await chatCompletionJSON({
      rendered: 'picked theme: knight at campfire',
      system: '<!-- mock-response: {"albumTitle":"from-system"} -->\nYou are a director.',
      schema: SimpleSchema,
      apiKey: 'mock',
    });
    expect(out).toEqual({ albumTitle: 'from-system' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('OpenRouterError', () => {
  it('exposes code, retriable, status', () => {
    const e = new OpenRouterError('X', 'msg', true, 429);
    expect(e.code).toBe('X');
    expect(e.retriable).toBe(true);
    expect(e.status).toBe(429);
  });
});

describe('chatCompletionText — mock mode', () => {
  it('returns the mock-response directive content as a raw string without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await chatCompletionText({
      rendered: '<!-- mock-response: "TITLE_BLOCK\\nLine 1: The Knight" -->\n\nignored body',
      apiKey: 'mock',
    });
    expect(out).toBe('TITLE_BLOCK\nLine 1: The Knight');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('chatCompletionText — real path', () => {
  function makeResponse(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  function envelope(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it('returns the assistant message content verbatim with no JSON parsing', async () => {
    const spec =
      'TITLE_BLOCK\nLine 1: The Knight\nLine 2: Quiet Fire\nPLACEMENT: top-left\nSTYLING\nFont: Cinzel';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(200, envelope(spec)));
    const out = await chatCompletionText({
      rendered: 'Title: Quiet Fire\n<task>...</task>',
      apiKey: 'sk-real',
      model: 'm',
    });
    expect(out).toBe(spec);
  });

  it('sends the user message as multimodal content blocks when an image is attached', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('ok')));
    await chatCompletionText({
      rendered: 'analyze this',
      apiKey: 'sk-real',
      model: 'm',
      image: { base64: 'QUJDRA==', mimeType: 'image/jpeg' },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = body.messages[body.messages.length - 1];
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'analyze this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJDRA==' } },
    ]);
  });

  it('sends a plain string user content when no image is attached (no regression to blocks)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeResponse(200, envelope('ok')));
    await chatCompletionText({ rendered: 'just text', apiKey: 'sk-real', model: 'm' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toBe('just text');
  });

  it('surfaces a 401 as OPENROUTER_AUTH with no retry (shared error path)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse(401, { error: 'nope' }));
    await expect(
      chatCompletionText({ rendered: 'x', apiKey: 'sk-real', model: 'm' }),
    ).rejects.toMatchObject({ code: 'OPENROUTER_AUTH' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

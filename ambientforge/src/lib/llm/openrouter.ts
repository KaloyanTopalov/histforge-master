import { z } from 'zod';
import { extractMockResponse, stripMockDirective } from '@/lib/prompts';
import { getOpenRouterApiKey, getSettings } from '@/lib/settings';

export class OpenRouterError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    code: string,
    message: string,
    retriable: boolean,
    status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type ChatCompletionJSONOpts<T> = {
  /** User-role message content. Mock-response directives are honored here. */
  rendered: string;
  schema: z.ZodType<T>;
  model?: string;
  apiKey?: string;
  malformedRetries?: number;
  rateLimitRetries?: number;
  /** Optional system-role message. When set, the request is two messages
   * (system + user) instead of one. Mock-response directives in either are
   * stripped on the real path and searched on the mock path. */
  system?: string;
  /** Sampling temperature. Omit to let the model use its default. */
  temperature?: number;
  /** Maximum response tokens. Omit to let the model use its default. */
  maxTokens?: number;
  /** OpenRouter response_format passthrough (e.g. `{ type: 'json_object' }`).
   * Forces JSON-mode for providers that support it. */
  responseFormat?: { type: 'json_object' };
};

/** Image attached to the user message for a vision call. */
export type ChatImageInput = { base64: string; mimeType: string };

export type ChatCompletionTextOpts = {
  /** User-role message content. Mock-response directives are honored here. */
  rendered: string;
  /** Optional system-role message. */
  system?: string;
  model?: string;
  apiKey?: string;
  rateLimitRetries?: number;
  temperature?: number;
  maxTokens?: number;
  /** Optional image attached to the user message (vision). When set, the
   * user message is sent as OpenRouter multimodal content blocks. */
  image?: ChatImageInput;
};

const STRICTER_REMINDER =
  '\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY valid JSON. No prose, no code fences, no explanation.';

const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 45_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Call OpenRouter's chat-completions endpoint and parse the response with a Zod
 * schema. Honors a `mock` API-key sentinel that returns the JSON embedded in the
 * rendered template's `<!-- mock-response: {...} -->` HTML comment.
 *
 * Retry policy:
 *   - 401            -> OPENROUTER_AUTH (no retry)
 *   - 429 / 5xx      -> OPENROUTER_RATE_LIMIT (up to rateLimitRetries+1 attempts, exp backoff)
 *   - network error  -> OPENROUTER_NETWORK (same backoff as rate-limit)
 *   - bad JSON / Zod -> retry once with stricter reminder; second failure -> OPENROUTER_MALFORMED_JSON
 */
export async function chatCompletionJSON<T>(opts: ChatCompletionJSONOpts<T>): Promise<T> {
  const apiKey = opts.apiKey ?? getOpenRouterApiKey();
  if (!apiKey || apiKey.length === 0) {
    throw new OpenRouterError(
      'OPENROUTER_AUTH',
      'OPENROUTER_API_KEY is not set (env or settings)',
      false,
    );
  }

  if (apiKey === 'mock') {
    return runMock(opts);
  }

  const model = opts.model ?? safeReadModelName();
  const malformedRetries = opts.malformedRetries ?? 1;
  let lastMalformedCause: unknown = undefined;
  const systemStripped = opts.system ? stripMockDirective(opts.system) : undefined;
  for (let mAttempt = 0; mAttempt <= malformedRetries; mAttempt++) {
    const reminder = mAttempt === 0 ? '' : STRICTER_REMINDER;
    const userStripped = stripMockDirective(opts.rendered) + reminder;
    const raw = await postWithRateLimitRetry(
      {
        user: userStripped,
        system: systemStripped,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        responseFormat: opts.responseFormat,
      },
      model,
      apiKey,
      opts.rateLimitRetries ?? 3,
    );
    try {
      const cleaned = stripJsonCodeFences(raw);
      const parsed = JSON.parse(cleaned);
      return opts.schema.parse(parsed);
    } catch (err) {
      lastMalformedCause = err;
      // try again with stricter reminder, unless we're out of malformed retries
      continue;
    }
  }
  throw new OpenRouterError(
    'OPENROUTER_MALFORMED_JSON',
    'OpenRouter returned non-JSON or schema-invalid response after retries',
    false,
    undefined,
    lastMalformedCause,
  );
}

/**
 * Plain-text chat completion (no JSON schema). Returns the assistant message
 * content verbatim. Used for prompts whose output is consumed as-is (e.g. a
 * Magnific image prompt). Honors the same `mock` API-key sentinel and
 * retry/backoff path as `chatCompletionJSON`.
 */
export async function chatCompletionText(opts: ChatCompletionTextOpts): Promise<string> {
  const apiKey = opts.apiKey ?? getOpenRouterApiKey();
  if (!apiKey || apiKey.length === 0) {
    throw new OpenRouterError(
      'OPENROUTER_AUTH',
      'OPENROUTER_API_KEY is not set (env or settings)',
      false,
    );
  }
  if (apiKey === 'mock') {
    return runMockText(opts);
  }

  const model = opts.model ?? safeReadModelName();
  return postWithRateLimitRetry(
    {
      user: stripMockDirective(opts.rendered),
      system: opts.system ? stripMockDirective(opts.system) : undefined,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      image: opts.image,
    },
    model,
    apiKey,
    opts.rateLimitRetries ?? 3,
  );
}

/**
 * Pull the `<!-- mock-response: ... -->` directive from system or user content
 * (system wins for steps that keep the template there). Throws the shared
 * missing-directive error so JSON and text mock paths behave identically.
 */
function extractMockOrThrow(parts: { system?: string; rendered: string }): unknown {
  const haystack = `${parts.system ?? ''}\n${parts.rendered}`;
  const raw = extractMockResponse(haystack);
  if (raw === null) {
    throw new OpenRouterError(
      'OPENROUTER_MOCK_DIRECTIVE_MISSING',
      'apiKey=mock but the rendered template has no <!-- mock-response: ... --> comment',
      false,
    );
  }
  return raw;
}

function runMockText(opts: ChatCompletionTextOpts): string {
  const raw = extractMockOrThrow(opts);
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

type PostInput = {
  user: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  /** When set, the user message is sent as multimodal content blocks
   * (text + image_url data URL) instead of a plain string. */
  image?: ChatImageInput;
};

/**
 * Strip ```json ... ``` (or unlabeled triple-backtick) fences if present.
 * Some Anthropic models on OpenRouter wrap JSON in markdown despite explicit
 * "no code fences" instructions. Be lenient on input even when our prompts
 * forbid fences — preserves backwards compatibility with strict-mode
 * responses (no fences) while accepting fenced ones.
 */
function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  // Matches ```json\n...\n``` or ```\n...\n``` with optional whitespace.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

function runMock<T>(opts: ChatCompletionJSONOpts<T>): T {
  return opts.schema.parse(extractMockOrThrow(opts));
}

function safeReadModelName(): string {
  try {
    return getSettings().model_name;
  } catch {
    return 'anthropic/claude-haiku-4.5';
  }
}

async function postWithRateLimitRetry(
  input: PostInput,
  model: string,
  apiKey: string,
  retries: number,
): Promise<string> {
  let attempt = 0;
  let lastErr: unknown = undefined;
  while (attempt <= retries) {
    try {
      return await postOnce(input, model, apiKey);
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenRouterError && !err.retriable) throw err;
      if (attempt === retries) break;
      const backoff = RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
      await sleep(backoff);
      attempt++;
    }
  }
  if (lastErr instanceof OpenRouterError) throw lastErr;
  throw new OpenRouterError(
    'OPENROUTER_NETWORK',
    'Exhausted rate-limit retries',
    false,
    undefined,
    lastErr,
  );
}

async function postOnce(input: PostInput, model: string, apiKey: string): Promise<string> {
  type TextBlock = { type: 'text'; text: string };
  type ImageBlock = { type: 'image_url'; image_url: { url: string } };
  type MsgContent = string | Array<TextBlock | ImageBlock>;
  const messages: Array<{ role: 'system' | 'user'; content: MsgContent }> = [];
  if (input.system && input.system.length > 0) {
    messages.push({ role: 'system', content: input.system });
  }
  const userContent: MsgContent = input.image
    ? [
        { type: 'text', text: input.user },
        {
          type: 'image_url',
          image_url: {
            url: `data:${input.image.mimeType};base64,${input.image.base64}`,
          },
        },
      ]
    : input.user;
  messages.push({ role: 'user', content: userContent });
  const body: Record<string, unknown> = { model, messages };
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.responseFormat) body.response_format = input.responseFormat;

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OpenRouterError('OPENROUTER_NETWORK', 'fetch failed', true, undefined, err);
  }

  if (res.status === 401) {
    throw new OpenRouterError('OPENROUTER_AUTH', 'OpenRouter rejected the API key', false, 401);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new OpenRouterError(
      'OPENROUTER_RATE_LIMIT',
      `OpenRouter responded ${res.status}`,
      true,
      res.status,
    );
  }
  if (!res.ok) {
    throw new OpenRouterError(
      'OPENROUTER_HTTP_ERROR',
      `OpenRouter responded ${res.status}`,
      false,
      res.status,
    );
  }

  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch (err) {
    throw new OpenRouterError(
      'OPENROUTER_NETWORK',
      'OpenRouter response was not valid JSON envelope',
      true,
      res.status,
      err,
    );
  }
  const content = extractMessageContent(envelope);
  if (content === null) {
    throw new OpenRouterError(
      'OPENROUTER_NETWORK',
      'OpenRouter response missing choices[0].message.content',
      true,
      res.status,
    );
  }
  return content;
}

function extractMessageContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

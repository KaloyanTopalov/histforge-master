'use client';

import { useState } from 'react';

type PromptKind = 'album-brief' | 'track-briefs' | 'cover-image' | 'thumbnail' | 'yt-metadata';

type PreviewResponse = {
  renderedPrompt: string;
  mode: 'mock' | 'live';
  mockResponse: unknown | null;
  llmResponse: unknown | null;
  parsedOk: boolean;
  validationErrors: string[];
};

type Result =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; data: PreviewResponse }
  | { kind: 'error'; message: string };

type Props = {
  promptKind: PromptKind;
  /** Current value of the textarea — passed in by the parent form. */
  promptValue: string;
  /** Optional draft channel/album state to interpolate into the rendered template. */
  channelDraft?: Record<string, unknown>;
  albumDraft?: Record<string, unknown>;
};

/**
 * "Test this prompt" button — POSTs to /api/channels/preview-prompt and
 * renders an inline result card showing the rendered prompt + parsed
 * response + any validation errors. Mirrors VerifyArtistButton's state
 * machine pattern.
 */
export default function PromptTestButton({
  promptKind,
  promptValue,
  channelDraft,
  albumDraft,
}: Props) {
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const onClick = async () => {
    if (!promptValue || promptValue.trim().length === 0) {
      setResult({
        kind: 'error',
        message: 'Type or paste a prompt above first — empty templates can\u2019t be tested.',
      });
      return;
    }
    setResult({ kind: 'pending' });
    try {
      const res = await fetch('/api/channels/preview-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: promptKind,
          prompt: promptValue,
          channelDraft: channelDraft ?? {},
          albumDraft: albumDraft ?? {},
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setResult({
          kind: 'error',
          message: json?.error?.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      setResult({ kind: 'ok', data: json as PreviewResponse });
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClick}
          disabled={result.kind === 'pending'}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          {result.kind === 'pending' ? 'Testing\u2026' : 'Test this prompt'}
        </button>
        {result.kind === 'error' && (
          <span className="text-xs text-red-700 dark:text-red-300">{result.message}</span>
        )}
      </div>
      {result.kind === 'ok' && (
        <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {result.data.mode}
            </span>
            <span
              className={
                result.data.parsedOk
                  ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-950 dark:text-red-200'
              }
            >
              {result.data.parsedOk ? '\u2713 schema ok' : '\u2717 schema fail'}
            </span>
          </div>
          {result.data.validationErrors.length > 0 && (
            <div className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
              <div className="mb-1 font-semibold">Validation errors</div>
              <ul className="list-disc pl-4">
                {result.data.validationErrors.map((e, i) => (
                  <li key={i} className="font-mono">{e}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="mb-2">
            <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
              Rendered prompt
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900">
              {result.data.renderedPrompt}
            </pre>
          </details>
          {result.data.mockResponse != null && (
            <details>
              <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
                Mock response (parsed JSON)
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900">
                {JSON.stringify(result.data.mockResponse, null, 2)}
              </pre>
            </details>
          )}
          {result.data.llmResponse != null && (
            <details>
              <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
                Live LLM response
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900">
                {JSON.stringify(result.data.llmResponse, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

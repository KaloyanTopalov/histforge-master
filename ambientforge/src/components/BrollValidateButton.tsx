'use client';

import { useState } from 'react';

type ValidateResponse = {
  exists: boolean;
  videoCount: number;
  sampleFiles: string[];
  codecsDetected: string[];
  reasons: string[];
  ok: boolean;
};

type Result =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; data: ValidateResponse }
  | { kind: 'error'; message: string };

type Props = {
  /** Current value of the brollFolderPath input — passed in by the parent form. */
  folderPath: string;
};

/**
 * "Validate folder" button — GETs /api/channels/validate-broll and renders
 * the preflight result inline. Fires the same preflight that runs at
 * album-trigger time so the operator sees identical reasons.
 */
export default function BrollValidateButton({ folderPath }: Props) {
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const onClick = async () => {
    if (!folderPath || folderPath.trim().length === 0) {
      setResult({ kind: 'error', message: 'Set a folder path above first.' });
      return;
    }
    setResult({ kind: 'pending' });
    try {
      const res = await fetch(
        `/api/channels/validate-broll?path=${encodeURIComponent(folderPath)}`,
      );
      const json = await res.json();
      if (!res.ok) {
        setResult({
          kind: 'error',
          message: json?.error?.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      setResult({ kind: 'ok', data: json as ValidateResponse });
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
          {result.kind === 'pending' ? 'Validating\u2026' : 'Validate folder'}
        </button>
        {result.kind === 'error' && (
          <span className="text-xs text-red-700 dark:text-red-300">{result.message}</span>
        )}
      </div>
      {result.kind === 'ok' && (
        <div
          className={
            result.data.ok
              ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
              : 'rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200'
          }
        >
          <div className="mb-1 font-semibold">
            {result.data.ok ? '\u2713 Folder ok' : '\u2717 Folder rejected'}
          </div>
          <div>
            {result.data.videoCount} video file(s); codecs:{' '}
            <span className="font-mono">
              {result.data.codecsDetected.join(', ') || '(none)'}
            </span>
          </div>
          {result.data.sampleFiles.length > 0 && (
            <div className="mt-1 font-mono text-[11px]">
              Sample: {result.data.sampleFiles.join(', ')}
            </div>
          )}
          <ul className="mt-2 list-disc pl-4">
            {result.data.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

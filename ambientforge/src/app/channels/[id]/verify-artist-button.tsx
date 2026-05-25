'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Result =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'found'; verifiedAt: number | null }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

type Props = {
  channelId: string;
};

export default function VerifyArtistButton({ channelId }: Props) {
  const router = useRouter();
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const onClick = async () => {
    setResult({ kind: 'pending' });
    try {
      const res = await fetch(`/api/channels/${channelId}/verify-distrokid-artist`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setResult({
          kind: 'error',
          message: json?.error?.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (json.found) {
        setResult({ kind: 'found', verifiedAt: json.verifiedAt ?? null });
        router.refresh();
      } else {
        setResult({ kind: 'not-found' });
      }
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={result.kind === 'pending'}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        {result.kind === 'pending' ? 'Verifying…' : 'Verify artist exists'}
      </button>
      {result.kind === 'found' && (
        <span className="text-sm text-emerald-700 dark:text-emerald-300">
          ✓ Artist found in DistroKid
        </span>
      )}
      {result.kind === 'not-found' && (
        <span className="text-sm text-red-700 dark:text-red-300">
          ✗ Artist not found — add it manually in your DistroKid account first.
        </span>
      )}
      {result.kind === 'error' && (
        <span className="text-sm text-red-700 dark:text-red-300">{result.message}</span>
      )}
    </div>
  );
}

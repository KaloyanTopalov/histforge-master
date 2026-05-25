'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  albumId: string;
};

type State = 'idle' | 'pending' | 'error';

export default function SunoReloginBanner({ albumId }: Props) {
  const router = useRouter();
  const [resumeState, setResumeState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  const onResume = async () => {
    setResumeState('pending');
    setError(null);
    try {
      const res = await fetch(`/api/albums/${albumId}/resume-suno-auth`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setResumeState('error');
        return;
      }
      setResumeState('idle');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResumeState('error');
    }
  };

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <div className="font-semibold">Suno re-login required for album {albumId}</div>
      <div className="mt-1">
        Run <span className="font-mono">npm run suno:login</span> in a terminal,
        then click Resume below.
      </div>
      {error && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
      <div className="mt-3">
        <button
          type="button"
          onClick={onResume}
          disabled={resumeState === 'pending'}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {resumeState === 'pending' ? 'Resuming…' : 'Resume'}
        </button>
      </div>
    </div>
  );
}

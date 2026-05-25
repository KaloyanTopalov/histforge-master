'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  channelId: string;
  disabled?: boolean;
};

export default function TriggerButton({ channelId, disabled }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [themePrompt, setThemePrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/albums', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channelId,
          themePrompt: themePrompt.trim() === '' ? null : themePrompt,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setThemePrompt('');
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        title={
          disabled
            ? 'Channel already has a queued / in_progress album, or is inactive'
            : 'Manually enqueue a new album'
        }
      >
        Manually trigger album
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold tracking-tight">Trigger album</h3>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Optional theme prompt steers the LLM&rsquo;s album-brief step. Leave blank to use
              the channel&rsquo;s default templates.
            </p>
            {error && (
              <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
                {error}
              </div>
            )}
            <form onSubmit={onSubmit} className="mt-4 space-y-3">
              <textarea
                value={themePrompt}
                onChange={(e) => setThemePrompt(e.target.value)}
                placeholder="optional: rainy night, neon reflections, slow piano…"
                rows={4}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setError(null);
                  }}
                  className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {submitting ? 'Enqueuing…' : 'Enqueue album'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

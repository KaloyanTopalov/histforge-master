'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LIVE_MODE_CONFIRM_PHRASE } from '@/lib/distrokid/constants';

const DAY_MS = 86_400_000;

function formatHoldEta(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

type Initial = {
  queue_state: 'paused' | 'running';
  scheduler_enabled: boolean;
  openrouter_api_key_masked: string;
  model_name: string;
  distrokid_dry_run: boolean;
  content_id_hold_days: number;
  broll_allowed_root_paths: string[];
};

export default function SettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [form, setForm] = useState({
    queue_state: initial.queue_state,
    scheduler_enabled: initial.scheduler_enabled,
    openrouter_api_key: '',
    model_name: initial.model_name,
    distrokid_dry_run: initial.distrokid_dry_run,
    content_id_hold_days: initial.content_id_hold_days,
    broll_allowed_root_paths_text: initial.broll_allowed_root_paths.join('\n'),
  });
  const [revealKey, setRevealKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [liveModeConfirm, setLiveModeConfirm] = useState('');

  const flippingToLive = !form.distrokid_dry_run && initial.distrokid_dry_run;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const brollRoots = form.broll_allowed_root_paths_text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const payload: Record<string, unknown> = {
        queue_state: form.queue_state,
        scheduler_enabled: form.scheduler_enabled,
        openrouter_api_key: form.openrouter_api_key,
        model_name: form.model_name,
        distrokid_dry_run: form.distrokid_dry_run,
        content_id_hold_days: form.content_id_hold_days,
        broll_allowed_root_paths: JSON.stringify(brollRoots),
      };
      if (flippingToLive) {
        if (liveModeConfirm !== LIVE_MODE_CONFIRM_PHRASE) {
          setError(
            `Type the exact phrase to confirm live mode: "${LIVE_MODE_CONFIRM_PHRASE}"`,
          );
          setSubmitting(false);
          return;
        }
        payload.live_mode_confirm = liveModeConfirm;
      }
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      setSavedAt(Date.now());
      setForm((p) => ({ ...p, openrouter_api_key: '' }));
      setLiveModeConfirm('');
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">Queue state</span>
          <select
            value={form.queue_state}
            onChange={(e) =>
              setForm((p) => ({ ...p, queue_state: e.target.value as 'paused' | 'running' }))
            }
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="paused">paused</option>
            <option value="running">running</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm md:mt-6">
          <input
            type="checkbox"
            checked={form.scheduler_enabled}
            onChange={(e) =>
              setForm((p) => ({ ...p, scheduler_enabled: e.target.checked }))
            }
          />
          <span>Scheduler enabled (no scheduler runs until Session 9)</span>
        </label>

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="flex items-center justify-between text-zinc-700 dark:text-zinc-300">
            <span>OpenRouter API key</span>
            <span className="font-mono text-xs text-zinc-500">
              current: {initial.openrouter_api_key_masked || 'unset'}
            </span>
          </span>
          <div className="flex gap-2">
            <input
              type={revealKey ? 'text' : 'password'}
              value={form.openrouter_api_key}
              onChange={(e) => setForm((p) => ({ ...p, openrouter_api_key: e.target.value }))}
              placeholder="leave blank to keep current"
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setRevealKey((v) => !v)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {revealKey ? 'Hide' : 'Reveal'}
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-zinc-700 dark:text-zinc-300">OpenRouter model</span>
          <input
            value={form.model_name}
            onChange={(e) => setForm((p) => ({ ...p, model_name: e.target.value }))}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.distrokid_dry_run}
            onChange={(e) =>
              setForm((p) => ({ ...p, distrokid_dry_run: e.target.checked }))
            }
          />
          <span>DistroKid dry-run (default true; live mode is locked until Session 13)</span>
        </label>

        {flippingToLive && (
          <label className="flex flex-col gap-1 text-sm md:col-span-2 rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950">
            <span className="font-semibold text-red-900 dark:text-red-200">
              You are about to disable DistroKid dry-run mode.
            </span>
            <span className="text-xs text-red-800 dark:text-red-300">
              Live releases are irreversible. Type the exact phrase below to confirm:
            </span>
            <span className="font-mono text-xs text-red-900 dark:text-red-100">
              {LIVE_MODE_CONFIRM_PHRASE}
            </span>
            <input
              type="text"
              value={liveModeConfirm}
              onChange={(e) => setLiveModeConfirm(e.target.value)}
              placeholder="Type the phrase exactly"
              className="mt-1 rounded-md border border-red-400 bg-white px-2 py-1.5 text-sm dark:border-red-600 dark:bg-zinc-900"
              autoComplete="off"
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-zinc-700 dark:text-zinc-300">
            B-roll allowed root paths (one per line)
          </span>
          <textarea
            value={form.broll_allowed_root_paths_text}
            onChange={(e) =>
              setForm((p) => ({ ...p, broll_allowed_root_paths_text: e.target.value }))
            }
            placeholder={'E:\\B-roll\nD:\\Footage'}
            rows={3}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">
            Rap-compilation channels can only validate or run against folders under one of these
            absolute prefixes. Empty = deny-all (no rap channel can validate).
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="flex items-center justify-between text-zinc-700 dark:text-zinc-300">
            <span>Content-ID hold (days)</span>
            <span className="font-mono text-xs text-zinc-500">{form.content_id_hold_days}</span>
          </span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={form.content_id_hold_days}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                content_id_hold_days: Number.parseInt(e.target.value || '0', 10),
              }))
            }
            className="w-full"
          />
          <span className="text-xs text-zinc-500">
            Current hold: {form.content_id_hold_days} day
            {form.content_id_hold_days === 1 ? '' : 's'}.{' '}
            {form.content_id_hold_days === 0
              ? 'Albums become upload-ready immediately when DistroKid finishes.'
              : `Albums submitted today will be ready on ${formatHoldEta(form.content_id_hold_days)}.`}
          </span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {submitting ? 'Saving…' : 'Save settings'}
        </button>
        {savedAt && (
          <span className="text-xs text-zinc-500">
            Saved at {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </form>
  );
}

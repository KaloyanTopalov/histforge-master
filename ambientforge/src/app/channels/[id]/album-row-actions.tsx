'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type AlbumLite = {
  id: string;
  status: string;
  distrokidStatus: string;
  videoStatus: string;
  videoProgressPct: number;
  safeToUploadAfter: number | null;
  youtubeVideoId: string | null;
  uploadedAt: number | null;
  ytTitle: string | null;
  ytDescription: string | null;
  tracklistText: string | null;
};

type State = 'idle' | 'pending' | 'error';

const DAY_MS = 86_400_000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export default function AlbumRowActions({ album }: { album: AlbumLite }) {
  const router = useRouter();
  const [retryState, setRetryState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [livePct, setLivePct] = useState<number>(album.videoProgressPct);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [modalOpen, setModalOpen] = useState(false);

  // Tick once a minute so the hold-countdown badge stays accurate without a refresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (album.videoStatus !== 'rendering') {
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/albums/${album.id}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { album?: AlbumLite };
        if (cancelled || !json.album) return;
        setLivePct(json.album.videoProgressPct);
        if (json.album.videoStatus !== 'rendering') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          router.refresh();
        }
      } catch {
        // ignore — next tick will retry
      }
    };
    pollTimer.current = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [album.id, album.videoStatus, router]);

  const onRetry = async (branch: 'A' | 'B') => {
    setRetryState('pending');
    setError(null);
    try {
      const res = await fetch(`/api/albums/${album.id}/retry-branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setRetryState('error');
        return;
      }
      setRetryState('idle');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRetryState('error');
    }
  };

  if (album.videoStatus === 'rendering') {
    const pct = Math.max(0, Math.min(100, livePct));
    return (
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-emerald-500 transition-[width] duration-500 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-xs text-zinc-500">{pct}%</span>
      </div>
    );
  }

  if (album.status === 'failed') {
    const showRetryA = album.distrokidStatus === 'failed';
    const showRetryB = album.videoStatus === 'failed';
    if (!showRetryA && !showRetryB) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {showRetryA && (
          <button
            type="button"
            onClick={() => onRetry('A')}
            disabled={retryState === 'pending'}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            {retryState === 'pending' ? '…' : 'Retry DistroKid only'}
          </button>
        )}
        {showRetryB && (
          <button
            type="button"
            onClick={() => onRetry('B')}
            disabled={retryState === 'pending'}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            {retryState === 'pending' ? '…' : 'Retry video render only'}
          </button>
        )}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
    );
  }

  if (album.status !== 'done') return null;

  // Already uploaded — show YT id + uploaded timestamp.
  if (album.youtubeVideoId) {
    return (
      <div className="flex flex-col gap-0.5 text-xs">
        <span className="font-mono">
          <a
            href={`https://www.youtube.com/watch?v=${album.youtubeVideoId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
            data-testid="yt-link"
          >
            {album.youtubeVideoId}
          </a>
        </span>
        {album.uploadedAt && (
          <span className="text-zinc-500">
            uploaded {new Date(album.uploadedAt).toISOString().slice(0, 10)}
          </span>
        )}
      </div>
    );
  }

  // Done & not yet uploaded → hold badge + Mark as uploaded button + copy/open buttons.
  const safeAfter = album.safeToUploadAfter;
  const holdPending = safeAfter !== null && now < safeAfter;
  const daysRemaining = safeAfter !== null ? Math.max(0, Math.ceil((safeAfter - now) / DAY_MS)) : 0;
  const safeAfterIso = safeAfter !== null ? new Date(safeAfter).toISOString().slice(0, 10) : '';
  const tooltip = holdPending
    ? `YouTube Content ID hold — wait until ${safeAfterIso} (UTC) to avoid auto-flagging your own song.`
    : '';

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {holdPending ? (
        <span
          data-testid="hold-badge-pending"
          className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          Hold: {daysRemaining} day{daysRemaining === 1 ? '' : 's'} remaining
        </span>
      ) : (
        <span
          data-testid="hold-badge-ready"
          className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          Ready to upload
        </span>
      )}

      <button
        type="button"
        onClick={() => setModalOpen(true)}
        disabled={holdPending}
        title={tooltip}
        data-testid="mark-uploaded-button"
        className="rounded border border-zinc-300 bg-white px-2 py-1 font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        Mark as uploaded
      </button>

      {album.ytTitle && (
        <CopyButton label="Copy YT title" text={album.ytTitle} />
      )}
      {album.ytDescription && (
        <CopyButton label="Copy YT description" text={album.ytDescription} />
      )}
      {album.tracklistText && (
        <CopyButton label="Copy tracklist" text={album.tracklistText} />
      )}
      <OpenFolderButton albumId={album.id} />

      {modalOpen && (
        <MarkUploadedModal
          albumId={album.id}
          onClose={() => setModalOpen(false)}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers without clipboard API
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded border border-zinc-300 bg-white px-2 py-1 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function OpenFolderButton({ albumId }: { albumId: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const onClick = async () => {
    setState('pending');
    try {
      const res = await fetch(`/api/albums/${albumId}/open-folder`, { method: 'POST' });
      setState(res.ok ? 'idle' : 'error');
    } catch {
      setState('error');
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'pending'}
      className="rounded border border-zinc-300 bg-white px-2 py-1 font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
    >
      {state === 'error' ? 'Failed' : 'Open folder'}
    </button>
  );
}

function MarkUploadedModal({
  albumId,
  onClose,
  onSuccess,
}: {
  albumId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [videoId, setVideoId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = useMemo(() => VIDEO_ID_RE.test(videoId), [videoId]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/albums/${albumId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ youtubeVideoId: videoId, uploadedAt: Date.now() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-md bg-white p-5 shadow-lg dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">Mark album as uploaded</h3>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Paste the 11-char YouTube video id (the part after <code>?v=</code>).
        </p>
        <form onSubmit={onSubmit} className="mt-3 space-y-3">
          <input
            autoFocus
            value={videoId}
            onChange={(e) => setVideoId(e.target.value.trim())}
            placeholder="dQw4w9WgXcQ"
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          {videoId.length > 0 && !valid && (
            <div className="text-xs text-red-600 dark:text-red-400">
              Must be exactly 11 characters of A-Z, a-z, 0-9, _ or -.
            </div>
          )}
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || submitting}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {submitting ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

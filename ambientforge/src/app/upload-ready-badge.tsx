'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 30_000;

export default function UploadReadyBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/albums/ready-to-upload', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { count?: number };
        if (cancelled) return;
        if (typeof json.count === 'number') setCount(json.count);
      } catch {
        // ignore — next tick will retry
      }
    };
    void tick();
    const t = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (count === null || count === 0) return null;
  return (
    <Link
      href="/?ready=1"
      data-testid="global-upload-ready-badge"
      className="ml-auto rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
    >
      Ready to upload: <span className="font-mono">{count}</span>
    </Link>
  );
}

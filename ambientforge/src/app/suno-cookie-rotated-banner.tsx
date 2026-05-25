import Link from 'next/link';
import { getRawSetting } from '@/lib/settings';
import * as albumsRepo from '@/lib/repos/albums';

type Flag = { albumId: string; channelId: string; at: number };

function parseFlag(raw: string | undefined): Flag | null {
  if (!raw || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Flag;
    if (
      typeof parsed?.albumId === 'string' &&
      typeof parsed?.channelId === 'string' &&
      typeof parsed?.at === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Global banner rendered in the layout when Suno's __client cookie has
 * rotated mid-album. Surfaces the album link, the timestamp of the failure,
 * and instructions for the operator (re-run npm run suno:login + click
 * Resume on the channel page).
 */
export default function SunoCookieRotatedBanner() {
  const flag = parseFlag(getRawSetting('suno_cookie_rotated'));
  if (!flag) return null;
  // Confirm the album row is still in awaiting_suno_relogin — defensive
  // against a stale flag (e.g. operator manually patched status).
  const album = albumsRepo.get(flag.albumId);
  if (!album || album.status !== 'awaiting_suno_relogin') return null;
  return (
    <div
      data-testid="suno-cookie-rotated-banner"
      className="border-b border-amber-300 bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <div className="mx-auto max-w-5xl">
        <div className="font-semibold">
          Suno cookie expired during album {flag.albumId}.
        </div>
        <div className="mt-1">
          Run <span className="font-mono">npm run suno:login</span> in a
          terminal, then{' '}
          <Link
            href={`/channels/${flag.channelId}`}
            className="underline hover:text-amber-700 dark:hover:text-amber-100"
          >
            click Resume on the channel page
          </Link>
          .
        </div>
      </div>
    </div>
  );
}

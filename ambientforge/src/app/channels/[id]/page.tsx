import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { get as getChannel } from '@/lib/repos/channels';
import { listByChannel } from '@/lib/repos/albums';
import { listByAlbum as listTracks, type TrackStatus } from '@/lib/repos/tracks';
import {
  listByChannel as listSunoPrompts,
  countAlbumsUsing as countAlbumsUsingPrompt,
  get as getSunoPrompt,
} from '@/lib/repos/channel-suno-prompts';
import { getRawSetting } from '@/lib/settings';
import { preflightBrollFolder } from '@/lib/broll/preflight';
import EditForm from './edit-form';
import TriggerButton from './trigger-button';
import VerifyArtistButton from './verify-artist-button';
import CaptchaBanner from './captcha-banner';
import SunoReloginBanner from './suno-relogin-banner';
import AlbumRowActions from './album-row-actions';
import SceneSection from './scene-section';

export const dynamic = 'force-dynamic';

type InsufficientCreditsFlag = {
  credits: number;
  required: number;
  at: number;
  albumId: string;
};

function parseInsufficient(raw: string | undefined): InsufficientCreditsFlag | null {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as InsufficientCreditsFlag;
  } catch {
    return null;
  }
}

type CaptchaPendingFlag = { albumId: string; channelId: string; at: number };

function parseCaptchaPending(raw: string | undefined): CaptchaPendingFlag | null {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as CaptchaPendingFlag;
  } catch {
    return null;
  }
}

type ArtistMissingFlag = {
  albumId: string;
  channelId: string;
  artistName: string;
  at: number;
};

function parseArtistMissing(raw: string | undefined): ArtistMissingFlag | null {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as ArtistMissingFlag;
  } catch {
    return null;
  }
}

const ARTIST_VERIFY_STALE_MS = 30 * 86400000;

const TRACK_STATUS_CLASSES: Record<TrackStatus, string> = {
  pending:
    'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  submitted:
    'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200',
  downloading:
    'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200',
};

export default async function ChannelDetailPage({ params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) notFound();
  const albums = listByChannel(channel.id, 50);
  // v7: per-channel suno style prompts. Fetch with usage counts so the form
  // can show "used in N albums" badges next to each card.
  const sunoPrompts = listSunoPrompts(channel.id, {});
  const sunoPromptsWithCounts = sunoPrompts.map((p) => ({
    id: p.id,
    label: p.label,
    content: p.content,
    weight: p.weight,
    active: p.active,
    albumsUsing: countAlbumsUsingPrompt(p.id),
  }));
  const sunoActivePromptCount = sunoPrompts.filter((p) => p.active).length;
  // Most-recent non-failed album's suno prompt (for the summary line).
  const lastNonFailedAlbum = albums.find((a) => a.status !== 'failed' && a.status !== 'new');
  const lastUsedPromptLabel =
    lastNonFailedAlbum?.sunoPromptId
      ? getSunoPrompt(lastNonFailedAlbum.sunoPromptId)?.label ?? null
      : null;
  // For rap channels, surface a short B-roll summary on the page (full
  // preflight runs on demand via the "Validate folder" button to avoid
  // probing every clip on every page load).
  let brollSummary: { exists: boolean; videoCount: number; sampleFiles: string[]; ok: boolean } | null =
    null;
  if (channel.workflow === 'rap-compilation' && channel.brollFolderPath) {
    try {
      const r = await preflightBrollFolder(channel.brollFolderPath);
      brollSummary = {
        exists: r.exists,
        videoCount: r.videoCount,
        sampleFiles: r.sampleFiles,
        ok: r.ok,
      };
    } catch {
      brollSummary = { exists: false, videoCount: 0, sampleFiles: [], ok: false };
    }
  }
  const inProgress = albums.some((a) => a.status === 'in_progress');
  const hasOpen = albums.some((a) =>
    ['new', 'queued', 'in_progress', 'awaiting_captcha', 'awaiting_suno_relogin'].includes(
      a.status,
    ),
  );
  const sunoReloginAlbum = albums.find((a) => a.status === 'awaiting_suno_relogin');
  const nowMs = Date.now();
  const readyToUploadCount = albums.filter(
    (a) =>
      a.status === 'done' &&
      a.youtubeVideoId === null &&
      a.safeToUploadAfter !== null &&
      a.safeToUploadAfter <= nowMs,
  ).length;
  const latestNonNew = albums.find((a) => a.status !== 'new') ?? null;
  const latestTracks = latestNonNew ? listTracks(latestNonNew.id) : [];
  const trackTotal = latestTracks.length;
  const trackDone = latestTracks.filter((t) => t.status === 'done').length;
  const sunoMockCredits = Number(getRawSetting('suno_mock_credits') ?? '100');
  const sunoMode = process.env.SUNO_MODE === 'mock' ? 'mock' : 'live';
  const insufficient = parseInsufficient(getRawSetting('suno_insufficient_credits'));
  const captchaPending = parseCaptchaPending(getRawSetting('distrokid_captcha_pending'));
  const artistMissing = parseArtistMissing(getRawSetting('distrokid_artist_missing'));
  const captchaAlbum =
    captchaPending && captchaPending.channelId === channel.id
      ? albums.find((a) => a.id === captchaPending.albumId && a.status === 'awaiting_captcha')
      : undefined;
  const artistMissingForChannel =
    artistMissing && artistMissing.channelId === channel.id ? artistMissing : null;
  const verifiedAt = channel.distrokidArtistVerifiedAt;
  const verifiedStale =
    verifiedAt !== null && Date.now() - verifiedAt > ARTIST_VERIFY_STALE_MS;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/channels"
            className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            ← All channels
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{channel.displayName}</h1>
            <span
              className={
                channel.workflow === 'rap-compilation'
                  ? 'rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-950 dark:text-orange-200'
                  : 'rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }
              title="workflow"
            >
              {channel.workflow}
            </span>
          </div>
          <div className="mt-1 font-mono text-xs text-zinc-500">
            {channel.name} · {channel.id}
          </div>
        </div>
        <TriggerButton channelId={channel.id} disabled={hasOpen || !channel.active} />
      </div>

      {inProgress && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          An album for this channel is currently in_progress. Editing is locked until it finishes.
        </div>
      )}

      {captchaAlbum && <CaptchaBanner albumId={captchaAlbum.id} />}

      {sunoReloginAlbum && <SunoReloginBanner albumId={sunoReloginAlbum.id} />}

      {artistMissingForChannel && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <strong>DISTROKID_ARTIST_NOT_FOUND</strong> — album{' '}
          <span className="font-mono">{artistMissingForChannel.albumId}</span> failed because artist{' '}
          <span className="font-mono">&ldquo;{artistMissingForChannel.artistName}&rdquo;</span>{' '}
          isn&rsquo;t in your DistroKid dropdown (last seen{' '}
          {new Date(artistMissingForChannel.at).toISOString()}). Add the artist profile in
          DistroKid, then click Verify artist below.
        </div>
      )}

      {insufficient && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <strong>INSUFFICIENT_SUNO_CREDITS</strong> — last pre-flight saw{' '}
          <span className="font-mono">{insufficient.credits}</span> credit
          {insufficient.credits === 1 ? '' : 's'} but needed{' '}
          <span className="font-mono">{insufficient.required}</span> for album{' '}
          <span className="font-mono">{insufficient.albumId}</span> at{' '}
          {new Date(insufficient.at).toISOString()}. Top up Suno (or raise{' '}
          <span className="font-mono">suno_mock_credits</span> in mock mode) and
          retry.
        </div>
      )}

      <section className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-semibold">DistroKid artist:</span>{' '}
            <span className="font-mono">{channel.distrokidArtistName}</span>
          </div>
          <VerifyArtistButton channelId={channel.id} />
        </div>
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          {verifiedAt
            ? `Last verified ${new Date(verifiedAt).toISOString()}`
            : 'Never verified — click the button to confirm the artist exists in your DistroKid dropdown.'}
        </div>
        {verifiedStale && (
          <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Verification is more than 30 days old — re-verify before the next release.
          </div>
        )}
      </section>

      <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-semibold">Suno credits</span>{' '}
            <span className="font-mono">{sunoMockCredits}</span>{' '}
            <span className="text-xs text-zinc-500">
              ({sunoMode === 'mock' ? 'mock — read from suno_mock_credits' : 'live — see extension popup'})
            </span>
          </div>
          {latestNonNew && trackTotal > 0 && (
            <div className="text-xs">
              <span className="font-semibold">Latest album tracks: </span>
              <span className="font-mono">
                {trackDone}/{trackTotal}
              </span>{' '}
              done
            </div>
          )}
        </div>
      </section>

      {channel.workflow === 'rap-compilation' && (
        <section
          className={
            brollSummary?.ok
              ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-700 dark:bg-emerald-950'
              : 'rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950'
          }
        >
          <div className="font-semibold">
            B-roll folder:{' '}
            <span className="font-mono text-xs">{channel.brollFolderPath ?? '(not set)'}</span>
          </div>
          {brollSummary && (
            <div className="mt-1 text-xs">
              {brollSummary.exists
                ? `${brollSummary.videoCount} clip(s) · ${brollSummary.ok ? 'preflight ok' : 'preflight fail (album triggers will fail)'}`
                : 'folder does not exist'}
              {brollSummary.sampleFiles.length > 0 && (
                <span className="ml-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                  sample: {brollSummary.sampleFiles.join(', ')}
                </span>
              )}
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Configuration</h2>
        <div
          className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          data-testid="suno-prompt-summary"
        >
          <span className="font-medium">{sunoActivePromptCount}</span> active suno prompts
          {lastUsedPromptLabel ? (
            <>
              {' '}
              (last album used: <span className="font-mono">{lastUsedPromptLabel}</span>)
            </>
          ) : (
            <></>
          )}
          {sunoActivePromptCount === 0 && channel.sunoStylePrompt ? (
            <>{' — falling back to legacy channel.suno_style_prompt'}</>
          ) : null}
        </div>
        <EditForm
          channel={channel}
          disabled={inProgress}
          initialSunoPrompts={sunoPromptsWithCounts}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Albums</h2>
          <span
            data-testid="ready-to-upload-count"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          >
            Ready to upload: <span className="font-mono">{readyToUploadCount}</span>
          </span>
        </div>
        {albums.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No albums yet. Trigger one with the button above.
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
                <th className="py-2 pr-4">Album id</th>
                <th className="py-2 pr-4">Workflow</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">DistroKid</th>
                <th className="py-2 pr-4">Video</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {albums.map((a) => (
                <tr key={a.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4 font-mono text-xs">{a.id}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{a.workflow}</td>
                  <td
                    className="py-2 pr-4 font-mono text-xs"
                    title={a.status === 'failed' && a.lastError ? a.lastError : undefined}
                  >
                    {a.status}
                    {a.status === 'failed' && a.lastError ? (
                      <span className="ml-1 cursor-help text-red-600 dark:text-red-400">ⓘ</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{a.distrokidStatus}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{a.videoStatus}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {new Date(a.createdAt).toISOString()}
                  </td>
                  <td className="py-2 pr-4">
                    <AlbumRowActions
                      album={{
                        id: a.id,
                        status: a.status,
                        distrokidStatus: a.distrokidStatus,
                        videoStatus: a.videoStatus,
                        videoProgressPct: a.videoProgressPct,
                        safeToUploadAfter: a.safeToUploadAfter,
                        youtubeVideoId: a.youtubeVideoId,
                        uploadedAt: a.uploadedAt,
                        ytTitle: a.ytTitle,
                        ytDescription: a.ytDescription,
                        tracklistText: a.tracklistText,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {latestNonNew &&
        (latestNonNew.coverImagePath || latestNonNew.thumbnailPath || latestNonNew.ytImagePath) && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">
              Generated images (latest album:{' '}
              <span className="font-mono text-sm">{latestNonNew.id}</span>)
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <ImageTile label="Cover (3000×3000)" filePath={latestNonNew.coverImagePath} />
              <ImageTile label="YouTube image (1920×1080)" filePath={latestNonNew.ytImagePath} />
              <ImageTile label="Thumbnail (1920×1080)" filePath={latestNonNew.thumbnailPath} />
            </div>
          </section>
        )}

      {latestNonNew &&
        latestNonNew.workflow === 'ambient-video' &&
        (() => {
          const thumbs = ambientVideoThumbPaths(channel.id, latestNonNew.id);
          if (!thumbs.some((t) => t !== null)) return null;
          return (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">
                Thumbnail candidates (latest album:{' '}
                <span className="font-mono text-sm">{latestNonNew.id}</span>)
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                4 graded 3840×2160 candidates (zoom/crop-to-fill, vibrance +30,
                saturation +10). Read-only — selection is not yet wired.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {thumbs.map((p, i) => (
                  <ImageTile
                    key={i}
                    label={`Thumb ${i + 1} (3840×2160)`}
                    filePath={p}
                  />
                ))}
              </div>
            </section>
          );
        })()}

      {latestNonNew && latestNonNew.workflow === 'ambient-video' && (
        <SceneSection
          albumId={latestNonNew.id}
          sceneTitle={latestNonNew.sceneTitle}
          sceneImagePrompt={latestNonNew.sceneImagePrompt}
          sceneSeedancePrompt={latestNonNew.sceneSeedancePrompt}
        />
      )}

      {latestNonNew && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Tracks (latest album: <span className="font-mono text-sm">{latestNonNew.id}</span>)
          </h2>
          {latestTracks.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No tracks yet.
            </div>
          ) : (
            <ol className="space-y-1 font-mono text-xs">
              {latestTracks.map((t) => (
                <li key={t.id} className="flex items-center gap-3">
                  <span className="w-6 text-right text-zinc-500">
                    {String(t.trackNumber).padStart(2, '0')}
                  </span>
                  <span className="flex-1">{t.title}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${TRACK_STATUS_CLASSES[t.status]}`}
                  >
                    {t.status}
                  </span>
                  {t.duration > 0 && (
                    <span className="w-12 text-right text-zinc-500">
                      {t.duration.toFixed(1)}s
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function ImageTile({
  label,
  filePath,
}: {
  label: string;
  filePath: string | null;
}) {
  const url = projectAssetUrl(filePath);
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </div>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={label}
            className="h-auto w-full rounded border border-zinc-200 object-cover dark:border-zinc-800"
          />
        </a>
      ) : (
        <div className="flex h-32 items-center justify-center rounded border border-dashed border-zinc-300 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          not generated yet
        </div>
      )}
      {filePath && (
        <div className="break-all font-mono text-[10px] text-zinc-500">{filePath}</div>
      )}
    </div>
  );
}

/**
 * Resolve the 4 ambient-video thumbnail candidates written by step 05b at
 * `projects/<ch>/<alb>/thumbs/thumb-N.png`. Each slot is the absolute path
 * when the file exists on disk, else null (ImageTile shows a placeholder).
 * step 05b sets no album DB column for these (selection is deferred), so the
 * dashboard derives them from disk.
 */
function ambientVideoThumbPaths(
  channelId: string,
  albumId: string,
): (string | null)[] {
  const thumbsDir = path.join(process.cwd(), 'projects', channelId, albumId, 'thumbs');
  return [1, 2, 3, 4].map((n) => {
    const p = path.join(thumbsDir, `thumb-${n}.png`);
    return fs.existsSync(p) ? p : null;
  });
}

/**
 * Convert an absolute disk path under `projects/` into a URL the dashboard
 * asset proxy (`/api/projects/[...path]`) will serve. Returns null when the
 * path is missing or doesn't live under `projects/`.
 */
function projectAssetUrl(filePath: string | null): string | null {
  if (!filePath) return null;
  const projectsRoot = path.resolve(process.cwd(), 'projects');
  const abs = path.resolve(filePath);
  if (!abs.startsWith(projectsRoot + path.sep)) return null;
  const rel = path.relative(projectsRoot, abs).split(path.sep).join('/');
  return `/api/projects/${rel}`;
}

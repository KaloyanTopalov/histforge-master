'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Channel } from '@/lib/repos/channels';
import ChannelFormBody, {
  channelToFormState,
  formStateToBody,
  type ChannelFormState,
  type SunoPromptCard,
} from '../_components/ChannelFormBody';

type Props = {
  channel: Channel;
  disabled: boolean;
  /** Suno prompt collection fetched server-side. Empty when the channel has
   *  none yet; the form's "Add prompt" button creates new entries. */
  initialSunoPrompts?: SunoPromptCard[];
};

export default function EditForm({ channel, disabled, initialSunoPrompts = [] }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ChannelFormState>(() => ({
    ...channelToFormState(channel),
    sunoStylePrompts: initialSunoPrompts,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(formStateToBody(form)),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      setEditing(false);
      setSavedAt(Date.now());
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  if (!editing) {
    return (
      <div className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
          <Row label="Name" value={channel.name} mono />
          <Row label="Display name" value={channel.displayName} />
          <Row label="Workflow" value={channel.workflow} mono />
          <Row label="Active" value={channel.active ? 'yes' : 'no'} />
          <Row label="Schedule" value={channel.scheduleCron} mono />
          <Row
            label="Tracks per album"
            value={channel.tracksPerAlbum != null ? String(channel.tracksPerAlbum) : '— (workflow default)'}
            mono
          />
          {channel.workflow === 'ambient' && (
            <Row
              label="Target video seconds"
              value={
                channel.targetVideoSeconds != null
                  ? String(channel.targetVideoSeconds)
                  : '— (global setting)'
              }
              mono
            />
          )}
          {channel.workflow === 'rap-compilation' && (
            <Row
              label="B-roll folder"
              value={channel.brollFolderPath ?? '—'}
              mono
              full
            />
          )}
          {channel.workflow === 'rap-compilation' && (
            <Row
              label="Rap clip strategy"
              value={channel.rapClipStrategy ?? '— (random-fill default)'}
              mono
            />
          )}
          <Row label="DistroKid artist" value={channel.distrokidArtistName} />
          <Row label="DistroKid genre" value={channel.distrokidPrimaryGenre} />
          <Row label="DistroKid label" value={channel.distrokidLabelName ?? '—'} />
          <Row
            label="DK songwriter (channel)"
            value={channel.distrokidSongwriterName ?? '— (global)'}
          />
          <Row
            label="DK performer"
            value={
              channel.distrokidPerformerName
                ? `${channel.distrokidPerformerName} (${channel.distrokidPerformerRole ?? '?'})`
                : '— (global)'
            }
          />
          <Row
            label="DK producer"
            value={
              channel.distrokidProducerName
                ? `${channel.distrokidProducerName} (${channel.distrokidProducerRole ?? '?'})`
                : '— (global)'
            }
          />
          <Row label="YouTube handle" value={channel.youtubeChannelHandle ?? '—'} mono />
          <Row
            label="YouTube channel id"
            value={channel.youtubeChannelId ?? '— (resolved later)'}
            mono
          />
          <Row label="Spotify playlist" value={channel.spotifyPlaylistUrl ?? '—'} mono />
          <Row label="Hashtags" value={channel.hashtags || '—'} />
          <Row label="Thumbnail overlay" value={channel.thumbnailOverlayText ?? '—'} />
          <Row
            label="YouTube image aspect"
            value={channel.youtubeImageAspect ?? '— (global)'}
          />
          <Row label="Suno model" value={channel.sunoModel} mono />
          <Row label="Suno mode" value={channel.sunoMode} />
          <Row label="Suno instrumental" value={channel.sunoInstrumental ? 'yes' : 'no'} />
          <Row label="Suno persona id" value={channel.sunoPersonaId ?? '—'} mono />
          <Row
            label="Suno style prompt"
            value={
              channel.sunoStylePrompt
                ? channel.sunoStylePrompt.slice(0, 200) +
                  (channel.sunoStylePrompt.length > 200 ? '…' : '')
                : '—'
            }
            full
          />
          <Row label="Description" value={channel.description || '—'} full />
        </dl>
        <PromptSourceSummary channel={channel} />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={disabled}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            title={disabled ? 'Locked while album is in_progress' : ''}
          >
            Edit channel
          </button>
          {savedAt && (
            <span className="text-xs text-zinc-500">
              Saved at {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
      <ChannelFormBody form={form} setForm={setForm} />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setForm(channelToFormState(channel));
            setEditing(false);
            setError(null);
          }}
          className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? 'md:col-span-2' : undefined}>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * Renders 5 rows showing where each prompt is being resolved from
 * (channel-db / channel-file / workflow-default). Helps the operator see at
 * a glance which fields they have customized.
 */
function PromptSourceSummary({ channel }: { channel: Channel }) {
  const rows: { label: string; source: string }[] = [
    {
      label: 'Album brief',
      source: channel.promptAlbumBrief ? 'channel-db' : 'workflow-default',
    },
    {
      label: 'Track briefs',
      source: channel.promptTrackBriefs ? 'channel-db' : 'workflow-default',
    },
    {
      label: 'Cover image',
      source: channel.promptCoverImage ? 'channel-db' : 'workflow-default',
    },
    {
      label: 'Thumbnail',
      source: channel.promptThumbnail ? 'channel-db' : 'workflow-default',
    },
    {
      label: 'YT metadata',
      source: channel.promptYtMetadata ? 'channel-db' : 'workflow-default',
    },
  ];
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Prompt configuration (precedence: channel-db &gt; channel-file &gt; workflow-default)
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3">
            <span>{r.label}</span>
            <span
              className={
                r.source === 'channel-db'
                  ? 'rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }
            >
              {r.source}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

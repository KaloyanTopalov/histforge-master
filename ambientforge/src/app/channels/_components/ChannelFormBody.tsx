'use client';

import { type Dispatch, type SetStateAction } from 'react';
import CollapsibleSection from '@/components/CollapsibleSection';
import PromptTestButton from '@/components/PromptTestButton';
import BrollValidateButton from '@/components/BrollValidateButton';
import {
  RAP_CLIP_STRATEGIES,
  WORKFLOWS,
  YOUTUBE_IMAGE_ASPECTS,
} from '@/lib/channels/constants';
import type { Channel, Workflow } from '@/lib/repos/channels';
import { SUNO_MODES, type SunoMode } from '@/lib/suno/modes';
import { SUNO_MODELS, isCustomSunoModel } from '@/lib/suno/models';

export type SunoPromptCard = {
  id?: string; // present on existing rows; absent on newly-added cards
  label: string;
  content: string;
  weight: number;
  active: boolean;
  /** Optional usage badge — populated server-side when fetching the prompts list. */
  albumsUsing?: number;
};

export type ChannelFormState = {
  name: string;
  displayName: string;
  description: string;
  active: boolean;
  scheduleCron: string;
  workflow: Workflow;
  tracksPerAlbum: string;
  targetVideoSeconds: string;
  brollFolderPath: string;
  rapClipStrategy: string;
  /** Legacy single-prompt field, kept for backward-compat with programmatic
   *  channel creators. The new UI uses sunoStylePrompts (collection) below. */
  sunoStylePrompt: string;
  sunoStylePrompts: SunoPromptCard[];
  sunoModel: string;
  sunoMode: SunoMode;
  sunoInstrumental: boolean;
  sunoPersonaId: string;
  promptAlbumBrief: string;
  promptTrackBriefs: string;
  promptCoverImage: string;
  promptThumbnail: string;
  promptYtMetadata: string;
  youtubeImageAspect: string;
  thumbnailOverlayText: string;
  distrokidArtistName: string;
  distrokidPrimaryGenre: string;
  distrokidLabelName: string;
  distrokidSongwriterName: string;
  distrokidPerformerName: string;
  distrokidPerformerRole: string;
  distrokidProducerName: string;
  distrokidProducerRole: string;
  youtubeChannelHandle: string;
  spotifyPlaylistUrl: string;
  hashtags: string;
  // v9 ambient-video. Only shown / used when workflow === 'ambient-video'.
  sceneThemes: string;
  seedanceMotionPrompt: string;
  // v10 ambient-video. Magnific saved-style name applied by the freepik-runner.
  imageStyleName: string;
};

export const NULLABLE_STRING_KEYS: (keyof ChannelFormState)[] = [
  'distrokidLabelName',
  'youtubeChannelHandle',
  'spotifyPlaylistUrl',
  'thumbnailOverlayText',
  'sunoPersonaId',
  'brollFolderPath',
  'sunoStylePrompt',
  'promptAlbumBrief',
  'promptTrackBriefs',
  'promptCoverImage',
  'promptThumbnail',
  'promptYtMetadata',
  'distrokidSongwriterName',
  'distrokidPerformerName',
  'distrokidPerformerRole',
  'distrokidProducerName',
  'distrokidProducerRole',
  'sceneThemes',
  'seedanceMotionPrompt',
  'imageStyleName',
];

const NULLABLE_NUMBER_KEYS: (keyof ChannelFormState)[] = [
  'tracksPerAlbum',
  'targetVideoSeconds',
];

const NULLABLE_ENUM_KEYS: (keyof ChannelFormState)[] = ['youtubeImageAspect', 'rapClipStrategy'];

export function emptyChannelFormState(): ChannelFormState {
  return {
    name: '',
    displayName: '',
    description: '',
    active: true,
    scheduleCron: '0 9 * * 1',
    workflow: 'ambient',
    tracksPerAlbum: '',
    targetVideoSeconds: '',
    brollFolderPath: '',
    rapClipStrategy: '',
    sunoStylePrompt: '',
    sunoStylePrompts: [],
    sunoModel: 'chirp-fenix',
    sunoMode: 'custom',
    sunoInstrumental: false,
    sunoPersonaId: '',
    promptAlbumBrief: '',
    promptTrackBriefs: '',
    promptCoverImage: '',
    promptThumbnail: '',
    promptYtMetadata: '',
    youtubeImageAspect: '',
    thumbnailOverlayText: '',
    distrokidArtistName: '',
    distrokidPrimaryGenre: 'Ambient',
    distrokidLabelName: '',
    distrokidSongwriterName: '',
    distrokidPerformerName: '',
    distrokidPerformerRole: '',
    distrokidProducerName: '',
    distrokidProducerRole: '',
    youtubeChannelHandle: '',
    spotifyPlaylistUrl: '',
    hashtags: '',
    sceneThemes: '',
    seedanceMotionPrompt: '',
    imageStyleName: '',
  };
}

export function channelToFormState(c: Channel): ChannelFormState {
  return {
    name: c.name,
    displayName: c.displayName,
    description: c.description,
    active: c.active,
    scheduleCron: c.scheduleCron,
    workflow: c.workflow,
    tracksPerAlbum: c.tracksPerAlbum != null ? String(c.tracksPerAlbum) : '',
    targetVideoSeconds: c.targetVideoSeconds != null ? String(c.targetVideoSeconds) : '',
    brollFolderPath: c.brollFolderPath ?? '',
    rapClipStrategy: c.rapClipStrategy ?? '',
    sunoStylePrompt: c.sunoStylePrompt ?? '',
    // sunoStylePrompts is fetched separately (not on Channel type) and merged
    // by the parent EditForm when opening the form. Default to empty list here.
    sunoStylePrompts: [],
    sunoModel: c.sunoModel,
    sunoMode: c.sunoMode,
    sunoInstrumental: c.sunoInstrumental,
    sunoPersonaId: c.sunoPersonaId ?? '',
    promptAlbumBrief: c.promptAlbumBrief ?? '',
    promptTrackBriefs: c.promptTrackBriefs ?? '',
    promptCoverImage: c.promptCoverImage ?? '',
    promptThumbnail: c.promptThumbnail ?? '',
    promptYtMetadata: c.promptYtMetadata ?? '',
    youtubeImageAspect: c.youtubeImageAspect ?? '',
    thumbnailOverlayText: c.thumbnailOverlayText ?? '',
    distrokidArtistName: c.distrokidArtistName,
    distrokidPrimaryGenre: c.distrokidPrimaryGenre,
    distrokidLabelName: c.distrokidLabelName ?? '',
    distrokidSongwriterName: c.distrokidSongwriterName ?? '',
    distrokidPerformerName: c.distrokidPerformerName ?? '',
    distrokidPerformerRole: c.distrokidPerformerRole ?? '',
    distrokidProducerName: c.distrokidProducerName ?? '',
    distrokidProducerRole: c.distrokidProducerRole ?? '',
    youtubeChannelHandle: c.youtubeChannelHandle ?? '',
    spotifyPlaylistUrl: c.spotifyPlaylistUrl ?? '',
    hashtags: c.hashtags,
    sceneThemes: c.sceneThemes ?? '',
    seedanceMotionPrompt: c.seedanceMotionPrompt ?? '',
    imageStyleName: c.imageStyleName ?? '',
  };
}

/** Convert form state to API request body. Empty strings on nullable string
 *  fields become null; empty numeric strings become null. */
export function formStateToBody(form: ChannelFormState): Record<string, unknown> {
  const body: Record<string, unknown> = { ...form };
  for (const k of NULLABLE_STRING_KEYS) {
    const v = body[k];
    if (typeof v === 'string' && v.trim() === '') body[k] = null;
  }
  for (const k of NULLABLE_NUMBER_KEYS) {
    const v = body[k];
    if (typeof v === 'string' && v.trim() === '') body[k] = null;
    else if (typeof v === 'string') body[k] = Number(v);
  }
  for (const k of NULLABLE_ENUM_KEYS) {
    const v = body[k];
    if (typeof v === 'string' && v.trim() === '') body[k] = null;
  }
  // Include sunoStylePrompts only if the user has at least one card or
  // explicitly cleared the list. We always send the array on form submit so
  // the API can replace-all (delete removed cards, patch existing, insert new).
  body.sunoStylePrompts = form.sunoStylePrompts.map((p) => ({
    ...(p.id ? { id: p.id } : {}),
    label: p.label,
    content: p.content,
    weight: p.weight,
    active: p.active,
  }));
  return body;
}

type Props = {
  form: ChannelFormState;
  setForm: Dispatch<SetStateAction<ChannelFormState>>;
};

export default function ChannelFormBody({ form, setForm }: Props) {
  const update = <K extends keyof ChannelFormState>(k: K, v: ChannelFormState[K]) => {
    setForm((p) => ({ ...p, [k]: v }));
  };
  const isRap = form.workflow === 'rap-compilation';
  const isAmbientVideo = form.workflow === 'ambient-video';

  return (
    <div className="space-y-4">
      {/* 1. Basic Info */}
      <CollapsibleSection title="Basic Info" defaultOpen>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name (slug)" required>
            <input
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="sad-ambient"
              className={inputCls}
            />
          </Field>
          <Field label="Display name" required>
            <input
              required
              value={form.displayName}
              onChange={(e) => update('displayName', e.target.value)}
              placeholder="i'm crying"
              className={inputCls}
            />
          </Field>
          <Field label="Description" full>
            <textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              rows={3}
              className={inputCls}
            />
          </Field>
          <Field label="Workflow" required>
            <select
              value={form.workflow}
              onChange={(e) =>
                update('workflow', e.target.value as ChannelFormState['workflow'])
              }
              className={inputCls}
            >
              {WORKFLOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Schedule (cron, 5 fields)" required>
            <input
              required
              value={form.scheduleCron}
              onChange={(e) => update('scheduleCron', e.target.value)}
              placeholder="0 9 * * 1"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="Active">
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => update('active', e.target.checked)}
              />
              <span>Scheduler will run this channel</span>
            </label>
          </Field>
        </div>
      </CollapsibleSection>

      {/* 2. Pipeline Config (workflow-aware) */}
      <CollapsibleSection
        title="Pipeline Config"
        hint={isRap ? 'rap-compilation: B-roll mux' : 'ambient: 2h static-image loop'}
        defaultOpen
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Tracks per album (blank = workflow default)">
            <input
              type="number"
              min={1}
              max={50}
              value={form.tracksPerAlbum}
              onChange={(e) => update('tracksPerAlbum', e.target.value)}
              placeholder={isRap ? '10' : '30'}
              className={inputCls}
            />
          </Field>
          {!isRap && (
            <Field label="Target video seconds (blank = global setting)">
              <input
                type="number"
                min={60}
                value={form.targetVideoSeconds}
                onChange={(e) => update('targetVideoSeconds', e.target.value)}
                placeholder="7200"
                className={inputCls}
              />
            </Field>
          )}
          {isRap && (
            <Field label="B-roll folder (absolute path)" required full>
              <input
                required
                value={form.brollFolderPath}
                onChange={(e) => update('brollFolderPath', e.target.value)}
                placeholder="C:\\Projects\\broll\\rap-clips"
                className={`${inputCls} font-mono`}
              />
              <BrollValidateButton folderPath={form.brollFolderPath} />
            </Field>
          )}
          {isRap && (
            <Field label="Rap clip strategy">
              <select
                value={form.rapClipStrategy}
                onChange={(e) => update('rapClipStrategy', e.target.value)}
                className={inputCls}
              >
                <option value="">(workflow default: random-fill)</option>
                {RAP_CLIP_STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </CollapsibleSection>

      {/* 2b. Ambient-video Scene Settings (only when workflow === 'ambient-video') */}
      {isAmbientVideo && (
        <CollapsibleSection
          title="Ambient-video"
          hint="Scene themes + Seedance motion-prompt fallback"
          defaultOpen
        >
          <div className="grid grid-cols-1 gap-3">
            <Field
              label="Scene themes (JSON array of strings; blank = use the default fallback theme)"
              full
            >
              <textarea
                value={form.sceneThemes}
                onChange={(e) => update('sceneThemes', e.target.value)}
                rows={6}
                placeholder={`["knight by campfire at night", "knight resting by river at dusk", "knight in ancient ruins at twilight"]`}
                className={`${inputCls} font-mono text-xs`}
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Each album run picks one theme at random. Step 01b uses the OpenRouter
                scene-generator to produce a Midjourney prompt, a Seedance motion prompt, and a
                Gates-formula title from the picked theme.
              </p>
            </Field>
            <Field
              label="Seedance motion prompt (channel-level fallback)"
              full
            >
              <textarea
                value={form.seedanceMotionPrompt}
                onChange={(e) => update('seedanceMotionPrompt', e.target.value)}
                rows={4}
                placeholder="Static locked camera. Animate only natural environmental elements directly visible in the scene. Knight is still. No camera movement, no zoom, no pan. Seamless infinite loop."
                className={`${inputCls} text-xs`}
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Used by step 08 when the per-album <code>scene_seedance_prompt</code> is empty.
                Operator-driven Midjourney generation goes through <code>source.jpg</code> dropped
                at <code>projects/&lt;channel_id&gt;/source.jpg</code>.
              </p>
            </Field>
            <Field label="Magnific saved-style name (optional)" full>
              <input
                type="text"
                value={form.imageStyleName}
                onChange={(e) => update('imageStyleName', e.target.value)}
                placeholder="medievel"
                className={inputCls}
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                When set, the freepik-runner picks this saved style in Magnific&apos;s My
                Styles before generating. Match the alt-text on the style card (the
                leading <code>#</code> is optional, case-insensitive).
              </p>
            </Field>
          </div>
        </CollapsibleSection>
      )}

      {/* 3. Suno Settings */}
      <CollapsibleSection title="Suno Settings" defaultOpen>
        <SunoPromptCardsSection
          prompts={form.sunoStylePrompts}
          onChange={(next) => update('sunoStylePrompts', next)}
          legacyPrompt={form.sunoStylePrompt}
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Suno model (mv)" required>
            <select
              value={isCustomSunoModel(form.sunoModel) ? '__custom__' : form.sunoModel}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  // Switch to custom — preserve the current value if it was
                  // already a custom string; otherwise clear so the operator
                  // can paste a new mv.
                  if (!isCustomSunoModel(form.sunoModel)) update('sunoModel', '');
                } else {
                  update('sunoModel', e.target.value);
                }
              }}
              className={inputCls}
            >
              {SUNO_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                  {m.hint ? ` — ${m.hint}` : ''}
                </option>
              ))}
              <option value="__custom__">Other / custom…</option>
            </select>
            {isCustomSunoModel(form.sunoModel) && (
              <input
                required
                value={form.sunoModel}
                onChange={(e) => update('sunoModel', e.target.value)}
                placeholder="chirp-custom:<uuid> or any mv string"
                className={`${inputCls} font-mono mt-2`}
              />
            )}
          </Field>
          <Field label="Suno mode">
            <select
              value={form.sunoMode}
              onChange={(e) => update('sunoMode', e.target.value as SunoMode)}
              className={inputCls}
            >
              {SUNO_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Suno persona id (optional)">
            <input
              value={form.sunoPersonaId}
              onChange={(e) => update('sunoPersonaId', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Suno instrumental">
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sunoInstrumental}
                onChange={(e) => update('sunoInstrumental', e.target.checked)}
              />
              <span>No vocals</span>
            </label>
          </Field>
        </div>
      </CollapsibleSection>

      {/* 4. LLM Prompts */}
      <CollapsibleSection
        title="LLM Prompts"
        hint="blank = workflow default; fill to customize"
      >
        <PromptField
          label="Album brief"
          kind="album-brief"
          value={form.promptAlbumBrief}
          onChange={(v) => update('promptAlbumBrief', v)}
          form={form}
        />
        <PromptField
          label="Track briefs"
          kind="track-briefs"
          value={form.promptTrackBriefs}
          onChange={(v) => update('promptTrackBriefs', v)}
          form={form}
        />
        <PromptField
          label="Cover image"
          kind="cover-image"
          value={form.promptCoverImage}
          onChange={(v) => update('promptCoverImage', v)}
          form={form}
        />
        <PromptField
          label="Thumbnail"
          kind="thumbnail"
          value={form.promptThumbnail}
          onChange={(v) => update('promptThumbnail', v)}
          form={form}
        />
        <PromptField
          label="YouTube metadata"
          kind="yt-metadata"
          value={form.promptYtMetadata}
          onChange={(v) => update('promptYtMetadata', v)}
          form={form}
        />
      </CollapsibleSection>

      {/* 5. Cover & Thumbnail Config */}
      <CollapsibleSection title="Cover & Thumbnail">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="YouTube image aspect (blank = global setting)">
            <select
              value={form.youtubeImageAspect}
              onChange={(e) => update('youtubeImageAspect', e.target.value)}
              className={inputCls}
            >
              <option value="">(global default)</option>
              {YOUTUBE_IMAGE_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Thumbnail overlay text (optional)">
            <input
              value={form.thumbnailOverlayText}
              onChange={(e) => update('thumbnailOverlayText', e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
      </CollapsibleSection>

      {/* 6. DistroKid Settings */}
      <CollapsibleSection title="DistroKid Settings" defaultOpen>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Artist name" required>
            <input
              required
              value={form.distrokidArtistName}
              onChange={(e) => update('distrokidArtistName', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Primary genre" required>
            <input
              required
              value={form.distrokidPrimaryGenre}
              onChange={(e) => update('distrokidPrimaryGenre', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Label name (optional)">
            <input
              value={form.distrokidLabelName}
              onChange={(e) => update('distrokidLabelName', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Songwriter name (channel override; blank = global)">
            <input
              value={form.distrokidSongwriterName}
              onChange={(e) => update('distrokidSongwriterName', e.target.value)}
              placeholder="First Last"
              className={inputCls}
            />
          </Field>
          <Field label="Performer name (override)">
            <input
              value={form.distrokidPerformerName}
              onChange={(e) => update('distrokidPerformerName', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Performer role (override)">
            <input
              value={form.distrokidPerformerRole}
              onChange={(e) => update('distrokidPerformerRole', e.target.value)}
              placeholder="main-artist"
              className={inputCls}
            />
          </Field>
          <Field label="Producer name (override)">
            <input
              value={form.distrokidProducerName}
              onChange={(e) => update('distrokidProducerName', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Producer role (override)">
            <input
              value={form.distrokidProducerRole}
              onChange={(e) => update('distrokidProducerRole', e.target.value)}
              placeholder="producer"
              className={inputCls}
            />
          </Field>
        </div>
      </CollapsibleSection>

      {/* 7. YouTube + Hashtags */}
      <CollapsibleSection title="YouTube & Hashtags">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="YouTube channel handle">
            <input
              value={form.youtubeChannelHandle}
              onChange={(e) => update('youtubeChannelHandle', e.target.value)}
              placeholder="@songsforcry"
              className={inputCls}
            />
          </Field>
          <Field label="Spotify playlist URL">
            <input
              type="url"
              value={form.spotifyPlaylistUrl}
              onChange={(e) => update('spotifyPlaylistUrl', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Hashtags (CSV)" full>
            <input
              value={form.hashtags}
              onChange={(e) => update('hashtags', e.target.value)}
              placeholder="ambient,sleep,study"
              className={inputCls}
            />
          </Field>
        </div>
      </CollapsibleSection>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${full ? 'md:col-span-2' : ''}`}>
      <span className="text-zinc-700 dark:text-zinc-300">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function SunoPromptCardsSection({
  prompts,
  onChange,
  legacyPrompt,
}: {
  prompts: SunoPromptCard[];
  onChange: (next: SunoPromptCard[]) => void;
  legacyPrompt: string;
}) {
  const update = (idx: number, patch: Partial<SunoPromptCard>) => {
    onChange(prompts.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };
  const addCard = () => {
    onChange([
      ...prompts,
      {
        label: `prompt-${prompts.length + 1}`,
        content: '',
        weight: 1.0,
        active: true,
      },
    ]);
  };
  const removeCard = (idx: number) => {
    onChange(prompts.filter((_, i) => i !== idx));
  };
  const activeCount = prompts.filter((p) => p.active && p.content.trim().length > 0).length;
  const showLegacyHint =
    prompts.length === 0 && legacyPrompt.trim().length > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Suno style prompts (collection)</div>
          <div className="text-xs text-zinc-500">
            {prompts.length === 0 ? (
              showLegacyHint ? (
                <span>
                  Using legacy single-prompt fallback (channel.suno_style_prompt).
                  Add cards to use the new collection.
                </span>
              ) : (
                <span>No prompts yet. Step 03 will fail at preflight without one.</span>
              )
            ) : (
              <span>
                {activeCount} active / {prompts.length} total — step 03 picks one at random
                per album.
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={addCard}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          + Add prompt
        </button>
      </div>
      {prompts.map((p, idx) => (
        <div
          key={p.id ?? `new-${idx}`}
          className="space-y-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_120px_80px_60px]">
            <input
              value={p.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              placeholder="label (e.g. warm-pads)"
              className={inputCls}
            />
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={p.weight}
              onChange={(e) => update(idx, { weight: Number(e.target.value) || 0 })}
              placeholder="weight"
              className={inputCls}
              title="weight (stored, not yet used for selection)"
            />
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.active}
                onChange={(e) => update(idx, { active: e.target.checked })}
              />
              <span>active</span>
            </label>
            <button
              type="button"
              onClick={() => removeCard(idx)}
              className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Delete
            </button>
          </div>
          <textarea
            value={p.content}
            onChange={(e) => update(idx, { content: e.target.value })}
            rows={4}
            placeholder="slow ambient drift at 60 BPM, warm analog pads..."
            className={inputCls}
          />
          {p.albumsUsing != null && p.albumsUsing > 0 && (
            <div className="text-xs text-zinc-500">used in {p.albumsUsing} album{p.albumsUsing === 1 ? '' : 's'}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function PromptField({
  label,
  kind,
  value,
  onChange,
  form,
}: {
  label: string;
  kind: 'album-brief' | 'track-briefs' | 'cover-image' | 'thumbnail' | 'yt-metadata';
  value: string;
  onChange: (v: string) => void;
  form: ChannelFormState;
}) {
  const channelDraft: Record<string, unknown> = {
    name: form.name,
    displayName: form.displayName,
    description: form.description,
    workflow: form.workflow,
    distrokidArtistName: form.distrokidArtistName,
    distrokidPrimaryGenre: form.distrokidPrimaryGenre,
    sunoStylePrompt: form.sunoStylePrompt,
    hashtags: form.hashtags,
    spotifyPlaylistUrl: form.spotifyPlaylistUrl,
  };
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <button
          type="button"
          onClick={() => onChange('')}
          disabled={value.length === 0}
          className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-30 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          Reset to default
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        placeholder={`(blank = workflow default for ${form.workflow})`}
        className={`${inputCls} font-mono text-xs`}
      />
      <PromptTestButton
        promptKind={kind}
        promptValue={value}
        channelDraft={channelDraft}
      />
    </div>
  );
}

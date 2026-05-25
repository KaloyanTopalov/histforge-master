import * as tracksRepo from '@/lib/repos/tracks';
import * as channelsRepo from '@/lib/repos/channels';
import { setSetting } from '@/lib/settings';
import { makeSunoClient, SunoError, type SunoClient } from '@/lib/suno/client';
import { resolveEffectiveSunoConfig } from '@/lib/suno/effective-config';
import { selectSunoPromptRotation, selectSunoPromptForAlbum } from '@/lib/suno/select-prompt';
import {
  isBridgeDisrupted,
  pauseAlbumForBridgeDisruption,
} from '@/lib/suno/bridge-disruption';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import * as albumsRepo from '@/lib/repos/albums';
import { getDb } from '@/lib/db';
import type { Album } from '@/lib/repos/albums';
import type { Channel } from '@/lib/repos/channels';
import type { Track } from '@/lib/repos/tracks';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const SUBMIT_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const step03SunoGenerate: PipelineStep = async (album, log) =>
  step03Internal(
    album,
    log,
    makeSunoClient(),
    process.env.SUNO_MODE === 'mock' ? { submitDelayMs: 0, retryDelayMs: 0 } : {},
  );

export async function step03Internal(
  album: Album,
  log: LogFn,
  client: SunoClient,
  opts: { submitDelayMs?: number; retryDelayMs?: number } = {},
): Promise<void> {
  log('step 03', 'start');
  const submitDelayMs = opts.submitDelayMs ?? SUBMIT_DELAY_MS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  const tracks = tracksRepo.listByAlbum(album.id);
  if (tracks.length === 0) {
    log('step 03', 'noop (no tracks)');
    return;
  }

  const pending = tracks.filter((t) => t.sunoTaskId == null);
  if (pending.length === 0) {
    log('step 03', `noop (all ${tracks.length} tracks already submitted)`);
    return;
  }

  const channel = channelsRepo.get(album.channelId);
  if (!channel) {
    throw new SunoError('SUNO_CHANNEL_MISSING', `channel ${album.channelId} not found`, false);
  }
  const effective = resolveEffectiveSunoConfig(album, channel);
  log(
    'step 03',
    `effective model=${effective.model} mode=${effective.mode} instrumental=${effective.instrumental} persona=${effective.personaId ?? '-'}`,
  );

  // Suno-dual-variant (per-channel opt-in): submit N/2 generations and keep
  // BOTH of Suno's clips per generation (≈half the Suno spend, same 30
  // tracks). Non-flagged channels skip this entirely and fall through to the
  // unchanged per-track path below — byte-identical legacy behavior.
  if (channel.sunoDualVariant) {
    await runDualVariantSubmit(album, log, client, channel, effective, {
      submitDelayMs,
      retryDelayMs,
    });
    return;
  }

  // Resolve per-track style assignments. With multiple active prompts in the
  // channel collection, this rotates styles across tracks (round-robin sorted
  // by id). With one active prompt it degenerates to a single style for the
  // whole album. Persists tracks.suno_prompt_id + suno_prompt_resolved_text
  // so retries reuse the same assignments idempotently.
  const rotation = await selectSunoPromptRotation(album.channelId, album.id);
  const activeCount = sunoPromptsRepo.listByChannel(album.channelId, { activeOnly: true }).length;
  // Build a per-track index (1-based) → SelectedSunoPrompt for quick lookup.
  const allTracks = tracksRepo.listByAlbum(album.id);
  const styleByTrackNumber = new Map<number, (typeof rotation)[number]>();
  for (let i = 0; i < allTracks.length && i < rotation.length; i++) {
    styleByTrackNumber.set(allTracks[i].trackNumber, rotation[i]);
  }

  // Distinct prompts actually used (for log readability + audit).
  const distinct = new Map<string | null, { count: number; label: string }>();
  for (const sel of rotation) {
    const key = sel.promptId;
    const cur = distinct.get(key);
    if (cur) {
      cur.count += 1;
    } else {
      const label = sel.promptId
        ? sunoPromptsRepo.get(sel.promptId)?.label ?? '(deleted)'
        : sel.source === 'legacy-column'
          ? '(legacy-column)'
          : sel.source === 'in-flight-album-snapshot'
            ? '(in-flight)'
            : '(snapshot)';
      distinct.set(key, { count: 1, label });
    }
  }
  const distinctSummary = [...distinct.values()]
    .map((v) => `${v.label}×${v.count}`)
    .join(', ');
  log(
    'step 03',
    `suno-prompt rotation active=${activeCount} distinct=${distinct.size} (${distinctSummary})`,
  );

  const credits = await client.getCredits();
  const required = pending.length;
  log(
    'step 03',
    `credits=${credits} required=${required} pending=${pending.length}/${tracks.length}`,
  );
  if (credits < required) {
    setSetting(
      'suno_insufficient_credits',
      JSON.stringify({ credits, required, at: Date.now(), albumId: album.id }),
    );
    throw new SunoError(
      'INSUFFICIENT_SUNO_CREDITS',
      `credits ${credits} < required ${required}`,
      false,
    );
  }
  setSetting('suno_insufficient_credits', '');

  for (let i = 0; i < pending.length; i++) {
    const track = pending[i];
    const trackStyle = styleByTrackNumber.get(track.trackNumber);
    if (!trackStyle) {
      // Should never happen — rotation length matches tracks length.
      throw new SunoError(
        'SUNO_STYLE_PROMPT_REQUIRED',
        `no style prompt resolved for track ${track.trackNumber} in album ${album.id}`,
        false,
      );
    }
    let attempts = 0;
    let lastErr: unknown;
    let succeeded = false;
    while (attempts < 2) {
      try {
        const taskId = await client.submit({
          stylePrompt: trackStyle.content,
          lyrics: track.sunoLyrics ?? '',
          model: effective.model,
          mode: effective.mode,
          instrumental: effective.instrumental,
          personaId: effective.personaId,
          title: track.title,
        });
        tracksRepo.patch(track.id, { sunoTaskId: taskId, status: 'submitted' });
        const styleLabel = trackStyle.promptId
          ? sunoPromptsRepo.get(trackStyle.promptId)?.label ?? '(deleted)'
          : `(${trackStyle.source})`;
        log(
          'step 03',
          `submitted track=${track.trackNumber} taskId=${taskId} style=${styleLabel}`,
        );
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof SunoError && err.code === 'INSUFFICIENT_SUNO_CREDITS') {
          throw err;
        }
        // Bridge / sidecar / Chrome chain is disrupted. Don't burn this track
        // (or the remaining ones) on failed retries — pause the album, throw,
        // and let the resume path pick up exactly the unsubmitted tracks. The
        // already-submitted tracks earlier in this loop keep their sunoTaskId
        // and are skipped by step 04 idempotency.
        if (isBridgeDisrupted(err)) {
          log(
            'step 03',
            `halted album for bridge disruption code=${err.code} after ${i} successful submits this run; ${pending.length - i} tracks left to retry on resume`,
          );
          pauseAlbumForBridgeDisruption(album.id, album.channelId, err);
        }
        if (err instanceof SunoError && !err.retriable) {
          break;
        }
        attempts++;
        if (attempts < 2) {
          log('step 03', `retry track=${track.trackNumber} after ${retryDelayMs}ms`);
          await sleep(retryDelayMs);
        }
      }
    }
    if (!succeeded) {
      tracksRepo.patch(track.id, { status: 'failed' });
      const code =
        lastErr instanceof SunoError ? lastErr.code : (lastErr as { code?: string })?.code ?? '';
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      const codeStr = code ? `code=${code} ` : '';
      log('step 03', `failed track=${track.trackNumber} ${codeStr}err=${msg}`);
    }
    if (i < pending.length - 1) {
      await sleep(submitDelayMs);
    }
  }

  const after = tracksRepo.listByAlbum(album.id);
  const submittedCount = after.filter((t) => t.sunoTaskId != null).length;
  const failedCount = after.filter((t) => t.status === 'failed').length;
  log(
    'step 03',
    `done submitted=${submittedCount}/${tracks.length} failed=${failedCount}`,
  );
}

/**
 * Suno-dual-variant submission. ONE Suno generation produces TWO clips; we
 * pair adjacent tracks and map a generation's two clips onto the pair (clip 0
 * / clip 1, recorded on tracks.suno_clip_index). 30 tracks → 15 generations
 * (≈half the Suno credits) while keeping 30 normal track rows so concat /
 * DistroKid / mux are unaffected. Mirrors the legacy loop's robustness
 * (credit gate, bridge-disruption pause-and-resume, retry, submit delay).
 * Only reached when channel.sunoDualVariant is set.
 */
async function runDualVariantSubmit(
  album: Album,
  log: LogFn,
  client: SunoClient,
  channel: Channel,
  effective: ReturnType<typeof resolveEffectiveSunoConfig>,
  opts: { submitDelayMs: number; retryDelayMs: number },
): Promise<void> {
  void channel; // gating already done by caller; kept for signature clarity
  const { submitDelayMs, retryDelayMs } = opts;
  if (typeof client.submitClips !== 'function') {
    throw new SunoError(
      'SUNO_DUAL_VARIANT_UNAVAILABLE',
      'dual-variant requires a client with submitClips (bridge/mock)',
      false,
    );
  }
  const tracks = tracksRepo.listByAlbum(album.id);
  // Adjacent tracks pair up: (1,2),(3,4),… Each pair = ONE generation whose
  // two clips become the two tracks. An odd tail track (never for
  // ambient-video=30) degrades to a single-clip generation.
  const pairs: Array<{ a: Track; b: Track | null; index: number }> = [];
  for (let i = 0; i < tracks.length; i += 2) {
    pairs.push({ a: tracks[i], b: tracks[i + 1] ?? null, index: i / 2 });
  }

  // One style per generation (per pair). Round-robin over the channel's
  // active prompts sorted by id (pair p → sorted[p % N]); deterministic so a
  // resumed run re-derives the same style. No active prompts → fall back to
  // the album-level single style (legacy column / hard-fail), resolved once.
  const active = sunoPromptsRepo.listByChannel(album.channelId, { activeOnly: true });
  const sorted = [...active].sort((x, y) => x.id.localeCompare(y.id));
  let fallback: { promptId: string | null; content: string } | null = null;
  const styleForPair = async (
    p: number,
  ): Promise<{ promptId: string | null; content: string }> => {
    if (sorted.length > 0) {
      const pick = sorted[p % sorted.length];
      return { promptId: pick.id, content: pick.content };
    }
    if (!fallback) {
      const sel = await selectSunoPromptForAlbum(album.channelId, album.id);
      fallback = { promptId: sel.promptId, content: sel.content };
    }
    return fallback;
  };

  // A pair is pending only if NEITHER track is submitted. The pair is patched
  // transactionally so a half-submitted pair shouldn't occur on the normal
  // path; if it somehow does (hard-kill in the submitClips→commit micro-window,
  // or a manual DB edit), it is NOT pending (we never re-bill a generation
  // whose partner clip may have succeeded).
  const pendingPairs = pairs.filter(
    (pr) => pr.a.sunoTaskId == null && (pr.b == null || pr.b.sunoTaskId == null),
  );
  // Observability: a half-pair (exactly one track has a task) is neither
  // pending (won't be re-submitted — conservative, no double-bill) nor
  // complete, so the orphan track would otherwise vanish silently and ship
  // the album one track short. Surface it loudly so the operator can repair
  // it. Logged BEFORE the noop early-return so it can't be hidden by an
  // otherwise fully-submitted album.
  const partialPairs = pairs.filter(
    (pr) => pr.b != null && (pr.a.sunoTaskId == null) !== (pr.b.sunoTaskId == null),
  );
  if (partialPairs.length > 0) {
    const detail = partialPairs
      .map((pr) => {
        const submitted = pr.a.sunoTaskId != null ? pr.a : pr.b!;
        const orphan = pr.a.sunoTaskId != null ? pr.b! : pr.a;
        return `pair=${pr.index} submitted=track${submitted.trackNumber}(${submitted.sunoTaskId}) orphan=track${orphan.trackNumber}`;
      })
      .join('; ');
    log(
      'step 03',
      `WARN ${partialPairs.length} half-submitted pair(s) — orphan track(s) SKIPPED (no double-bill); album will be short unless repaired: ${detail}`,
    );
  }
  if (pendingPairs.length === 0) {
    log('step 03', `noop (all ${pairs.length} dual-variant pairs already submitted)`);
    return;
  }

  const credits = await client.getCredits();
  const required = pendingPairs.length; // ONE generation per pair
  log(
    'step 03',
    `dual-variant: ${tracks.length} tracks → ${pairs.length} pairs; pending=${pendingPairs.length} generations=${required} credits=${credits}`,
  );
  if (credits < required) {
    setSetting(
      'suno_insufficient_credits',
      JSON.stringify({ credits, required, at: Date.now(), albumId: album.id }),
    );
    throw new SunoError(
      'INSUFFICIENT_SUNO_CREDITS',
      `credits ${credits} < required ${required}`,
      false,
    );
  }
  setSetting('suno_insufficient_credits', '');

  const db = getDb();
  for (let pi = 0; pi < pendingPairs.length; pi++) {
    const pr = pendingPairs[pi];
    const style = await styleForPair(pr.index);
    let attempts = 0;
    let lastErr: unknown;
    let succeeded = false;
    while (attempts < 2) {
      try {
        const { taskId } = await client.submitClips!({
          stylePrompt: style.content,
          lyrics: pr.a.sunoLyrics ?? '',
          model: effective.model,
          mode: effective.mode,
          instrumental: effective.instrumental,
          personaId: effective.personaId,
          title: pr.a.title,
        });
        // Atomic pair commit: both tracks share the generation's taskId;
        // clip 0 → first track, clip 1 → second. Either both rows get the
        // task or neither (crash-safe — no half-submitted pair).
        const commit = db.transaction(() => {
          tracksRepo.patch(
            pr.a.id,
            {
              sunoTaskId: taskId,
              sunoClipIndex: 0,
              status: 'submitted',
              sunoPromptId: style.promptId,
              sunoPromptResolvedText: style.content,
            },
            db,
          );
          if (pr.b) {
            tracksRepo.patch(
              pr.b.id,
              {
                sunoTaskId: taskId,
                sunoClipIndex: 1,
                status: 'submitted',
                sunoPromptId: style.promptId,
                sunoPromptResolvedText: style.content,
              },
              db,
            );
          }
        });
        commit();
        log(
          'step 03',
          `submitted pair=${pr.index} taskId=${taskId} tracks=${pr.a.trackNumber}${pr.b ? '+' + pr.b.trackNumber : ''} clips=2 style=${style.promptId ?? '(fallback)'}`,
        );
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof SunoError && err.code === 'INSUFFICIENT_SUNO_CREDITS') {
          throw err;
        }
        if (isBridgeDisrupted(err)) {
          log(
            'step 03',
            `halted album for bridge disruption code=${err.code} after ${pi} pairs this run; ${pendingPairs.length - pi} pairs left to retry on resume`,
          );
          pauseAlbumForBridgeDisruption(album.id, album.channelId, err);
        }
        if (err instanceof SunoError && !err.retriable) {
          break;
        }
        attempts++;
        if (attempts < 2) {
          log('step 03', `retry pair=${pr.index} after ${retryDelayMs}ms`);
          await sleep(retryDelayMs);
        }
      }
    }
    if (!succeeded) {
      const code =
        lastErr instanceof SunoError
          ? lastErr.code
          : (lastErr as { code?: string })?.code ?? '';
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      tracksRepo.patch(pr.a.id, { status: 'failed' });
      if (pr.b) tracksRepo.patch(pr.b.id, { status: 'failed' });
      log('step 03', `failed pair=${pr.index} ${code ? `code=${code} ` : ''}err=${msg}`);
    }
    if (pi < pendingPairs.length - 1) {
      await sleep(submitDelayMs);
    }
  }

  // Album-level "primary" = pair 0's style, mirroring selectSunoPromptRotation
  // so cover/audit queries keep working without knowing about pairing.
  try {
    const first = await styleForPair(0);
    albumsRepo.patch(
      album.id,
      {
        sunoPromptId: first.promptId,
        sunoPromptResolvedText: first.content,
        sunoStylePrompt: first.content,
      },
      db,
    );
  } catch {
    /* best-effort audit field */
  }

  const after = tracksRepo.listByAlbum(album.id);
  const submittedCount = after.filter((t) => t.sunoTaskId != null).length;
  const failedCount = after.filter((t) => t.status === 'failed').length;
  log(
    'step 03',
    `done dual-variant submitted=${submittedCount}/${tracks.length} failed=${failedCount}`,
  );
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import {
  selectSunoPromptForAlbum,
  selectSunoPromptRotation,
  SunoStylePromptRequiredError,
} from '@/lib/suno/select-prompt';

function seedTracks(albumId: string, n: number, db: Db): void {
  tracksRepo.insertMany(
    Array.from({ length: n }, (_, i) => ({
      albumId,
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
      sunoLyrics: 'placeholder',
    })),
    db,
  );
}

let db: Db;

const baseChannel = {
  name: 'sp-test',
  displayName: 'SP Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'SP Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
});

describe('selectSunoPromptForAlbum', () => {
  it('throws SUNO_STYLE_PROMPT_REQUIRED when no source exists', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    const album = albumsRepo.create({ channelId: channel.id }, db);
    await expect(selectSunoPromptForAlbum(channel.id, album.id, db)).rejects.toBeInstanceOf(
      SunoStylePromptRequiredError,
    );
  });

  it('returns legacy column when no active prompts but channel.sunoStylePrompt set', async () => {
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy seed' },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    const result = await selectSunoPromptForAlbum(channel.id, album.id, db);
    expect(result.source).toBe('legacy-column');
    expect(result.promptId).toBe(null);
    expect(result.content).toBe('legacy seed');
    const after = albumsRepo.get(album.id, db)!;
    expect(after.sunoPromptResolvedText).toBe('legacy seed');
    expect(after.sunoStylePrompt).toBe('legacy seed');
  });

  it('picks from active collection and persists FK + resolved text', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'one', content: 'voice 1', active: true },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    const result = await selectSunoPromptForAlbum(channel.id, album.id, db);
    expect(result.source).toBe('channel-prompts');
    expect(result.promptId).not.toBe(null);
    expect(result.content).toBe('voice 1');
    const after = albumsRepo.get(album.id, db)!;
    expect(after.sunoPromptId).toBe(result.promptId);
    expect(after.sunoPromptResolvedText).toBe('voice 1');
    expect(after.sunoStylePrompt).toBe('voice 1');
  });

  it('idempotent: re-running uses the same prompt (no re-roll)', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'A', active: true },
      db,
    );
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'b', content: 'B', active: true },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    const first = await selectSunoPromptForAlbum(channel.id, album.id, db);
    const second = await selectSunoPromptForAlbum(channel.id, album.id, db);
    expect(second.promptId).toBe(first.promptId);
    expect(second.source).toBe('resumed');
  });

  it('in-flight album: preserves existing sunoStylePrompt without re-rolling', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    // Add a prompt to the collection so the random-pick branch exists, but the
    // album was created before that — its sunoStylePrompt is already populated.
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'new-collection', content: 'fresh content', active: true },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    albumsRepo.patch(album.id, { sunoStylePrompt: 'old in-flight value' }, db);

    const result = await selectSunoPromptForAlbum(channel.id, album.id, db);
    expect(result.source).toBe('in-flight-album-snapshot');
    expect(result.content).toBe('old in-flight value');
    expect(result.promptId).toBe(null);
    const after = albumsRepo.get(album.id, db)!;
    expect(after.sunoPromptResolvedText).toBe('old in-flight value');
  });

  it('resumed: prompt deleted falls back to resolved-text snapshot', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'soon-deleted', content: 'snap-content', active: true },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    await selectSunoPromptForAlbum(channel.id, album.id, db);
    // Now delete the prompt — album.suno_prompt_id should null out, but
    // resolved_text stays as the snapshot.
    sunoPromptsRepo.remove(p.id, db);
    const result = await selectSunoPromptForAlbum(channel.id, album.id, db);
    expect(result.source).toBe('resumed');
    expect(result.promptId).toBe(null);
    expect(result.content).toBe('snap-content');
  });

  it('distribution: 100 invocations across 3 prompts spread to ≥2 distinct labels', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'a', content: 'A' }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'b', content: 'B' }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'c', content: 'C' }, db);

    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const album = albumsRepo.create({ channelId: channel.id }, db);
      const r = await selectSunoPromptForAlbum(channel.id, album.id, db);
      seen.add(r.content);
    }
    // With 3 equally-likely prompts in 100 trials, P(only 1 label seen) is
    // (1/3)^99 * 3 — astronomically small. ≥2 labels is a very loose bound.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe('selectSunoPromptRotation', () => {
  it('round-robin: 10 tracks across 3 prompts → 4/3/3 distribution', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'a', content: 'A' }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'b', content: 'B' }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'c', content: 'C' }, db);

    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 10, db);

    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(result).toHaveLength(10);
    const counts = new Map<string, number>();
    for (const r of result) counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
    expect(counts.size).toBe(3);
    const sorted = [...counts.values()].sort((a, b) => b - a);
    expect(sorted).toEqual([4, 3, 3]);
    // All tracks have stored prompt_id + snapshot
    const tracks = tracksRepo.listByAlbum(album.id, db);
    for (const t of tracks) {
      expect(t.sunoPromptId).not.toBe(null);
      expect(t.sunoPromptResolvedText).not.toBe(null);
    }
    // Album-level primary = track 1's pick
    const after = albumsRepo.get(album.id, db)!;
    expect(after.sunoPromptId).toBe(tracks[0].sunoPromptId);
    expect(after.sunoPromptResolvedText).toBe(tracks[0].sunoPromptResolvedText);
    expect(after.sunoStylePrompt).toBe(tracks[0].sunoPromptResolvedText);
  });

  it('idempotent resume: re-running gives identical assignments', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'a', content: 'A' }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'b', content: 'B' }, db);
    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 5, db);

    const first = await selectSunoPromptRotation(channel.id, album.id, db);
    const second = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(second.map((r) => r.promptId)).toEqual(first.map((r) => r.promptId));
    // Source flips to 'resumed' on the second pass
    for (const r of second) expect(r.source).toBe('resumed');
  });

  it('single active prompt: all tracks get same prompt', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create({ channelId: channel.id, label: 'only', content: 'ONLY' }, db);
    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 7, db);

    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(new Set(result.map((r) => r.content))).toEqual(new Set(['ONLY']));
  });

  it('no active prompts + legacy column: all tracks get legacy content', async () => {
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy seed' },
      db,
    );
    // The schema-init backfill creates a migrated-default prompt from
    // sunoStylePrompt, so deactivate it to simulate "0 active + legacy col".
    const all = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    for (const p of all) sunoPromptsRepo.patch(p.id, { active: false }, db);

    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 4, db);

    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.content))).toEqual(new Set(['legacy seed']));
    expect(result[0].source).toBe('legacy-column');
  });

  it('legacy single-style album (v7-era): copies album.suno_prompt_id to all tracks', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    const promptA = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'A' },
      db,
    );
    sunoPromptsRepo.create({ channelId: channel.id, label: 'b', content: 'B' }, db);
    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 5, db);
    // Simulate v7-era state: album-level binding exists but tracks do not.
    albumsRepo.patch(
      album.id,
      {
        sunoPromptId: promptA.id,
        sunoPromptResolvedText: 'A',
        sunoStylePrompt: 'A',
      },
      db,
    );

    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(new Set(result.map((r) => r.content))).toEqual(new Set(['A']));
    const tracks = tracksRepo.listByAlbum(album.id, db);
    for (const t of tracks) {
      expect(t.sunoPromptId).toBe(promptA.id);
      expect(t.sunoPromptResolvedText).toBe('A');
    }
  });

  it('cascade delete: nulls track FK, snapshot survives, content still resolvable', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'A' },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 3, db);
    await selectSunoPromptRotation(channel.id, album.id, db);

    // All 3 tracks point at the prompt, snapshots set
    const before = tracksRepo.listByAlbum(album.id, db);
    for (const t of before) expect(t.sunoPromptId).toBe(p.id);

    // Delete the prompt — track FKs should null but snapshots survive
    sunoPromptsRepo.remove(p.id, db);
    const after = tracksRepo.listByAlbum(album.id, db);
    for (const t of after) {
      expect(t.sunoPromptId).toBe(null);
      expect(t.sunoPromptResolvedText).toBe('A');
    }

    // Re-running rotation: snapshots used as resume-source
    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    expect(result.every((r) => r.content === 'A')).toBe(true);
    expect(result.every((r) => r.source === 'resumed')).toBe(true);
  });

  it('determinism: rotation order is sorted by prompt id ASC', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    // Create prompts in shuffled order to verify the sort happens.
    const pZ = sunoPromptsRepo.create({ channelId: channel.id, label: 'z', content: 'Z' }, db);
    const pA = sunoPromptsRepo.create({ channelId: channel.id, label: 'a', content: 'A' }, db);
    const pM = sunoPromptsRepo.create({ channelId: channel.id, label: 'm', content: 'M' }, db);

    const album = albumsRepo.create({ channelId: channel.id }, db);
    seedTracks(album.id, 6, db);

    const result = await selectSunoPromptRotation(channel.id, album.id, db);
    // ULIDs are time-monotonic and Crockford-sorted, so insertion order =
    // sorted-by-id order. Track 1 → Z, Track 2 → A, Track 3 → M, Track 4 → Z, ...
    const sortedIds = [pZ.id, pA.id, pM.id].sort();
    for (let i = 0; i < 6; i++) {
      expect(result[i].promptId).toBe(sortedIds[i % 3]);
    }
  });
});

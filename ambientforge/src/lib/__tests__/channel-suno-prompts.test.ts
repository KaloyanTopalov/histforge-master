import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, initSchema, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';

let db: Db;

const channelInput = {
  name: 'csp-test',
  displayName: 'CSP Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'CSP Artist',
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
});

describe('repos/channel-suno-prompts', () => {
  it('create + get round-trip', () => {
    const channel = channelsRepo.create(channelInput, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'p1', content: 'foo bar baz' },
      db,
    );
    expect(p.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(p.weight).toBe(1.0);
    expect(p.active).toBe(true);
    const got = sunoPromptsRepo.get(p.id, db);
    expect(got?.content).toBe('foo bar baz');
  });

  it('listByChannel returns rows ordered by createdAt asc', () => {
    const channel = channelsRepo.create(channelInput, db);
    const a = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'first' },
      db,
    );
    const b = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'b', content: 'second' },
      db,
    );
    const list = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('listByChannel({activeOnly: true}) filters inactive', () => {
    const channel = channelsRepo.create(channelInput, db);
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'on', content: 'x', active: true },
      db,
    );
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'off', content: 'x', active: false },
      db,
    );
    const all = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    const active = sunoPromptsRepo.listByChannel(channel.id, { activeOnly: true }, db);
    expect(all).toHaveLength(2);
    expect(active).toHaveLength(1);
    expect(active[0].label).toBe('on');
  });

  it('patch updates fields and bumps updated_at', async () => {
    const channel = channelsRepo.create(channelInput, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'before' },
      db,
    );
    // sleep a tick so updated_at differs
    await new Promise((r) => setTimeout(r, 5));
    const updated = sunoPromptsRepo.patch(p.id, { content: 'after', active: false }, db);
    expect(updated?.content).toBe('after');
    expect(updated?.active).toBe(false);
    expect((updated?.updatedAt ?? 0)).toBeGreaterThan(p.updatedAt);
  });

  it('remove cascades album.suno_prompt_id to NULL but preserves resolved_text', () => {
    const channel = channelsRepo.create(channelInput, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'snap-this' },
      db,
    );
    const album = albumsRepo.create({ channelId: channel.id }, db);
    albumsRepo.patch(
      album.id,
      { sunoPromptId: p.id, sunoPromptResolvedText: 'snap-this' },
      db,
    );
    expect(sunoPromptsRepo.remove(p.id, db)).toBe(true);
    const after = albumsRepo.get(album.id, db)!;
    expect(after.sunoPromptId).toBe(null);
    expect(after.sunoPromptResolvedText).toBe('snap-this');
  });

  it('countAlbumsUsing reports the number of albums referencing a prompt', () => {
    const channel = channelsRepo.create(channelInput, db);
    const p = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'x' },
      db,
    );
    expect(sunoPromptsRepo.countAlbumsUsing(p.id, db)).toBe(0);
    const a1 = albumsRepo.create({ channelId: channel.id }, db);
    albumsRepo.patch(a1.id, { sunoPromptId: p.id }, db);
    const a2 = albumsRepo.create({ channelId: channel.id }, db);
    albumsRepo.patch(a2.id, { sunoPromptId: p.id }, db);
    expect(sunoPromptsRepo.countAlbumsUsing(p.id, db)).toBe(2);
  });

  it('replaceAllForChannel diffs add/update/delete by id', () => {
    const channel = channelsRepo.create(channelInput, db);
    const a = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'keep', content: 'A' },
      db,
    );
    const b = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'delete-me', content: 'B' },
      db,
    );
    const after = sunoPromptsRepo.replaceAllForChannel(
      channel.id,
      [
        // patch existing 'keep' (id set)
        { id: a.id, label: 'keep-renamed', content: 'A' },
        // new entry (no id)
        { label: 'new', content: 'C' },
        // 'delete-me' (b.id) intentionally absent → should be deleted
      ],
      db,
    );
    expect(after).toHaveLength(2);
    const labels = after.map((p) => p.label).sort();
    expect(labels).toEqual(['keep-renamed', 'new']);
    expect(sunoPromptsRepo.get(b.id, db)).toBeNull();
  });
});

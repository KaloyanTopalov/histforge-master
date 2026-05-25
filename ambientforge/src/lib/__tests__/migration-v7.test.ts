import { describe, it, expect } from 'vitest';
import { openDb, initSchema, DB_VERSION, getDbVersion } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';

const baseChannel = {
  name: 'mig-test',
  displayName: 'Mig Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Mig Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

describe('migration v6→v7 (channel_suno_prompts backfill)', () => {
  it('DB_VERSION is current and getDbVersion reflects it after initSchema', () => {
    const db = openDb(':memory:');
    initSchema(db);
    // Assert symmetry — the DB metadata matches the code constant — without
    // pinning a literal. Hardcoded literals here were a recurring papercut
    // every migration; runMigrations in src/lib/db.ts is the source of truth.
    expect(getDbVersion(db)).toBe(DB_VERSION);
  });

  it('idempotency: re-running initSchema after a manual prompt does not duplicate or backfill', () => {
    const db = openDb(':memory:');
    initSchema(db);
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy seed content' },
      db,
    );
    // First post-init backfill triggers because the channel now has legacy
    // text but no collection rows. Verify exactly one was created.
    initSchema(db);
    const afterBackfill = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    expect(afterBackfill).toHaveLength(1);
    expect(afterBackfill[0].label).toBe('migrated-default');

    // Add an additional prompt manually, then re-run initSchema. Backfill
    // skips this channel because at least one row already exists.
    const manual = sunoPromptsRepo.create(
      { channelId: channel.id, label: 'manual', content: 'manual', active: true },
      db,
    );
    initSchema(db);
    const after = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    expect(after).toHaveLength(2);
    const ids = after.map((p) => p.id).sort();
    expect(ids).toContain(manual.id);
    expect(ids).toContain(afterBackfill[0].id);
  });

  it('channel with NULL suno_style_prompt produces zero migrated rows', () => {
    const db = openDb(':memory:');
    initSchema(db);
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: null },
      db,
    );
    initSchema(db);
    const prompts = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    expect(prompts).toHaveLength(0);
  });

  it('backfill triggers when a channel has legacy text but no collection rows yet', () => {
    // Simulate a v6 DB by:
    //  1. Open a fresh DB and init it.
    //  2. Insert a channel with suno_style_prompt set.
    //  3. Manually delete any prompt rows the migration created.
    //  4. Re-run initSchema → backfill should re-insert one row.
    const db = openDb(':memory:');
    initSchema(db);
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy backfill test' },
      db,
    );
    // The first initSchema saw the empty channels table; no backfill happened
    // yet. Now there's a channel with legacy text. Re-run init.
    initSchema(db);
    const prompts = sunoPromptsRepo.listByChannel(channel.id, {}, db);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].label).toBe('migrated-default');
    expect(prompts[0].content).toBe('legacy backfill test');
    expect(prompts[0].weight).toBe(1.0);
    expect(prompts[0].active).toBe(true);
    // Channel.suno_style_prompt unchanged by migration.
    const channelAfter = channelsRepo.get(channel.id, db)!;
    expect(channelAfter.sunoStylePrompt).toBe('legacy backfill test');
  });
});

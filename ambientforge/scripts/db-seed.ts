import { openDb, initSchema, defaultDbPath } from '@/lib/db';
import { create as createChannel, getByName } from '@/lib/repos/channels';

const db = openDb(defaultDbPath());
initSchema(db);

const NAME = 'test-ambient';

if (getByName(NAME, db)) {
  console.log(`[db:seed] channel "${NAME}" already exists — nothing to do.`);
} else {
  const ch = createChannel(
    {
      name: NAME,
      displayName: 'Test Ambient',
      description: 'Seed channel for development. Delete or rename before going live.',
      scheduleCron: '0 9 * * 1',
      albumBriefTemplate: null,
      trackBriefsTemplate: null,
      coverPromptTemplate: null,
      thumbnailPromptTemplate: null,
      ytMetadataTemplate: null,
      distrokidArtistName: 'Test Ambient Artist',
      distrokidPrimaryGenre: 'Ambient',
      distrokidLabelName: null,
      youtubeChannelId: null,
      youtubeChannelHandle: null,
      thumbnailOverlayText: null,
      spotifyPlaylistUrl: null,
      hashtags: 'ambient,sleep,study',
    },
    db,
  );
  console.log(`[db:seed] created channel ${ch.id} (${ch.name}).`);
}

db.close();

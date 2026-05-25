/**
 * Session 12 runtime validation (Checks A–G), direct invocation against
 * data/session-12-validation.db. No dev server required.
 */
process.env.AMBIENTFORGE_DB_PATH =
  process.env.AMBIENTFORGE_DB_PATH ?? 'data/session-12-validation.db';
process.env.OPENROUTER_API_KEY = 'mock';
process.env.SUNO_MODE = 'mock';

import { openDb } from '../src/lib/db';
import * as channelsRepo from '../src/lib/repos/channels';
import * as albumsRepo from '../src/lib/repos/albums';
import * as sunoPromptsRepo from '../src/lib/repos/channel-suno-prompts';
import {
  selectSunoPromptForAlbum,
  SunoStylePromptRequiredError,
} from '../src/lib/suno/select-prompt';
import { requireSunoStylePromptSource } from '../src/worker/workflows/checks';
import { getSettings } from '../src/lib/settings';
import { POST as createChannelRoute } from '../src/app/api/channels/route';

const MIDNIGHT_WHISPERS = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

type Result = { name: string; pass: boolean; note: string };
const allResults: Result[] = [];

function record(check: string, name: string, pass: boolean, note: string) {
  allResults.push({ name: `${check} — ${name}`, pass, note });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${check} — ${name}`);
  console.log(`         ${note}`);
}

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const db = openDb(); // uses AMBIENTFORGE_DB_PATH = validation DB

  // ===== Check A — migration backfill =====
  console.log('\n=== Check A — migration v6→v7 backfill ===');
  const mwPrompts = sunoPromptsRepo.listByChannel(MIDNIGHT_WHISPERS, {}, db);
  record(
    'A',
    `midnight whispers has 1 migrated row`,
    mwPrompts.length === 1 && mwPrompts[0].label === 'migrated-default',
    `count=${mwPrompts.length} label=${mwPrompts[0]?.label ?? '?'}`,
  );
  const mwChannel = channelsRepo.get(MIDNIGHT_WHISPERS, db);
  const legacyContent = mwChannel?.sunoStylePrompt ?? '';
  record(
    'A',
    `migrated content matches legacy`,
    !!mwPrompts[0] && mwPrompts[0].content === legacyContent,
    `legacy_len=${legacyContent.length} migrated_len=${mwPrompts[0]?.content?.length ?? 0}`,
  );
  record(
    'A',
    `legacy column unchanged`,
    legacyContent.length > 0,
    `length=${legacyContent.length}`,
  );

  // ===== Check B — random selection across multiple albums =====
  console.log('\n=== Check B — random selection across 6 albums ===');
  // Add 2 more prompts for variety.
  const altWarmer = sunoPromptsRepo.create(
    {
      channelId: MIDNIGHT_WHISPERS,
      label: 'alt-warmer',
      content:
        'gentle warm analog pads with mellow string textures, 55 BPM, A major, soft late-evening mood, no percussion',
    },
    db,
  );
  const altSparser = sunoPromptsRepo.create(
    {
      channelId: MIDNIGHT_WHISPERS,
      label: 'alt-sparser',
      content:
        'extremely sparse drone tones, 40 BPM, D minor, deep sub-bass, occasional bell-like accents, meditative',
    },
    db,
  );
  const activeCount = sunoPromptsRepo.listByChannel(
    MIDNIGHT_WHISPERS,
    { activeOnly: true },
    db,
  ).length;
  console.log(`  (added 2 alt prompts; active count now = ${activeCount})`);

  const distinctLabels = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const a = albumsRepo.create({ channelId: MIDNIGHT_WHISPERS }, db);
    const r = await selectSunoPromptForAlbum(MIDNIGHT_WHISPERS, a.id, db);
    const after = albumsRepo.get(a.id, db)!;
    if (r.promptId) {
      const p = sunoPromptsRepo.get(r.promptId, db);
      if (p) distinctLabels.add(p.label);
    }
    if (i === 0) {
      record(
        'B',
        `album.suno_prompt_id set after selection`,
        after.sunoPromptId === r.promptId,
        `expected=${r.promptId} actual=${after.sunoPromptId}`,
      );
      record(
        'B',
        `album.suno_prompt_resolved_text matches selection`,
        after.sunoPromptResolvedText === r.content,
        `len=${after.sunoPromptResolvedText?.length ?? 0}`,
      );
    }
  }
  record(
    'B',
    `≥2 distinct labels picked across 6 albums`,
    distinctLabels.size >= 2,
    `distinct=${distinctLabels.size} labels=[${[...distinctLabels].join(', ')}]`,
  );

  // ===== Check C — preflight failure when zero active =====
  console.log('\n=== Check C — preflight failure when 0 active prompts ===');
  // Deactivate ALL prompts (including migrated-default + 2 alts).
  const allPrompts = sunoPromptsRepo.listByChannel(MIDNIGHT_WHISPERS, {}, db);
  for (const p of allPrompts) {
    sunoPromptsRepo.patch(p.id, { active: false }, db);
  }
  // Channel still has legacy column populated, so preflight passes via legacy.
  // Wipe legacy column too for a true 0-source state.
  const channelBeforeWipe = channelsRepo.get(MIDNIGHT_WHISPERS, db)!;
  channelsRepo.patch(MIDNIGHT_WHISPERS, { sunoStylePrompt: null });
  const channelAfterWipe = channelsRepo.get(MIDNIGHT_WHISPERS, db)!;

  const result = await requireSunoStylePromptSource({
    album: { id: 'fake' } as never,
    channel: channelAfterWipe,
    settings: getSettings(db),
  });
  record(
    'C',
    `preflight returns SUNO_STYLE_PROMPT_REQUIRED with no source`,
    !result.ok && result.code === 'SUNO_STYLE_PROMPT_REQUIRED',
    `result=${JSON.stringify(result)}`,
  );

  // Restore: re-activate one prompt; preflight should now pass.
  sunoPromptsRepo.patch(allPrompts[0].id, { active: true }, db);
  const channelStillNoLegacy = channelsRepo.get(MIDNIGHT_WHISPERS, db)!;
  const result2 = await requireSunoStylePromptSource({
    album: { id: 'fake' } as never,
    channel: channelStillNoLegacy,
    settings: getSettings(db),
  });
  record(
    'C',
    `preflight passes after re-activating one prompt`,
    result2.ok,
    `result=${JSON.stringify(result2)}`,
  );
  // Restore legacy column for downstream tests.
  channelsRepo.patch(MIDNIGHT_WHISPERS, {
    sunoStylePrompt: channelBeforeWipe.sunoStylePrompt,
  });

  // ===== Check D — legacy fallback path =====
  console.log('\n=== Check D — legacy fallback ===');
  const legacyChannel = channelsRepo.create(
    {
      name: `legacy-fallback-${Date.now()}`,
      displayName: 'Legacy Test',
      description: '',
      scheduleCron: '0 9 * * 1',
      active: true,
      albumBriefTemplate: null,
      trackBriefsTemplate: null,
      coverPromptTemplate: null,
      thumbnailPromptTemplate: null,
      ytMetadataTemplate: null,
      distrokidArtistName: 'Legacy Artist',
      distrokidPrimaryGenre: 'Ambient',
      distrokidLabelName: null,
      youtubeChannelId: null,
      youtubeChannelHandle: null,
      thumbnailOverlayText: null,
      spotifyPlaylistUrl: null,
      hashtags: '',
      sunoStylePrompt: 'legacy-only voice for fallback test',
    },
    db,
  );
  const legacyAlbum = albumsRepo.create({ channelId: legacyChannel.id }, db);
  const legacyResult = await selectSunoPromptForAlbum(legacyChannel.id, legacyAlbum.id, db);
  record(
    'D',
    `legacy fallback: source='legacy-column'`,
    legacyResult.source === 'legacy-column',
    `source=${legacyResult.source}`,
  );
  record(
    'D',
    `legacy fallback: promptId=null`,
    legacyResult.promptId === null,
    `promptId=${legacyResult.promptId}`,
  );
  record(
    'D',
    `legacy fallback: content matches legacy column`,
    legacyResult.content === 'legacy-only voice for fallback test',
    `content="${legacyResult.content.slice(0, 40)}..."`,
  );
  const legacyAlbumAfter = albumsRepo.get(legacyAlbum.id, db)!;
  record(
    'D',
    `album.suno_prompt_resolved_text persisted from legacy`,
    legacyAlbumAfter.sunoPromptResolvedText === 'legacy-only voice for fallback test',
    `resolved=${legacyAlbumAfter.sunoPromptResolvedText}`,
  );

  // ===== Check E — prompt deletion preserves history =====
  console.log('\n=== Check E — deletion preserves resolved-text snapshot ===');
  // Create a fresh test channel + 1 prompt + 1 album using it.
  const delChannel = channelsRepo.create(
    {
      name: `del-test-${Date.now()}`,
      displayName: 'Del Test',
      description: '',
      scheduleCron: '0 9 * * 1',
      active: true,
      albumBriefTemplate: null,
      trackBriefsTemplate: null,
      coverPromptTemplate: null,
      thumbnailPromptTemplate: null,
      ytMetadataTemplate: null,
      distrokidArtistName: 'Del Artist',
      distrokidPrimaryGenre: 'Ambient',
      distrokidLabelName: null,
      youtubeChannelId: null,
      youtubeChannelHandle: null,
      thumbnailOverlayText: null,
      spotifyPlaylistUrl: null,
      hashtags: '',
    },
    db,
  );
  const delPrompt = sunoPromptsRepo.create(
    { channelId: delChannel.id, label: 'doomed', content: 'snap-this-content', active: true },
    db,
  );
  const delAlbum = albumsRepo.create({ channelId: delChannel.id }, db);
  await selectSunoPromptForAlbum(delChannel.id, delAlbum.id, db);
  const delAlbumBefore = albumsRepo.get(delAlbum.id, db)!;
  sunoPromptsRepo.remove(delPrompt.id, db);
  const delAlbumAfter = albumsRepo.get(delAlbum.id, db)!;
  record(
    'E',
    `album.suno_prompt_id is NULL after delete`,
    delAlbumAfter.sunoPromptId === null,
    `before=${delAlbumBefore.sunoPromptId} after=${delAlbumAfter.sunoPromptId}`,
  );
  record(
    'E',
    `album.suno_prompt_resolved_text preserved after delete`,
    delAlbumAfter.sunoPromptResolvedText === 'snap-this-content',
    `resolved=${delAlbumAfter.sunoPromptResolvedText}`,
  );
  // Re-running selectSunoPromptForAlbum should return the resolved-text snapshot.
  const recoveredResult = await selectSunoPromptForAlbum(delChannel.id, delAlbum.id, db);
  record(
    'E',
    `selectSunoPromptForAlbum returns resolved-text after FK loss`,
    recoveredResult.source === 'resumed' &&
      recoveredResult.content === 'snap-this-content' &&
      recoveredResult.promptId === null,
    `source=${recoveredResult.source} content="${recoveredResult.content}" promptId=${recoveredResult.promptId}`,
  );

  // ===== Check F — idempotency =====
  console.log('\n=== Check F — idempotency: re-running picks same prompt ===');
  const idemChannel = channelsRepo.create(
    {
      name: `idem-test-${Date.now()}`,
      displayName: 'Idem Test',
      description: '',
      scheduleCron: '0 9 * * 1',
      active: true,
      albumBriefTemplate: null,
      trackBriefsTemplate: null,
      coverPromptTemplate: null,
      thumbnailPromptTemplate: null,
      ytMetadataTemplate: null,
      distrokidArtistName: 'Idem Artist',
      distrokidPrimaryGenre: 'Ambient',
      distrokidLabelName: null,
      youtubeChannelId: null,
      youtubeChannelHandle: null,
      thumbnailOverlayText: null,
      spotifyPlaylistUrl: null,
      hashtags: '',
    },
    db,
  );
  for (let i = 0; i < 3; i++) {
    sunoPromptsRepo.create(
      { channelId: idemChannel.id, label: `i${i}`, content: `idem-${i}`, active: true },
      db,
    );
  }
  const idemAlbum = albumsRepo.create({ channelId: idemChannel.id }, db);
  const first = await selectSunoPromptForAlbum(idemChannel.id, idemAlbum.id, db);
  const second = await selectSunoPromptForAlbum(idemChannel.id, idemAlbum.id, db);
  const third = await selectSunoPromptForAlbum(idemChannel.id, idemAlbum.id, db);
  record(
    'F',
    `re-running uses the same prompt (no re-roll)`,
    first.promptId === second.promptId && second.promptId === third.promptId,
    `first=${first.promptId} second=${second.promptId} third=${third.promptId}`,
  );
  record(
    'F',
    `subsequent calls report source='resumed'`,
    second.source === 'resumed' && third.source === 'resumed',
    `second.source=${second.source} third.source=${third.source}`,
  );

  // ===== Check G — backward-compat API =====
  console.log('\n=== Check G — backward-compat API ===');
  // G1: POST /api/channels with legacy sunoStylePrompt only.
  const g1Body = {
    name: `g1-legacy-${Date.now()}`,
    displayName: 'G1 Legacy',
    description: '',
    scheduleCron: '0 9 * * 1',
    distrokidArtistName: 'G1 Artist',
    distrokidPrimaryGenre: 'Ambient',
    sunoStylePrompt: 'legacy field test value',
  };
  const g1Res = await createChannelRoute(
    jsonReq('http://localhost/api/channels', 'POST', g1Body),
  );
  const g1Json = await g1Res.json();
  const g1Channel = channelsRepo.get(g1Json.channel.id, db);
  const g1Prompts = sunoPromptsRepo.listByChannel(g1Json.channel.id, {}, db);
  record(
    'G',
    `POST with legacy sunoStylePrompt: channel created with column set`,
    g1Res.status === 200 && g1Channel?.sunoStylePrompt === 'legacy field test value',
    `status=${g1Res.status} channel.sunoStylePrompt="${g1Channel?.sunoStylePrompt ?? ''}"`,
  );
  record(
    'G',
    `POST with legacy sunoStylePrompt: collection has 0 entries`,
    g1Prompts.length === 0,
    `count=${g1Prompts.length}`,
  );

  // G2: POST /api/channels with sunoStylePrompts array.
  const g2Body = {
    name: `g2-array-${Date.now()}`,
    displayName: 'G2 Array',
    description: '',
    scheduleCron: '0 9 * * 1',
    distrokidArtistName: 'G2 Artist',
    distrokidPrimaryGenre: 'Ambient',
    sunoStylePrompts: [
      { label: 'a', content: 'foo', active: true },
    ],
  };
  const g2Res = await createChannelRoute(
    jsonReq('http://localhost/api/channels', 'POST', g2Body),
  );
  const g2Json = await g2Res.json();
  const g2Channel = channelsRepo.get(g2Json.channel.id, db);
  const g2Prompts = sunoPromptsRepo.listByChannel(g2Json.channel.id, {}, db);
  record(
    'G',
    `POST with sunoStylePrompts array: channel.suno_style_prompt is null`,
    g2Res.status === 200 && (g2Channel?.sunoStylePrompt === null),
    `status=${g2Res.status} channel.sunoStylePrompt=${g2Channel?.sunoStylePrompt}`,
  );
  record(
    'G',
    `POST with sunoStylePrompts array: collection has 1 entry`,
    g2Prompts.length === 1 && g2Prompts[0].label === 'a' && g2Prompts[0].content === 'foo',
    `count=${g2Prompts.length} first=${JSON.stringify(g2Prompts[0])}`,
  );

  // ===== Summary =====
  const passed = allResults.filter((r) => r.pass).length;
  console.log(`\n=== summary: ${passed}/${allResults.length} checks passed ===`);
  for (const r of allResults) {
    if (!r.pass) console.log(`  FAIL: ${r.name} — ${r.note}`);
  }
  if (passed !== allResults.length) process.exit(1);
}

main().catch((e) => {
  console.error('[validate] FAILED:', e);
  process.exit(1);
});

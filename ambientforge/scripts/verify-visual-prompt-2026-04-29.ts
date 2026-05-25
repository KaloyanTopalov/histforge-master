/**
 * Verify the full visual prompt that step 05a would send to Flow,
 * given the LA-skyline-girl prompt template in the validation DB.
 */
process.env.AMBIENTFORGE_DB_PATH =
  process.env.AMBIENTFORGE_DB_PATH ?? 'data/session-cover-fix-validation.db';
process.env.OPENROUTER_API_KEY = 'mock';

import { openDb } from '../src/lib/db';
import * as channelsRepo from '../src/lib/repos/channels';
import { resolveChannelPrompt } from '../src/lib/prompts';
import { generateImagePrompt } from '../src/lib/flow/llm-image-prompt';

async function main(): Promise<void> {
  const db = openDb();
  const channel = channelsRepo.get('01KQ7HRA4SJ9GX6JMC4Q3CNWR1');
  if (!channel) throw new Error('channel not found');
  const cp = resolveChannelPrompt(channel, 'cover-image');
  console.log(`source=${cp.source} kind=${cp.kind} origin=${cp.origin}`);

  const album = {
    albumTitle: 'cover-fix validation album',
    sunoStylePrompt: 'gentle late-night ambient',
  };
  const vp = await generateImagePrompt({
    album: album as never,
    channel,
    templateContent: cp.content,
  });
  console.log('--- VISUAL PROMPT FULL ---');
  console.log(vp);
  console.log('--- checks ---');
  const checks: Array<[string, boolean]> = [
    ['contains "Los Angeles"', /Los Angeles/i.test(vp)],
    ['contains "skyline"', /skyline/i.test(vp)],
    ['contains "rooftop"', /rooftop/i.test(vp)],
    ['contains "magenta"', /magenta/i.test(vp)],
    ['NO "BPM"', !/BPM/i.test(vp)],
    ['NO " tempo "', !/ tempo /i.test(vp)],
    ['NO "A minor"', !/A minor/i.test(vp)],
    ['NO "D minor"', !/D minor/i.test(vp)],
  ];
  for (const [name, pass] of checks) {
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`length: ${vp.length}`);
  db.close();
}

main().catch((e) => {
  console.error('ERR:', e);
  process.exit(1);
});

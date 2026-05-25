import { getDb } from '../src/lib/db';
import * as albumsRepo from '../src/lib/repos/albums';
const db = getDb();
const ALBUM_ID = '01KQCD4R12J9WB2YKVR105HGJH';
const reason =
  'SUNO_BRIDGE_502_ALL_TRACKS — every step 03 submit returned 502 over ~14 min (30 tracks × 2 attempts each). Sidecar /credits worked at the time (3610 credits). Manual /submit reproduction ~30 min later returned 200 OK with valid taskId — likely transient captcha cascade or hCaptcha-solver overwhelm during the burst, dissipated by idle. See pipeline.log for full trace.';
const before = albumsRepo.get(ALBUM_ID);
if (!before) {
  console.error('album not found');
  process.exit(1);
}
console.log('before lastError:', before.lastError);
albumsRepo.patch(ALBUM_ID, { lastError: reason });
const after = albumsRepo.get(ALBUM_ID);
console.log('after lastError:', after?.lastError);

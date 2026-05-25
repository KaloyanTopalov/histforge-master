/**
 * Trigger N mock albums against the running dev server (validation DB),
 * then poll each album to status='done' or 'failed'.
 *
 * Usage: tsx scripts/trigger-mock-albums-2026-04-29.ts
 *
 * Env:
 *   AMBIENTFORGE_DB_PATH       — must point at validation DB
 *   AMBIENTFORGE_BASE_URL      — default http://localhost:3003
 *   AMBIENTFORGE_NUM_ALBUMS    — default 3
 *   AMBIENTFORGE_ALBUM_TIMEOUT — per-album, in seconds (default 600)
 */
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const BASE = process.env.AMBIENTFORGE_BASE_URL ?? 'http://localhost:3003';
const N = Number(process.env.AMBIENTFORGE_NUM_ALBUMS ?? 3);
const PER_ALBUM_TIMEOUT_SEC = Number(process.env.AMBIENTFORGE_ALBUM_TIMEOUT ?? 600);

type Album = {
  id: string;
  status: string;
  videoStatus: string;
  distrokidStatus: string;
  finalVideoPath: string | null;
  thumbnailPath: string | null;
  coverImagePath: string | null;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${r.statusText} on ${url}: ${await r.text().catch(() => '')}`);
  }
  return r.json() as Promise<T>;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const h = await fetchJson<{ ok: boolean; queueState: string }>(`${BASE}/api/health`);
      if (h.ok) {
        console.log(`health OK: queueState=${h.queueState}`);
        if (h.queueState !== 'running') {
          console.warn('WARNING: queue_state is not "running" — albums will queue but not pick up');
        }
        return;
      }
    } catch (e) {
      // Dev still spinning up.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server at ${BASE} did not become healthy within 60s`);
}

async function triggerAlbum(): Promise<string> {
  const r = await fetchJson<{ album: Album }>(`${BASE}/api/albums`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: CHANNEL_ID }),
  });
  return r.album.id;
}

function readAlbumStatusFromDb(albumId: string): Album {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, status, video_status as videoStatus, distrokid_status as distrokidStatus,
              final_video_path as finalVideoPath, thumbnail_path as thumbnailPath,
              cover_image_path as coverImagePath
       FROM albums WHERE id = ?`,
    )
    .get(albumId) as Album | undefined;
  db.close();
  if (!row) throw new Error(`album ${albumId} not found in DB`);
  return row;
}

async function pollAlbum(albumId: string, label: string): Promise<Album> {
  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < PER_ALBUM_TIMEOUT_SEC * 1000) {
    const a = readAlbumStatusFromDb(albumId);
    const sig = `status=${a.status} video=${a.videoStatus} dk=${a.distrokidStatus}`;
    if (sig !== lastStatus) {
      console.log(`  [${label}] ${sig}`);
      lastStatus = sig;
    }
    if (a.status === 'done' || a.status === 'failed') return a;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`album ${albumId} did not finish within ${PER_ALBUM_TIMEOUT_SEC}s`);
}

async function main(): Promise<void> {
  console.log(`Targeting ${BASE}; AMBIENTFORGE_DB_PATH=${process.env.AMBIENTFORGE_DB_PATH ?? '(default)'}`);
  await waitForHealth();

  const albumIds: string[] = [];
  const startedAt = Date.now();

  for (let i = 1; i <= N; i++) {
    console.log(`\n--- album ${i}/${N} ---`);
    const id = await triggerAlbum();
    albumIds.push(id);
    console.log(`  triggered album_id=${id}`);
    const final = await pollAlbum(id, `${i}/${N}`);
    if (final.status !== 'done') {
      console.error(`  FAILED ${id} status=${final.status}`);
      process.exit(2);
    }
    console.log(`  done`);
  }

  console.log(`\nAll ${N} albums done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log('album_ids:', albumIds.join(' '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { ulid } from 'ulid';
import { getDb, type Db } from '../db';

export type ChannelStats = {
  id: string;
  channelId: string;
  fetchedAt: number;
  subscriberCount: number;
  totalViews: number;
  videoCount: number;
};

type Row = {
  id: string;
  channel_id: string;
  fetched_at: number;
  subscriber_count: number;
  total_views: number;
  video_count: number;
};

function fromRow(r: Row): ChannelStats {
  return {
    id: r.id,
    channelId: r.channel_id,
    fetchedAt: r.fetched_at,
    subscriberCount: r.subscriber_count,
    totalViews: r.total_views,
    videoCount: r.video_count,
  };
}

const COLS = 'id, channel_id, fetched_at, subscriber_count, total_views, video_count';

export function insertSnapshot(
  input: Omit<ChannelStats, 'id'>,
  db: Db = getDb(),
): ChannelStats {
  const id = ulid();
  db.prepare(
    `INSERT INTO channel_stats (id, channel_id, fetched_at, subscriber_count, total_views, video_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.channelId,
    input.fetchedAt,
    input.subscriberCount,
    input.totalViews,
    input.videoCount,
  );
  return { id, ...input };
}

export function listByChannel(
  channelId: string,
  opts: { since?: number; limit?: number } = {},
  db: Db = getDb(),
): ChannelStats[] {
  const sinceClause = opts.since !== undefined ? 'AND fetched_at >= ?' : '';
  const limitClause = opts.limit !== undefined ? 'LIMIT ?' : '';
  const params: unknown[] = [channelId];
  if (opts.since !== undefined) params.push(opts.since);
  if (opts.limit !== undefined) params.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM channel_stats WHERE channel_id = ? ${sinceClause}
       ORDER BY fetched_at ASC ${limitClause}`,
    )
    .all(...params) as Row[];
  return rows.map(fromRow);
}

export function latestForChannel(channelId: string, db: Db = getDb()): ChannelStats | null {
  const row = db
    .prepare(
      `SELECT ${COLS} FROM channel_stats WHERE channel_id = ? ORDER BY fetched_at DESC LIMIT 1`,
    )
    .get(channelId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function existsForChannelInRange(
  channelId: string,
  rangeStart: number,
  rangeEnd: number,
  db: Db = getDb(),
): boolean {
  const row = db
    .prepare(
      'SELECT 1 FROM channel_stats WHERE channel_id = ? AND fetched_at >= ? AND fetched_at < ? LIMIT 1',
    )
    .get(channelId, rangeStart, rangeEnd);
  return !!row;
}

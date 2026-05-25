import { getDb, type Db } from '../db';

export type Service = 'suno' | 'distrokid' | 'flow' | 'yt-stats';
export type SessionStatus = 'valid' | 'expired';

export type Session = {
  service: Service;
  status: SessionStatus;
  lastChecked: number;
};

type Row = {
  service: Service;
  status: SessionStatus;
  last_checked: number;
};

function fromRow(r: Row): Session {
  return { service: r.service, status: r.status, lastChecked: r.last_checked };
}

export function get(service: Service, db: Db = getDb()): Session | null {
  const row = db
    .prepare('SELECT service, status, last_checked FROM sessions WHERE service = ?')
    .get(service) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listAll(db: Db = getDb()): Session[] {
  const rows = db.prepare('SELECT service, status, last_checked FROM sessions').all() as Row[];
  return rows.map(fromRow);
}

export function upsert(
  service: Service,
  status: SessionStatus,
  lastChecked: number = Date.now(),
  db: Db = getDb(),
): Session {
  db.prepare(
    `INSERT INTO sessions (service, status, last_checked) VALUES (?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET status = excluded.status, last_checked = excluded.last_checked`,
  ).run(service, status, lastChecked);
  return { service, status, lastChecked };
}

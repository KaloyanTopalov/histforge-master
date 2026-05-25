import { getDb, type Db } from '../db';

export function getRaw(key: string, db: Db = getDb()): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setRaw(key: string, value: string, db: Db = getDb()): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getAllRaw(db: Db = getDb()): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteRaw(key: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

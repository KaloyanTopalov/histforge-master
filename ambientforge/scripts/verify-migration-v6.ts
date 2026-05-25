import { openDb, getDb } from '../src/lib/db';
// openDb does NOT run migrations. We need getDb() (or initSchema explicitly).
const db = getDb();
const cols = db.pragma('table_info(albums)') as Array<{ name: string }>;
const hasCol = cols.some((c) => c.name === 'last_error');
console.log('last_error column present:', hasCol);
const v = db.prepare("SELECT value FROM settings WHERE key='db_version'").get();
console.log('db_version:', v);

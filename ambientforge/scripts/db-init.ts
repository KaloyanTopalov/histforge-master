import { openDb, initSchema, defaultDbPath, getDbVersion, DB_VERSION } from '@/lib/db';

const dbPath = defaultDbPath();
const db = openDb(dbPath);
initSchema(db);
const version = getDbVersion(db);
console.log(`[db:init] schema version ${version} (target ${DB_VERSION}) — ${dbPath}`);
db.close();

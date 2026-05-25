import { openDb } from '../src/lib/db';
const db = openDb();
db.prepare("INSERT INTO settings(key,value) VALUES('queue_state','running') ON CONFLICT(key) DO UPDATE SET value='running'").run();
console.log('queue_state =', db.prepare("SELECT value FROM settings WHERE key='queue_state'").get());

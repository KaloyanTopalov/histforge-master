import { openDb } from '../src/lib/db';
const db = openDb();
db.prepare("INSERT INTO settings(key,value) VALUES('queue_state','paused') ON CONFLICT(key) DO UPDATE SET value='paused'").run();
const queue = db.prepare("SELECT value FROM settings WHERE key='queue_state'").get();
const album = db.prepare("SELECT id, status, updated_at FROM albums WHERE id='01KQCD4R12J9WB2YKVR105HGJH'").get();
console.log('queue_state:', JSON.stringify(queue));
console.log('failed album:', JSON.stringify(album));

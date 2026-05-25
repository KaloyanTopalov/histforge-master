const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const sql = process.argv[3];
const rows = db.prepare(sql).all();
console.log(JSON.stringify(rows, null, 2));
db.close();

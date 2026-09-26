'use strict';
// Applies db/migrations/*.sql in order. Safe to run repeatedly: applied files are recorded.
//   npm run migrate
const fs = require('fs');
const path = require('path');
const { loadConfig, loadDotEnv, ROOT } = require('../src/config');

loadDotEnv(path.join(ROOT, '.env'));
const cfg = loadConfig();

(async () => {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    multipleStatements: true, charset: 'utf8mb4',
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${cfg.db.database}\``);
  await conn.query('CREATE TABLE IF NOT EXISTS migrations (name VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB');
  const [done] = await conn.query('SELECT name FROM migrations');
  const applied = new Set(done.map((r) => r.name));
  const dir = path.join(ROOT, 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    console.log('Applying', f);
    await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await conn.query('INSERT INTO migrations (name, applied_at) VALUES (?, NOW())', [f]);
    count++;
  }
  console.log(count ? `Done. ${count} migration(s) applied.` : 'Database is already up to date.');
  await conn.end();
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });

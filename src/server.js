'use strict';
const http = require('http');
const path = require('path');
const { loadConfig, loadDotEnv, assertSecure, ROOT } = require('./config');

loadDotEnv(path.join(ROOT, '.env'));
const cfg = loadConfig();
cfg.trustProxy = process.env.TRUST_PROXY === '1';
assertSecure(cfg);

const { createMysqlDb } = require('./db');
const { createApp } = require('./app');

const db = createMysqlDb(cfg.db);
const server = http.createServer(createApp({ db, cfg }));

server.listen(cfg.port, () => {
  console.log(`MyFinance running on http://localhost:${cfg.port}  (admin: /   customer portal: /portal)`);
});

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

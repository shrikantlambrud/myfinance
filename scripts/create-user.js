'use strict';
// Create the first owner (or any staff/owner login) from the command line:
//   npm run create-user -- --username ramesh --name "Ramesh Patil" --role owner [--password "..."]
// If --password is omitted a temporary one is generated and printed. The user must change it on first login.
const path = require('path');
const { loadConfig, loadDotEnv, ROOT } = require('../src/config');
const pw = require('../src/lib/password');
const { nowStamp } = require('../src/engine/dates');

loadDotEnv(path.join(ROOT, '.env'));
const cfg = loadConfig();

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const username = (arg('username') || '').toLowerCase();
  const name = arg('name');
  const role = arg('role') || 'owner';
  if (!/^[a-z0-9._@-]{3,40}$/.test(username) || !name || !['owner', 'staff'].includes(role)) {
    console.error('Usage: npm run create-user -- --username <name> --name "<Full Name>" --role <owner|staff> [--password <pw>]');
    process.exit(1);
  }
  const password = arg('password') || pw.generateTemp(12);
  if (password.length < 8) { console.error('Password must be at least 8 characters'); process.exit(1); }

  const { createMysqlDb } = require('../src/db');
  const db = createMysqlDb(cfg.db);
  await db.run(
    'INSERT INTO users (username, name, role, password_hash, must_change_password, created_at) VALUES (?,?,?,?,1,?)',
    [username, name, role, await pw.hash(password), nowStamp(cfg.tz)]);
  console.log(`Created ${role} "${username}".`);
  if (!arg('password')) console.log(`Temporary password: ${password}   (you will be asked to change it at first login)`);
  await db.close();
})().catch((e) => {
  console.error(e.code === 'ER_DUP_ENTRY' ? 'That username already exists.' : 'Failed: ' + e.message);
  process.exit(1);
});

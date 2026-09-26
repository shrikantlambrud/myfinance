'use strict';
// Test-only database: same interface as src/db.js, backed by node:sqlite (in memory).
// The MySQL migration is translated on the fly so tests exercise the real schema + real service code.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function translate(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\) ENGINE=[^;]*;/g, ');')
    .replace(/INT UNSIGNED AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/ENUM\([^)]*\)/g, 'TEXT')
    .replace(/^\s*UNIQUE KEY \w+ (\([^)]*\)),?\s*$/gm, '  UNIQUE $1,')
    .replace(/^\s*KEY \w+ \([^)]*\),?\s*$/gm, '')
    .replace(/,\s*\n\s*(CONSTRAINT)/g, ',\n  $1')
    .replace(/,(\s*\n?\s*\))/g, '$1');
}

function createSqliteDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(translate(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  const clean = (ps) => (ps || []).map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const fix = (sql) => sql.replace(/\s+FOR UPDATE/gi, '');
  const api = {
    async all(sql, params) { return raw.prepare(fix(sql)).all(...clean(params)).map((r) => ({ ...r })); },
    async get(sql, params) { const r = raw.prepare(fix(sql)).get(...clean(params)); return r ? { ...r } : null; },
    async run(sql, params) {
      const r = raw.prepare(fix(sql)).run(...clean(params));
      return { insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) };
    },
  };
  let lock = Promise.resolve();
  return {
    ...api,
    tx(fn) {
      const next = lock.then(async () => {
        raw.exec('BEGIN');
        try { const out = await fn(api); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
      });
      lock = next.catch(() => {});
      return next;
    },
    async close() { raw.close(); },
  };
}

module.exports = { createSqliteDb };

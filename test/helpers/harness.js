'use strict';
const http = require('http');
const { createSqliteDb } = require('./sqlite-db');
const { createApp } = require('../../src/app');
const pw = require('../../src/lib/password');

async function start({ today = '2026-03-15' } = {}) {
  const db = createSqliteDb();
  const state = { today };
  const cfg = {
    isProd: false, tz: 'Asia/Kolkata', jwtSecret: 'test-secret-test-secret-test-secret-123456', tokenTtlHours: 1,
    todayOverride: () => state.today,
  };
  process.env.LOG_REQUESTS = '0';
  const server = http.createServer(createApp({ db, cfg }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, url, body, token) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async function addUser(username, role, password = 'Password123', extra = {}) {
    const r = await db.run(
      'INSERT INTO users (username, name, role, password_hash, party_id, must_change_password, created_at) VALUES (?,?,?,?,?,?,?)',
      [username, username.toUpperCase(), role, await pw.hash(password), extra.party_id || null, 0, '2026-01-01 00:00:00']);
    return r.insertId;
  }
  async function login(username, password = 'Password123') {
    const r = await req('POST', '/api/auth/login', { username, password });
    return r.data.token;
  }
  return { base, db, cfg, state, req, addUser, login, close: async () => { server.close(); await db.close(); } };
}

module.exports = { start };

'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Real environment variables win over the file.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const cfg = {
    isProd,
    port: parseInt(env.PORT || '3000', 10),
    tz: env.BUSINESS_TZ || 'Asia/Kolkata',
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: parseInt(env.DB_PORT || '3306', 10),
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'myfinance',
      // MySQL session time zone so CURRENT_TIMESTAMP-style values match the business timezone
      tzOffset: env.DB_TZ_OFFSET || '+05:30',
    },
    jwtSecret: env.JWT_SECRET || '',
    tokenTtlHours: parseFloat(env.TOKEN_TTL_HOURS || '12'),
  };
  return cfg;
}

function assertSecure(cfg) {
  if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  }
}

module.exports = { loadConfig, loadDotEnv, assertSecure, ROOT: path.join(__dirname, '..') };

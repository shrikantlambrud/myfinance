'use strict';
const fs = require('fs');
const path = require('path');
const { Router } = require('./lib/router');
const { HttpError } = require('./lib/errors');
const { todayISO, nowStamp } = require('./engine/dates');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isRaw ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isRaw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/portal' || rel === '/portal/') rel = '/portal/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) return send(res, 403, 'Forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

function createApp({ db, cfg }) {
  const router = new Router();
  for (const name of ['auth', 'users', 'parties', 'loans', 'payments', 'collections', 'dashboard', 'ledger', 'investments', 'reports', 'settings', 'portal']) {
    require(`./routes/${name}`)(router, { db, cfg });
  }

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  };

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (cfg.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return serveStatic(req, res, pathname);
      }
      res.setHeader('Cache-Control', 'no-store');
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Unknown API endpoint');
      if (m.allowed) throw new HttpError(405, 'Method not allowed');

      const ctx = {
        req, res, db, cfg, params: m.params, user: null, ip: clientIp(req),
        query: Object.fromEntries(url.searchParams),
        body: {},
        today: () => (cfg.todayOverride ? cfg.todayOverride() : todayISO(cfg.tz)),
        now: () => nowStamp(cfg.tz),
      };
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) ctx.body = await readBody(req);

      const fns = m.route.fns;
      let result;
      for (let i = 0; i < fns.length; i++) {
        const r = await fns[i](ctx);
        if (i === fns.length - 1) result = r;
      }
      if (result && result.__res) {
        if (result.raw !== undefined) return send(res, result.status, result.raw, result.headers);
        return send(res, result.status, result.body === undefined ? {} : result.body);
      }
      return send(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      let status = 500, body = { error: 'Something went wrong on our side. Please try again.' };
      if (e instanceof HttpError) {
        status = e.status;
        body = { error: e.message, ...(e.extra || {}) };
      } else if (e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY' || /UNIQUE constraint/.test(e.message || ''))) {
        status = 409;
        body = { error: 'That record already exists' };
      } else {
        console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}`, e);
      }
      if (!res.headersSent) send(res, status, body);
    } finally {
      if (process.env.LOG_REQUESTS !== '0' && pathname.startsWith('/api/')) {
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  };
}

module.exports = { createApp };

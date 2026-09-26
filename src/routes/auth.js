'use strict';
const jwt = require('../lib/jwt');
const pw = require('../lib/password');
const { check } = require('../lib/validate');
const { auth } = require('../lib/guards');
const { HttpError, badRequest, unauthorized } = require('../lib/errors');
const { nowStamp } = require('../engine/dates');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const ipHits = new Map(); // ip -> [timestamps]; crude flood guard on top of per-user lockout

function ipLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length > 40;
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

const publicUser = (u) => ({
  id: u.id, username: u.username, name: u.name, role: u.role, party_id: u.party_id,
  must_change_password: !!u.must_change_password,
});
const issue = (cfg, u) => jwt.sign({ sub: u.id, tv: u.token_version, role: u.role }, cfg.jwtSecret, Math.round(cfg.tokenTtlHours * 3600));

module.exports = (router, { db, cfg }) => {
  router.post('/api/auth/login', async (ctx) => {
    if (ipLimited(ctx.ip)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    const body = check(ctx.body, { username: { t: 'str', req: true, max: 60 }, password: { t: 'str', req: true, max: 200 } });
    const user = await db.get('SELECT * FROM users WHERE username = ?', [body.username.toLowerCase()]);
    if (user && user.locked_until && user.locked_until > ctx.now()) {
      throw new HttpError(429, 'Too many wrong attempts. This account is locked for a few minutes.');
    }
    const ok = await pw.verify(body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !user.is_active || !ok) {
      if (user) {
        const fails = user.failed_attempts + 1;
        if (fails >= MAX_FAILS) {
          const until = nowStamp(cfg.tz, new Date(Date.now() + LOCK_MINUTES * 60000));
          await db.run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', [until, user.id]);
        } else {
          await db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', [fails, user.id]);
        }
      }
      throw unauthorized('Wrong username or password');
    }
    await db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [ctx.now(), user.id]);
    await db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, ip, created_at) VALUES (?,?,?,?,?,?)',
      [user.id, 'auth.login', 'user', user.id, ctx.ip, ctx.now()]);
    return { token: issue(cfg, user), user: publicUser(user) };
  });

  router.get('/api/auth/me', auth, (ctx) => ({ user: publicUser(ctx.user) }));

  router.post('/api/auth/change-password', auth, async (ctx) => {
    const body = check(ctx.body, {
      current_password: { t: 'str', req: true, max: 200 },
      new_password: { t: 'str', req: true, min: 8, max: 200, label: 'New password' },
    });
    if (!(await pw.verify(body.current_password, ctx.user.password_hash))) {
      throw badRequest('Current password is wrong', { fields: { current_password: 'Current password is wrong' } });
    }
    if (body.new_password === body.current_password) {
      throw badRequest('Choose a password different from the current one', { fields: { new_password: 'Must be different' } });
    }
    const hash = await pw.hash(body.new_password);
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [hash, ctx.user.id]);
    const fresh = await db.get('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
    await db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, ip, created_at) VALUES (?,?,?,?,?,?)',
      [ctx.user.id, 'auth.change_password', 'user', ctx.user.id, ctx.ip, ctx.now()]);
    return { token: issue(cfg, fresh), user: publicUser(fresh) };
  });

  router.post('/api/auth/logout', auth, async (ctx) => {
    await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [ctx.user.id]);
    return { ok: true };
  });
};
module.exports.ipHits = ipHits;

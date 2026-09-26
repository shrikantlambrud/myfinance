'use strict';
const pw = require('../lib/password');
const { check } = require('../lib/validate');
const { ownerOnly } = require('../lib/guards');
const { created } = require('../lib/router');
const { badRequest, notFound } = require('../lib/errors');
const { audit, envOf } = require('../services/common');

const USERNAME = /^[a-z0-9._@-]{3,40}$/;

module.exports = (router, { db }) => {
  router.get('/api/users', ...ownerOnly, async () => {
    const rows = await db.all(
      "SELECT id, username, name, role, party_id, is_active, last_login_at, created_at FROM users WHERE role <> 'customer' ORDER BY id");
    return { users: rows.map((u) => ({ ...u, is_active: !!u.is_active })) };
  });

  router.post('/api/users', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      username: { t: 'str', req: true, pattern: USERNAME, patternMsg: 'Use 3-40 letters, digits, dot, dash or underscore' },
      name: { t: 'str', req: true, max: 120 },
      role: { t: 'enum', req: true, values: ['owner', 'staff'] },
      password: { t: 'str', req: true, min: 8, max: 200 },
    });
    const username = b.username.toLowerCase();
    const hash = await pw.hash(b.password);
    const r = await db.tx(async (tx) => {
      const res = await tx.run(
        'INSERT INTO users (username, name, role, password_hash, must_change_password, created_at) VALUES (?,?,?,?,?,?)',
        [username, b.name, b.role, hash, 1, ctx.now()]);
      await audit(tx, envOf(ctx), 'user.create', 'user', res.insertId, { username, role: b.role });
      return res;
    });
    return created({ id: r.insertId, username });
  });

  router.patch('/api/users/:id', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      name: { t: 'str', max: 120 },
      role: { t: 'enum', values: ['owner', 'staff'] },
      is_active: { t: 'bool' },
      new_password: { t: 'str', min: 8, max: 200, label: 'New password' },
    });
    const id = Number(ctx.params.id);
    const target = await db.get("SELECT * FROM users WHERE id = ? AND role <> 'customer'", [id]);
    if (!target) throw notFound('User not found');
    const raw = ctx.body || {};
    const nextActive = 'is_active' in raw ? (b.is_active ? 1 : 0) : target.is_active;
    const nextRole = b.role || target.role;
    if (id === ctx.user.id && (!nextActive || nextRole !== 'owner')) {
      throw badRequest('You cannot deactivate yourself or remove your own owner access');
    }
    await db.tx(async (tx) => {
      if ((target.role === 'owner' && target.is_active) && (nextRole !== 'owner' || !nextActive)) {
        const others = await tx.get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id <> ?", [id]);
        if (Number(others.n) < 1) throw badRequest('At least one active owner is required');
      }
      let bump = !nextActive && target.is_active ? 1 : 0;
      const sets = ['name = ?', 'role = ?', 'is_active = ?'];
      const vals = [b.name || target.name, nextRole, nextActive];
      if (b.new_password) {
        sets.push('password_hash = ?', 'must_change_password = 1', 'failed_attempts = 0', 'locked_until = NULL');
        vals.push(await pw.hash(b.new_password));
        bump = 1;
      }
      if (nextRole !== target.role) bump = 1;
      if (bump) sets.push('token_version = token_version + 1');
      await tx.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
      await audit(tx, envOf(ctx), 'user.update', 'user', id, { role: nextRole, active: !!nextActive, password_reset: !!b.new_password });
    });
    return { ok: true };
  });
};

'use strict';
const pw = require('../lib/password');
const { check } = require('../lib/validate');
const { staffArea } = require('../lib/guards');
const { created } = require('../lib/router');
const { badRequest, notFound } = require('../lib/errors');
const { audit, envOf } = require('../services/common');
const views = require('../services/views');

const PHONE = /^[0-9+\-\s]{7,20}$/;
const partySchema = {
  name: { t: 'str', req: true, max: 120 },
  phone: { t: 'str', pattern: PHONE, patternMsg: 'Enter a valid phone number', max: 20 },
  alt_phone: { t: 'str', pattern: PHONE, patternMsg: 'Enter a valid phone number', max: 20 },
  address: { t: 'str', max: 255 },
  id_proof_type: { t: 'str', max: 30 },
  id_proof_no: { t: 'str', max: 40 },
  notes: { t: 'str', max: 500 },
};

async function insertParty(tx, env, kind, b) {
  const r = await tx.run(
    `INSERT INTO parties (kind, name, phone, alt_phone, address, id_proof_type, id_proof_no, notes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [kind, b.name, b.phone, b.alt_phone, b.address, b.id_proof_type, b.id_proof_no, b.notes, env.user.id, env.now()]);
  await audit(tx, env, 'party.create', 'party', r.insertId, { name: b.name, kind });
  return r.insertId;
}

module.exports = (router, { db }) => {
  router.get('/api/parties', ...staffArea, async (ctx) => {
    const kind = ctx.query.kind === 'lender' ? 'lender' : 'customer';
    const where = ['p.kind = ?', 'p.is_active = 1'];
    const params = [kind];
    if (ctx.query.q) {
      where.push('(p.name LIKE ? OR p.phone LIKE ?)');
      params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
    }
    const rows = await db.all(
      `SELECT p.*,
         (SELECT COUNT(*) FROM loans l WHERE l.party_id = p.id AND l.status = 'active') AS active_loans,
         (SELECT COALESCE(SUM(l.principal_outstanding), 0) FROM loans l WHERE l.party_id = p.id AND l.status = 'active') AS outstanding,
         (SELECT COUNT(*) FROM users u WHERE u.party_id = p.id AND u.is_active = 1) AS has_login
       FROM parties p WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`, params);
    return { parties: rows.map((p) => ({ ...p, outstanding: Number(p.outstanding), active_loans: Number(p.active_loans), has_login: Number(p.has_login) > 0 })) };
  });

  router.post('/api/parties', ...staffArea, async (ctx) => {
    const b = check(ctx.body, { ...partySchema, kind: { t: 'enum', values: ['customer', 'lender'], def: 'customer' } });
    const id = await db.tx((tx) => insertParty(tx, envOf(ctx), b.kind || 'customer', b));
    return created({ id });
  });

  router.get('/api/parties/:id', ...staffArea, async (ctx) => {
    const p = await db.get('SELECT * FROM parties WHERE id = ?', [Number(ctx.params.id)]);
    if (!p) throw notFound('Customer not found');
    const loans = await views.listLoans(db, { party_id: p.id, limit: 0 }, ctx.today());
    const login = await db.get('SELECT username, is_active, last_login_at FROM users WHERE party_id = ? ORDER BY id DESC LIMIT 1', [p.id]);
    return { party: p, loans, portal_login: login ? { ...login, is_active: !!login.is_active } : null };
  });

  router.patch('/api/parties/:id', ...staffArea, async (ctx) => {
    const b = check(ctx.body, { ...partySchema, is_active: { t: 'bool' } });
    const id = Number(ctx.params.id);
    const p = await db.get('SELECT * FROM parties WHERE id = ?', [id]);
    if (!p) throw notFound('Customer not found');
    const active = 'is_active' in (ctx.body || {}) ? (b.is_active ? 1 : 0) : p.is_active;
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE parties SET name = ?, phone = ?, alt_phone = ?, address = ?, id_proof_type = ?, id_proof_no = ?, notes = ?, is_active = ? WHERE id = ?`,
        [b.name, b.phone, b.alt_phone, b.address, b.id_proof_type, b.id_proof_no, b.notes, active, id]);
      if (!active) await tx.run('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE party_id = ?', [id]);
      await audit(tx, envOf(ctx), 'party.update', 'party', id, { name: b.name });
    });
    return { ok: true };
  });

  // Give a customer a login for the customer portal / future mobile app (or reset their password)
  router.post('/api/parties/:id/portal-access', ...staffArea, async (ctx) => {
    const id = Number(ctx.params.id);
    const p = await db.get("SELECT * FROM parties WHERE id = ? AND kind = 'customer'", [id]);
    if (!p) throw notFound('Customer not found');
    const b = check(ctx.body, { username: { t: 'str', max: 40, pattern: /^[a-z0-9._@-]{3,40}$/i, patternMsg: 'Use 3-40 letters, digits, dot, dash or underscore' } });
    const digits = (p.phone || '').replace(/\D/g, '').slice(-10);
    const existing = await db.get('SELECT * FROM users WHERE party_id = ? ORDER BY id DESC LIMIT 1', [id]);
    const username = (existing ? existing.username : (b.username || digits)).toLowerCase();
    if (!username || username.length < 3) throw badRequest('Add a phone number to this customer first, or choose a username');
    const temp = pw.generateTemp(8);
    const hash = await pw.hash(temp);
    await db.tx(async (tx) => {
      if (existing) {
        await tx.run('UPDATE users SET password_hash = ?, must_change_password = 1, is_active = 1, failed_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = ?', [hash, existing.id]);
      } else {
        await tx.run(
          "INSERT INTO users (username, name, role, password_hash, party_id, must_change_password, created_at) VALUES (?,?,'customer',?,?,1,?)",
          [username, p.name, hash, id, ctx.now()]);
      }
      await audit(tx, envOf(ctx), existing ? 'portal.reset' : 'portal.create', 'party', id, { username });
    });
    return { username, temporary_password: temp };
  });
};
module.exports.insertParty = insertParty;
module.exports.partySchema = partySchema;

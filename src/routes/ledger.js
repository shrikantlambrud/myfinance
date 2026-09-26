'use strict';
const { check } = require('../lib/validate');
const { ownerOnly } = require('../lib/guards');
const { created } = require('../lib/router');
const { badRequest, notFound } = require('../lib/errors');
const { toPaise, fromPaise } = require('../engine/money');
const { envOf, audit, addLedger, availableCashPaise } = require('../services/common');

const MANUAL = ['capital_in', 'capital_out', 'expense', 'other_in'];

module.exports = (router, { db }) => {
  router.get('/api/ledger', ...ownerOnly, async (ctx) => {
    const q = check(ctx.query, {
      from: { t: 'date', def: null }, to: { t: 'date', def: null }, kind: { t: 'str', max: 30 },
      limit: { t: 'int', min: 1, max: 2000, def: 300 },
    });
    const where = ['1=1'];
    const params = [];
    if (q.from) { where.push('l.entry_date >= ?'); params.push(q.from); }
    if (q.to) { where.push('l.entry_date <= ?'); params.push(q.to); }
    if (q.kind) { where.push('l.kind = ?'); params.push(q.kind); }
    const rows = await db.all(
      `SELECT l.*, u.name AS by_name FROM ledger l LEFT JOIN users u ON u.id = l.created_by
       WHERE ${where.join(' AND ')} ORDER BY l.entry_date DESC, l.id DESC LIMIT ?`, [...params, q.limit || 300]);
    const totals = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) AS money_in,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS money_out
       FROM ledger l WHERE reversed_at IS NULL AND ${where.join(' AND ')}`, params);
    const cap = await db.get(
      "SELECT COALESCE(SUM(CASE WHEN kind = 'capital_in' THEN amount WHEN kind = 'capital_out' THEN -amount ELSE 0 END), 0) AS c FROM ledger WHERE reversed_at IS NULL");
    return {
      entries: rows.map((r) => ({
        id: r.id, entry_date: r.entry_date, kind: r.kind, direction: r.direction, amount: Number(r.amount),
        ref_type: r.ref_type, ref_id: r.ref_id, note: r.note, by_name: r.by_name, reversed_at: r.reversed_at,
        manual: !r.ref_type,
      })),
      totals: { money_in: Number(totals.money_in), money_out: Number(totals.money_out) },
      cash: fromPaise(await availableCashPaise(db)),
      capital: Number(cap.c),
    };
  });

  router.post('/api/ledger', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      kind: { t: 'enum', req: true, values: MANUAL },
      entry_date: { t: 'date', req: true, label: 'Date' },
      amount: { t: 'num', req: true, min: 0.01, max: 1000000000 },
      note: { t: 'str', max: 300 },
    });
    if (b.entry_date > ctx.today()) throw badRequest('Date cannot be in the future', { fields: { entry_date: 'Date cannot be in the future' } });
    const env = envOf(ctx);
    const id = await db.tx(async (tx) => {
      const out = b.kind === 'capital_out' || b.kind === 'expense';
      if (out && !ctx.body.allow_low_cash) {
        const cash = await availableCashPaise(tx);
        if (toPaise(b.amount) > cash) {
          const e = badRequest(`Available cash is only ₹${fromPaise(cash).toLocaleString('en-IN')}`, { code: 'LOW_CASH', available: fromPaise(cash) });
          e.status = 409;
          throw e;
        }
      }
      const lid = await addLedger(tx, env, { date: b.entry_date, kind: b.kind, direction: out ? 'out' : 'in', amountPaise: toPaise(b.amount), note: b.note });
      await audit(tx, env, 'ledger.create', 'ledger', lid, b);
      return lid;
    });
    return created({ id });
  });

  router.post('/api/ledger/:id/reverse', ...ownerOnly, async (ctx) => {
    const id = Number(ctx.params.id);
    const row = await db.get('SELECT * FROM ledger WHERE id = ?', [id]);
    if (!row) throw notFound('Entry not found');
    if (row.ref_type) throw badRequest('This entry was created by a loan or payment. Reverse that instead.');
    if (row.reversed_at) throw badRequest('Already reversed');
    await db.tx(async (tx) => {
      await tx.run('UPDATE ledger SET reversed_at = ? WHERE id = ?', [ctx.now(), id]);
      await audit(tx, envOf(ctx), 'ledger.reverse', 'ledger', id, { kind: row.kind, amount: Number(row.amount) });
    });
    return { ok: true };
  });
};

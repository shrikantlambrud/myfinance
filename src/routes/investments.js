'use strict';
const { check } = require('../lib/validate');
const { ownerOnly } = require('../lib/guards');
const { created } = require('../lib/router');
const { badRequest, notFound } = require('../lib/errors');
const { toPaise, fromPaise } = require('../engine/money');
const { envOf, audit, addLedger, reverseLedgerFor } = require('../services/common');

const SUMS = `(SELECT COALESCE(SUM(r.principal_part), 0) FROM investment_returns r WHERE r.investment_id = i.id AND r.reversed_at IS NULL) AS principal_returned,
              (SELECT COALESCE(SUM(r.profit_part), 0) FROM investment_returns r WHERE r.investment_id = i.id AND r.reversed_at IS NULL) AS profit`;

const present = (i) => {
  const out = fromPaise(toPaise(i.amount) - toPaise(i.principal_returned));
  return {
    id: i.id, name: i.name, amount: Number(i.amount), invested_on: i.invested_on, note: i.note,
    principal_returned: Number(i.principal_returned), profit: Number(i.profit), outstanding: out,
    total_returned: fromPaise(toPaise(i.principal_returned) + toPaise(i.profit)),
    status: out <= 0.005 ? 'closed' : 'active',
  };
};

module.exports = (router, { db }) => {
  router.get('/api/investments', ...ownerOnly, async () => {
    const rows = await db.all(`SELECT i.*, ${SUMS} FROM investments i WHERE i.deleted_at IS NULL ORDER BY i.id DESC`);
    return { investments: rows.map(present) };
  });

  router.post('/api/investments', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      name: { t: 'str', req: true, max: 150 }, amount: { t: 'num', req: true, min: 1, max: 1000000000 },
      invested_on: { t: 'date', req: true, label: 'Date' }, note: { t: 'str', max: 300 },
    });
    const env = envOf(ctx);
    const id = await db.tx(async (tx) => {
      const r = await tx.run('INSERT INTO investments (name, amount, invested_on, note, created_by, created_at) VALUES (?,?,?,?,?,?)',
        [b.name, b.amount, b.invested_on, b.note, env.user.id, env.now()]);
      await addLedger(tx, env, { date: b.invested_on, kind: 'investment_out', direction: 'out', amountPaise: toPaise(b.amount), refType: 'investment', refId: r.insertId, note: b.name });
      await audit(tx, env, 'investment.create', 'investment', r.insertId, b);
      return r.insertId;
    });
    return created({ id });
  });

  router.get('/api/investments/:id', ...ownerOnly, async (ctx) => {
    const i = await db.get(`SELECT i.*, ${SUMS} FROM investments i WHERE i.id = ? AND i.deleted_at IS NULL`, [Number(ctx.params.id)]);
    if (!i) throw notFound('Investment not found');
    const returns = await db.all('SELECT * FROM investment_returns WHERE investment_id = ? ORDER BY returned_on DESC, id DESC', [i.id]);
    return {
      investment: present(i),
      returns: returns.map((r) => ({ id: r.id, returned_on: r.returned_on, amount: Number(r.amount), principal_part: Number(r.principal_part), profit_part: Number(r.profit_part), note: r.note, reversed_at: r.reversed_at })),
    };
  });

  router.post('/api/investments/:id/returns', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      returned_on: { t: 'date', req: true, label: 'Date' },
      principal_part: { t: 'num', min: 0, max: 1000000000, def: 0, label: 'Principal recovered' },
      profit_part: { t: 'num', min: 0, max: 1000000000, def: 0, label: 'Profit' },
      note: { t: 'str', max: 300 },
    });
    const env = envOf(ctx);
    const total = toPaise(b.principal_part) + toPaise(b.profit_part);
    if (total <= 0) throw badRequest('Enter a profit or principal amount', { fields: { profit_part: 'Enter an amount' } });
    if (b.returned_on > ctx.today()) throw badRequest('Date cannot be in the future', { fields: { returned_on: 'Date cannot be in the future' } });
    const id = await db.tx(async (tx) => {
      const i = await tx.get(`SELECT i.*, ${SUMS} FROM investments i WHERE i.id = ? AND i.deleted_at IS NULL`, [Number(ctx.params.id)]);
      if (!i) throw notFound('Investment not found');
      if (toPaise(b.principal_part) > toPaise(i.amount) - toPaise(i.principal_returned)) {
        throw badRequest('Principal recovered is more than what is still outstanding', { fields: { principal_part: 'More than outstanding' } });
      }
      const r = await tx.run(
        'INSERT INTO investment_returns (investment_id, returned_on, amount, principal_part, profit_part, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [i.id, b.returned_on, fromPaise(total), b.principal_part, b.profit_part, b.note, env.user.id, env.now()]);
      await addLedger(tx, env, { date: b.returned_on, kind: 'investment_return', direction: 'in', amountPaise: total, refType: 'inv_return', refId: r.insertId, note: i.name });
      await audit(tx, env, 'investment.return', 'investment', i.id, b);
      return r.insertId;
    });
    return created({ id });
  });

  router.post('/api/investment-returns/:id/reverse', ...ownerOnly, async (ctx) => {
    const id = Number(ctx.params.id);
    await db.tx(async (tx) => {
      const r = await tx.get('SELECT * FROM investment_returns WHERE id = ?', [id]);
      if (!r) throw notFound('Return not found');
      if (r.reversed_at) throw badRequest('Already reversed');
      await tx.run('UPDATE investment_returns SET reversed_at = ? WHERE id = ?', [ctx.now(), id]);
      await reverseLedgerFor(tx, envOf(ctx), 'inv_return', id);
      await audit(tx, envOf(ctx), 'investment.return_reverse', 'investment', r.investment_id, { return_id: id });
    });
    return { ok: true };
  });

  router.delete('/api/investments/:id', ...ownerOnly, async (ctx) => {
    const id = Number(ctx.params.id);
    await db.tx(async (tx) => {
      const i = await tx.get('SELECT * FROM investments WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!i) throw notFound('Investment not found');
      const n = await tx.get('SELECT COUNT(*) AS n FROM investment_returns WHERE investment_id = ? AND reversed_at IS NULL', [id]);
      if (Number(n.n) > 0) throw badRequest('This investment has returns recorded. Reverse them first.');
      await tx.run('UPDATE investments SET deleted_at = ? WHERE id = ?', [ctx.now(), id]);
      await reverseLedgerFor(tx, envOf(ctx), 'investment', id);
      await audit(tx, envOf(ctx), 'investment.delete', 'investment', id, { name: i.name });
    });
    return { ok: true };
  });
};

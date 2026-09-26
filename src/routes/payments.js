'use strict';
const { check } = require('../lib/validate');
const { staffArea, ownerOnly } = require('../lib/guards');
const { notFound } = require('../lib/errors');
const { envOf, getSettings } = require('../services/common');
const L = require('../services/loans');

module.exports = (router, { db }) => {
  router.get('/api/payments', ...staffArea, async (ctx) => {
    const q = check(ctx.query, {
      from: { t: 'date', def: null }, to: { t: 'date', def: null },
      loan_id: { t: 'int', min: 1, def: null }, limit: { t: 'int', min: 1, max: 1000, def: 200 },
    });
    const where = ['1=1'];
    const params = [];
    if (q.from) { where.push('p.paid_on >= ?'); params.push(q.from); }
    if (q.to) { where.push('p.paid_on <= ?'); params.push(q.to); }
    if (q.loan_id) { where.push('p.loan_id = ?'); params.push(q.loan_id); }
    const rows = await db.all(
      `SELECT p.id, p.receipt_no, p.kind, p.paid_on, p.amount, p.pay_mode, p.reversed_at, l.loan_no, l.direction, pt.name AS party_name
       FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id
       WHERE ${where.join(' AND ')} ORDER BY p.paid_on DESC, p.id DESC LIMIT ?`, [...params, q.limit || 200]);
    return { payments: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
  });

  // Everything needed to print a receipt
  router.get('/api/payments/:id', ...staffArea, async (ctx) => {
    const p = await db.get(
      `SELECT p.*, l.loan_no, l.direction, l.type, l.principal, pt.name AS party_name, pt.phone AS party_phone, u.name AS received_by_name
       FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id LEFT JOIN users u ON u.id = p.received_by
       WHERE p.id = ?`, [Number(ctx.params.id)]);
    if (!p) throw notFound('Payment not found');
    const settings = await getSettings(db);
    return {
      receipt: {
        receipt_no: p.receipt_no, kind: p.kind, paid_on: p.paid_on, amount: Number(p.amount),
        principal_part: Number(p.principal_part), interest_part: Number(p.interest_part),
        penalty_part: Number(p.penalty_part), charge_part: Number(p.charge_part),
        pay_mode: p.pay_mode, ref_no: p.ref_no, note: p.note, reversed_at: p.reversed_at,
        loan_no: p.loan_no, direction: p.direction, party_name: p.party_name, party_phone: p.party_phone,
        received_by: p.received_by_name,
      },
      business: { name: settings.business_name, phone: settings.business_phone },
    };
  });

  router.post('/api/payments/:id/reverse', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, { reason: { t: 'str', req: true, min: 3, max: 300, label: 'Reason' } });
    const loanId = await db.tx((tx) => L.reversePayment(envOf(ctx), tx, Number(ctx.params.id), b.reason));
    return { ok: true, loan_id: loanId };
  });
};

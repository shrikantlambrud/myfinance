'use strict';
const { check } = require('../lib/validate');
const { staffArea, ownerOnly } = require('../lib/guards');
const { created } = require('../lib/router');
const { badRequest } = require('../lib/errors');
const { envOf } = require('../services/common');
const L = require('../services/loans');
const views = require('../services/views');
const { insertParty, partySchema } = require('./parties');

const termsSchema = {
  direction: { t: 'enum', values: ['given', 'taken'], def: 'given' },
  type: { t: 'enum', req: true, values: ['interest_only', 'emi_monthly', 'emi_daily'], label: 'Loan type' },
  interest_method: { t: 'enum', values: ['flat', 'reducing'], def: 'flat' },
  principal: { t: 'num', req: true, min: 1, max: 1000000000, label: 'Loan amount' },
  processing_fee: { t: 'num', min: 0, max: 1000000000, def: 0, label: 'Processing fee' },
  rate: { t: 'num', min: 0, max: 100, label: 'Interest rate' },
  fixed_installment: { t: 'num', min: 0.01, max: 1000000000, label: 'Fixed EMI' },
  tenure: { t: 'int', min: 1, max: 3650, label: 'Tenure' },
  start_date: { t: 'date', req: true, label: 'Start date' },
  first_due_date: { t: 'date', label: 'First due date' },
  late_fee_per_day: { t: 'num', min: 0, max: 1000000, label: 'Late fee per day' },
  foreclosure_charge_pct: { t: 'num', min: 0, max: 100, label: 'Foreclosure charge' },
  foreclosure_interest_policy: { t: 'enum', values: ['accrued', 'full'] },
};

module.exports = (router, { db }) => {
  router.post('/api/loans/preview', ...staffArea, async (ctx) => {
    const b = check(ctx.body, termsSchema);
    return L.previewLoan(db, b);
  });

  router.post('/api/loans', ...staffArea, async (ctx) => {
    const b = check(ctx.body, {
      ...termsSchema,
      party_id: { t: 'int', min: 1 },
      note: { t: 'str', max: 500 },
      allow_low_cash: { t: 'bool' },
    });
    const env = envOf(ctx);
    const id = await db.tx(async (tx) => {
      let partyId = b.party_id;
      if (!partyId) {
        const np = ctx.body.new_party;
        if (!np || typeof np !== 'object') throw badRequest('Choose a customer or add a new one', { fields: { party_id: 'Choose a customer' } });
        const party = check(np, partySchema);
        partyId = await insertParty(tx, env, b.direction === 'taken' ? 'lender' : 'customer', party);
      }
      return L.createLoan(env, tx, { ...b, party_id: partyId });
    });
    return created({ id });
  });

  router.get('/api/loans', ...staffArea, async (ctx) => {
    const q = ctx.query;
    const loans = await views.listLoans(db, {
      direction: ['given', 'taken'].includes(q.direction) ? q.direction : null,
      status: ['active', 'closed', 'foreclosed', 'written_off', 'void', 'overdue'].includes(q.status) ? q.status : null,
      party_id: q.party_id ? Number(q.party_id) : null,
      q: q.q ? String(q.q).slice(0, 60) : null,
      limit: Math.min(Number(q.limit) || 300, 1000),
    }, ctx.today());
    return { loans };
  });

  router.get('/api/loans/:id', ...staffArea, (ctx) => views.getLoanDetail(db, Number(ctx.params.id), ctx.today()));

  router.post('/api/loans/:id/payments', ...staffArea, async (ctx) => {
    const b = check(ctx.body, {
      amount: { t: 'num', req: true, min: 0.01, max: 1000000000 },
      paid_on: { t: 'date', def: null },
      pay_mode: { t: 'enum', values: ['cash', 'upi', 'bank', 'cheque', 'other'], def: 'cash' },
      ref_no: { t: 'str', max: 60, label: 'Reference' },
      note: { t: 'str', max: 300 },
      principal_amount: { t: 'num', min: 0, max: 1000000000, def: 0, label: 'Principal part' },
    });
    b.paid_on = b.paid_on || ctx.today();
    const id = await db.tx((tx) => L.recordPayment(envOf(ctx), tx, Number(ctx.params.id), b));
    return created({ id });
  });

  router.get('/api/loans/:id/foreclosure-quote', ...staffArea, async (ctx) => {
    const b = check(ctx.query, { date: { t: 'date', def: null } });
    return L.quoteForeclosure(db, Number(ctx.params.id), b.date || ctx.today());
  });

  router.post('/api/loans/:id/foreclose', ...staffArea, async (ctx) => {
    const b = check(ctx.body, {
      date: { t: 'date', def: null },
      discount: { t: 'num', min: 0, max: 1000000000, def: 0 },
      pay_mode: { t: 'enum', values: ['cash', 'upi', 'bank', 'cheque', 'other'], def: 'cash' },
      ref_no: { t: 'str', max: 60 },
      note: { t: 'str', max: 300 },
    });
    b.date = b.date || ctx.today();
    return db.tx((tx) => L.foreclose(envOf(ctx), tx, Number(ctx.params.id), b));
  });

  router.post('/api/loans/:id/write-off', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, { note: { t: 'str', req: true, min: 3, max: 300, label: 'Reason' } });
    await db.tx((tx) => L.writeOff(envOf(ctx), tx, Number(ctx.params.id), b.note));
    return { ok: true };
  });

  router.post('/api/loans/:id/reopen', ...ownerOnly, async (ctx) => {
    await db.tx((tx) => L.reopenLoan(envOf(ctx), tx, Number(ctx.params.id)));
    return { ok: true };
  });

  router.post('/api/loans/:id/void', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, { reason: { t: 'str', req: true, min: 3, max: 300, label: 'Reason' } });
    await db.tx((tx) => L.voidLoan(envOf(ctx), tx, Number(ctx.params.id), b.reason));
    return { ok: true };
  });
};

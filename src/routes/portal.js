'use strict';
const { check } = require('../lib/validate');
const { customerOnly } = require('../lib/guards');
const { notFound, forbidden } = require('../lib/errors');
const { toPaise, fromPaise } = require('../engine/money');
const { getSettings } = require('../services/common');
const L = require('../services/loans');
const views = require('../services/views');

// Customers can only ever see their own loans. Every handler re-checks ownership.
function publicCard(c) {
  return {
    id: c.id, loan_no: c.loan_no, type: c.type, interest_method: c.interest_method, principal: c.principal, rate: c.rate,
    tenure: c.tenure, start_date: c.start_date, status: c.status, closed_on: c.closed_on,
    installment: c.installment, principal_outstanding: c.principal_outstanding, total_paid: c.total_paid,
    summary: c.summary,
  };
}

module.exports = (router, { db }) => {
  router.get('/api/portal/me', ...customerOnly, async (ctx) => {
    if (!ctx.user.party_id) throw forbidden();
    const party = await db.get('SELECT name, phone FROM parties WHERE id = ?', [ctx.user.party_id]);
    const settings = await getSettings(db);
    const cards = await views.listLoans(db, { direction: 'given', party_id: ctx.user.party_id, limit: 0 }, ctx.today());
    const active = cards.filter((c) => c.status === 'active');
    const dues = active.filter((c) => c.summary && c.summary.next_due).sort((a, b) => a.summary.next_due.due_date.localeCompare(b.summary.next_due.due_date));
    const sumP = (arr, f) => fromPaise(arr.reduce((t, c) => t + toPaise(f(c)), 0));
    return {
      customer: party,
      business: { name: settings.business_name, phone: settings.business_phone },
      totals: {
        active_loans: active.length,
        principal_outstanding: sumP(active, (c) => c.principal_outstanding),
        overdue_amount: sumP(active, (c) => c.summary.overdue_amount),
        due_now: sumP(active, (c) => c.summary.due_now_amount),
        next_due: dues.length ? { ...dues[0].summary.next_due, loan_no: dues[0].loan_no, loan_id: dues[0].id } : null,
      },
    };
  });

  router.get('/api/portal/loans', ...customerOnly, async (ctx) => {
    if (!ctx.user.party_id) throw forbidden();
    const cards = await views.listLoans(db, { direction: 'given', party_id: ctx.user.party_id, limit: 0 }, ctx.today());
    return { loans: cards.filter((c) => c.status !== 'void').map(publicCard) };
  });

  async function ownLoan(ctx) {
    const id = Number(ctx.params.id);
    const row = await db.get("SELECT party_id, direction, status FROM loans WHERE id = ?", [id]);
    if (!row || row.party_id !== ctx.user.party_id || row.direction !== 'given' || row.status === 'void') throw notFound('Loan not found');
    return id;
  }

  router.get('/api/portal/loans/:id', ...customerOnly, async (ctx) => {
    const id = await ownLoan(ctx);
    const d = await views.getLoanDetail(db, id, ctx.today(), { portal: true });
    delete d.loan.note; delete d.loan.created_at; delete d.loan.party; delete d.loan.party_id;
    delete d.loan.foreclosure_interest_policy;
    return d;
  });

  router.get('/api/portal/loans/:id/foreclosure-quote', ...customerOnly, async (ctx) => {
    const id = await ownLoan(ctx);
    const q = check(ctx.query, { date: { t: 'date', def: null } });
    const date = q.date && q.date >= ctx.today() ? q.date : ctx.today();
    return L.quoteForeclosure(db, id, date);
  });
};

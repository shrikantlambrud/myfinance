'use strict';
const { check } = require('../lib/validate');
const { ownerOnly } = require('../lib/guards');
const { csv } = require('../lib/router');
const { toCsv } = require('../lib/csv');
const { toPaise, fromPaise } = require('../engine/money');
const views = require('../services/views');

const R = fromPaise;
const range = (q, today) => ({ from: q.from || today.slice(0, 8) + '01', to: q.to || today });

// Interest received per customer, broken down by calendar year, plus an all-time total.
// Grouped in JS (not SQL YEAR()) so this works the same on MySQL and the sqlite test adapter.
async function customerInterestMatrix(db) {
  const rows = await db.all(
    `SELECT pt.id AS party_id, pt.name AS customer, p.paid_on, p.interest_part
     FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id
     WHERE l.direction = 'given' AND p.reversed_at IS NULL`);
  const byCustomer = new Map();
  const years = new Set();
  for (const r of rows) {
    const year = r.paid_on.slice(0, 4);
    years.add(year);
    if (!byCustomer.has(r.party_id)) byCustomer.set(r.party_id, { name: r.customer, years: {}, total: 0 });
    const c = byCustomer.get(r.party_id);
    const paise = toPaise(r.interest_part);
    c.years[year] = (c.years[year] || 0) + paise;
    c.total += paise;
  }
  const yearList = [...years].sort();
  const customers = [...byCustomer.values()]
    .map((c) => ({ name: c.name, total: R(c.total), years: Object.fromEntries(yearList.map((y) => [y, R(c.years[y] || 0)])) }))
    .sort((a, b) => b.total - a.total);
  const yearTotals = Object.fromEntries(yearList.map((y) => [y, R(customers.reduce((t, c) => t + toPaise(c.years[y]), 0))]));
  return { years: yearList, customers, grand_total: R(customers.reduce((t, c) => t + toPaise(c.total), 0)), year_totals: yearTotals };
}

module.exports = (router, { db }) => {
  router.get('/api/reports/customer-interest', ...ownerOnly, async () => customerInterestMatrix(db));

  router.get('/api/reports/customer-interest.csv', ...ownerOnly, async (ctx) => {
    const { years, customers, grand_total, year_totals } = await customerInterestMatrix(db);
    const rows = [['Customer', ...years, 'All time']];
    customers.forEach((c) => rows.push([c.name, ...years.map((y) => c.years[y]), c.total]));
    rows.push(['TOTAL', ...years.map((y) => year_totals[y]), grand_total]);
    return csv(`customer_interest_${ctx.today()}.csv`, toCsv(rows));
  });

  router.get('/api/reports/summary', ...ownerOnly, async (ctx) => {
    const q = check(ctx.query, { from: { t: 'date', def: null }, to: { t: 'date', def: null } });
    const { from, to } = range(q, ctx.today());
    const pay = async (direction) => db.get(
      `SELECT COALESCE(SUM(p.interest_part), 0) AS interest, COALESCE(SUM(p.penalty_part), 0) AS penalty,
              COALESCE(SUM(p.charge_part), 0) AS charge, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*) AS n
       FROM payments p JOIN loans l ON l.id = p.loan_id
       WHERE l.direction = ? AND p.reversed_at IS NULL AND p.paid_on >= ? AND p.paid_on <= ?`, [direction, from, to]);
    const loans = async (direction) => db.get(
      `SELECT COALESCE(SUM(principal), 0) AS principal, COALESCE(SUM(processing_fee), 0) AS fees, COUNT(*) AS n
       FROM loans WHERE direction = ? AND status <> 'void' AND start_date >= ? AND start_date <= ?`, [direction, from, to]);
    const given = await pay('given'), taken = await pay('taken');
    const lg = await loans('given'), lt = await loans('taken');
    const invProfit = await db.get(
      `SELECT COALESCE(SUM(r.profit_part), 0) AS p FROM investment_returns r JOIN investments i ON i.id = r.investment_id
       WHERE r.reversed_at IS NULL AND i.deleted_at IS NULL AND r.returned_on >= ? AND r.returned_on <= ?`, [from, to]);
    const exp = await db.get(
      "SELECT COALESCE(SUM(amount), 0) AS e FROM ledger WHERE kind = 'expense' AND reversed_at IS NULL AND entry_date >= ? AND entry_date <= ?", [from, to]);

    const income = {
      interest: Number(given.interest), late_fees: Number(given.penalty), foreclosure_charges: Number(given.charge),
      processing_fees: Number(lg.fees), investment_profit: Number(invProfit.p),
    };
    const costs = {
      borrowing_interest: R(toPaise(taken.interest) + toPaise(taken.penalty) + toPaise(taken.charge)),
      borrowing_fees: Number(lt.fees), expenses: Number(exp.e),
    };
    const sum = (o) => R(Object.values(o).reduce((t, v) => t + toPaise(v), 0));
    return {
      from, to, income, total_income: sum(income), costs, total_costs: sum(costs),
      net_profit: R(toPaise(sum(income)) - toPaise(sum(costs))),
      activity: {
        loans_given: Number(lg.n), disbursed: Number(lg.principal), collected: Number(given.amount), payments_received: Number(given.n),
        loans_taken: Number(lt.n), borrowed: Number(lt.principal), repaid_to_lenders: Number(taken.amount),
      },
    };
  });

  router.get('/api/reports/loans.csv', ...ownerOnly, async (ctx) => {
    const direction = ctx.query.direction === 'taken' ? 'taken' : 'given';
    const loans = await views.listLoans(db, { direction, limit: 0 }, ctx.today());
    const rows = [['Loan no', direction === 'given' ? 'Customer' : 'Lender', 'Phone', 'Type', 'Principal', 'Rate %', 'Start date', 'Status',
      'Total paid', 'Principal outstanding', 'Overdue amount', 'Overdue days', 'Next due date', 'Next due amount']];
    loans.forEach((c) => rows.push([
      c.loan_no, c.party.name, c.party.phone, c.type, c.principal, c.rate, c.start_date, c.status, c.total_paid, c.principal_outstanding,
      c.summary ? c.summary.overdue_amount : 0, c.summary ? c.summary.overdue_days : 0,
      c.summary && c.summary.next_due ? c.summary.next_due.due_date : '', c.summary && c.summary.next_due ? c.summary.next_due.amount : '',
    ]));
    return csv(`loans_${direction}_${ctx.today()}.csv`, toCsv(rows));
  });

  router.get('/api/reports/payments.csv', ...ownerOnly, async (ctx) => {
    const q = check(ctx.query, { from: { t: 'date', def: null }, to: { t: 'date', def: null } });
    const { from, to } = range(q, ctx.today());
    const rows = await db.all(
      `SELECT p.receipt_no, p.paid_on, l.loan_no, l.direction, pt.name, p.kind, p.amount, p.principal_part, p.interest_part, p.penalty_part, p.charge_part,
              p.pay_mode, p.ref_no, u.name AS by_name
       FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id LEFT JOIN users u ON u.id = p.received_by
       WHERE p.reversed_at IS NULL AND p.paid_on >= ? AND p.paid_on <= ? ORDER BY p.paid_on, p.id`, [from, to]);
    const out = [['Receipt', 'Date', 'Loan', 'Direction', 'Party', 'Kind', 'Amount', 'Principal', 'Interest', 'Late fee', 'Charge', 'Mode', 'Reference', 'Received by']];
    rows.forEach((r) => out.push([r.receipt_no, r.paid_on, r.loan_no, r.direction, r.name, r.kind, r.amount, r.principal_part, r.interest_part, r.penalty_part, r.charge_part, r.pay_mode, r.ref_no, r.by_name]));
    return csv(`payments_${from}_to_${to}.csv`, toCsv(out));
  });

  router.get('/api/reports/ledger.csv', ...ownerOnly, async (ctx) => {
    const q = check(ctx.query, { from: { t: 'date', def: null }, to: { t: 'date', def: null } });
    const { from, to } = range(q, ctx.today());
    const rows = await db.all(
      'SELECT entry_date, kind, direction, amount, note FROM ledger WHERE reversed_at IS NULL AND entry_date >= ? AND entry_date <= ? ORDER BY entry_date, id', [from, to]);
    const out = [['Date', 'Kind', 'In / Out', 'Amount', 'Note']];
    rows.forEach((r) => out.push([r.entry_date, r.kind, r.direction, r.amount, r.note]));
    return csv(`cashbook_${from}_to_${to}.csv`, toCsv(out));
  });
};

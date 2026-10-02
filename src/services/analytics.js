'use strict';
const { toPaise, fromPaise } = require('../engine/money');
const { addMonths } = require('../engine/dates');
const views = require('./views');

const R = fromPaise;
const TYPE_LABEL = { interest_only: 'Interest only', emi_monthly: 'Monthly EMI', emi_daily: 'Daily EMI' };
const STATUS_LABEL = { active: 'Active', closed: 'Closed', foreclosed: 'Foreclosed', written_off: 'Written off' };
const BUCKETS = [
  { label: '1-7 days', min: 1, max: 7 },
  { label: '8-30 days', min: 8, max: 30 },
  { label: '31-60 days', min: 31, max: 60 },
  { label: '61-90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: Infinity },
];

// ['2026-04', ... , '2026-09'] ending with the month of `asOf`
function monthList(asOf, n) {
  const first = asOf.slice(0, 8) + '01';
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(first, -i).slice(0, 7));
  return out;
}

/**
 * Everything the Analytics page draws. All grouping happens in JS (not SQL YEAR()/MONTH())
 * so it behaves identically on MySQL and the sqlite test adapter. Money is summed in paise.
 */
async function analytics(db, asOf, nMonths) {
  const months = monthList(asOf, nMonths);
  const at = new Map(months.map((m, i) => [m, i]));
  const zeros = () => months.map(() => 0);
  const S = { interest: zeros(), fees: zeros(), penalties: zeros(), invProfit: zeros(), disbursed: zeros(), collected: zeros(), borrowCost: zeros(), expenses: zeros() };
  const add = (arr, iso, paise) => { const i = at.get(String(iso).slice(0, 7)); if (i !== undefined) arr[i] += paise; };

  /* ---- payments: monthly series + all-time interest by customer / loan type ---- */
  const pays = await db.all(
    `SELECT p.paid_on, p.amount, p.interest_part, p.penalty_part, p.charge_part, l.direction, l.type, l.party_id, pt.name AS customer
     FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id
     WHERE p.reversed_at IS NULL`);
  const interestByCustomer = new Map();
  const interestByType = {};
  for (const p of pays) {
    const interest = toPaise(p.interest_part);
    if (p.direction === 'given') {
      add(S.interest, p.paid_on, interest);
      add(S.penalties, p.paid_on, toPaise(p.penalty_part) + toPaise(p.charge_part));
      add(S.collected, p.paid_on, toPaise(p.amount));
      if (!interestByCustomer.has(p.party_id)) interestByCustomer.set(p.party_id, { name: p.customer, paise: 0 });
      interestByCustomer.get(p.party_id).paise += interest;
      interestByType[p.type] = (interestByType[p.type] || 0) + interest;
    } else {
      add(S.borrowCost, p.paid_on, interest + toPaise(p.penalty_part) + toPaise(p.charge_part));
    }
  }

  /* ---- loans: disbursed, processing fees, status mix ---- */
  const loans = await db.all("SELECT direction, principal, processing_fee, start_date, status FROM loans WHERE status <> 'void'");
  const statusCount = {};
  let givenCount = 0, givenPrincipal = 0;
  for (const l of loans) {
    if (l.direction === 'given') {
      add(S.disbursed, l.start_date, toPaise(l.principal));
      add(S.fees, l.start_date, toPaise(l.processing_fee));
      statusCount[l.status] = (statusCount[l.status] || 0) + 1;
      givenCount++; givenPrincipal += toPaise(l.principal);
    } else {
      add(S.borrowCost, l.start_date, toPaise(l.processing_fee));
    }
  }

  /* ---- expenses + investment profit ---- */
  (await db.all("SELECT entry_date, amount FROM ledger WHERE kind = 'expense' AND reversed_at IS NULL"))
    .forEach((e) => add(S.expenses, e.entry_date, toPaise(e.amount)));
  (await db.all(
    `SELECT r.returned_on, r.profit_part FROM investment_returns r JOIN investments i ON i.id = r.investment_id
     WHERE r.reversed_at IS NULL AND i.deleted_at IS NULL`))
    .forEach((r) => add(S.invProfit, r.returned_on, toPaise(r.profit_part)));

  const income = months.map((_, i) => S.interest[i] + S.fees[i] + S.penalties[i] + S.invProfit[i]);
  const costs = months.map((_, i) => S.borrowCost[i] + S.expenses[i]);
  const net = months.map((_, i) => income[i] - costs[i]);
  const sum = (a) => a.reduce((t, v) => t + v, 0);

  /* ---- current portfolio (active loans given to customers) ---- */
  const cards = await views.listLoans(db, { direction: 'given', status: 'active', limit: 1000 }, asOf);
  const byType = {};
  const byCustomer = new Map();
  const ageing = BUCKETS.map((b) => ({ label: b.label, paise: 0, count: 0 }));
  let outstanding = 0, overduePrincipal = 0, par30Principal = 0, overdueTotal = 0;
  const customers = new Set();
  for (const c of cards) {
    const out = toPaise(c.principal_outstanding);
    outstanding += out;
    customers.add(c.party.id);
    byType[c.type] = (byType[c.type] || 0) + out;
    if (!byCustomer.has(c.party.id)) byCustomer.set(c.party.id, { name: c.party.name, paise: 0 });
    byCustomer.get(c.party.id).paise += out;
    const s = c.summary;
    if (s && s.overdue_amount > 0) {
      overduePrincipal += out;
      overdueTotal += toPaise(s.overdue_amount);
      if (s.overdue_days > 30) par30Principal += out;
      const bi = BUCKETS.findIndex((b) => s.overdue_days >= b.min && s.overdue_days <= b.max);
      if (bi >= 0) { ageing[bi].paise += toPaise(s.overdue_amount); ageing[bi].count++; }
    }
  }
  const custSorted = [...byCustomer.values()].sort((a, b) => b.paise - a.paise);
  const topCust = custSorted.slice(0, 6).map((c) => ({ name: c.name, value: R(c.paise) }));
  const restCust = custSorted.slice(6).reduce((t, c) => t + c.paise, 0);
  if (restCust > 0) topCust.push({ name: 'Others', value: R(restCust) });

  const topInterest = [...interestByCustomer.values()].filter((c) => c.paise > 0).sort((a, b) => b.paise - a.paise).slice(0, 8)
    .map((c) => ({ name: c.name, value: R(c.paise) }));

  const last = months.length - 1;
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
  let bestIdx = 0;
  income.forEach((v, i) => { if (v > income[bestIdx]) bestIdx = i; });

  return {
    as_of: asOf,
    months,
    series: {
      interest: S.interest.map(R), fees_charges: months.map((_, i) => R(S.fees[i] + S.penalties[i])), investment_profit: S.invProfit.map(R),
      income: income.map(R), costs: costs.map(R), net: net.map(R), disbursed: S.disbursed.map(R), collected: S.collected.map(R),
    },
    portfolio: {
      outstanding: R(outstanding),
      by_type: Object.entries(byType).map(([key, v]) => ({ key, label: TYPE_LABEL[key] || key, value: R(v) })).sort((a, b) => b.value - a.value),
      by_customer: topCust,
      ageing: ageing.map((b) => ({ label: b.label, amount: R(b.paise), count: b.count })),
      status: Object.entries(statusCount).map(([key, count]) => ({ key, label: STATUS_LABEL[key] || key, count })),
    },
    top_interest: topInterest,
    interest_by_type: Object.entries(interestByType).filter(([, v]) => v > 0).map(([key, v]) => ({ key, label: TYPE_LABEL[key] || key, value: R(v) })).sort((a, b) => b.value - a.value),
    kpis: {
      outstanding: R(outstanding),
      active_loans: cards.length,
      active_customers: customers.size,
      avg_loan: givenCount ? R(Math.round(givenPrincipal / givenCount)) : 0,
      interest_window: R(sum(S.interest)),
      income_window: R(sum(income)),
      net_window: R(sum(net)),
      interest_this_month: R(S.interest[last]),
      interest_prev_month: last > 0 ? R(S.interest[last - 1]) : 0,
      overdue_amount: R(overdueTotal),
      par_pct: pct(overduePrincipal, outstanding),
      par30_pct: pct(par30Principal, outstanding),
      best_month: months[bestIdx],
      best_month_income: R(income[bestIdx]),
    },
  };
}

module.exports = { analytics };

'use strict';
const { toPaise, fromPaise } = require('../engine/money');
const { addDays } = require('../engine/dates');
const L = require('./loans');
const { availableCashPaise } = require('./common');
const { notFound } = require('../lib/errors');

const R = fromPaise;

function installmentAmount(b) {
  if (!b.installments.length) return null;
  const i = b.installments[0];
  return R(toPaise(i.principal_due) + toPaise(i.interest_due));
}

function cardOf(b, asOf) {
  const row = b.row;
  const party = { id: row.party_id, name: row.party_name, phone: row.party_phone };
  const active = row.status === 'active';
  const s = active ? L.summarizeBundle(b, asOf) : null;
  const paid = b.payments.reduce((t, p) => t + toPaise(p.amount), 0);
  return {
    ...L.presentLoanRow(row, party),
    installment: installmentAmount(b),
    principal_outstanding: s ? R(s.principal_outstanding) : Number(row.principal_outstanding),
    total_paid: R(paid),
    summary: s ? L.presentSummary(s) : null,
  };
}

async function selectLoanRows(db, { direction, status, party_id, q, limit, offset }) {
  const where = [];
  const params = [];
  if (direction) { where.push('l.direction = ?'); params.push(direction); }
  if (status && status !== 'overdue') { where.push('l.status = ?'); params.push(status); }
  if (status === 'overdue') where.push("l.status = 'active'");
  if (party_id) { where.push('l.party_id = ?'); params.push(party_id); }
  if (q) {
    where.push('(p.name LIKE ? OR p.phone LIKE ? OR l.loan_no LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  let sql = `SELECT l.*, p.name AS party_name, p.phone AS party_phone FROM loans l JOIN parties p ON p.id = l.party_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC`;
  if (limit) { sql += ' LIMIT ? OFFSET ?'; params.push(limit, offset || 0); }
  return db.all(sql, params);
}

async function listLoans(db, filters, asOf) {
  const rows = await selectLoanRows(db, { ...filters, limit: filters.status === 'overdue' ? 0 : (filters.limit || 300) });
  const bundles = await L.loadBundles(db, rows);
  let cards = bundles.map((b) => cardOf(b, asOf));
  if (filters.status === 'overdue') cards = cards.filter((c) => c.summary && c.summary.overdue_amount > 0);
  return cards;
}

async function getLoanDetail(db, id, asOf, { portal = false } = {}) {
  const b = await L.loadBundle(db, id);
  const party = await db.get('SELECT id, name, phone, alt_phone, address FROM parties WHERE id = ?', [b.row.party_id]);
  if (!party) throw notFound('Loan not found');
  b.row.party_name = party.name;
  const asOfEff = b.closure ? b.closure.closed_on : asOf;
  const summary = b.row.status === 'void' ? null : L.summarizeBundle(b, b.row.status === 'active' ? asOf : asOfEff);
  const pays = await db.all(
    `SELECT p.*, u.name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by
     WHERE p.loan_id = ? ORDER BY p.paid_on DESC, p.id DESC`, [id]);
  const out = {
    loan: { ...L.presentLoanRow(b.row, party), installment: installmentAmount(b), principal_outstanding: summary ? R(summary.principal_outstanding) : 0 },
    summary: summary ? L.presentSummary(summary) : null,
    schedule: summary ? summary.rows.map(L.presentRow) : [],
    payments: pays
      .filter((p) => !portal || !p.reversed_at)
      .map((p) => ({
        id: p.id, receipt_no: p.receipt_no, kind: p.kind, paid_on: p.paid_on, amount: Number(p.amount),
        principal_part: Number(p.principal_part), interest_part: Number(p.interest_part),
        penalty_part: Number(p.penalty_part), charge_part: Number(p.charge_part),
        pay_mode: p.pay_mode, ref_no: p.ref_no, note: p.note,
        ...(portal ? {} : { received_by_name: p.received_by_name, reversed_at: p.reversed_at, reverse_reason: p.reverse_reason }),
      })),
    closure: b.closure ? {
      kind: b.closure.kind, closed_on: b.closure.closed_on, principal_settled: Number(b.closure.principal_settled),
      interest_settled: Number(b.closure.interest_settled), penalty_settled: Number(b.closure.penalty_settled),
      charge: Number(b.closure.charge), discount: Number(b.closure.discount), amount_received: Number(b.closure.amount_received),
    } : null,
    quote: b.row.status === 'active' ? L.presentQuote(L.quoteFromBundle(b, asOf)) : null,
  };
  if (!portal) {
    out.audit = await db.all(
      `SELECT a.action, a.details, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE (a.entity = 'loan' AND a.entity_id = ?) ORDER BY a.id DESC LIMIT 30`, [id]);
  }
  return out;
}

/* ------------------------------------------------------------------ */

async function collections(db, asOf) {
  const cards = await listLoans(db, { direction: 'given', status: 'active', limit: 0 }, asOf);
  const horizon = addDays(asOf, 7);
  const due = [], upcoming = [];
  for (const c of cards) {
    const s = c.summary;
    if (!s || !s.next_due) continue;
    const item = {
      loan_id: c.id, loan_no: c.loan_no, party_id: c.party_id, name: c.party.name, phone: c.party.phone,
      type: c.type, installment: c.installment, principal_outstanding: c.principal_outstanding,
      due_now: s.due_now_amount, overdue_amount: s.overdue_amount, overdue_days: s.overdue_days,
      next_due_date: s.next_due.due_date, next_due_amount: s.next_due.amount,
    };
    if (s.due_now_amount > 0) due.push(item);
    else if (s.next_due.due_date <= horizon) upcoming.push(item);
  }
  due.sort((a, b) => b.overdue_days - a.overdue_days || a.next_due_date.localeCompare(b.next_due_date));
  upcoming.sort((a, b) => a.next_due_date.localeCompare(b.next_due_date));
  const col = await db.get(
    `SELECT COALESCE(SUM(p.amount), 0) AS total, COUNT(*) AS n FROM payments p JOIN loans l ON l.id = p.loan_id
     WHERE l.direction = 'given' AND p.paid_on = ? AND p.reversed_at IS NULL`, [asOf]);
  const dueToday = due.filter((d) => d.overdue_days === 0);
  return {
    as_of: asOf, due, upcoming,
    totals: {
      due_now: R(due.reduce((t, d) => t + toPaise(d.due_now), 0)),
      due_count: due.length,
      overdue_count: due.filter((d) => d.overdue_days > 0).length,
      due_today_only: dueToday.length,
      collected_today: Number(col.total), payments_today: Number(col.n),
    },
  };
}

async function dashboard(db, asOf) {
  const monthStart = asOf.slice(0, 8) + '01';
  const cash = await availableCashPaise(db);
  const cap = await db.get(
    "SELECT COALESCE(SUM(CASE WHEN kind = 'capital_in' THEN amount WHEN kind = 'capital_out' THEN -amount ELSE 0 END), 0) AS c FROM ledger WHERE reversed_at IS NULL");

  const given = await listLoans(db, { direction: 'given', status: 'active', limit: 0 }, asOf);
  const taken = await listLoans(db, { direction: 'taken', status: 'active', limit: 0 }, asOf);
  const sumP = (arr, f) => arr.reduce((t, x) => t + toPaise(f(x)), 0);

  const lentOut = sumP(given, (c) => c.principal_outstanding);
  const overdue = given.filter((c) => c.summary && c.summary.overdue_amount > 0);
  const par30 = overdue.filter((c) => c.summary.overdue_days > 30);
  const dueNow = given.filter((c) => c.summary && c.summary.due_now_amount > 0);

  const income = async (from) => {
    const r = await db.get(
      `SELECT COALESCE(SUM(p.interest_part), 0) AS interest, COALESCE(SUM(p.penalty_part), 0) AS penalty,
              COALESCE(SUM(p.charge_part), 0) AS charge, COALESCE(SUM(p.amount), 0) AS collected
       FROM payments p JOIN loans l ON l.id = p.loan_id
       WHERE l.direction = 'given' AND p.reversed_at IS NULL AND p.paid_on >= ?`, [from]);
    const f = await db.get(
      "SELECT COALESCE(SUM(processing_fee), 0) AS fees FROM loans WHERE direction = 'given' AND status <> 'void' AND start_date >= ?", [from]);
    const total = toPaise(r.interest) + toPaise(r.penalty) + toPaise(r.charge) + toPaise(f.fees);
    return { interest: Number(r.interest), late_fees: Number(r.penalty), charges: Number(r.charge), processing_fees: Number(f.fees), total: R(total), collected: Number(r.collected) };
  };
  const inv = await db.get(
    `SELECT COALESCE((SELECT SUM(amount) FROM investments WHERE deleted_at IS NULL), 0) AS invested,
            COALESCE((SELECT SUM(principal_part) FROM investment_returns r JOIN investments i ON i.id = r.investment_id
                      WHERE r.reversed_at IS NULL AND i.deleted_at IS NULL), 0) AS returned,
            COALESCE((SELECT SUM(profit_part) FROM investment_returns r JOIN investments i ON i.id = r.investment_id
                      WHERE r.reversed_at IS NULL AND i.deleted_at IS NULL), 0) AS profit`);
  const recent = await db.all(
    `SELECT p.id, p.receipt_no, p.paid_on, p.amount, p.kind, l.loan_no, l.direction, pt.name AS party_name
     FROM payments p JOIN loans l ON l.id = p.loan_id JOIN parties pt ON pt.id = l.party_id
     WHERE p.reversed_at IS NULL ORDER BY p.id DESC LIMIT 8`);

  return {
    as_of: asOf,
    cash: R(cash),
    capital: Number(cap.c),
    lent: {
      count: given.length,
      principal_outstanding: R(lentOut),
      interest_remaining: R(sumP(given, (c) => c.summary.interest_remaining)),
    },
    overdue: {
      count: overdue.length,
      amount: R(sumP(overdue, (c) => c.summary.overdue_amount)),
      par30_count: par30.length,
      par30_pct: lentOut > 0 ? Math.round((sumP(par30, (c) => c.principal_outstanding) / lentOut) * 1000) / 10 : 0,
    },
    today: {
      due_count: dueNow.length,
      due_amount: R(sumP(dueNow, (c) => c.summary.due_now_amount)),
      collected: (await income(asOf)).collected,
    },
    month: await income(monthStart),
    borrowed: {
      count: taken.length,
      principal_outstanding: R(sumP(taken, (c) => c.principal_outstanding)),
      due_now: R(sumP(taken, (c) => c.summary.due_now_amount)),
    },
    investments: { outstanding: R(toPaise(inv.invested) - toPaise(inv.returned)), profit: Number(inv.profit) },
    recent_payments: recent.map((p) => ({ ...p, amount: Number(p.amount) })),
  };
}

module.exports = { listLoans, getLoanDetail, collections, dashboard, cardOf };

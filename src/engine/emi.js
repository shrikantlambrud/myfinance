'use strict';
const { diffDays } = require('./dates');

// Late fee for one installment: flat paise per day between due date and `endDate`.
function lateFeeAccrued(feePerDay, dueDate, endDate) {
  if (!feePerDay) return 0;
  return feePerDay * Math.max(0, diffDays(dueDate, endDate));
}

const byDateThenId = (a, b) => (a.paid_on < b.paid_on ? -1 : a.paid_on > b.paid_on ? 1 : a.id - b.id);

/**
 * Replay every payment (in date, then id order) against the fixed schedule.
 * Each payment is applied oldest-installment-first; inside an installment: penalty, then interest, then principal.
 * Because the replay is deterministic, reversing a payment is just "replay without it".
 *
 * @param {Array<{seq,due_date,principal_due,interest_due}>} schedule  (paise)
 * @param {Array<{id,paid_on,amount}>} payments  regular, non-reversed payments (paise)
 * @param {number} feePerDay late fee per overdue installment per day (paise)
 */
function replay(schedule, payments, feePerDay) {
  const st = schedule.map((s) => ({
    seq: s.seq, due_date: s.due_date, principal_due: s.principal_due, interest_due: s.interest_due,
    principal_paid: 0, interest_paid: 0, penalty_paid: 0, cleared_on: null,
  }));
  const splits = new Map();
  for (const p of [...payments].sort(byDateThenId)) {
    let rem = p.amount;
    const sp = { principal: 0, interest: 0, penalty: 0, unallocated: 0 };
    for (const s of st) {
      if (rem <= 0) break;
      const end = s.cleared_on !== null ? s.cleared_on : p.paid_on;
      const penOwed = Math.max(0, lateFeeAccrued(feePerDay, s.due_date, end) - s.penalty_paid);
      const payPen = Math.min(rem, penOwed);
      s.penalty_paid += payPen; sp.penalty += payPen; rem -= payPen;

      const payInt = Math.min(rem, s.interest_due - s.interest_paid);
      s.interest_paid += payInt; sp.interest += payInt; rem -= payInt;

      const payPri = Math.min(rem, s.principal_due - s.principal_paid);
      s.principal_paid += payPri; sp.principal += payPri; rem -= payPri;

      if (s.cleared_on === null && s.principal_paid >= s.principal_due && s.interest_paid >= s.interest_due) {
        s.cleared_on = p.paid_on;
      }
    }
    sp.unallocated = rem;
    splits.set(p.id, sp);
  }
  return { installments: st, splits };
}

/**
 * Full picture of an EMI loan as of a date.
 * @param closure null | {closed_on}  (foreclosure / write-off): unpaid installments become 'waived'
 */
function summarizeEmi(loan, schedule, payments, asOf, closure) {
  const { installments, splits } = replay(schedule, payments, loan.late_fee_per_day || 0);
  const rows = installments.map((s) => {
    const cleared = s.cleared_on !== null;
    const waived = !!closure && !cleared;
    let penTotal;
    if (waived) penTotal = s.penalty_paid;
    else penTotal = lateFeeAccrued(loan.late_fee_per_day || 0, s.due_date, cleared ? s.cleared_on : asOf);
    const penRem = waived ? 0 : Math.max(0, penTotal - s.penalty_paid);
    const priRem = waived ? 0 : s.principal_due - s.principal_paid;
    const intRem = waived ? 0 : s.interest_due - s.interest_paid;
    const remaining = priRem + intRem + penRem;
    let status;
    if (waived) status = 'waived';
    else if (cleared && penRem === 0) status = 'paid';
    else if (cleared) status = 'penalty_due';
    else if (s.due_date < asOf) status = 'overdue';
    else if (s.due_date === asOf) status = 'due';
    else status = 'upcoming';
    const paidTotal = s.principal_paid + s.interest_paid + s.penalty_paid;
    return {
      seq: s.seq, due_date: s.due_date,
      principal_due: s.principal_due, interest_due: s.interest_due, emi: s.principal_due + s.interest_due,
      principal_paid: s.principal_paid, interest_paid: s.interest_paid, penalty_paid: s.penalty_paid,
      penalty: penTotal, penalty_remaining: penRem,
      principal_remaining: priRem, interest_remaining: intRem,
      remaining, paid_total: paidTotal, partial: paidTotal > 0 && remaining > 0,
      cleared_on: s.cleared_on, status,
    };
  });

  const active = rows.filter((r) => r.status !== 'waived');
  const open = active.filter((r) => r.remaining > 0);
  const overdueRows = open.filter((r) => r.due_date < asOf);
  const sum = (arr, k) => arr.reduce((t, r) => t + r[k], 0);

  return {
    kind: 'emi',
    rows,
    splits,
    principal_outstanding: closure ? 0 : sum(active, 'principal_remaining'),
    interest_remaining: sum(active, 'interest_remaining'),
    penalty_outstanding: sum(active, 'penalty_remaining'),
    total_remaining: sum(active, 'remaining'),
    due_now_amount: sum(open.filter((r) => r.due_date <= asOf), 'remaining'),
    overdue_amount: sum(overdueRows, 'remaining'),
    overdue_days: overdueRows.length ? diffDays(overdueRows[0].due_date, asOf) : 0,
    overdue_count: overdueRows.length,
    next_due: open.length ? { seq: open[0].seq, due_date: open[0].due_date, amount: open[0].remaining } : null,
    // A lump-sum foreclosure isn't split across individual instalments above, but it must
    // still count in the lifetime totals shown on the loan page - otherwise a loan closed
    // with no prior regular payments (foreclosed on day one) would show "paid: ₹0".
    totals: {
      principal_paid: sum(rows, 'principal_paid') + (closure ? closure.principal_settled || 0 : 0),
      interest_paid: sum(rows, 'interest_paid') + (closure ? closure.interest_settled || 0 : 0),
      penalty_paid: sum(rows, 'penalty_paid') + (closure ? closure.penalty_settled || 0 : 0),
    },
    fully_paid: !closure && open.length === 0,
    unallocated: [...splits.values()].reduce((t, s) => t + s.unallocated, 0),
  };
}

module.exports = { replay, summarizeEmi, lateFeeAccrued };

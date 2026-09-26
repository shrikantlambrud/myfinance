'use strict';
const { addMonths, diffDays } = require('./dates');
const { anchorDue } = require('./schedule');

const MAX_CYCLES = 1200; // 100 years of monthly cycles: a hard stop against runaway loops

/**
 * Interest-only loans have no stored schedule. Monthly "cycles" are derived from the
 * loan terms + payments, so a reversed payment can never leave stale rows behind.
 *
 *   cycle k starts on (k=1: start_date, else due date of cycle k-1) and is due on anchor + (k-1) months
 *   interest of a cycle = outstanding principal at the START of the cycle x rate% (a full month's interest)
 *   interest paid is applied to cycles oldest-first
 *
 * @param loan {principal, rate, start_date, first_due_date}  (paise, % per month)
 * @param payments non-reversed regular payments [{id, paid_on, principal_part, interest_part}] (paise)
 */
function summarizeInterestOnly(loan, payments, asOf, closure) {
  const anchor = anchorDue('interest_only', loan.start_date, loan.first_due_date);
  const principalPaidBy = (date) => payments.reduce((t, p) => (p.paid_on <= date ? t + p.principal_part : t), 0);
  const totalInterestPaid = payments.reduce((t, p) => t + p.interest_part, 0);
  const totalPrincipalPaid = payments.reduce((t, p) => t + p.principal_part, 0);
  const horizon = closure ? closure.closed_on : asOf;

  const cycles = [];
  let unpaid = totalInterestPaid;
  let prevDue = loan.start_date;
  for (let k = 1; k <= MAX_CYCLES; k++) {
    const start = prevDue;
    const due = addMonths(anchor, k - 1);
    const base = loan.principal - principalPaidBy(start);
    if (base <= 0) break;
    const interest = Math.round(base * (loan.rate / 100));
    const paid = Math.min(unpaid, interest);
    unpaid -= paid;
    cycles.push({ seq: k, start_date: start, due_date: due, principal_base: base, interest_due: interest, interest_paid: paid });
    prevDue = due;
    if (due > horizon && (paid < interest || interest === 0)) break;
  }

  // Once a loan is closed (foreclosed), every cycle that wasn't already cleared by a
  // regular payment is settled by that one lump-sum closure - whether its due date fell
  // before, on, or after the closing date. None of them are "overdue" or "due" any more.
  // (Matches how EMI loans treat every unpaid instalment as settled/waived on closure.)
  const rows = cycles.map((c) => {
    const remaining = c.interest_due - c.interest_paid;
    const cleared = remaining === 0;
    const waived = !!closure && !cleared;
    let status;
    if (waived) status = 'waived';
    else if (cleared) status = 'paid';
    else if (c.due_date < asOf) status = 'overdue';
    else if (c.due_date === asOf) status = 'due';
    else status = 'upcoming';
    return {
      seq: c.seq, start_date: c.start_date, due_date: c.due_date, principal_base: c.principal_base,
      principal_due: 0, interest_due: c.interest_due, emi: c.interest_due,
      principal_paid: 0, interest_paid: c.interest_paid, penalty_paid: 0, penalty: 0, penalty_remaining: 0,
      interest_remaining: waived ? 0 : remaining, principal_remaining: 0,
      remaining: waived ? 0 : remaining, paid_total: c.interest_paid,
      partial: c.interest_paid > 0 && remaining > 0 && !waived, cleared_on: null, status,
    };
  });

  const open = rows.filter((r) => r.status !== 'waived' && r.remaining > 0);
  const overdueRows = open.filter((r) => r.due_date < asOf);
  const sum = (arr, k) => arr.reduce((t, r) => t + r[k], 0);
  const principalOutstanding = closure ? 0 : loan.principal - totalPrincipalPaid;

  // Interest earned up to `asOf`: whole cycles that have fallen due + the elapsed part of the running cycle.
  let accrued = 0;
  for (const c of cycles) {
    if (c.due_date <= horizon) accrued += c.interest_due;
    else {
      const span = diffDays(c.start_date, c.due_date);
      const done = Math.max(0, diffDays(c.start_date, horizon));
      accrued += span > 0 ? Math.round((c.interest_due * Math.min(done, span)) / span) : 0;
      break;
    }
  }

  return {
    kind: 'interest_only',
    rows,
    splits: null,
    principal_outstanding: principalOutstanding,
    interest_remaining: sum(rows.filter((r) => r.status !== 'waived'), 'interest_remaining'),
    penalty_outstanding: 0,
    total_remaining: sum(open, 'remaining'),
    due_now_amount: sum(open.filter((r) => r.due_date <= asOf), 'remaining'),
    overdue_amount: sum(overdueRows, 'remaining'),
    overdue_days: overdueRows.length ? diffDays(overdueRows[0].due_date, asOf) : 0,
    overdue_count: overdueRows.length,
    next_due: open.length ? { seq: open[0].seq, due_date: open[0].due_date, amount: open[0].remaining } : null,
    // A lump-sum foreclosure payment isn't attributed to individual cycles above (that's not
    // meaningful for a single settlement), but it must still count in the lifetime totals shown
    // on the loan page - otherwise a loan closed with no prior regular payments shows "paid: ₹0".
    totals: {
      principal_paid: totalPrincipalPaid + (closure ? closure.principal_settled || 0 : 0),
      interest_paid: totalInterestPaid + (closure ? closure.interest_settled || 0 : 0),
      penalty_paid: closure ? closure.penalty_settled || 0 : 0,
    },
    // most interest that can be accepted now: everything listed (through the first future cycle)
    max_interest_payable: sum(rows.filter((r) => r.status !== 'waived'), 'interest_due') - totalInterestPaid,
    interest_accrued: accrued,
    fully_paid: false, // interest-only loans only close through foreclosure
    unallocated: 0,
  };
}

module.exports = { summarizeInterestOnly };

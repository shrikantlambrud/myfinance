'use strict';
const { summarizeEmi } = require('./emi');
const { summarizeInterestOnly } = require('./interestOnly');
const { buildSchedule, isEmi } = require('./schedule');
const { diffDays } = require('./dates');

/**
 * @param loan  engine loan (paise): {type, principal, rate, tenure, start_date, first_due_date,
 *              late_fee_per_day, foreclosure_charge_pct, foreclosure_interest_policy}
 * @param installments stored schedule (EMI only): [{seq, due_date, principal_due, interest_due}]
 * @param payments non-reversed REGULAR payments: [{id, paid_on, amount, principal_part, interest_part}]
 * @param closure null | {closed_on}
 */
function summarizeLoan(loan, installments, payments, asOf, closure = null) {
  if (isEmi(loan.type)) return summarizeEmi(loan, installments, payments, asOf, closure);
  return summarizeInterestOnly(loan, payments, asOf, closure);
}

/**
 * What it costs to close the loan on `asOf`.
 *   total = principal outstanding + interest payable + late fees + foreclosure charge
 * interest policy:
 *   'accrued' - only interest earned up to asOf (unpaid part of it). Interest prepaid beyond asOf is refunded (rebate).
 *   'full'    - every rupee of interest in the original schedule stays payable (no rebate).
 */
function foreclosureQuote(loan, installments, payments, asOf) {
  let s, interestAccrued;
  if (isEmi(loan.type)) {
    s = summarizeEmi(loan, installments, payments, asOf, null);
    if (loan.foreclosure_interest_policy === 'full') {
      interestAccrued = s.rows.reduce((t, r) => t + r.interest_due, 0);
    } else {
      interestAccrued = 0;
      s.rows.forEach((r, i) => {
        if (r.due_date <= asOf) { interestAccrued += r.interest_due; return; }
        const prev = i === 0 ? loan.start_date : s.rows[i - 1].due_date;
        if (prev < asOf) {
          const span = diffDays(prev, r.due_date);
          interestAccrued += span > 0 ? Math.round((r.interest_due * diffDays(prev, asOf)) / span) : 0;
        }
      });
    }
  } else {
    s = summarizeInterestOnly(loan, payments, asOf, null);
    interestAccrued = s.interest_accrued;
  }
  const principal = s.principal_outstanding;
  const interestPaid = s.totals.interest_paid;
  const interestPayable = interestAccrued - interestPaid; // negative = rebate for prepaid interest
  const penalty = s.penalty_outstanding;
  const charge = Math.round((principal * (loan.foreclosure_charge_pct || 0)) / 100);
  const raw = principal + interestPayable + penalty + charge;
  return {
    as_of: asOf,
    policy: loan.foreclosure_interest_policy || 'accrued',
    charge_pct: loan.foreclosure_charge_pct || 0,
    principal,
    interest_accrued: interestAccrued,
    interest_paid: interestPaid,
    interest_payable: interestPayable,
    penalty,
    charge,
    total: Math.max(0, raw),
    refund_due: raw < 0 ? -raw : 0,
  };
}

/**
 * Apply a discount (waiver) to a quote. Order: foreclosure charge, then late fees, then interest.
 * Principal can never be discounted.
 */
function applyDiscount(quote, discount) {
  let d = discount;
  const take = (amt) => { const t = Math.min(d, Math.max(0, amt)); d -= t; return t; };
  const charge = quote.charge - take(quote.charge);
  const penalty = quote.penalty - take(quote.penalty);
  const interest = quote.interest_payable > 0 ? quote.interest_payable - take(quote.interest_payable) : quote.interest_payable;
  if (d > 0) throw new Error('Discount is more than the interest, late fees and charges combined. Principal cannot be discounted.');
  const amount = Math.max(0, quote.principal + interest + penalty + charge);
  return { principal: quote.principal, interest, penalty, charge, amount };
}

module.exports = { summarizeLoan, foreclosureQuote, applyDiscount, buildSchedule, isEmi };

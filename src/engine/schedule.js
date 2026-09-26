'use strict';
const { evenSplit } = require('./money');
const { addDays, addMonths } = require('./dates');

const isEmi = (type) => type === 'emi_monthly' || type === 'emi_daily';

// Anchor for due dates. Monthly EMI / interest cycles: one month after disbursal unless overridden.
// Daily EMI: the day after disbursal unless overridden.
function anchorDue(type, startDate, firstDueDate) {
  if (firstDueDate) return firstDueDate;
  return type === 'emi_daily' ? addDays(startDate, 1) : addMonths(startDate, 1);
}
function dueDateFor(type, anchor, k) { // k is 1-based
  return type === 'emi_daily' ? addDays(anchor, k - 1) : addMonths(anchor, k - 1);
}

/**
 * Build the fixed repayment schedule for an EMI loan. All money in integer paise.
 * @param {{type:string, method:'flat'|'reducing', principal:number, rate:number, tenure:number,
 *          fixedInstallment?:number|null, startDate:string, firstDueDate?:string|null}} p
 * @returns {{installments:Array, totalInterest:number, totalPayable:number, installment:number, effectiveRate:number}}
 *   effectiveRate = interest as a flat % of principal per period (per month or per day)
 */
function buildSchedule(p) {
  if (!isEmi(p.type)) throw new Error('buildSchedule is only for EMI loans');
  const n = p.tenure;
  const P = p.principal;
  if (!Number.isInteger(n) || n < 1) throw new Error('Tenure must be a whole number of at least 1');
  if (!Number.isInteger(P) || P <= 0) throw new Error('Principal must be positive');
  if (p.method === 'reducing' && p.type !== 'emi_monthly') throw new Error('Reducing balance is only available for monthly EMI');

  const anchor = anchorDue(p.type, p.startDate, p.firstDueDate);
  const principals = evenSplit(P, n);
  let rows; // [{principal_due, interest_due}]

  if (p.fixedInstallment) {
    const total = p.fixedInstallment * n;
    if (total < P) throw new Error('Fixed EMI x tenure is less than the loan amount');
    rows = principals.map((pr) => ({ principal_due: pr, interest_due: p.fixedInstallment - pr }));
  } else if (p.method === 'reducing') {
    const r = p.rate / 100;
    const emi = r === 0 ? Math.round(P / n)
      : Math.round((P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
    let bal = P;
    rows = [];
    for (let k = 1; k <= n; k++) {
      const interest = Math.round(bal * r);
      let pr = emi - interest;
      if (k === n || pr > bal) pr = bal;
      if (pr < 0) pr = 0;
      rows.push({ principal_due: pr, interest_due: interest });
      bal -= pr;
    }
  } else {
    const totalInterest = Math.round(P * (p.rate / 100) * n);
    const emis = evenSplit(P + totalInterest, n);
    rows = principals.map((pr, i) => ({ principal_due: pr, interest_due: emis[i] - pr }));
  }

  const installments = rows.map((r, i) => ({
    seq: i + 1,
    due_date: dueDateFor(p.type, anchor, i + 1),
    principal_due: r.principal_due,
    interest_due: r.interest_due,
  }));
  const totalInterest = installments.reduce((s, r) => s + r.interest_due, 0);
  return {
    installments,
    totalInterest,
    totalPayable: P + totalInterest,
    installment: installments[0].principal_due + installments[0].interest_due,
    effectiveRate: Math.round((totalInterest / (P * n)) * 100 * 10000) / 10000,
  };
}

module.exports = { buildSchedule, anchorDue, dueDateFor, isEmi };

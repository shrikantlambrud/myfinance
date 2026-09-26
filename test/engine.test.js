'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchedule } = require('../src/engine/schedule');
const { summarizeLoan, foreclosureQuote, applyDiscount } = require('../src/engine');
const { addMonths, addDays, diffDays, isISODate } = require('../src/engine/dates');
const { evenSplit, toPaise } = require('../src/engine/money');

const R = (rupees) => Math.round(rupees * 100);
const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);

function emiLoan(over = {}) {
  return {
    type: 'emi_monthly', principal: R(12000), rate: 2, tenure: 12, start_date: '2026-01-10', first_due_date: null,
    late_fee_per_day: 0, foreclosure_charge_pct: 0, foreclosure_interest_policy: 'accrued', ...over,
  };
}
function sched(loan, method = 'flat', fixed = null) {
  return buildSchedule({
    type: loan.type, method, principal: loan.principal, rate: loan.rate, tenure: loan.tenure,
    fixedInstallment: fixed, startDate: loan.start_date, firstDueDate: loan.first_due_date,
  });
}
const pay = (id, paid_on, rupees) => ({ id, paid_on, amount: R(rupees), principal_part: 0, interest_part: 0 });

test('dates: month-end clamping does not drift', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(addMonths('2026-12-10', 1), '2027-01-10');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(diffDays('2026-01-01', '2026-03-01'), 59);
  assert.ok(isISODate('2028-02-29'));
  assert.ok(!isISODate('2026-02-29'));
  assert.ok(!isISODate('2026-13-01'));
});

test('evenSplit adds up exactly and is monotone in the total', () => {
  assert.deepEqual(evenSplit(10, 3), [4, 3, 3]);
  for (let total = 0; total < 200; total++) {
    const a = evenSplit(total, 7);
    assert.equal(a.reduce((x, y) => x + y, 0), total);
    const b = evenSplit(total + 1, 7);
    a.forEach((v, i) => assert.ok(b[i] >= v));
  }
});

test('flat monthly EMI: 10,000 @ 3%/month for 10 months = 1,300 x 10', () => {
  const loan = emiLoan({ principal: R(10000), rate: 3, tenure: 10 });
  const s = sched(loan);
  assert.equal(s.totalInterest, R(3000));
  assert.equal(s.totalPayable, R(13000));
  assert.equal(s.installments.length, 10);
  s.installments.forEach((i) => assert.equal(i.principal_due + i.interest_due, R(1300)));
  assert.equal(s.installments[0].due_date, '2026-02-10');
  assert.equal(s.installments[9].due_date, '2026-11-10');
  assert.equal(sum(s.installments, 'principal_due'), R(10000));
  assert.equal(s.effectiveRate, 3);
});

test('flat EMI with awkward rounding still adds up to the paisa and never has negative interest', () => {
  for (const [p, r, n] of [[10000, 2.5, 7], [33333.33, 1.7, 11], [1000.01, 0.03, 3], [50000, 0, 6], [999.99, 4.99, 13]]) {
    const loan = emiLoan({ principal: R(p), rate: r, tenure: n });
    const s = sched(loan);
    assert.equal(sum(s.installments, 'principal_due'), R(p));
    assert.equal(s.totalPayable, R(p) + Math.round(R(p) * (r / 100) * n));
    s.installments.forEach((i) => assert.ok(i.interest_due >= 0, `negative interest for ${p}/${r}/${n}`));
    // installments differ by at most one paisa
    const emis = s.installments.map((i) => i.principal_due + i.interest_due);
    assert.ok(Math.max(...emis) - Math.min(...emis) <= 1);
  }
});

test('fixed EMI: 2,000 x 6 on 10,000 -> interest 2,000; rejects total below principal', () => {
  const loan = emiLoan({ principal: R(10000), tenure: 6 });
  const s = sched(loan, 'flat', R(2000));
  assert.equal(s.totalInterest, R(2000));
  assert.equal(sum(s.installments, 'principal_due'), R(10000));
  assert.throws(() => sched(loan, 'flat', R(1600)), /less than the loan amount/);
});

test('reducing balance: 1,00,000 @ 2%/month for 12 months -> EMI 9,455.96, principal fully repaid', () => {
  const loan = emiLoan({ principal: R(100000), rate: 2, tenure: 12 });
  const s = sched(loan, 'reducing');
  assert.equal(s.installments[0].principal_due + s.installments[0].interest_due, R(9455.96));
  assert.equal(sum(s.installments, 'principal_due'), R(100000));
  assert.equal(s.installments[0].interest_due, R(2000)); // 2% of full balance
  assert.ok(s.installments[11].interest_due < s.installments[0].interest_due);
  assert.throws(() => buildSchedule({ ...{ type: 'emi_daily', method: 'reducing', principal: 100, rate: 1, tenure: 5, startDate: '2026-01-01' } }), /monthly/);
});

test('daily EMI: 10,000 @ 0.2%/day for 100 days = 120 per day, due dates are consecutive days', () => {
  const loan = emiLoan({ type: 'emi_daily', principal: R(10000), rate: 0.2, tenure: 100 });
  const s = sched(loan);
  assert.equal(s.totalInterest, R(2000));
  assert.equal(s.installment, R(120));
  assert.equal(s.installments[0].due_date, '2026-01-11');
  assert.equal(s.installments[99].due_date, '2026-04-20');
});

test('custom first due date is respected', () => {
  const loan = emiLoan({ first_due_date: '2026-02-05', tenure: 3, principal: R(3000), rate: 1 });
  const s = sched(loan);
  assert.deepEqual(s.installments.map((i) => i.due_date), ['2026-02-05', '2026-03-05', '2026-04-05']);
});

test('payments: exact EMI clears an installment, partial pay goes interest first, extra rolls forward', () => {
  const loan = emiLoan(); // 12000 @2% x12 -> EMI 1240 (1000 principal + 240 interest)
  const s = sched(loan);
  let r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-10', 1240)], '2026-02-10');
  assert.equal(r.rows[0].status, 'paid');
  assert.equal(r.rows[1].status, 'upcoming');
  assert.equal(r.principal_outstanding, R(11000));
  assert.equal(r.next_due.seq, 2);

  // partial: 300 -> 240 interest + 60 principal
  r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-10', 300)], '2026-02-10');
  assert.equal(r.rows[0].interest_paid, R(240));
  assert.equal(r.rows[0].principal_paid, R(60));
  assert.equal(r.rows[0].partial, true);
  assert.equal(r.splits.get(1).interest, R(240));
  assert.equal(r.splits.get(1).principal, R(60));

  // 2,000 pays installment 1 fully and 760 of installment 2
  r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-10', 2000)], '2026-02-10');
  assert.equal(r.rows[0].status, 'paid');
  assert.equal(r.rows[1].paid_total, R(760));
  assert.equal(r.unallocated, 0);
});

test('paying more than the whole schedule leaves an unallocated amount (service rejects it)', () => {
  const loan = emiLoan({ tenure: 2, principal: R(2000), rate: 1 }); // total 2040
  const s = sched(loan);
  const r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-10', 2100)], '2026-02-10');
  assert.equal(r.unallocated, R(60));
  assert.equal(r.fully_paid, true);
});

test('reversal = replay without the payment: schedule reopens', () => {
  const loan = emiLoan();
  const s = sched(loan);
  const both = [pay(1, '2026-02-10', 1240), pay(2, '2026-03-10', 1240)];
  assert.equal(summarizeLoan(loan, s.installments, both, '2026-03-10').rows[1].status, 'paid');
  const after = summarizeLoan(loan, s.installments, [both[1]], '2026-03-10');
  // payment 2 now lands on installment 1 instead
  assert.equal(after.rows[0].status, 'paid');
  assert.equal(after.rows[1].status, 'due');
});

test('overdue tracking: days, amount, due-now', () => {
  const loan = emiLoan();
  const s = sched(loan);
  const r = summarizeLoan(loan, s.installments, [], '2026-04-15'); // due Feb10, Mar10, Apr10 all missed
  assert.equal(r.overdue_count, 3);
  assert.equal(r.overdue_days, diffDays('2026-02-10', '2026-04-15'));
  assert.equal(r.overdue_amount, R(1240 * 3));
  assert.equal(r.due_now_amount, R(1240 * 3));
  assert.equal(r.next_due.seq, 1);
  assert.equal(r.rows[0].status, 'overdue');
  assert.equal(r.rows[3].status, 'upcoming');
});

test('late fee: 50/day for 5 days late is taken before interest and principal', () => {
  const loan = emiLoan({ late_fee_per_day: R(50) });
  const s = sched(loan);
  const r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-15', 1240)], '2026-02-15');
  assert.equal(r.splits.get(1).penalty, R(250));
  assert.equal(r.splits.get(1).interest, R(240));
  assert.equal(r.splits.get(1).principal, R(750));
  assert.equal(r.rows[0].status, 'overdue'); // 250 of principal still unpaid
  // the fee keeps growing until the instalment is cleared: on the 20th it is 500 (250 already paid)
  const r2 = summarizeLoan(loan, s.installments, [pay(1, '2026-02-15', 1240), pay(2, '2026-02-20', 500)], '2026-02-20');
  assert.equal(r2.splits.get(2).penalty, R(250));
  assert.equal(r2.splits.get(2).principal, R(250));
  assert.equal(r2.rows[0].cleared_on, '2026-02-20');
  assert.equal(r2.rows[0].penalty, R(500));
  assert.equal(r2.rows[0].penalty_remaining, 0);
  assert.equal(r2.rows[0].status, 'paid');
  // once cleared, later dates do not add more fee
  const r3 = summarizeLoan(loan, s.installments, [pay(1, '2026-02-15', 1240), pay(2, '2026-02-20', 500)], '2026-06-01');
  assert.equal(r3.rows[0].penalty, R(500));
});

test('foreclosure (accrued policy): 3 EMIs paid, closing on 4th due date', () => {
  const loan = emiLoan(); // 12000 @2% x 12: 1000 principal + 240 interest per month
  const s = sched(loan);
  const paid = [pay(1, '2026-02-10', 1240), pay(2, '2026-03-10', 1240), pay(3, '2026-04-10', 1240)];
  const q = foreclosureQuote(loan, s.installments, paid, '2026-05-10');
  assert.equal(q.principal, R(9000));
  assert.equal(q.interest_accrued, R(960));   // 4 months
  assert.equal(q.interest_paid, R(720));
  assert.equal(q.interest_payable, R(240));   // 4th month interest not yet paid
  assert.equal(q.total, R(9240));
});

test('foreclosure: charge %, full-interest policy, pro-rata mid-period, prepaid rebate', () => {
  const s = sched(emiLoan());
  const paid = [pay(1, '2026-02-10', 1240), pay(2, '2026-03-10', 1240), pay(3, '2026-04-10', 1240)];

  const withCharge = emiLoan({ foreclosure_charge_pct: 2 });
  assert.equal(foreclosureQuote(withCharge, s.installments, paid, '2026-05-10').total, R(9240 + 180));

  const full = emiLoan({ foreclosure_interest_policy: 'full' });
  const qf = foreclosureQuote(full, s.installments, paid, '2026-05-10');
  assert.equal(qf.interest_payable, R(2880 - 720));
  assert.equal(qf.total, R(9000 + 2160));

  // mid-period: Apr 25 is 15 of 30 days into the May-10 instalment -> half of 240
  const mid = foreclosureQuote(emiLoan(), s.installments, paid, '2026-04-25');
  assert.equal(mid.interest_accrued, R(720 + 240 * 15 / 30));
  assert.equal(mid.interest_payable, R(120));

  // customer prepaid 6 installments up front; closing early on Mar 10 refunds unearned interest
  const prepaid = [pay(1, '2026-02-10', 1240 * 6)];
  const qr = foreclosureQuote(emiLoan(), s.installments, prepaid, '2026-03-10');
  assert.equal(qr.principal, R(6000));
  assert.equal(qr.interest_accrued, R(240 * 2));
  assert.equal(qr.interest_payable, R(480 - 1440));
  assert.equal(qr.total, R(6000 - 960));
});

test('foreclosure includes unpaid late fees; discount waives charge, then late fee, then interest', () => {
  const loan = emiLoan({ late_fee_per_day: R(10), foreclosure_charge_pct: 1 });
  const s = sched(loan);
  const q = foreclosureQuote(loan, s.installments, [], '2026-02-20'); // 10 days late on inst 1
  assert.equal(q.penalty, R(100));
  assert.equal(q.principal, R(12000));
  assert.equal(q.charge, R(120));
  const accrued = R(240) + Math.round(R(240) * 10 / 28); // inst 1 in full + 10/28 of inst 2
  assert.equal(q.interest_payable, accrued);
  assert.equal(q.total, R(12000 + 100 + 120) + accrued);

  const d1 = applyDiscount(q, R(150));
  assert.equal(d1.charge, 0); assert.equal(d1.penalty, R(70)); assert.equal(d1.interest, accrued);
  assert.equal(d1.amount, q.total - R(150));
  const d2 = applyDiscount(q, R(400));
  assert.equal(d2.charge, 0); assert.equal(d2.penalty, 0); assert.equal(d2.interest, accrued - R(180));
  assert.throws(() => applyDiscount(q, R(600)), /Principal cannot be discounted/);
});

test('interest-only: monthly cycles, overdue tracking, principal part lowers next cycle', () => {
  const loan = { type: 'interest_only', principal: R(50000), rate: 2, start_date: '2026-01-10', first_due_date: null,
    foreclosure_charge_pct: 0, foreclosure_interest_policy: 'accrued' };
  let r = summarizeLoan(loan, [], [], '2026-03-15');
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((x) => x.due_date), ['2026-02-10', '2026-03-10', '2026-04-10']);
  assert.equal(r.overdue_count, 2);
  assert.equal(r.overdue_amount, R(2000));
  assert.equal(r.overdue_days, diffDays('2026-02-10', '2026-03-15'));

  // Feb 10: pay 1000 interest. Mar 10: pay 1000 interest + 10,000 principal
  const pays = [
    { id: 1, paid_on: '2026-02-10', amount: R(1000), principal_part: 0, interest_part: R(1000) },
    { id: 2, paid_on: '2026-03-10', amount: R(11000), principal_part: R(10000), interest_part: R(1000) },
  ];
  r = summarizeLoan(loan, [], pays, '2026-03-15');
  assert.equal(r.overdue_count, 0);
  assert.equal(r.principal_outstanding, R(40000));
  assert.equal(r.rows[2].due_date, '2026-04-10');
  assert.equal(r.rows[2].interest_due, R(800)); // 2% of 40,000
  assert.equal(r.next_due.amount, R(800));
  assert.equal(r.status, undefined);
});

test('interest-only: partial interest payment leaves the cycle open; prepayment covers next cycle', () => {
  const loan = { type: 'interest_only', principal: R(30000), rate: 3, start_date: '2026-01-31', first_due_date: null };
  const partial = [{ id: 1, paid_on: '2026-02-28', amount: R(500), principal_part: 0, interest_part: R(500) }];
  let r = summarizeLoan(loan, [], partial, '2026-02-28');
  assert.equal(r.rows[0].due_date, '2026-02-28');
  assert.equal(r.rows[0].interest_remaining, R(400)); // 900 due, 500 paid
  assert.equal(r.rows[0].partial, true);
  const prepay = [{ id: 1, paid_on: '2026-02-01', amount: R(1800), principal_part: 0, interest_part: R(1800) }];
  r = summarizeLoan(loan, [], prepay, '2026-02-01');
  assert.equal(r.rows[0].status, 'paid');
  assert.equal(r.rows[1].status, 'paid');
  assert.equal(r.next_due.seq, 3);
});

test('interest-only foreclosure: accrued interest is pro-rated for the running month', () => {
  const loan = { type: 'interest_only', principal: R(50000), rate: 2, start_date: '2026-01-10', first_due_date: null,
    foreclosure_charge_pct: 0, foreclosure_interest_policy: 'accrued' };
  const paid = [{ id: 1, paid_on: '2026-02-10', amount: R(1000), principal_part: 0, interest_part: R(1000) }];
  const q = foreclosureQuote(loan, [], paid, '2026-03-25');
  // cycles 1 & 2 fully accrued (2000) + 15/31 of 1000 for the running cycle
  assert.equal(q.interest_accrued, R(2000) + Math.round(R(1000) * 15 / 31));
  assert.equal(q.interest_payable, q.interest_accrued - R(1000));
  assert.equal(q.principal, R(50000));
  assert.equal(q.total, q.principal + q.interest_payable);
});

test('interest-only loan foreclosed with ZERO prior payments: schedule and totals both reflect the lump sum (regression)', () => {
  // Loan given 5 Aug, foreclosed 5 Oct with no regular payments beforehand - the exact
  // shape that exposed the "Overdue"/"Due today" + "Total paid ₹0" display bug.
  const loan = { type: 'interest_only', principal: R(50000), rate: 3, start_date: '2026-08-05', first_due_date: null,
    foreclosure_charge_pct: 0, foreclosure_interest_policy: 'accrued' };
  const q = foreclosureQuote(loan, [], [], '2026-10-05');
  assert.equal(q.total, R(53000)); // 50,000 principal + 2 months x 1,500 interest
  const closure = { closed_on: '2026-10-05', principal_settled: q.principal, interest_settled: q.interest_payable, penalty_settled: 0 };
  const s = summarizeLoan(loan, [], [], '2026-10-05', closure);
  // every cycle up to and including the closing date must show as settled, never overdue/due
  s.rows.forEach((r) => assert.equal(r.status, 'waived', `seq ${r.seq} due ${r.due_date} should be waived, got ${r.status}`));
  assert.equal(s.overdue_amount, 0);
  assert.equal(s.due_now_amount, 0);
  assert.equal(s.next_due, null);
  // the lump-sum foreclosure must still show up in lifetime totals, not ₹0
  assert.equal(s.totals.principal_paid, R(50000));
  assert.equal(s.totals.interest_paid, R(3000));
});

test('closure marks unpaid EMI installments as waived and zeroes the outstanding', () => {
  const loan = emiLoan({ tenure: 3, principal: R(3000), rate: 1 });
  const s = sched(loan);
  const r = summarizeLoan(loan, s.installments, [pay(1, '2026-02-10', 1030)], '2026-02-20', { closed_on: '2026-02-20' });
  assert.deepEqual(r.rows.map((x) => x.status), ['paid', 'waived', 'waived']);
  assert.equal(r.principal_outstanding, 0);
  assert.equal(r.next_due, null);
  assert.equal(r.overdue_amount, 0);
});

test('toPaise handles float noise', () => {
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(toPaise(19.99), 1999);
  assert.equal(toPaise('1234.5'), 123450);
  assert.equal(toPaise(null), 0);
});

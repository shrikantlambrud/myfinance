'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/harness');

let h, owner, staff;

test.before(async () => {
  h = await start({ today: '2026-03-15' });
  await h.addUser('owner1', 'owner');
  await h.addUser('staff1', 'staff');
  owner = await h.login('owner1');
  staff = await h.login('staff1');
});
test.after(async () => { await h.close(); });

const cashOf = async () => (await h.req('GET', '/api/ledger', undefined, owner)).data.cash;
let loanA, loanB, payA1, payA2;

test('auth: rejects missing/invalid tokens, wrong passwords, and locks after repeated failures', async () => {
  assert.equal((await h.req('GET', '/api/dashboard')).status, 401);
  assert.equal((await h.req('GET', '/api/dashboard', undefined, 'garbage.token.here')).status, 401);
  await h.addUser('victim', 'staff');
  for (let i = 0; i < 5; i++) assert.equal((await h.req('POST', '/api/auth/login', { username: 'victim', password: 'nope-nope' })).status, 401);
  const locked = await h.req('POST', '/api/auth/login', { username: 'victim', password: 'Password123' });
  assert.equal(locked.status, 429);
  const me = await h.req('GET', '/api/auth/me', undefined, owner);
  assert.equal(me.data.user.role, 'owner');
});

test('roles: staff cannot see owner-only areas', async () => {
  assert.equal((await h.req('GET', '/api/ledger', undefined, staff)).status, 403);
  assert.equal((await h.req('GET', '/api/users', undefined, staff)).status, 403);
  assert.equal((await h.req('GET', '/api/investments', undefined, staff)).status, 403);
  assert.equal((await h.req('GET', '/api/reports/summary', undefined, staff)).status, 403);
  assert.equal((await h.req('GET', '/api/dashboard', undefined, staff)).status, 200);
});

test('capital: owner adds capital; cash reflects it', async () => {
  const r = await h.req('POST', '/api/ledger', { kind: 'capital_in', entry_date: '2026-01-01', amount: 500000, note: 'Opening' }, owner);
  assert.equal(r.status, 201);
  assert.equal(await cashOf(), 500000);
  const bad = await h.req('POST', '/api/ledger', { kind: 'capital_in', entry_date: '2027-01-01', amount: 10 }, owner);
  assert.equal(bad.status, 400);
});

test('loan preview returns schedule; validation errors name the field', async () => {
  const p = await h.req('POST', '/api/loans/preview', { type: 'emi_monthly', principal: 12000, rate: 2, tenure: 12, start_date: '2026-01-10' }, staff);
  assert.equal(p.status, 200);
  assert.equal(p.data.installment, 1240);
  assert.equal(p.data.total_interest, 2880);
  assert.equal(p.data.schedule.length, 12);
  const bad = await h.req('POST', '/api/loans/preview', { type: 'emi_monthly', principal: 12000, rate: 90, tenure: 100, start_date: '2026-01-10' }, staff);
  assert.equal(bad.status, 400);
  const noTenure = await h.req('POST', '/api/loans/preview', { type: 'emi_monthly', principal: 12000, rate: 2, start_date: '2026-01-10' }, staff);
  assert.ok(noTenure.data.fields.tenure);
});

test('create EMI loan with a new customer: schedule saved, cash out = principal - fee', async () => {
  const r = await h.req('POST', '/api/loans', {
    new_party: { name: 'Ramesh Patil', phone: '9876543210', address: 'Pune' },
    type: 'emi_monthly', principal: 12000, processing_fee: 200, rate: 2, tenure: 12, start_date: '2026-01-10',
  }, staff);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  loanA = r.data.id;
  const d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(d.loan.loan_no, 'LN' + String(loanA).padStart(6, '0'));
  assert.equal(d.schedule.length, 12);
  assert.equal(d.schedule[0].emi, 1240);
  assert.equal(d.loan.net_disbursed, 11800);
  assert.equal(d.loan.total_payable, 14880);
  assert.equal(d.summary.overdue_amount, 2480); // Feb 10 and Mar 10 unpaid as of Mar 15
  assert.equal(await cashOf(), 500000 - 11800);
});

test('low cash needs explicit confirmation', async () => {
  const body = { party_id: 1, type: 'interest_only', principal: 900000, rate: 2, start_date: '2026-03-01' };
  const r = await h.req('POST', '/api/loans', body, staff);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'LOW_CASH');
  assert.equal(r.data.available, 488200);
});

test('payments: exact EMI clears an instalment and adds to cash; bad amounts/dates are rejected', async () => {
  const before = await cashOf();
  const r1 = await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 1240, paid_on: '2026-02-10', pay_mode: 'upi', ref_no: 'UTR1' }, staff);
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  payA1 = r1.data.id;
  const r2 = await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 1240, paid_on: '2026-03-10' }, staff);
  payA2 = r2.data.id;
  assert.equal(await cashOf(), before + 2480);
  const d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.deepEqual(d.schedule.slice(0, 3).map((s) => s.status), ['paid', 'paid', 'upcoming']);
  assert.equal(d.summary.overdue_amount, 0);
  assert.equal(d.loan.principal_outstanding, 10000);
  const p = d.payments.find((x) => x.id === payA1);
  assert.equal(p.receipt_no, 'RC' + String(payA1).padStart(6, '0'));
  assert.equal(p.interest_part, 240);
  assert.equal(p.principal_part, 1000);

  assert.equal((await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 100, paid_on: '2026-04-01' }, staff)).status, 400);
  assert.equal((await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 100, paid_on: '2025-12-01' }, staff)).status, 400);
  const tooMuch = await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 99999, paid_on: '2026-03-15' }, staff);
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.error, /more than the remaining balance/);
  // nothing was saved by the failed attempt
  assert.equal(await cashOf(), before + 2480);
  assert.equal((await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data.payments.length, 2);
});

test('receipt data', async () => {
  const r = await h.req('GET', `/api/payments/${payA1}`, undefined, staff);
  assert.equal(r.data.receipt.party_name, 'Ramesh Patil');
  assert.equal(r.data.receipt.amount, 1240);
  assert.equal(r.data.business.name, 'MyFinance');
});

test('reverse payment: owner only, needs a reason, restores cash and reopens the instalment', async () => {
  assert.equal((await h.req('POST', `/api/payments/${payA2}/reverse`, { reason: 'wrong entry' }, staff)).status, 403);
  assert.equal((await h.req('POST', `/api/payments/${payA2}/reverse`, {}, owner)).status, 400);
  const before = await cashOf();
  assert.equal((await h.req('POST', `/api/payments/${payA2}/reverse`, { reason: 'Entered twice by mistake' }, owner)).status, 200);
  assert.equal(await cashOf(), before - 1240);
  let d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(d.schedule[1].status, 'overdue');
  assert.equal(d.loan.principal_outstanding, 11000);
  assert.equal((await h.req('POST', `/api/payments/${payA2}/reverse`, { reason: 'again' }, owner)).status, 400);
  // put it back
  const again = await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 1240, paid_on: '2026-03-10' }, staff);
  assert.equal(again.status, 201);
  payA2 = again.data.id;
  d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(d.loan.principal_outstanding, 10000);
  assert.ok(d.audit.length >= 1);
});

test('interest-only loan: cycles, interest/principal split, rules around closing', async () => {
  const c = await h.req('POST', '/api/loans', {
    new_party: { name: 'Sunita Jadhav', phone: '9000000001' },
    type: 'interest_only', principal: 50000, rate: 2, start_date: '2026-01-10',
  }, staff);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  loanB = c.data.id;
  let d = (await h.req('GET', `/api/loans/${loanB}`, undefined, staff)).data;
  assert.equal(d.summary.overdue_amount, 2000);
  assert.equal(d.schedule.length, 3);

  assert.equal((await h.req('POST', `/api/loans/${loanB}/payments`, { amount: 1000, paid_on: '2026-02-10' }, staff)).status, 201);
  const p2 = await h.req('POST', `/api/loans/${loanB}/payments`, { amount: 11000, principal_amount: 10000, paid_on: '2026-03-10' }, staff);
  assert.equal(p2.status, 201, JSON.stringify(p2.data));
  d = (await h.req('GET', `/api/loans/${loanB}`, undefined, staff)).data;
  assert.equal(d.summary.overdue_amount, 0);
  assert.equal(d.loan.principal_outstanding, 40000);
  assert.equal(d.summary.next_due.amount, 800);

  const closeViaPayment = await h.req('POST', `/api/loans/${loanB}/payments`, { amount: 40800, principal_amount: 40000, paid_on: '2026-03-15' }, staff);
  assert.equal(closeViaPayment.status, 400);
  assert.match(closeViaPayment.data.error, /Foreclose/);
  const tooMuchInterest = await h.req('POST', `/api/loans/${loanB}/payments`, { amount: 5000, paid_on: '2026-03-15' }, staff);
  assert.equal(tooMuchInterest.status, 400);
});

test('collections list: shows who to collect from and totals', async () => {
  // Ramesh has next EMI on Apr 10 (not due on Mar 15); Sunita's next interest is Apr 10 too
  let c = (await h.req('GET', '/api/collections', undefined, staff)).data;
  assert.equal(c.due.length, 0);
  c = (await h.req('GET', '/api/collections?date=2026-04-12', undefined, staff)).data;
  assert.equal(c.due.length, 2);
  assert.equal(c.due[0].overdue_days, 2);
  assert.ok(c.totals.due_now > 0);
  const today = (await h.req('GET', '/api/collections?date=2026-03-10', undefined, staff)).data;
  assert.equal(today.totals.collected_today, 12240); // 1,240 EMI + 11,000 (interest + principal)
});

test('foreclosure quote for the EMI loan (accrued policy)', async () => {
  const q = (await h.req('GET', `/api/loans/${loanA}/foreclosure-quote`, undefined, staff)).data;
  assert.equal(q.principal, 10000);
  assert.equal(q.interest_paid, 480);
  assert.equal(q.interest_accrued, 518.71); // 2 months + 5/31 of the third
  assert.equal(q.total, 10038.71);
});

test('foreclose: staff cannot discount; exact quote settles the loan, cash comes in, schedule is waived', async () => {
  const noDiscount = await h.req('POST', `/api/loans/${loanA}/foreclose`, { discount: 38.71 }, staff);
  assert.equal(noDiscount.status, 403);
  const before = await cashOf();
  const r = await h.req('POST', `/api/loans/${loanA}/foreclose`, { pay_mode: 'cash', note: 'Customer closing early' }, staff);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, 10038.71);
  assert.equal(await cashOf(), before + 10038.71);
  const d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(d.loan.status, 'foreclosed');
  assert.equal(d.loan.principal_outstanding, 0);
  assert.equal(d.closure.amount_received, 10038.71);
  assert.equal(d.schedule[5].status, 'waived');
  assert.equal(d.quote, null);
  assert.equal((await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 100 }, staff)).status, 400);
  assert.equal((await h.req('POST', `/api/loans/${loanA}/foreclose`, {}, staff)).status, 400);
});

test('reopen (owner): undoes the foreclosure including the cash', async () => {
  assert.equal((await h.req('POST', `/api/loans/${loanA}/reopen`, {}, staff)).status, 403);
  const before = await cashOf();
  assert.equal((await h.req('POST', `/api/loans/${loanA}/reopen`, {}, owner)).status, 200);
  assert.equal(await cashOf(), before - 10038.71);
  const d = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(d.loan.status, 'active');
  assert.equal(d.loan.principal_outstanding, 10000);
  assert.equal(d.schedule[5].status, 'upcoming');
});

test('foreclosure with owner discount: waiver comes off interest, principal is never discounted', async () => {
  const r = await h.req('POST', `/api/loans/${loanB}/foreclose`, { discount: 100000 }, owner);
  assert.equal(r.status, 400);
  const q = (await h.req('GET', `/api/loans/${loanB}/foreclosure-quote`, undefined, owner)).data;
  assert.equal(q.principal, 40000);
  const ok = await h.req('POST', `/api/loans/${loanB}/foreclose`, { discount: 100 }, owner);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.received, Math.round((q.total - 100) * 100) / 100);
  const d = (await h.req('GET', `/api/loans/${loanB}`, undefined, owner)).data;
  assert.equal(d.loan.status, 'foreclosed');
  assert.equal(d.closure.discount, 100);
});

test('customer portal: own loans only', async () => {
  const cust = (await h.req('GET', '/api/parties?q=Ramesh', undefined, staff)).data.parties[0];
  const access = await h.req('POST', `/api/parties/${cust.id}/portal-access`, {}, staff);
  assert.equal(access.status, 200, JSON.stringify(access.data));
  assert.equal(access.data.username, '9876543210');
  const token = await h.login(access.data.username, access.data.temporary_password);
  assert.ok(token);

  const me = (await h.req('GET', '/api/portal/me', undefined, token)).data;
  assert.equal(me.customer.name, 'Ramesh Patil');
  assert.equal(me.totals.active_loans, 1);
  assert.equal(me.totals.principal_outstanding, 10000);
  assert.equal(me.totals.next_due.amount, 1240);

  const loans = (await h.req('GET', '/api/portal/loans', undefined, token)).data.loans;
  assert.equal(loans.length, 1);
  assert.equal(loans[0].id, loanA);
  const detail = (await h.req('GET', `/api/portal/loans/${loanA}`, undefined, token)).data;
  assert.equal(detail.schedule.length, 12);
  assert.equal(detail.payments.length, 2);
  assert.equal(detail.audit, undefined);
  assert.equal(detail.loan.note, undefined);
  assert.equal((await h.req('GET', `/api/portal/loans/${loanB}`, undefined, token)).status, 404);
  assert.equal((await h.req('GET', `/api/portal/loans/${loanA}/foreclosure-quote`, undefined, token)).status, 200);

  // customers cannot use the staff API
  for (const url of ['/api/loans', '/api/parties', '/api/dashboard', '/api/collections']) {
    assert.equal((await h.req('GET', url, undefined, token)).status, 403, url);
  }
  assert.equal((await h.req('POST', `/api/loans/${loanA}/payments`, { amount: 10 }, token)).status, 403);
  // staff tokens cannot use the portal
  assert.equal((await h.req('GET', '/api/portal/me', undefined, staff)).status, 403);
});

test('change password invalidates old tokens', async () => {
  await h.addUser('temp1', 'staff', 'OldPassword1');
  const t = await h.login('temp1', 'OldPassword1');
  const r = await h.req('POST', '/api/auth/change-password', { current_password: 'OldPassword1', new_password: 'NewPassword2' }, t);
  assert.equal(r.status, 200);
  assert.equal((await h.req('GET', '/api/auth/me', undefined, t)).status, 401);
  assert.equal((await h.req('GET', '/api/auth/me', undefined, r.data.token)).status, 200);
  assert.ok(await h.login('temp1', 'NewPassword2'));
});

test('borrowed money: lender loan brings cash in, repayments go out', async () => {
  const before = await cashOf();
  const c = await h.req('POST', '/api/loans', {
    direction: 'taken', new_party: { name: 'Suresh Financiers', phone: '9111111111' },
    type: 'emi_monthly', principal: 100000, processing_fee: 1000, rate: 1.5, tenure: 10, start_date: '2026-03-01',
  }, owner);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(await cashOf(), before + 99000);
  const d = (await h.req('GET', `/api/loans/${c.data.id}`, undefined, owner)).data;
  assert.match(d.loan.loan_no, /^BR/);
  const mid = await cashOf();
  const pay = await h.req('POST', `/api/loans/${c.data.id}/payments`, { amount: 11500, paid_on: '2026-03-15' }, owner);
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.equal(await cashOf(), mid - 11500);
  const lenders = (await h.req('GET', '/api/parties?kind=lender', undefined, owner)).data.parties;
  assert.equal(lenders.length, 1);
  // a customer cannot be used as a lender and vice versa
  const bad = await h.req('POST', '/api/loans', { direction: 'taken', party_id: 1, type: 'interest_only', principal: 1000, rate: 1, start_date: '2026-03-01' }, owner);
  assert.equal(bad.status, 400);
});

test('void: only loans without payments; disbursement cash is returned', async () => {
  const before = await cashOf();
  const c = await h.req('POST', '/api/loans', { party_id: 1, type: 'interest_only', principal: 5000, rate: 3, start_date: '2026-03-15' }, staff);
  assert.equal(c.status, 201);
  assert.equal(await cashOf(), before - 5000);
  assert.equal((await h.req('POST', `/api/loans/${c.data.id}/void`, { reason: 'typo' }, staff)).status, 403);
  assert.equal((await h.req('POST', `/api/loans/${c.data.id}/void`, { reason: 'Entered by mistake' }, owner)).status, 200);
  assert.equal(await cashOf(), before);
  assert.equal((await h.req('POST', `/api/loans/${loanA}/void`, { reason: 'try' }, owner)).status, 400);
});

test('write-off marks the loan and keeps cash untouched', async () => {
  const c = await h.req('POST', '/api/loans', { party_id: 1, type: 'emi_daily', principal: 3000, rate: 0.2, tenure: 60, start_date: '2026-03-01' }, staff);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const before = await cashOf();
  assert.equal((await h.req('POST', `/api/loans/${c.data.id}/write-off`, { note: 'Customer untraceable' }, owner)).status, 200);
  assert.equal(await cashOf(), before);
  const d = (await h.req('GET', `/api/loans/${c.data.id}`, undefined, owner)).data;
  assert.equal(d.loan.status, 'written_off');
  assert.equal(d.closure.kind, 'write_off');
});

test('daily EMI loan: 60 instalments, overdue days count', async () => {
  const c = await h.req('POST', '/api/loans', { party_id: 1, type: 'emi_daily', principal: 6000, fixed_installment: 120, tenure: 60, start_date: '2026-03-01' }, staff);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const d = (await h.req('GET', `/api/loans/${c.data.id}`, undefined, staff)).data;
  assert.equal(d.schedule.length, 60);
  assert.equal(d.schedule[0].due_date, '2026-03-02');
  assert.equal(d.summary.overdue_count, 13); // Mar 2..Mar 14 are before "today" (Mar 15 is due today)
  assert.equal(d.summary.due_now_amount, 120 * 14);
  assert.equal(d.loan.total_interest, 1200);
});

test('investments: returns, outstanding, ledger', async () => {
  const before = await cashOf();
  const i = await h.req('POST', '/api/investments', { name: 'Tata Capital IPO', amount: 20000, invested_on: '2026-03-05' }, owner);
  assert.equal(i.status, 201);
  assert.equal(await cashOf(), before - 20000);
  const bad = await h.req('POST', `/api/investments/${i.data.id}/returns`, { returned_on: '2026-03-12', principal_part: 25000 }, owner);
  assert.equal(bad.status, 400);
  const r = await h.req('POST', `/api/investments/${i.data.id}/returns`, { returned_on: '2026-03-12', principal_part: 20000, profit_part: 1500 }, owner);
  assert.equal(r.status, 201);
  assert.equal(await cashOf(), before + 1500);
  const list = (await h.req('GET', '/api/investments', undefined, owner)).data.investments;
  assert.equal(list[0].status, 'closed');
  assert.equal(list[0].profit, 1500);
  assert.equal((await h.req('DELETE', `/api/investments/${i.data.id}`, undefined, owner)).status, 400);
});

test('dashboard: cash, lent, income; staff view hides business money', async () => {
  const d = (await h.req('GET', '/api/dashboard', undefined, owner)).data;
  assert.equal(d.cash, await cashOf());
  assert.ok(d.lent.count >= 2);
  assert.ok(d.month.total > 0);
  assert.equal(d.borrowed.count, 1);
  const s = (await h.req('GET', '/api/dashboard', undefined, staff)).data;
  assert.equal(s.cash, undefined);
  assert.equal(s.investments, undefined);
  assert.ok(s.lent);
});

test('reports: profit & loss and CSV exports', async () => {
  const r = (await h.req('GET', '/api/reports/summary?from=2026-01-01&to=2026-03-15', undefined, owner)).data;
  assert.equal(r.income.processing_fees, 200);
  assert.equal(r.income.investment_profit, 1500);
  assert.ok(r.income.interest > 0);
  assert.equal(r.costs.borrowing_fees, 1000);
  assert.equal(r.net_profit, Math.round((r.total_income - r.total_costs) * 100) / 100);
  const csv = await h.req('GET', '/api/reports/loans.csv', undefined, owner);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Ramesh Patil/);
  const pay = await h.req('GET', '/api/reports/payments.csv?from=2026-01-01&to=2026-03-15', undefined, owner);
  assert.match(pay.data, /RC0000/);
});

test('analytics: owner-only, series are per-month, portfolio totals agree with the dashboard', async () => {
  assert.equal((await h.req('GET', '/api/analytics', undefined, staff)).status, 403);
  assert.equal((await h.req('GET', '/api/analytics')).status, 401);
  const r = await h.req('GET', '/api/analytics?months=6', undefined, owner);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = r.data;
  assert.equal(a.months.length, 6);
  assert.equal(a.months[5], '2026-03'); // harness "today" is 2026-03-15
  for (const k of ['interest', 'fees_charges', 'investment_profit', 'income', 'costs', 'net', 'disbursed', 'collected']) {
    assert.equal(a.series[k].length, 6, k);
  }
  // net = income - costs, month by month (to the paisa)
  a.series.net.forEach((n, i) => assert.equal(Math.round((a.series.income[i] - a.series.costs[i]) * 100), Math.round(n * 100)));
  // the portfolio pieces must add up to what the dashboard says is lent out
  const dash = (await h.req('GET', '/api/dashboard', undefined, owner)).data;
  const sum = (arr, f) => Math.round(arr.reduce((t, x) => t + f(x) * 100, 0)) / 100;
  assert.equal(a.portfolio.outstanding, dash.lent.principal_outstanding);
  assert.equal(sum(a.portfolio.by_type, (x) => x.value), dash.lent.principal_outstanding);
  assert.equal(sum(a.portfolio.by_customer, (x) => x.value), dash.lent.principal_outstanding);
  assert.equal(a.kpis.active_loans, dash.lent.count);
  // ageing counts only overdue loans
  assert.equal(a.portfolio.ageing.reduce((t, b) => t + b.count, 0), dash.overdue.count);
  // status mix covers every non-void loan we gave
  const given = (await h.req('GET', '/api/loans?direction=given&limit=1000', undefined, owner)).data.loans.filter((l) => l.status !== 'void');
  assert.equal(a.portfolio.status.reduce((t, s2) => t + s2.count, 0), given.length);
  // top customers list is sorted high to low
  const ti = a.top_interest.map((c) => c.value);
  assert.deepEqual(ti, [...ti].sort((x, y) => y - x));
  assert.equal((await h.req('GET', '/api/analytics?months=99', undefined, owner)).status, 400);
});

test('users & settings (owner)', async () => {
  const u = await h.req('POST', '/api/users', { username: 'newstaff', name: 'New Staff', role: 'staff', password: 'Sup3rSecret' }, owner);
  assert.equal(u.status, 201);
  assert.equal((await h.req('POST', '/api/users', { username: 'newstaff', name: 'Dup', role: 'staff', password: 'Sup3rSecret' }, owner)).status, 409);
  assert.equal((await h.req('POST', '/api/users', { username: 'x', name: 'Bad', role: 'staff', password: 'short' }, owner)).status, 400);
  const me = (await h.req('GET', '/api/auth/me', undefined, owner)).data.user;
  assert.equal((await h.req('PATCH', `/api/users/${me.id}`, { is_active: false }, owner)).status, 400);
  const s = await h.req('PUT', '/api/settings', { business_name: 'Patil Finance', foreclosure_charge_pct: 2, late_fee_per_day: 25, foreclosure_interest_policy: 'accrued' }, owner);
  assert.equal(s.data.settings.business_name, 'Patil Finance');
  // new loans pick up the defaults; existing ones are untouched
  const c = await h.req('POST', '/api/loans', { party_id: 1, type: 'emi_monthly', principal: 1000, rate: 1, tenure: 3, start_date: '2026-03-15' }, staff);
  const d = (await h.req('GET', `/api/loans/${c.data.id}`, undefined, staff)).data;
  assert.equal(d.loan.foreclosure_charge_pct, 2);
  assert.equal(d.loan.late_fee_per_day, 25);
  const old = (await h.req('GET', `/api/loans/${loanA}`, undefined, staff)).data;
  assert.equal(old.loan.foreclosure_charge_pct, 0);
});

test('security headers are set and unknown API paths 404', async () => {
  const r = await h.req('GET', '/api/nope', undefined, owner);
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const put = await h.req('PUT', '/api/loans', {}, owner);
  assert.equal(put.status, 405);
});

test('static: admin app, customer app and assets are served; traversal attempts are not', async () => {
  for (const [url, type] of [['/', 'text/html'], ['/portal', 'text/html'], ['/assets/app.js', 'text/javascript'], ['/assets/styles.css', 'text/css']]) {
    const r = await fetch(h.base + url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get('content-type'), new RegExp(type));
  }
  for (const url of ['/..%2f..%2fpackage.json', '/assets/..%2f..%2f.env', '/src/config.js', '/test/api.test.js', '/.env']) {
    assert.equal((await fetch(h.base + url)).status, 404, url);
  }
  assert.equal((await fetch(h.base + '/', { method: 'POST' })).status, 405);
});

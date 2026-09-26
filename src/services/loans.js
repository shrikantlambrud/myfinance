'use strict';
const engine = require('../engine');
const { toPaise, fromPaise } = require('../engine/money');
const { addDays } = require('../engine/dates');
const { badRequest, notFound, forbidden, HttpError } = require('../lib/errors');
const { pad, qmarks, chunk, audit, addLedger, reverseLedgerFor, availableCashPaise, getSettings } = require('./common');

const R = fromPaise;
const isEmi = engine.isEmi;

/* ------------------------------------------------------------------ */
/* DB rows <-> engine models                                            */
/* ------------------------------------------------------------------ */

function engineLoan(row) {
  return {
    type: row.type,
    principal: toPaise(row.principal),
    rate: Number(row.rate),
    tenure: row.tenure,
    start_date: row.start_date,
    first_due_date: row.first_due_date || null,
    late_fee_per_day: toPaise(row.late_fee_per_day),
    foreclosure_charge_pct: Number(row.foreclosure_charge_pct),
    foreclosure_interest_policy: row.foreclosure_interest_policy,
  };
}
const engineInstallments = (rows) => rows.map((r) => ({
  seq: r.seq, due_date: r.due_date, principal_due: toPaise(r.principal_due), interest_due: toPaise(r.interest_due),
}));
const enginePayments = (rows) => rows
  .filter((p) => !p.reversed_at && p.kind === 'regular')
  .map((p) => ({
    id: p.id, paid_on: p.paid_on, amount: toPaise(p.amount),
    principal_part: toPaise(p.principal_part), interest_part: toPaise(p.interest_part),
  }));

async function loadBundle(db, id, lock = false) {
  const row = await db.get(`SELECT * FROM loans WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!row) throw notFound('Loan not found');
  const installments = await db.all('SELECT * FROM installments WHERE loan_id = ? ORDER BY seq', [id]);
  const payments = await db.all('SELECT * FROM payments WHERE loan_id = ? ORDER BY paid_on, id', [id]);
  const closure = await db.get('SELECT * FROM loan_closures WHERE loan_id = ? AND reversed_at IS NULL ORDER BY id DESC LIMIT 1', [id]);
  return { row, installments, payments, closure };
}

// Bulk version for lists / dashboard: 3 queries per 500 loans instead of 3 per loan.
async function loadBundles(db, loanRows) {
  const map = new Map(loanRows.map((r) => [r.id, { row: r, installments: [], payments: [], closure: null }]));
  for (const ids of chunk([...map.keys()], 500)) {
    const inst = await db.all(`SELECT * FROM installments WHERE loan_id IN (${qmarks(ids.length)}) ORDER BY loan_id, seq`, ids);
    inst.forEach((i) => map.get(i.loan_id).installments.push(i));
    const pays = await db.all(`SELECT * FROM payments WHERE loan_id IN (${qmarks(ids.length)}) AND reversed_at IS NULL ORDER BY paid_on, id`, ids);
    pays.forEach((p) => map.get(p.loan_id).payments.push(p));
    const cl = await db.all(`SELECT * FROM loan_closures WHERE loan_id IN (${qmarks(ids.length)}) AND reversed_at IS NULL`, ids);
    cl.forEach((c) => { map.get(c.loan_id).closure = c; });
  }
  return [...map.values()];
}

function summarizeBundle(b, asOf) {
  const closure = b.closure ? {
    closed_on: b.closure.closed_on, kind: b.closure.kind,
    principal_settled: toPaise(b.closure.principal_settled), interest_settled: toPaise(b.closure.interest_settled),
    penalty_settled: toPaise(b.closure.penalty_settled),
  } : null;
  return engine.summarizeLoan(engineLoan(b.row), engineInstallments(b.installments), enginePayments(b.payments), asOf, closure);
}

/* ------------------------------------------------------------------ */
/* Presentation (paise -> rupees)                                       */
/* ------------------------------------------------------------------ */

function presentRow(r) {
  return {
    seq: r.seq, start_date: r.start_date || null, due_date: r.due_date,
    principal_base: r.principal_base === undefined ? null : R(r.principal_base),
    principal_due: R(r.principal_due), interest_due: R(r.interest_due), emi: R(r.emi),
    principal_paid: R(r.principal_paid), interest_paid: R(r.interest_paid),
    penalty: R(r.penalty), penalty_paid: R(r.penalty_paid), penalty_remaining: R(r.penalty_remaining),
    remaining: R(r.remaining), paid_total: R(r.paid_total), partial: r.partial,
    cleared_on: r.cleared_on, status: r.status,
  };
}
function presentSummary(s) {
  return {
    principal_outstanding: R(s.principal_outstanding),
    interest_remaining: R(s.interest_remaining),
    penalty_outstanding: R(s.penalty_outstanding),
    total_remaining: R(s.total_remaining),
    due_now_amount: R(s.due_now_amount),
    overdue_amount: R(s.overdue_amount),
    overdue_days: s.overdue_days,
    overdue_count: s.overdue_count,
    next_due: s.next_due ? { seq: s.next_due.seq, due_date: s.next_due.due_date, amount: R(s.next_due.amount) } : null,
    total_principal_paid: R(s.totals.principal_paid),
    total_interest_paid: R(s.totals.interest_paid),
    total_penalty_paid: R(s.totals.penalty_paid),
  };
}
function presentQuote(q) {
  return {
    as_of: q.as_of, policy: q.policy, charge_pct: q.charge_pct,
    principal: R(q.principal), interest_accrued: R(q.interest_accrued), interest_paid: R(q.interest_paid),
    interest_payable: R(q.interest_payable), penalty: R(q.penalty), charge: R(q.charge),
    total: R(q.total), refund_due: R(q.refund_due),
  };
}
function presentLoanRow(row, party) {
  return {
    id: row.id, loan_no: row.loan_no, direction: row.direction,
    party_id: row.party_id, party: party || null,
    type: row.type, interest_method: row.interest_method,
    principal: Number(row.principal), processing_fee: Number(row.processing_fee),
    net_disbursed: R(toPaise(row.principal) - toPaise(row.processing_fee)),
    rate: Number(row.rate), fixed_installment: row.fixed_installment === null ? null : Number(row.fixed_installment),
    tenure: row.tenure, start_date: row.start_date, first_due_date: row.first_due_date,
    total_interest: row.total_interest === null ? null : Number(row.total_interest),
    total_payable: row.total_payable === null ? null : Number(row.total_payable),
    late_fee_per_day: Number(row.late_fee_per_day),
    foreclosure_charge_pct: Number(row.foreclosure_charge_pct),
    foreclosure_interest_policy: row.foreclosure_interest_policy,
    status: row.status, closed_on: row.closed_on, note: row.note, created_at: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Terms / preview                                                      */
/* ------------------------------------------------------------------ */

function fieldError(field, message) {
  return badRequest(message, { fields: { [field]: message } });
}

// Validate business rules and build the schedule. Used by both preview and create.
function deriveTerms(input, defaults) {
  const type = input.type;
  const principal = toPaise(input.principal);
  const fee = toPaise(input.processing_fee || 0);
  if (principal <= 0) throw fieldError('principal', 'Loan amount must be more than zero');
  if (fee < 0 || fee >= principal) throw fieldError('processing_fee', 'Processing fee must be less than the loan amount');
  if (input.first_due_date && input.first_due_date < input.start_date) {
    throw fieldError('first_due_date', 'First due date cannot be before the start date');
  }
  const terms = {
    type, principal, fee, method: 'flat', rate: 0, fixed: null, tenure: null, schedule: null,
    late_fee_per_day: toPaise(input.late_fee_per_day !== null && input.late_fee_per_day !== undefined ? input.late_fee_per_day : defaults.late_fee_per_day),
    foreclosure_charge_pct: input.foreclosure_charge_pct !== null && input.foreclosure_charge_pct !== undefined ? input.foreclosure_charge_pct : defaults.foreclosure_charge_pct,
    foreclosure_interest_policy: input.foreclosure_interest_policy || defaults.foreclosure_interest_policy,
  };
  if (type === 'interest_only') {
    if (input.rate === null || input.rate === undefined) throw fieldError('rate', 'Interest rate is required');
    terms.rate = input.rate;
    terms.late_fee_per_day = 0; // late fees apply to EMI loans only
    return terms;
  }
  const maxTenure = type === 'emi_daily' ? 3650 : 360;
  if (!input.tenure) throw fieldError('tenure', 'Tenure is required');
  if (input.tenure > maxTenure) throw fieldError('tenure', `Tenure cannot be more than ${maxTenure} ${type === 'emi_daily' ? 'days' : 'months'}`);
  terms.tenure = input.tenure;
  terms.method = input.interest_method || 'flat';
  terms.fixed = input.fixed_installment ? toPaise(input.fixed_installment) : null;
  if (!terms.fixed && (input.rate === null || input.rate === undefined)) throw fieldError('rate', 'Enter the interest rate or a fixed EMI amount');
  if (terms.fixed && terms.method === 'reducing') throw badRequest('Reducing balance cannot be combined with a fixed EMI amount');
  let sch;
  try {
    sch = engine.buildSchedule({
      type, method: terms.method, principal, rate: input.rate || 0, tenure: input.tenure,
      fixedInstallment: terms.fixed, startDate: input.start_date, firstDueDate: input.first_due_date || null,
    });
  } catch (e) {
    throw badRequest(e.message);
  }
  if (sch.totalInterest > principal * 5) {
    throw badRequest('Total interest works out to more than 5 times the loan amount. Please check the rate and tenure.');
  }
  terms.schedule = sch;
  terms.rate = terms.fixed ? sch.effectiveRate : input.rate;
  return terms;
}

async function previewLoan(db, input) {
  const defaults = await getSettings(db);
  const t = deriveTerms(input, defaults);
  const base = { net_disbursed: R(t.principal - t.fee), processing_fee: R(t.fee) };
  if (t.type === 'interest_only') {
    const { anchorDue } = require('../engine/schedule');
    return {
      ...base, type: t.type,
      monthly_interest: R(Math.round(t.principal * (t.rate / 100))),
      first_due_date: anchorDue('interest_only', input.start_date, input.first_due_date || null),
    };
  }
  const s = t.schedule;
  return {
    ...base, type: t.type, method: t.method, effective_rate: s.effectiveRate,
    installment: R(s.installment), total_interest: R(s.totalInterest), total_payable: R(s.totalPayable),
    first_due_date: s.installments[0].due_date, last_due_date: s.installments[s.installments.length - 1].due_date,
    schedule: s.installments.map((i) => ({ seq: i.seq, due_date: i.due_date, principal_due: R(i.principal_due), interest_due: R(i.interest_due), emi: R(i.principal_due + i.interest_due) })),
  };
}

/* ------------------------------------------------------------------ */
/* Create                                                               */
/* ------------------------------------------------------------------ */

async function createLoan(env, tx, input) {
  const direction = input.direction || 'given';
  const party = await tx.get('SELECT * FROM parties WHERE id = ? AND is_active = 1', [input.party_id]);
  if (!party) throw fieldError('party_id', 'Choose a customer');
  if ((direction === 'given') !== (party.kind === 'customer')) {
    throw fieldError('party_id', direction === 'given' ? 'Loans can only be given to customers' : 'Borrowed money must come from a lender');
  }
  if (input.start_date > addDays(env.today(), 1)) throw fieldError('start_date', 'Start date cannot be in the future');

  const defaults = await getSettings(tx);
  const t = deriveTerms(input, defaults);
  const net = t.principal - t.fee;

  if (direction === 'given' && !input.allow_low_cash) {
    const cash = await availableCashPaise(tx);
    if (net > cash) {
      throw new HttpError(409, `Available cash is only ₹${R(cash).toLocaleString('en-IN')}. Add capital first, or confirm to continue anyway.`, { code: 'LOW_CASH', available: R(cash), needed: R(net) });
    }
  }

  const res = await tx.run(
    `INSERT INTO loans (direction, party_id, type, interest_method, principal, processing_fee, rate, fixed_installment, tenure,
       start_date, first_due_date, total_interest, total_payable, late_fee_per_day, foreclosure_charge_pct, foreclosure_interest_policy,
       status, principal_outstanding, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [direction, party.id, t.type, t.method, R(t.principal), R(t.fee), t.rate, t.fixed ? R(t.fixed) : null, t.tenure,
      input.start_date, input.first_due_date || null,
      t.schedule ? R(t.schedule.totalInterest) : null, t.schedule ? R(t.schedule.totalPayable) : null,
      R(t.late_fee_per_day), t.foreclosure_charge_pct, t.foreclosure_interest_policy,
      'active', R(t.principal), input.note || null, env.user.id, env.now()],
  );
  const id = res.insertId;
  await tx.run('UPDATE loans SET loan_no = ? WHERE id = ?', [(direction === 'given' ? 'LN' : 'BR') + pad(id), id]);

  if (t.schedule) {
    for (const part of chunk(t.schedule.installments, 400)) {
      await tx.run(
        `INSERT INTO installments (loan_id, seq, due_date, principal_due, interest_due) VALUES ${part.map(() => '(?,?,?,?,?)').join(',')}`,
        part.flatMap((i) => [id, i.seq, i.due_date, R(i.principal_due), R(i.interest_due)]),
      );
    }
  }
  await addLedger(tx, env, {
    date: input.start_date, kind: direction === 'given' ? 'loan_disbursement' : 'borrowing_in',
    direction: direction === 'given' ? 'out' : 'in', amountPaise: net, refType: 'loan', refId: id,
    note: `${direction === 'given' ? 'Loan to' : 'Borrowed from'} ${party.name}`,
  });
  await audit(tx, env, 'loan.create', 'loan', id, { party: party.name, type: t.type, principal: R(t.principal), fee: R(t.fee) });
  return id;
}

/* ------------------------------------------------------------------ */
/* Recompute: the single place that writes derived loan state           */
/* ------------------------------------------------------------------ */

async function recomputeLoan(tx, env, loanId) {
  const b = await loadBundle(tx, loanId);
  if (b.row.status === 'void') return { b, s: null };
  const s = summarizeBundle(b, env.today());

  if (b.installments.length) {
    const bySeq = new Map(s.rows.map((r) => [r.seq, r]));
    for (const inst of b.installments) {
      const r = bySeq.get(inst.seq);
      const status = r.status === 'waived' ? 'waived' : r.cleared_on ? 'paid' : r.paid_total > 0 ? 'partial' : 'pending';
      if (toPaise(inst.principal_paid) !== r.principal_paid || toPaise(inst.interest_paid) !== r.interest_paid
        || toPaise(inst.penalty_paid) !== r.penalty_paid || (inst.cleared_on || null) !== r.cleared_on || inst.status !== status) {
        await tx.run(
          'UPDATE installments SET principal_paid = ?, interest_paid = ?, penalty_paid = ?, cleared_on = ?, status = ? WHERE id = ?',
          [R(r.principal_paid), R(r.interest_paid), R(r.penalty_paid), r.cleared_on, status, inst.id],
        );
      }
    }
    for (const p of b.payments) {
      if (p.reversed_at || p.kind !== 'regular') continue;
      const sp = s.splits.get(p.id);
      if (!sp) continue;
      if (toPaise(p.principal_part) !== sp.principal || toPaise(p.interest_part) !== sp.interest || toPaise(p.penalty_part) !== sp.penalty) {
        await tx.run('UPDATE payments SET principal_part = ?, interest_part = ?, penalty_part = ? WHERE id = ?',
          [R(sp.principal), R(sp.interest), R(sp.penalty), p.id]);
      }
    }
  }

  const active = b.payments.filter((p) => !p.reversed_at);
  let status = 'active', closedOn = null;
  if (b.closure) {
    status = b.closure.kind === 'foreclosure' ? 'foreclosed' : 'written_off';
    closedOn = b.closure.closed_on;
  } else if (s.fully_paid) {
    status = 'closed';
    closedOn = active.reduce((m, p) => (p.paid_on > m ? p.paid_on : m), b.row.start_date);
  }
  if (b.row.status !== status || (b.row.closed_on || null) !== closedOn || toPaise(b.row.principal_outstanding) !== s.principal_outstanding) {
    await tx.run('UPDATE loans SET status = ?, closed_on = ?, principal_outstanding = ? WHERE id = ?',
      [status, closedOn, R(s.principal_outstanding), loanId]);
  }
  return { b, s };
}

/* ------------------------------------------------------------------ */
/* Payments                                                             */
/* ------------------------------------------------------------------ */

async function insertPayment(tx, env, loan, p) {
  const r = await tx.run(
    `INSERT INTO payments (loan_id, kind, paid_on, amount, principal_part, interest_part, penalty_part, charge_part,
       pay_mode, ref_no, note, received_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [loan.id, p.kind, p.paid_on, R(p.amount), R(p.principal || 0), R(p.interest || 0), R(p.penalty || 0), R(p.charge || 0),
      p.pay_mode || 'cash', p.ref_no || null, p.note || null, env.user.id, env.now()],
  );
  await tx.run('UPDATE payments SET receipt_no = ? WHERE id = ?', ['RC' + pad(r.insertId), r.insertId]);
  await addLedger(tx, env, {
    date: p.paid_on, kind: loan.direction === 'given' ? 'loan_repayment' : 'borrowing_repayment',
    direction: loan.direction === 'given' ? 'in' : 'out', amountPaise: p.amount, refType: 'payment', refId: r.insertId,
    note: `${p.kind === 'foreclosure' ? 'Foreclosure' : 'Payment'} ${loan.loan_no}`,
  });
  return r.insertId;
}

async function recordPayment(env, tx, loanId, input) {
  const b = await loadBundle(tx, loanId, true);
  const loan = b.row;
  if (loan.status !== 'active') throw badRequest(`This loan is ${loan.status.replace('_', ' ')}. Payments can only be added to active loans.`);
  const amount = toPaise(input.amount);
  if (amount <= 0) throw fieldError('amount', 'Amount must be more than zero');
  if (input.paid_on > env.today()) throw fieldError('paid_on', 'Payment date cannot be in the future');
  if (input.paid_on < loan.start_date) throw fieldError('paid_on', 'Payment date cannot be before the loan start date');

  let principal = 0, interest = 0;
  if (loan.type === 'interest_only') {
    principal = toPaise(input.principal_amount || 0);
    if (principal < 0 || principal > amount) throw fieldError('principal_amount', 'Principal part cannot be more than the amount received');
    interest = amount - principal;
    const pre = summarizeBundle(b, input.paid_on);
    if (principal >= pre.principal_outstanding && principal > 0) {
      throw fieldError('principal_amount', `Principal outstanding is ₹${R(pre.principal_outstanding).toLocaleString('en-IN')}. To close the loan completely use Foreclose, so the interest is settled correctly.`);
    }
    if (interest > pre.max_interest_payable) {
      throw fieldError('amount', `At most ₹${R(pre.max_interest_payable).toLocaleString('en-IN')} of interest can be accepted right now`);
    }
  }

  const id = await insertPayment(tx, env, loan, {
    kind: 'regular', paid_on: input.paid_on, amount, principal, interest,
    pay_mode: input.pay_mode, ref_no: input.ref_no, note: input.note,
  });
  const { s } = await recomputeLoan(tx, env, loanId);
  if (s.unallocated > 0) {
    throw badRequest(`Amount is ₹${R(s.unallocated).toLocaleString('en-IN')} more than the remaining balance. Maximum you can collect is ₹${R(amount - s.unallocated).toLocaleString('en-IN')}. To close early use Foreclose.`,
      { fields: { amount: 'More than the remaining balance' } });
  }
  await audit(tx, env, 'payment.create', 'payment', id, { loan: loan.loan_no, amount: R(amount), paid_on: input.paid_on });
  return id;
}

async function reversePayment(env, tx, paymentId, reason) {
  const p = await tx.get('SELECT * FROM payments WHERE id = ? FOR UPDATE', [paymentId]);
  if (!p) throw notFound('Payment not found');
  if (p.reversed_at) throw badRequest('This payment is already reversed');
  await tx.get('SELECT id FROM loans WHERE id = ? FOR UPDATE', [p.loan_id]);
  await tx.run('UPDATE payments SET reversed_at = ?, reversed_by = ?, reverse_reason = ? WHERE id = ?', [env.now(), env.user.id, reason, paymentId]);
  await reverseLedgerFor(tx, env, 'payment', paymentId);
  if (p.kind === 'foreclosure') {
    await tx.run('UPDATE loan_closures SET reversed_at = ? WHERE payment_id = ? AND reversed_at IS NULL', [env.now(), paymentId]);
  }
  await recomputeLoan(tx, env, p.loan_id);
  await audit(tx, env, 'payment.reverse', 'payment', paymentId, { receipt: p.receipt_no, amount: Number(p.amount), reason });
  return p.loan_id;
}

/* ------------------------------------------------------------------ */
/* Foreclosure, write-off, void, reopen                                 */
/* ------------------------------------------------------------------ */

function quoteFromBundle(b, date) {
  return engine.foreclosureQuote(engineLoan(b.row), engineInstallments(b.installments), enginePayments(b.payments), date);
}

async function quoteForeclosure(db, loanId, date) {
  const b = await loadBundle(db, loanId);
  if (b.row.status !== 'active') throw badRequest('Only active loans can be foreclosed');
  if (date < b.row.start_date) throw fieldError('date', 'Date cannot be before the loan start date');
  return presentQuote(quoteFromBundle(b, date));
}

async function foreclose(env, tx, loanId, input) {
  const b = await loadBundle(tx, loanId, true);
  const loan = b.row;
  if (loan.status !== 'active') throw badRequest('Only active loans can be foreclosed');
  const date = input.date;
  if (date > env.today()) throw fieldError('date', 'Foreclosure date cannot be in the future');
  if (date < loan.start_date) throw fieldError('date', 'Date cannot be before the loan start date');
  const lastPay = b.payments.filter((p) => !p.reversed_at).reduce((m, p) => (p.paid_on > m ? p.paid_on : m), '');
  if (lastPay && date < lastPay) throw fieldError('date', `A payment was recorded on ${lastPay}. Foreclosure date cannot be earlier.`);

  const discount = toPaise(input.discount || 0);
  if (discount < 0) throw fieldError('discount', 'Discount cannot be negative');
  if (discount > 0 && env.user.role !== 'owner') throw forbidden('Only an owner can give a discount on foreclosure');

  const quote = quoteFromBundle(b, date);
  if (quote.refund_due > 0) throw badRequest('The customer has paid more than is owed. Please contact the owner to settle the refund manually.');
  let parts;
  try { parts = engine.applyDiscount(quote, discount); } catch (e) { throw fieldError('discount', e.message); }

  const paymentId = await insertPayment(tx, env, loan, {
    kind: 'foreclosure', paid_on: date, amount: parts.amount,
    principal: parts.principal, interest: parts.interest, penalty: parts.penalty, charge: parts.charge,
    pay_mode: input.pay_mode, ref_no: input.ref_no, note: input.note || 'Foreclosure',
  });
  await tx.run(
    `INSERT INTO loan_closures (loan_id, kind, closed_on, principal_settled, interest_settled, penalty_settled, charge, discount,
       amount_received, payment_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [loanId, 'foreclosure', date, R(parts.principal), R(parts.interest), R(parts.penalty), R(parts.charge), R(discount),
      R(parts.amount), paymentId, input.note || null, env.user.id, env.now()],
  );
  await recomputeLoan(tx, env, loanId);
  await audit(tx, env, 'loan.foreclose', 'loan', loanId, { loan: loan.loan_no, date, received: R(parts.amount), discount: R(discount) });
  return { paymentId, received: R(parts.amount) };
}

async function writeOff(env, tx, loanId, note) {
  const b = await loadBundle(tx, loanId, true);
  if (b.row.status !== 'active') throw badRequest('Only active loans can be written off');
  const s = summarizeBundle(b, env.today());
  await tx.run(
    `INSERT INTO loan_closures (loan_id, kind, closed_on, principal_settled, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)`,
    [loanId, 'write_off', env.today(), R(s.principal_outstanding), note || null, env.user.id, env.now()],
  );
  await recomputeLoan(tx, env, loanId);
  await audit(tx, env, 'loan.write_off', 'loan', loanId, { loan: b.row.loan_no, loss: R(s.principal_outstanding), note });
}

async function reopenLoan(env, tx, loanId) {
  const b = await loadBundle(tx, loanId, true);
  if (!['foreclosed', 'written_off'].includes(b.row.status)) throw badRequest('Only foreclosed or written-off loans can be reopened');
  if (b.closure && b.closure.payment_id) {
    await reversePayment(env, tx, b.closure.payment_id, 'Loan reopened');
  } else if (b.closure) {
    await tx.run('UPDATE loan_closures SET reversed_at = ? WHERE id = ?', [env.now(), b.closure.id]);
    await recomputeLoan(tx, env, loanId);
  }
  await audit(tx, env, 'loan.reopen', 'loan', loanId, { loan: b.row.loan_no });
}

async function voidLoan(env, tx, loanId, reason) {
  const b = await loadBundle(tx, loanId, true);
  if (b.row.status !== 'active') throw badRequest('Only active loans can be voided');
  if (b.payments.some((p) => !p.reversed_at)) throw badRequest('This loan has payments. Reverse them first, then void the loan.');
  await tx.run("UPDATE loans SET status = 'void', principal_outstanding = 0 WHERE id = ?", [loanId]);
  await tx.run("UPDATE installments SET status = 'waived' WHERE loan_id = ?", [loanId]);
  await reverseLedgerFor(tx, env, 'loan', loanId);
  await audit(tx, env, 'loan.void', 'loan', loanId, { loan: b.row.loan_no, reason });
}

module.exports = {
  loadBundle, loadBundles, summarizeBundle, quoteFromBundle,
  presentRow, presentSummary, presentQuote, presentLoanRow,
  previewLoan, createLoan, recomputeLoan, recordPayment, reversePayment,
  quoteForeclosure, foreclose, writeOff, reopenLoan, voidLoan, isEmi,
};

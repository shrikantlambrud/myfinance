import { get, post, ApiError } from '../api.js';
import {
  h, raw, mount, inr, fmtDate, todayLocal, badge, icon, on, toast, openSheet, confirmSheet, readForm, showErrors, clearErrors,
  numOrNull, strOrNull, busy, debounce, TYPE_LABEL, STATUS_LABEL, telLink, daysFromNow,
} from '../ui.js';
import { state, isOwner } from '../state.js';
import { openCollect, openForeclose, openReceipt, openReverse, openReasonSheet } from './payments.js';

/* =====================================================================
   Loan list (given = customers, taken = borrowed from lenders)
   ===================================================================== */
export const list = (direction) => async function listView(root, _p, query) {
  const taken = direction === 'taken';
  let status = query.status || 'active';
  let q = query.q || '';
  const FILTERS = [['active', 'Active'], ['overdue', 'Overdue'], ['closed', 'Closed'], ['all', 'All']];

  mount(root, h`
    <div class="page-head"><div><h1>${taken ? 'Borrowed money' : 'Loans'}</h1><div class="sub">${taken ? 'Money you have taken from lenders' : 'Every loan you have given'}</div></div>
      <a class="btn" href="${taken ? '#/new?direction=taken' : '#/new'}">${icon.plus} ${taken ? 'Add borrowing' : 'New loan'}</a></div>
    <section class="section">
      <div class="section-head">
        <div class="chips" id="ln-chips">${FILTERS.map(([k, l]) => h`<button class="chip" data-status="${k}" aria-pressed="${k === status}">${l}</button>`)}</div>
        <div class="search">${icon.search}<input type="search" id="ln-q" placeholder="Search name, phone or loan no." value="${q}" aria-label="Search loans"></div>
      </div>
      <div id="ln-body"><div class="spinner"></div></div>
    </section>`);

  const body = root.querySelector('#ln-body');
  async function load() {
    const params = new URLSearchParams({ direction });
    if (status !== 'all') params.set('status', status === 'closed' ? 'closed' : status);
    if (q) params.set('q', q);
    let loans;
    try { ({ loans } = await get('/api/loans?' + params)); } catch (e) { mount(body, h`<div class="empty">${e.message}</div>`); return; }
    if (status === 'closed') {
      const more = await get('/api/loans?' + new URLSearchParams({ direction, status: 'foreclosed', ...(q ? { q } : {}) }));
      loans = loans.concat(more.loans);
    }
    if (status === 'all') loans = loans.filter((l) => l.status !== 'void');
    if (!loans.length) {
      mount(body, h`<div class="empty"><strong>${q ? 'No matches' : 'No loans here yet'}</strong>${q ? 'Try a different name or number.' : (taken ? 'Add money you have borrowed to track repayments.' : 'Create your first loan to get started.')}
        ${q ? '' : h`<br><a class="btn" href="${taken ? '#/new?direction=taken' : '#/new'}">${taken ? 'Add borrowing' : 'New loan'}</a>`}</div>`);
      return;
    }
    mount(body, h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr>
      <th>${taken ? 'Lender' : 'Customer'}</th><th>Type</th><th class="r">Amount</th><th class="r">Outstanding</th><th>Next due</th><th>Status</th></tr></thead><tbody>
      ${loans.map((l) => {
    const s = l.summary;
    const nd = s && s.next_due;
    const late = s && s.overdue_amount > 0;
    return h`<tr class="click" data-href="#/loans/${l.id}">
          <td class="first name" data-label="${taken ? 'Lender' : 'Customer'}">${l.party.name}<div class="sub num">${l.loan_no}</div></td>
          <td data-label="Type">${TYPE_LABEL[l.type]}</td>
          <td class="r num" data-label="Amount">${inr(l.principal)}</td>
          <td class="r num" data-label="Outstanding">${inr(l.principal_outstanding)}</td>
          <td data-label="Next due">${nd ? h`${fmtDate(nd.due_date)} <span class="num ${late ? 'neg' : 'muted'}">· ${inr(late ? s.due_now_amount : nd.amount)}</span>` : '–'}</td>
          <td data-label="Status">${late ? badge('overdue', `${s.overdue_days}d late`) : badge(l.status)}</td></tr>`;
  })}</tbody></table></div>`);
  }
  root.querySelector('#ln-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    status = b.dataset.status;
    root.querySelectorAll('#ln-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.status === status)));
    load();
  });
  root.querySelector('#ln-q').addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 250));
  load();
};

/* =====================================================================
   Loan detail: the khata
   ===================================================================== */
const ACTION_LABEL = {
  'loan.create': 'Loan created', 'payment.create': 'Payment recorded', 'payment.reverse': 'Payment reversed', 'loan.foreclose': 'Loan foreclosed',
  'loan.write_off': 'Written off', 'loan.reopen': 'Loan reopened', 'loan.void': 'Loan voided',
};
function rateText(l) {
  if (l.type === 'interest_only') return `${l.rate}% per month on the outstanding principal`;
  const per = l.type === 'emi_daily' ? 'day' : 'month';
  if (l.fixed_installment) return `Fixed EMI, about ${l.rate}% per ${per} flat`;
  if (l.interest_method === 'reducing') return `${l.rate}% per month on reducing balance`;
  return `${l.rate}% per ${per}, flat on the loan amount`;
}
function detailsText(a) {
  let d = {};
  try { d = JSON.parse(a.details || '{}'); } catch { /* ignore */ }
  if (a.action === 'payment.create') return `${inr(d.amount)} on ${fmtDate(d.paid_on)}`;
  if (a.action === 'payment.reverse') return `${inr(d.amount)}: ${d.reason || ''}`;
  if (a.action === 'loan.foreclose') return `Received ${inr(d.received)}${d.discount ? `, discount ${inr(d.discount)}` : ''}`;
  if (a.action === 'loan.void' || a.action === 'loan.write_off') return d.reason || d.note || '';
  return '';
}

function khata(d) {
  const { loan, schedule } = d;
  const io = loan.type === 'interest_only';
  const fee = loan.late_fee_per_day > 0;
  if (!schedule.length) return h`<div class="empty">No schedule.</div>`;
  const tot = (k) => schedule.filter((r) => r.status !== 'waived').reduce((s, r) => s + r[k], 0);
  const rowStatus = (r) => (r.partial && r.status !== 'paid' && r.status !== 'overdue' ? 'partial' : r.status);
  return h`<div class="khata"><div class="khata-scroll"><table>
    <thead><tr><th>#</th><th>Due date</th>
      ${io ? h`<th class="r">On principal</th><th class="r">Interest</th>` : h`<th class="r">Instalment</th><th class="r">Principal</th><th class="r">Interest</th>`}
      ${fee ? h`<th class="r">Late fee</th>` : ''}<th class="r">Paid</th><th>Status</th></tr></thead>
    <tbody>${schedule.map((r) => h`<tr class="is-${r.status}">
      <td class="num">${r.seq}</td><td>${fmtDate(r.due_date)}</td>
      ${io ? h`<td class="r num">${inr(r.principal_base || 0)}</td><td class="r num">${inr(r.interest_due)}</td>`
    : h`<td class="r num">${inr(r.emi)}</td><td class="r num">${inr(r.principal_due)}</td><td class="r num">${inr(r.interest_due)}</td>`}
      ${fee ? h`<td class="r num">${r.penalty ? inr(r.penalty) : '–'}</td>` : ''}
      <td class="r num">${r.paid_total ? inr(r.paid_total) : '–'}</td>
      <td>${badge(rowStatus(r))}</td></tr>`)}</tbody>
    ${io ? '' : h`<tfoot><tr><td></td><td>Total</td><td class="r num">${inr(tot('emi'))}</td><td class="r num">${inr(tot('principal_due'))}</td><td class="r num">${inr(tot('interest_due'))}</td>${fee ? h`<td></td>` : ''}<td class="r num">${inr(tot('paid_total'))}</td><td></td></tr></tfoot>`}
  </table></div></div>
  ${io ? h`<p class="faint" style="margin:0 24px 18px;font-size:14px">Interest is charged for each full month on the principal outstanding at the start of that month. More months appear as time passes.</p>` : ''}`;
}

function paymentsTab(d) {
  const owner = isOwner();
  if (!d.payments.length) return h`<div class="empty"><strong>No payments yet</strong>Payments you record will appear here with their receipts.</div>`;
  return h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Receipt</th><th>Date</th><th class="r">Amount</th><th>Split</th><th>Paid by</th><th></th></tr></thead><tbody>
    ${d.payments.map((p) => {
    const split = [p.principal_part ? `Principal ${inr(p.principal_part)}` : '', p.interest_part ? `Interest ${inr(p.interest_part)}` : '',
      p.penalty_part ? `Late fee ${inr(p.penalty_part)}` : '', p.charge_part ? `Charge ${inr(p.charge_part)}` : ''].filter(Boolean).join(' · ');
    return h`<tr class="${p.reversed_at ? 'is-waived' : ''}">
        <td class="first num name" data-label="Receipt">${p.receipt_no}${p.kind === 'foreclosure' ? h` <span class="badge foreclosed">Foreclosure</span>` : ''}${p.reversed_at ? h` <span class="badge overdue">Reversed</span>` : ''}</td>
        <td data-label="Date">${fmtDate(p.paid_on)}</td>
        <td class="r num" data-label="Amount">${inr(p.amount)}</td>
        <td data-label="Split" class="muted" style="font-size:14px">${split || '–'}${p.reverse_reason ? h`<div class="neg">Reason: ${p.reverse_reason}</div>` : ''}</td>
        <td data-label="Paid by">${p.pay_mode.toUpperCase()}${p.ref_no ? h`<div class="sub">${p.ref_no}</div>` : ''}<div class="sub">${p.received_by_name || ''}</div></td>
        <td class="r noLabel"><button class="btn quiet small" data-action="receipt" data-id="${p.id}">Receipt</button>
          ${owner && !p.reversed_at ? h`<button class="btn quiet small neg" data-action="reverse" data-id="${p.id}" data-no="${p.receipt_no}">Reverse</button>` : ''}</td></tr>`;
  })}</tbody></table></div>`;
}

function termsTab(d) {
  const l = d.loan;
  const f = (k, v, num) => h`<div><div class="k">${k}</div><div class="v ${num ? 'num' : ''}">${v}</div></div>`;
  return h`<div class="section-body"><div class="facts">
    ${f('Loan amount', inr(l.principal), true)}
    ${f('Processing fee', l.processing_fee ? inr(l.processing_fee) : 'None', true)}
    ${f(l.direction === 'taken' ? 'Money received' : 'Handed to customer', inr(l.net_disbursed), true)}
    ${f('Type', TYPE_LABEL[l.type])}
    ${f('Interest', rateText(l))}
    ${l.tenure ? f('Tenure', `${l.tenure} ${l.type === 'emi_daily' ? 'days' : 'months'}`) : ''}
    ${l.type !== 'interest_only' ? f('Instalment', inr(l.installment), true) : ''}
    ${l.total_interest !== null ? f('Total interest', inr(l.total_interest), true) : ''}
    ${l.total_payable !== null ? f('Total payable', inr(l.total_payable), true) : ''}
    ${f('Start date', fmtDate(l.start_date))}
    ${l.first_due_date ? f('First due date', fmtDate(l.first_due_date)) : ''}
    ${l.type !== 'interest_only' ? f('Late fee', l.late_fee_per_day ? `${inr(l.late_fee_per_day)} per day per late instalment` : 'None') : ''}
    ${f('Foreclosure charge', l.foreclosure_charge_pct ? `${l.foreclosure_charge_pct}% of principal outstanding` : 'None')}
    ${f('On early closure', l.foreclosure_interest_policy === 'full' ? 'All scheduled interest stays payable' : 'Interest only till the closing date')}
    ${l.note ? f('Note', l.note) : ''}
  </div></div>`;
}

function historyTab(d) {
  if (!d.audit || !d.audit.length) return h`<div class="empty">No history yet.</div>`;
  return h`<div class="section-body flush">${d.audit.map((a) => h`<div class="list-row" style="cursor:default"><div class="grow"><div class="t">${ACTION_LABEL[a.action] || a.action}</div>
    <div class="s">${detailsText(a)}</div></div><div class="s right">${a.user_name || 'System'}<br>${fmtDate(a.created_at)}</div></div>`)}</div>`;
}

let currentTab = 'schedule';
let lastId = null;

export async function detail(root, [id]) {
  if (lastId !== id) { currentTab = 'schedule'; lastId = id; }
  const d = await get(`/api/loans/${id}`);
  const { loan: l, summary: s } = d;
  const taken = l.direction === 'taken';
  const owner = isOwner();
  const active = l.status === 'active';
  const nd = s && s.next_due;
  const tel = telLink(l.party.phone);

  let closure = '';
  if (d.closure && d.closure.kind === 'foreclosure') {
    const c = d.closure;
    closure = h`<div class="section-body"><div class="notice good">${taken ? 'Paid off early' : 'Foreclosed'} on <b>${fmtDate(c.closed_on)}</b>. ${taken ? 'You paid' : 'Customer paid'} <b>${inr(c.amount_received)}</b>
      (principal ${inr(c.principal_settled)}, interest ${inr(c.interest_settled)}${c.penalty_settled ? `, late fees ${inr(c.penalty_settled)}` : ''}${c.charge ? `, charge ${inr(c.charge)}` : ''})${c.discount ? `. Discount given: ${inr(c.discount)}` : ''}.</div></div>`;
  } else if (d.closure) {
    closure = h`<div class="section-body"><div class="notice bad">Written off on <b>${fmtDate(d.closure.closed_on)}</b>. Loss: <b>${inr(d.closure.principal_settled)}</b>.</div></div>`;
  } else if (l.status === 'closed') {
    closure = h`<div class="section-body"><div class="notice good">Fully paid${l.closed_on ? ` on ${fmtDate(l.closed_on)}` : ''}.</div></div>`;
  }

  const tabs = [['schedule', 'Schedule'], ['payments', `Payments (${d.payments.filter((p) => !p.reversed_at).length})`], ['terms', 'Terms'], ['history', 'History']];
  const tabBody = currentTab === 'schedule' ? khata(d) : currentTab === 'payments' ? paymentsTab(d) : currentTab === 'terms' ? termsTab(d) : historyTab(d);

  mount(root, h`
    <p style="margin-bottom:12px"><a href="${taken ? '#/borrowed' : '#/loans'}" class="row" style="gap:4px;display:inline-flex;width:auto">${icon.back} ${taken ? 'Borrowed' : 'Loans'}</a></p>
    <section class="section">
      <div class="loan-head">
        <div>
          <h1>${l.loan_no} ${badge(l.status)}</h1>
          <div class="sub"><a href="#/customers/${l.party.id}" style="font-weight:600">${l.party.name}</a>
            ${tel ? h`<a href="${tel}" class="row" style="gap:4px;display:inline-flex">${icon.phone} ${l.party.phone}</a>` : ''}
            <span>${TYPE_LABEL[l.type]}</span><span>Started ${fmtDate(l.start_date)}</span></div>
        </div>
        <div class="row wrap">
          ${active ? h`<button class="btn good" data-action="collect" data-loan="${l.id}">${taken ? 'Record payment' : 'Collect payment'}</button>
            <button class="btn secondary" data-action="foreclose" data-loan="${l.id}">${taken ? 'Pay off early' : 'Foreclose'}</button>` : ''}
          ${owner && active ? h`<button class="btn secondary" data-action="more" data-loan="${l.id}" data-no="${l.loan_no}" aria-label="More actions">${icon.more}</button>` : ''}
          ${owner && ['foreclosed', 'written_off'].includes(l.status) ? h`<button class="btn secondary" data-action="reopen" data-loan="${l.id}">Reopen loan</button>` : ''}
        </div>
      </div>
      <div class="loan-kpis">
        <div><div class="k">Principal outstanding</div><div class="v">${inr(l.principal_outstanding)}</div></div>
        <div><div class="k">${active ? (s.overdue_amount > 0 ? 'Overdue now' : 'Next due') : 'Total paid'}</div>
          <div class="v ${active && s.overdue_amount > 0 ? 'neg' : ''}">${active ? (s.overdue_amount > 0 ? inr(s.due_now_amount) : nd ? inr(nd.amount) : '–') : inr(s.total_principal_paid + s.total_interest_paid + s.total_penalty_paid)}</div>
          ${active && nd ? h`<div class="faint" style="font-size:14px">${s.overdue_amount > 0 ? `${s.overdue_days} days late since ${fmtDate(nd.due_date)}` : fmtDate(nd.due_date) + (daysFromNow(nd.due_date) === 0 ? ' (today)' : daysFromNow(nd.due_date) > 0 ? ` (in ${daysFromNow(nd.due_date)} days)` : '')}</div>` : ''}</div>
        <div><div class="k">${l.type === 'interest_only' ? 'Interest paid so far' : 'Interest still to come'}</div><div class="v">${inr(l.type === 'interest_only' ? s.total_interest_paid : s.interest_remaining)}</div></div>
      </div>
      ${closure ? h`<div style="border-top:1px solid var(--rule)">${closure}</div>` : ''}
      <div class="tabs" role="tablist" id="ld-tabs">${tabs.map(([k, t]) => h`<button role="tab" data-tab="${k}" aria-selected="${k === currentTab}">${t}</button>`)}</div>
      <div id="ld-tab" style="padding-top:14px">${tabBody}</div>
    </section>`);

  root.querySelector('#ld-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    currentTab = b.dataset.tab;
    state.rerender();
  });
}

on('foreclose', (el) => openForeclose(Number(el.dataset.loan), () => state.rerender()));
on('reverse', (el) => openReverse(Number(el.dataset.id), el.dataset.no, () => state.rerender()));
on('reopen', async (el) => {
  const ok = await confirmSheet({ title: 'Reopen this loan?', message: 'The closing payment will be reversed and the cash book adjusted. The loan goes back to active.', confirmLabel: 'Reopen loan' });
  if (!ok) return;
  await post(`/api/loans/${el.dataset.loan}/reopen`);
  toast('Loan reopened');
  state.rerender();
});
on('more', (el) => {
  const id = el.dataset.loan;
  const s = openSheet({
    title: `${el.dataset.no}: more actions`,
    body: h`<div class="stack">
      <button class="btn secondary block" id="mo-wo">Write off as bad debt</button>
      <p class="faint" style="font-size:14px;margin-top:-6px">Use when the money cannot be recovered. No cash moves; the outstanding principal is recorded as a loss.</p>
      <button class="btn secondary block" id="mo-void">Void this loan</button>
      <p class="faint" style="font-size:14px;margin-top:-6px">Use when the loan was entered by mistake. Only possible when it has no payments.</p></div>`,
  });
  s.el.querySelector('#mo-wo').addEventListener('click', () => {
    s.close();
    openReasonSheet({ title: 'Write off loan', warning: 'The outstanding principal will be recorded as a loss and the remaining schedule cancelled. You can reopen the loan later.', cta: 'Write off', path: { url: `/api/loans/${id}/write-off`, field: 'note' }, onDone: () => state.rerender() });
  });
  s.el.querySelector('#mo-void').addEventListener('click', () => {
    s.close();
    openReasonSheet({ title: 'Void loan', warning: 'The loan is cancelled and the money handed out returns to your cash book. This cannot be undone.', cta: 'Void loan', path: { url: `/api/loans/${id}/void`, field: 'reason' }, onDone: () => { location.hash = '#/loans'; } });
  });
});

/* =====================================================================
   New loan
   ===================================================================== */
export async function create(root, _p, query) {
  const taken = query.direction === 'taken';
  const st = state.settings;
  const nl = { type: 'emi_monthly', emiMode: 'rate', party: null, addNew: false };

  mount(root, h`
    <p style="margin-bottom:12px"><a href="${taken ? '#/borrowed' : '#/loans'}" class="row" style="gap:4px;display:inline-flex;width:auto">${icon.back} Cancel</a></p>
    <div class="page-head"><div><h1>${taken ? 'Add borrowing' : 'New loan'}</h1><div class="sub">${taken ? 'Record money you have borrowed from a lender' : 'Choose the customer, then set the terms'}</div></div></div>
    <div class="nl-grid">
      <div class="stack">
        <section class="section"><div class="section-head"><h2>${taken ? 'Lender' : 'Customer'}</h2></div><div class="section-body" id="nl-party"></div></section>
        <section class="section"><div class="section-head"><h2>Loan terms</h2></div><div class="section-body">
          <form id="nl-form" novalidate class="stack" style="gap:16px">
            <div class="field"><span class="lbl">Type</span>
              <div class="segmented" id="nl-type">
                <button type="button" data-type="emi_monthly" aria-pressed="true">Monthly EMI</button>
                <button type="button" data-type="emi_daily" aria-pressed="false">Daily EMI</button>
                <button type="button" data-type="interest_only" aria-pressed="false">Interest only</button></div></div>
            <div class="form-grid">
              <div class="field"><label for="nl-principal">Loan amount</label><div class="input-affix"><span>₹</span><input id="nl-principal" name="principal" type="number" inputmode="decimal" min="1" step="0.01"></div></div>
              <div class="field"><label for="nl-fee">Processing fee (optional)</label><div class="input-affix"><span>₹</span><input id="nl-fee" name="processing_fee" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div>
                <div class="hint" id="nl-net"></div></div>
              <div class="field"><label for="nl-start">${taken ? 'Date money received' : 'Date money given'}</label><input id="nl-start" name="start_date" type="date" value="${todayLocal()}"></div>
              <div class="field" id="w-mode"><span class="lbl">How is the EMI decided?</span>
                <div class="segmented" id="nl-emimode"><button type="button" data-mode="rate" aria-pressed="true">Interest rate</button><button type="button" data-mode="fixed" aria-pressed="false">Fixed EMI</button></div></div>
              <div class="field" id="w-rate"><label for="nl-rate" id="l-rate">Interest rate (% per month, flat)</label><div class="input-affix suffix"><span>%</span><input id="nl-rate" name="rate" type="number" inputmode="decimal" min="0" step="0.01"></div></div>
              <div class="field" id="w-fixed" hidden><label for="nl-fixed" id="l-fixed">EMI amount (per month)</label><div class="input-affix"><span>₹</span><input id="nl-fixed" name="fixed_installment" type="number" inputmode="decimal" min="0" step="0.01"></div></div>
              <div class="field" id="w-tenure"><label for="nl-tenure" id="l-tenure">Tenure (months)</label><input id="nl-tenure" name="tenure" type="number" inputmode="numeric" min="1" step="1"></div>
              <div class="field" id="w-method"><label for="nl-method">Interest is charged on</label><select id="nl-method" name="interest_method"><option value="flat">Full loan amount (flat)</option><option value="reducing">Remaining balance (reducing)</option></select></div>
            </div>
            <details><summary style="cursor:pointer;font-weight:600;color:var(--neel)">More options</summary>
              <div class="form-grid" style="margin-top:14px">
                <div class="field"><label for="nl-first">First due date</label><input id="nl-first" name="first_due_date" type="date"><div class="hint">Leave empty for one month (or one day for daily EMI) after the start date.</div></div>
                <div class="field" id="w-late"><label for="nl-late">Late fee per day (₹)</label><input id="nl-late" name="late_fee_per_day" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Default ${st.late_fee_per_day}"><div class="hint">Charged for each late instalment, each day.</div></div>
                <div class="field"><label for="nl-fc">Foreclosure charge (%)</label><input id="nl-fc" name="foreclosure_charge_pct" type="number" inputmode="decimal" min="0" max="100" step="0.01" placeholder="Default ${st.foreclosure_charge_pct}"><div class="hint">Of principal outstanding, if closed early.</div></div>
                <div class="field"><label for="nl-pol">If closed early</label><select id="nl-pol" name="foreclosure_interest_policy"><option value="">Default (${st.foreclosure_interest_policy === 'full' ? 'all scheduled interest' : 'interest till closing date'})</option><option value="accrued">Interest till closing date only</option><option value="full">All scheduled interest stays payable</option></select></div>
                <div class="field full"><label for="nl-note">Note</label><input id="nl-note" name="note" type="text" maxlength="500"></div>
              </div></details>
          </form></div></section>
      </div>
      <aside class="stack nl-side"><section class="section" id="nl-preview"></section>
        <button class="btn block" id="nl-submit" style="min-height:50px;font-size:17px">${taken ? 'Save borrowing' : 'Give loan'}</button></aside>
    </div>`);

  const $ = (s) => root.querySelector(s);
  const form = $('#nl-form');
  const F = (n) => form.elements[n];

  /* ---- party picker ---- */
  const partyBox = $('#nl-party');
  function paintParty() {
    if (nl.party) {
      mount(partyBox, h`<div class="row between"><div><div style="font-weight:600;font-size:18px">${nl.party.name}</div><div class="muted">${nl.party.phone || 'No phone number'}</div></div>
        <button class="btn quiet small" id="pp-change">Change</button></div>`);
      partyBox.querySelector('#pp-change').addEventListener('click', () => { nl.party = null; nl.addNew = false; paintParty(); });
    } else if (nl.addNew) {
      mount(partyBox, h`<div class="form-grid" id="np-form">
        <div class="field"><label for="np-name">Full name</label><input id="np-name" name="name" type="text" maxlength="120"></div>
        <div class="field"><label for="np-phone">Mobile number</label><input id="np-phone" name="phone" type="tel" inputmode="tel" maxlength="20"></div>
        <div class="field full"><label for="np-addr">Address (optional)</label><input id="np-addr" name="address" type="text" maxlength="255"></div>
        <div class="full"><button class="btn quiet small" id="pp-back" type="button">Search existing ${taken ? 'lenders' : 'customers'} instead</button></div></div>`);
      partyBox.querySelector('#pp-back').addEventListener('click', () => { nl.addNew = false; paintParty(); });
    } else {
      mount(partyBox, h`<div class="stack" style="gap:10px"><div class="search" style="max-width:none">${icon.search}<input type="search" id="pp-q" placeholder="Search by name or phone" aria-label="Search ${taken ? 'lenders' : 'customers'}"></div>
        <div id="pp-res"></div>
        <div><button class="btn secondary small" id="pp-new" type="button">${icon.plus} Add new ${taken ? 'lender' : 'customer'}</button></div></div>`);
      const res = partyBox.querySelector('#pp-res');
      const search = async () => {
        const q = partyBox.querySelector('#pp-q').value.trim();
        const { parties } = await get(`/api/parties?kind=${taken ? 'lender' : 'customer'}${q ? '&q=' + encodeURIComponent(q) : ''}`);
        if (!parties.length) { mount(res, h`<p class="muted">${q ? 'No match. Add them as a new one.' : 'Nobody added yet.'}</p>`); return; }
        mount(res, h`<div class="picker-results">${parties.slice(0, 30).map((p) => h`<button type="button" data-id="${p.id}"><span><b>${p.name}</b></span><span class="muted">${p.phone || ''}${p.active_loans ? ` · ${p.active_loans} active` : ''}</span></button>`)}</div>`);
        res.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { nl.party = parties.find((x) => x.id === Number(b.dataset.id)); paintParty(); refreshPreview(); }));
      };
      partyBox.querySelector('#pp-q').addEventListener('input', debounce(search, 250));
      partyBox.querySelector('#pp-new').addEventListener('click', () => { nl.addNew = true; paintParty(); partyBox.querySelector('#np-name').focus(); });
      search();
    }
  }
  paintParty();
  if (query.party) {
    get(`/api/parties/${query.party}`).then((r) => { nl.party = r.party; paintParty(); }).catch(() => {});
  }

  /* ---- form visibility ---- */
  function syncForm() {
    const t = nl.type;
    const io = t === 'interest_only';
    const emi = !io;
    $('#w-mode').hidden = !emi;
    const fixed = emi && nl.emiMode === 'fixed';
    $('#w-rate').hidden = fixed;
    $('#w-fixed').hidden = !fixed;
    $('#w-tenure').hidden = io;
    $('#w-method').hidden = !(t === 'emi_monthly' && !fixed);
    $('#w-late').hidden = io;
    $('#l-rate').textContent = io ? 'Interest rate (% per month)' : t === 'emi_daily' ? 'Interest rate (% per day, flat)' : 'Interest rate (% per month, flat)';
    $('#l-fixed').textContent = `EMI amount (per ${t === 'emi_daily' ? 'day' : 'month'})`;
    $('#l-tenure').textContent = t === 'emi_daily' ? 'Tenure (days)' : 'Tenure (months)';
    root.querySelectorAll('#nl-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === t)));
    root.querySelectorAll('#nl-emimode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === nl.emiMode)));
  }
  $('#nl-type').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { nl.type = b.dataset.type; syncForm(); refreshPreview(); } });
  $('#nl-emimode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) { nl.emiMode = b.dataset.mode; syncForm(); refreshPreview(); } });
  syncForm();

  function payload() {
    const f = readForm(form);
    const io = nl.type === 'interest_only';
    const fixed = !io && nl.emiMode === 'fixed';
    return {
      direction: taken ? 'taken' : 'given', type: nl.type,
      interest_method: nl.type === 'emi_monthly' && !fixed ? f.interest_method : 'flat',
      principal: numOrNull(f.principal), processing_fee: numOrNull(f.processing_fee) || 0,
      rate: fixed ? null : numOrNull(f.rate), fixed_installment: fixed ? numOrNull(f.fixed_installment) : null,
      tenure: io ? null : numOrNull(f.tenure), start_date: f.start_date || null, first_due_date: strOrNull(f.first_due_date),
      late_fee_per_day: io ? null : numOrNull(f.late_fee_per_day), foreclosure_charge_pct: numOrNull(f.foreclosure_charge_pct),
      foreclosure_interest_policy: strOrNull(f.foreclosure_interest_policy), note: strOrNull(f.note),
    };
  }

  /* ---- live preview ---- */
  const previewEl = $('#nl-preview');
  let lastPreview = null;
  const placeholder = () => mount(previewEl, h`<div class="section-body"><p class="muted" style="padding-top:16px">Enter the amount and ${nl.emiMode === 'fixed' && nl.type !== 'interest_only' ? 'EMI' : 'interest rate'} to see the instalment and total interest.</p></div>`);
  placeholder();
  async function refreshPreview() {
    const p = payload();
    const net = (p.principal || 0) - (p.processing_fee || 0);
    $('#nl-net').textContent = p.principal ? `${taken ? 'You receive' : 'Customer receives'} ${inr(Math.max(0, net))}` : '';
    const ready = p.principal && p.start_date && (nl.type === 'interest_only' ? p.rate !== null : (p.tenure && (p.rate !== null || p.fixed_installment)));
    if (!ready) { placeholder(); lastPreview = null; return; }
    try {
      const r = await post('/api/loans/preview', p);
      lastPreview = r;
      if (r.type === 'interest_only') {
        mount(previewEl, h`<div class="preview-box"><div class="muted">Interest each month</div><div class="big">${inr(r.monthly_interest)}</div>
          <p class="muted" style="margin-top:8px">First due ${fmtDate(r.first_due_date)}. Principal stays outstanding until you record repayments.</p></div>`);
      } else {
        mount(previewEl, h`<div class="preview-box"><div class="muted">${nl.type === 'emi_daily' ? 'Daily instalment' : 'Monthly instalment'}</div><div class="big">${inr(r.installment)}</div>
          <table class="sum" style="margin-top:10px">
            <tr class="sub"><td>Total interest</td><td>${inr(r.total_interest)}</td></tr>
            <tr class="sub"><td>Total payable</td><td>${inr(r.total_payable)}</td></tr>
            <tr class="sub"><td>Interest rate (flat, per ${nl.type === 'emi_daily' ? 'day' : 'month'})</td><td>${r.effective_rate}%</td></tr>
            <tr class="sub"><td>First due</td><td>${fmtDate(r.first_due_date)}</td></tr>
            <tr class="sub"><td>Last due</td><td>${fmtDate(r.last_due_date)}</td></tr></table>
          <button class="btn quiet small" type="button" id="nl-sched" style="margin-top:8px">View full schedule</button></div>`);
        previewEl.querySelector('#nl-sched').addEventListener('click', () => showSchedule(r));
      }
    } catch (err) {
      mount(previewEl, h`<div class="section-body"><div class="notice bad" style="margin-top:16px">${err.message}</div></div>`);
      lastPreview = null;
    }
  }
  function showSchedule(r) {
    openSheet({
      title: 'Repayment schedule', wide: true,
      body: h`<div class="khata" style="margin:0"><div class="khata-scroll"><table><thead><tr><th>#</th><th>Due date</th><th class="r">Instalment</th><th class="r">Principal</th><th class="r">Interest</th></tr></thead>
        <tbody>${r.schedule.map((s) => h`<tr><td class="num">${s.seq}</td><td>${fmtDate(s.due_date)}</td><td class="r num">${inr(s.emi)}</td><td class="r num">${inr(s.principal_due)}</td><td class="r num">${inr(s.interest_due)}</td></tr>`)}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="r num">${inr(r.total_payable)}</td><td class="r num">${inr(r.schedule.reduce((a, s) => a + s.principal_due, 0))}</td><td class="r num">${inr(r.total_interest)}</td></tr></tfoot></table></div></div>`,
    });
  }
  form.addEventListener('input', debounce(refreshPreview, 300));

  /* ---- submit ---- */
  const submit = $('#nl-submit');
  async function save(extra = {}) {
    clearErrors(form);
    const body = { ...payload(), ...extra };
    if (nl.party) body.party_id = nl.party.id;
    else if (nl.addNew) {
      const np = readForm(partyBox);
      body.new_party = { name: np.name, phone: strOrNull(np.phone), address: strOrNull(np.address) };
      if (!np.name) { toast(`Enter the ${taken ? 'lender' : 'customer'}'s name`, 'error'); partyBox.querySelector('#np-name').focus(); return; }
    } else { toast(`Choose a ${taken ? 'lender' : 'customer'} first`, 'error'); partyBox.scrollIntoView({ behavior: 'smooth' }); return; }
    busy(submit, true, 'Saving…');
    try {
      const r = await post('/api/loans', body);
      toast(taken ? 'Borrowing saved' : 'Loan created');
      location.hash = `#/loans/${r.id}`;
    } catch (err) {
      busy(submit, false);
      if (err instanceof ApiError && err.data.code === 'LOW_CASH') {
        const ok = await confirmSheet({ title: 'Not enough cash', message: `Cash in hand is ${inr(err.data.available)} but this loan needs ${inr(err.data.needed)}. Add capital first, or continue anyway and your cash book will go negative.`, confirmLabel: 'Continue anyway' });
        if (ok) save({ allow_low_cash: true });
        return;
      }
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  }
  submit.addEventListener('click', () => save());
}

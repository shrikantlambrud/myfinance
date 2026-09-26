// Payment-related sheets shared by Today and Loan detail: collect, receipt, foreclose, reverse.
import { get, post, ApiError } from '../api.js';
import {
  h, raw, openSheet, toast, inr, fmtDate, todayLocal, readForm, showErrors, clearErrors, numOrNull, strOrNull, busy,
  TYPE_LABEL, waLink, icon, confirmSheet, on, mount,
} from '../ui.js';
import { state, isOwner } from '../state.js';

const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']];
const modeSelect = (v = 'cash') => h`<select name="pay_mode">${MODES.map(([k, l]) => h`<option value="${k}" ${k === v ? raw('selected') : ''}>${l}</option>`)}</select>`;

/* ---------------- collect / record payment ---------------- */
export async function openCollect(loanId, onDone) {
  const d = await get(`/api/loans/${loanId}`);
  const { loan, summary: s } = d;
  if (loan.status !== 'active') { toast('This loan is not active', 'error'); return; }
  const taken = loan.direction === 'taken';
  const io = loan.type === 'interest_only';
  const suggested = s.due_now_amount > 0 ? s.due_now_amount : s.next_due ? s.next_due.amount : 0;

  const status = s.overdue_amount > 0
    ? h`<div class="notice bad"><b>${inr(s.due_now_amount)}</b> due now, ${s.overdue_days} day${s.overdue_days === 1 ? '' : 's'} late</div>`
    : s.next_due ? h`<div class="notice info">Next due ${fmtDate(s.next_due.due_date)}: <b>${inr(s.next_due.amount)}</b></div>` : '';

  const sheet = openSheet({
    title: taken ? 'Pay lender' : 'Collect payment',
    body: h`<div class="stack">
      <div><div style="font-weight:600;font-size:18px">${loan.party.name}</div>
        <div class="muted">${loan.loan_no} · ${TYPE_LABEL[loan.type]} · Principal outstanding <span class="num">${inr(loan.principal_outstanding)}</span></div></div>
      ${status}
      <form id="pay-form" class="form-grid" novalidate>
        <div class="field"><label for="p-amount">Amount received</label>
          <div class="input-affix"><span>₹</span><input id="p-amount" name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${suggested || ''}" required></div></div>
        <div class="field"><label for="p-date">Date</label><input id="p-date" name="paid_on" type="date" value="${todayLocal()}" max="${todayLocal()}"></div>
        ${io ? h`<div class="field full"><label for="p-prin">Of which principal repaid</label>
          <div class="input-affix"><span>₹</span><input id="p-prin" name="principal_amount" type="number" inputmode="decimal" step="0.01" min="0" value="0"></div>
          <div class="hint">The rest of the amount is counted as interest. To close the loan completely, use Foreclose.</div></div>` : ''}
        <div class="field"><label for="p-mode">Paid by</label>${modeSelect()}</div>
        <div class="field"><label for="p-ref">Reference (UPI ID, cheque no.)</label><input id="p-ref" name="ref_no" type="text" maxlength="60"></div>
        <div class="field full"><label for="p-note">Note</label><input id="p-note" name="note" type="text" maxlength="300"></div>
      </form>
      ${io ? '' : h`<p class="faint" style="font-size:14px">Late fee is settled first, then interest, then principal, oldest instalment first.</p>`}
    </div>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn good" id="pay-save">Save payment</button>`,
  });

  const form = sheet.el.querySelector('#pay-form');
  sheet.el.querySelector('#pay-save').addEventListener('click', async (e) => {
    const f = readForm(form);
    clearErrors(form);
    busy(e.target, true, 'Saving…');
    try {
      const r = await post(`/api/loans/${loanId}/payments`, {
        amount: numOrNull(f.amount), paid_on: f.paid_on || null, pay_mode: f.pay_mode,
        ref_no: strOrNull(f.ref_no), note: strOrNull(f.note), principal_amount: io ? numOrNull(f.principal_amount) || 0 : 0,
      });
      sheet.close();
      toast('Payment saved');
      if (onDone) onDone();
      openReceipt(r.id);
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}

/* ---------------- receipt ---------------- */
export async function openReceipt(paymentId) {
  const { receipt: r, business: b } = await get(`/api/payments/${paymentId}`);
  const taken = r.direction === 'taken';
  const lines = [];
  if (r.principal_part) lines.push(['Principal', r.principal_part]);
  if (r.interest_part) lines.push(['Interest', r.interest_part]);
  if (r.penalty_part) lines.push(['Late fee', r.penalty_part]);
  if (r.charge_part) lines.push(['Foreclosure charge', r.charge_part]);
  const wa = waLink(r.party_phone, `${b.name}: ${taken ? 'Paid' : 'Received'} ${inr(r.amount)} on ${fmtDate(r.paid_on)} for loan ${r.loan_no}. Receipt no. ${r.receipt_no}. Thank you.`);
  const sheet = openSheet({
    title: 'Receipt',
    body: h`<div class="receipt">
      <div class="row between"><h3>${b.name}</h3><span class="num faint">${r.receipt_no}</span></div>
      ${b.phone ? h`<div class="muted">${b.phone}</div>` : ''}
      <div class="rule"></div>
      <div class="row between"><span class="muted">${taken ? 'Paid to' : 'Received from'}</span><b>${r.party_name}</b></div>
      <div class="row between"><span class="muted">Loan</span><span class="num">${r.loan_no}</span></div>
      <div class="row between"><span class="muted">Date</span><span>${fmtDate(r.paid_on)}</span></div>
      <div class="row between"><span class="muted">Paid by</span><span>${r.pay_mode.toUpperCase()}${r.ref_no ? ' · ' + r.ref_no : ''}</span></div>
      <div class="rule"></div>
      <table class="sum">
        ${lines.map(([k, v]) => h`<tr class="sub"><td>${k}</td><td>${inr(v)}</td></tr>`)}
        <tr class="total"><td>${r.kind === 'foreclosure' ? 'Loan closed · total' : 'Total'}</td><td>${inr(r.amount)}</td></tr>
      </table>
      ${r.reversed_at ? h`<div class="notice bad" style="margin-top:12px">This payment was reversed.</div>` : ''}
      ${r.received_by ? h`<p class="faint" style="margin-top:14px;font-size:14px">Received by ${r.received_by}</p>` : ''}
    </div>`,
    footer: h`<button class="btn secondary" id="rc-print">${icon.print} Print</button>
      ${wa ? h`<a class="btn secondary" href="${wa}" target="_blank" rel="noopener">${icon.chat} WhatsApp</a>` : ''}
      <button class="btn" data-sheet-close>Done</button>`,
  });
  sheet.el.querySelector('#rc-print').addEventListener('click', () => {
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  });
}

/* ---------------- foreclose ---------------- */
export async function openForeclose(loanId, onDone) {
  const d = await get(`/api/loans/${loanId}`);
  const loan = d.loan;
  const taken = loan.direction === 'taken';
  const owner = isOwner();
  let quote = null;

  const sheet = openSheet({
    title: taken ? 'Pay off loan early' : 'Foreclose loan', wide: true,
    body: h`<div class="stack">
      <div><div style="font-weight:600;font-size:18px">${loan.party.name}</div><div class="muted">${loan.loan_no} · ${TYPE_LABEL[loan.type]}</div></div>
      <form id="fc-form" class="form-grid" novalidate>
        <div class="field"><label for="fc-date">Closing date</label><input id="fc-date" name="date" type="date" value="${todayLocal()}" max="${todayLocal()}" min="${loan.start_date}"></div>
        <div class="field"><label for="fc-mode">Paid by</label>${modeSelect()}</div>
        ${owner ? h`<div class="field"><label for="fc-disc">Discount (waiver)</label>
          <div class="input-affix"><span>₹</span><input id="fc-disc" name="discount" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div>
          <div class="hint">Comes off charges, late fees, then interest. Never principal.</div></div>` : ''}
        <div class="field"><label for="fc-ref">Reference</label><input id="fc-ref" name="ref_no" type="text" maxlength="60"></div>
        <div class="field full"><label for="fc-note">Note</label><input id="fc-note" name="note" type="text" maxlength="300"></div>
      </form>
      <div id="fc-quote"><div class="spinner"></div></div>
    </div>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn danger" id="fc-go" disabled>Foreclose</button>`,
  });
  const form = sheet.el.querySelector('#fc-form');
  const qbox = sheet.el.querySelector('#fc-quote');
  const go = sheet.el.querySelector('#fc-go');

  const payable = () => {
    const disc = owner ? Number(form.elements.discount.value) || 0 : 0;
    return Math.max(0, Math.round((quote.total - disc) * 100) / 100);
  };
  function paint() {
    if (!quote) return;
    const q = quote;
    const disc = owner ? Number(form.elements.discount.value) || 0 : 0;
    const intLabel = q.interest_payable < 0 ? 'Interest rebate (paid ahead)' : 'Interest still to pay';
    mount(qbox, h`<table class="sum">
      <tr><td>Principal outstanding</td><td>${inr(q.principal)}</td></tr>
      <tr class="sub"><td>Interest earned till ${fmtDate(q.as_of)}</td><td>${inr(q.interest_accrued)}</td></tr>
      <tr class="sub"><td>Less interest already paid</td><td>−${inr(q.interest_paid)}</td></tr>
      <tr><td>${intLabel}</td><td>${inr(q.interest_payable)}</td></tr>
      ${q.penalty ? h`<tr><td>Late fees</td><td>${inr(q.penalty)}</td></tr>` : ''}
      ${q.charge ? h`<tr><td>Foreclosure charge (${q.charge_pct}%)</td><td>${inr(q.charge)}</td></tr>` : ''}
      ${disc ? h`<tr><td>Discount</td><td>−${inr(disc)}</td></tr>` : ''}
      <tr class="total"><td>${taken ? 'To pay' : 'Customer pays'}</td><td>${inr(payable())}</td></tr>
    </table>
    ${q.policy === 'full' ? h`<p class="faint" style="font-size:14px;margin-top:10px">This loan’s terms keep all scheduled interest payable on early closure.</p>` : ''}`);
    go.disabled = false;
    go.textContent = `${taken ? 'Pay' : 'Collect'} ${inr(payable())} & close`;
  }
  async function load() {
    go.disabled = true;
    const date = form.elements.date.value;
    if (!date) return;
    try { quote = await get(`/api/loans/${loanId}/foreclosure-quote?date=${date}`); paint(); }
    catch (err) { mount(qbox, h`<div class="notice bad">${err.message}</div>`); }
  }
  form.elements.date.addEventListener('change', load);
  if (owner) form.elements.discount.addEventListener('input', paint);
  load();

  go.addEventListener('click', async () => {
    const f = readForm(form);
    clearErrors(form);
    busy(go, true, 'Closing…');
    try {
      const r = await post(`/api/loans/${loanId}/foreclose`, {
        date: f.date, discount: owner ? numOrNull(f.discount) || 0 : 0, pay_mode: f.pay_mode, ref_no: strOrNull(f.ref_no), note: strOrNull(f.note),
      });
      sheet.close();
      toast('Loan closed');
      if (onDone) onDone();
      openReceipt(r.paymentId);
    } catch (err) {
      busy(go, false);
      go.textContent = `Collect ${inr(payable())} & close`;
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}

/* ---------------- owner actions ---------------- */
export function openReverse(paymentId, receiptNo, onDone) {
  const sheet = openSheet({
    title: 'Reverse payment',
    body: h`<div class="stack"><div class="notice">Reversing ${receiptNo} takes the money out of the cash book and reopens the instalments it paid. The entry stays in the history.</div>
      <form id="rv-form" novalidate><div class="field"><label for="rv-reason">Why is it being reversed?</label><input id="rv-reason" name="reason" type="text" maxlength="300" required></div></form></div>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn danger" id="rv-go">Reverse payment</button>`,
  });
  const form = sheet.el.querySelector('#rv-form');
  sheet.el.querySelector('#rv-go').addEventListener('click', async (e) => {
    busy(e.target, true);
    try {
      await post(`/api/payments/${paymentId}/reverse`, { reason: readForm(form).reason });
      sheet.close(); toast('Payment reversed'); if (onDone) onDone();
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}

export function openReasonSheet({ title, warning, cta, path, onDone }) {
  const sheet = openSheet({
    title,
    body: h`<div class="stack"><div class="notice">${warning}</div>
      <form id="rs-form" novalidate><div class="field"><label for="rs-reason">Reason</label><input id="rs-reason" name="${path.field}" type="text" maxlength="300" required></div></form></div>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn danger" id="rs-go">${cta}</button>`,
  });
  const form = sheet.el.querySelector('#rs-form');
  sheet.el.querySelector('#rs-go').addEventListener('click', async (e) => {
    busy(e.target, true);
    try {
      await post(path.url, { [path.field]: readForm(form)[path.field] });
      sheet.close(); toast('Done'); if (onDone) onDone();
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}
export { confirmSheet };

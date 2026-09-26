import { get, post, patch, ApiError } from '../api.js';
import {
  h, mount, inr, fmtDate, badge, icon, on, toast, openSheet, readForm, showErrors, clearErrors, strOrNull, busy, debounce,
  TYPE_LABEL, telLink, waLink,
} from '../ui.js';
import { state } from '../state.js';

function partyForm(p = {}) {
  return h`<form id="pf" class="form-grid" novalidate>
    <div class="field full"><label for="pf-name">Full name</label><input id="pf-name" name="name" type="text" maxlength="120" value="${p.name || ''}" required></div>
    <div class="field"><label for="pf-phone">Mobile number</label><input id="pf-phone" name="phone" type="tel" inputmode="tel" maxlength="20" value="${p.phone || ''}"></div>
    <div class="field"><label for="pf-alt">Alternate number</label><input id="pf-alt" name="alt_phone" type="tel" inputmode="tel" maxlength="20" value="${p.alt_phone || ''}"></div>
    <div class="field full"><label for="pf-addr">Address</label><input id="pf-addr" name="address" type="text" maxlength="255" value="${p.address || ''}"></div>
    <div class="field"><label for="pf-idt">ID proof type</label><input id="pf-idt" name="id_proof_type" type="text" maxlength="30" placeholder="Aadhaar, PAN, Voter ID…" value="${p.id_proof_type || ''}"></div>
    <div class="field"><label for="pf-idn">ID number</label><input id="pf-idn" name="id_proof_no" type="text" maxlength="40" value="${p.id_proof_no || ''}"><div class="hint">For Aadhaar, store only the last 4 digits.</div></div>
    <div class="field full"><label for="pf-notes">Notes</label><input id="pf-notes" name="notes" type="text" maxlength="500" value="${p.notes || ''}"></div>
  </form>`;
}

function openPartyForm(existing, kind, onDone) {
  const sheet = openSheet({
    title: existing ? 'Edit details' : kind === 'lender' ? 'Add lender' : 'Add customer', body: partyForm(existing),
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn" id="pf-save">Save</button>`,
  });
  const form = sheet.el.querySelector('#pf');
  sheet.el.querySelector('#pf-save').addEventListener('click', async (e) => {
    const f = readForm(form);
    const body = { name: f.name, phone: strOrNull(f.phone), alt_phone: strOrNull(f.alt_phone), address: strOrNull(f.address), id_proof_type: strOrNull(f.id_proof_type), id_proof_no: strOrNull(f.id_proof_no), notes: strOrNull(f.notes) };
    clearErrors(form);
    busy(e.target, true, 'Saving…');
    try {
      const r = existing ? await patch(`/api/parties/${existing.id}`, body) : await post('/api/parties', { ...body, kind });
      sheet.close(); toast('Saved'); onDone(r);
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}

export async function list(root, _p, query) {
  let q = query.q || '';
  mount(root, h`
    <div class="page-head"><div><h1>Customers</h1><div class="sub">People you lend to</div></div><button class="btn" data-action="add-customer">${icon.plus} Add customer</button></div>
    <section class="section">
      <div class="section-head"><div class="search">${icon.search}<input type="search" id="cu-q" placeholder="Search name or phone" value="${q}" aria-label="Search customers"></div></div>
      <div id="cu-body"><div class="spinner"></div></div></section>`);
  const body = root.querySelector('#cu-body');
  async function load() {
    const { parties } = await get('/api/parties?kind=customer' + (q ? '&q=' + encodeURIComponent(q) : ''));
    if (!parties.length) {
      mount(body, h`<div class="empty"><strong>${q ? 'No matches' : 'No customers yet'}</strong>${q ? 'Try a different name or number.' : 'Add a customer, or add one while creating a loan.'}</div>`);
      return;
    }
    mount(body, h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Name</th><th>Phone</th><th class="r">Active loans</th><th class="r">Outstanding</th><th>App login</th></tr></thead><tbody>
      ${parties.map((p) => h`<tr class="click" data-href="#/customers/${p.id}"><td class="first name" data-label="Name">${p.name}<div class="sub">${p.address || ''}</div></td>
        <td data-label="Phone">${p.phone || '–'}</td><td class="r num" data-label="Active loans">${p.active_loans}</td>
        <td class="r num" data-label="Outstanding">${inr(p.outstanding)}</td><td data-label="App login">${p.has_login ? badge('active', 'Has login') : h`<span class="faint">None</span>`}</td></tr>`)}</tbody></table></div>`);
  }
  root.querySelector('#cu-q').addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 250));
  load();
}

export async function detail(root, [id]) {
  const { party: p, loans, portal_login: login } = await get(`/api/parties/${id}`);
  const tel = telLink(p.phone);
  const active = loans.filter((l) => l.status === 'active');
  const outstanding = active.reduce((s, l) => s + l.principal_outstanding, 0);
  mount(root, h`
    <p style="margin-bottom:12px"><a href="#/customers" class="row" style="gap:4px;display:inline-flex;width:auto">${icon.back} Customers</a></p>
    <section class="section">
      <div class="loan-head">
        <div><h1>${p.name}</h1>
          <div class="sub">${tel ? h`<a href="${tel}" class="row" style="gap:4px;display:inline-flex">${icon.phone} ${p.phone}</a>` : h`<span>No phone number</span>`}
            ${p.alt_phone ? h`<span>${p.alt_phone}</span>` : ''}${p.address ? h`<span>${p.address}</span>` : ''}</div></div>
        <div class="row wrap"><a class="btn" href="#/new?party=${p.id}">${icon.plus} New loan</a><button class="btn secondary" data-action="edit-customer" data-id="${p.id}">Edit</button></div>
      </div>
      <div class="loan-kpis"><div><div class="k">Active loans</div><div class="v">${active.length}</div></div>
        <div><div class="k">Principal outstanding</div><div class="v">${inr(outstanding)}</div></div>
        <div><div class="k">All loans</div><div class="v">${loans.length}</div></div></div>
    </section>

    <section class="section"><div class="section-head"><h2>Customer app login</h2></div>
      <div class="section-body">
        ${login ? h`<div class="row between wrap"><div><div>Username <b class="num">${login.username}</b> ${login.is_active ? badge('active', 'Enabled') : badge('closed', 'Disabled')}</div>
            <div class="faint" style="font-size:14px">${login.last_login_at ? 'Last opened ' + fmtDate(login.last_login_at) : 'Has not opened the app yet'}</div></div>
          <button class="btn secondary" data-action="portal" data-id="${p.id}">Reset password</button></div>`
    : h`<div class="row between wrap"><p class="muted" style="max-width:520px">Give ${p.name} a login so they can see their loans, EMI dates, interest and payments on their own phone.</p>
          <button class="btn" data-action="portal" data-id="${p.id}">Create login</button></div>`}
      </div></section>

    <section class="section"><div class="section-head"><h2>Loans</h2></div>
      ${loans.length ? h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Loan</th><th>Type</th><th class="r">Amount</th><th class="r">Outstanding</th><th>Status</th></tr></thead><tbody>
        ${loans.map((l) => h`<tr class="click" data-href="#/loans/${l.id}"><td class="first num name" data-label="Loan">${l.loan_no}<div class="sub">Started ${fmtDate(l.start_date)}</div></td><td data-label="Type">${TYPE_LABEL[l.type]}</td>
          <td class="r num" data-label="Amount">${inr(l.principal)}</td><td class="r num" data-label="Outstanding">${inr(l.principal_outstanding)}</td>
          <td data-label="Status">${l.summary && l.summary.overdue_amount > 0 ? badge('overdue', `${l.summary.overdue_days}d late`) : badge(l.status)}</td></tr>`)}</tbody></table></div>`
    : h`<div class="empty">No loans yet.<br><a class="btn" href="#/new?party=${p.id}">Give first loan</a></div>`}
    </section>`);
  root.__party = p;
}

on('add-customer', () => openPartyForm(null, 'customer', (r) => { location.hash = `#/customers/${r.id}`; }));
on('edit-customer', async (el) => {
  const { party } = await get(`/api/parties/${el.dataset.id}`);
  openPartyForm(party, party.kind, () => state.rerender());
});
on('portal', async (el) => {
  const r = await post(`/api/parties/${el.dataset.id}/portal-access`, {});
  const { party } = await get(`/api/parties/${el.dataset.id}`);
  const url = location.origin + '/portal';
  const msg = `Namaste ${party.name}! You can now see your loans, EMI dates and payments on your phone.\nOpen: ${url}\nUsername: ${r.username}\nTemporary password: ${r.temporary_password}\nYou will be asked to set your own password.`;
  const wa = waLink(party.phone, msg);
  const s = openSheet({
    title: 'Customer login ready',
    body: h`<div class="stack"><div class="notice good">Share these details with ${party.name}. The password is shown only now.</div>
      <table class="sum"><tr><td>Website</td><td>${url}</td></tr><tr><td>Username</td><td>${r.username}</td></tr><tr><td>Temporary password</td><td><b>${r.temporary_password}</b></td></tr></table></div>`,
    footer: h`<button class="btn secondary" id="pa-copy">Copy message</button>${wa ? h`<a class="btn good" href="${wa}" target="_blank" rel="noopener">${icon.chat} Send on WhatsApp</a>` : ''}<button class="btn" data-sheet-close>Done</button>`,
  });
  s.el.querySelector('#pa-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(msg); toast('Copied'); } catch { toast('Could not copy. Select the text instead.', 'error'); }
  });
  state.rerender();
});

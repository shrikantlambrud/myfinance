import { get, post, patch, put, download, ApiError } from '../api.js';
import {
  h, mount, inr, fmtDate, todayLocal, badge, icon, on, toast, openSheet, readForm, showErrors, clearErrors, numOrNull, strOrNull, busy,
} from '../ui.js';
import { state, isOwner } from '../state.js';

/* ---------------- reports ---------------- */
function range(kind) {
  const t = todayLocal();
  const [y, m] = t.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  if (kind === 'month') return { from: `${y}-${pad(m)}-01`, to: t };
  if (kind === 'last') {
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${last}` };
  }
  if (kind === 'fy') return { from: `${m >= 4 ? y : y - 1}-04-01`, to: t };
  return { from: '2000-01-01', to: t };
}
let rep = range('month');
let repKind = 'month';

export async function reports(root) {
  const r = await get(`/api/reports/summary?from=${rep.from}&to=${rep.to}`);
  const ci = await get('/api/reports/customer-interest');
  const line = (k, v, cls = '') => h`<tr class="sub"><td>${k}</td><td class="${cls}">${inr(v)}</td></tr>`;
  const PRESETS = [['month', 'This month'], ['last', 'Last month'], ['fy', 'This financial year'], ['all', 'All time']];
  mount(root, h`
    <div class="page-head"><div><h1>Reports</h1><div class="sub">${fmtDate(r.from)} to ${fmtDate(r.to)}</div></div></div>
    <section class="section">
      <div class="section-head"><div class="chips" id="rp-chips">${PRESETS.map(([k, l]) => h`<button class="chip" data-k="${k}" aria-pressed="${String(k === repKind)}">${l}</button>`)}</div>
        <div class="row wrap"><input type="date" id="rp-from" value="${r.from}" aria-label="From date" style="width:auto"><span class="muted">to</span><input type="date" id="rp-to" value="${r.to}" aria-label="To date" style="width:auto"></div></div>
      <div class="section-body">
        <table class="sum" style="max-width:560px">
          <tr><td colspan="2"><b>Income</b></td></tr>
          ${line('Interest received', r.income.interest)}${line('Late fees', r.income.late_fees)}${line('Foreclosure charges', r.income.foreclosure_charges)}
          ${line('Processing fees', r.income.processing_fees)}${line('Investment profit', r.income.investment_profit)}
          <tr class="total"><td>Total income</td><td>${inr(r.total_income)}</td></tr>
          <tr><td colspan="2" style="padding-top:18px"><b>Costs</b></td></tr>
          ${line('Interest paid on borrowings', r.costs.borrowing_interest)}${line('Fees on borrowings', r.costs.borrowing_fees)}${line('Expenses', r.costs.expenses)}
          <tr class="total"><td>Total costs</td><td>${inr(r.total_costs)}</td></tr>
          <tr class="total"><td>${r.net_profit >= 0 ? 'Net profit' : 'Net loss'}</td><td class="${r.net_profit >= 0 ? 'pos' : 'neg'}">${inr(r.net_profit)}</td></tr>
        </table>
        <p class="faint" style="margin-top:12px;font-size:14px;max-width:560px">Income counts money actually received in this period. Discounts given on foreclosure reduce it automatically.</p>
      </div></section>
    <section class="section"><div class="section-head"><h2>Activity</h2></div>
      <div class="section-body"><div class="facts">
        <div><div class="k">Loans given</div><div class="v num">${r.activity.loans_given} · ${inr(r.activity.disbursed)}</div></div>
        <div><div class="k">Collected from customers</div><div class="v num">${inr(r.activity.collected)}</div><div class="k">${r.activity.payments_received} payments</div></div>
        <div><div class="k">Borrowed</div><div class="v num">${r.activity.loans_taken} · ${inr(r.activity.borrowed)}</div></div>
        <div><div class="k">Repaid to lenders</div><div class="v num">${inr(r.activity.repaid_to_lenders)}</div></div></div></div></section>
    <section class="section">
      <div class="section-head"><h2>Interest received - customer × year</h2>
        <button class="btn secondary small" data-action="dl" data-url="/api/reports/customer-interest.csv" data-name="customer_interest.csv">Download CSV</button></div>
      ${ci.customers.length ? h`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Customer</th>${ci.years.map((y) => h`<th class="r">${y}</th>`)}<th class="r">All time</th></tr></thead><tbody>
          ${ci.customers.map((c) => h`<tr><td class="first name">${c.name}</td>${ci.years.map((y) => h`<td class="r num">${c.years[y] ? inr(c.years[y]) : '–'}</td>`)}<td class="r num" style="font-weight:600">${inr(c.total)}</td></tr>`)}
        </tbody><tfoot><tr><td>Total</td>${ci.years.map((y) => h`<td class="r num">${inr(ci.year_totals[y])}</td>`)}<td class="r num">${inr(ci.grand_total)}</td></tr></tfoot></table></div>`
    : h`<div class="empty">No interest collected yet.</div>`}
    </section>
    <section class="section"><div class="section-head"><h2>Download for Excel</h2></div>
      <div class="section-body row wrap">
        <button class="btn secondary" data-action="dl" data-url="/api/reports/loans.csv?direction=given" data-name="loans.csv">All loans</button>
        <button class="btn secondary" data-action="dl" data-url="/api/reports/loans.csv?direction=taken" data-name="borrowings.csv">Borrowings</button>
        <button class="btn secondary" data-action="dl" data-url="/api/reports/payments.csv?from=${r.from}&to=${r.to}" data-name="payments.csv">Payments in this period</button>
        <button class="btn secondary" data-action="dl" data-url="/api/reports/ledger.csv?from=${r.from}&to=${r.to}" data-name="cashbook.csv">Cash book in this period</button></div></section>`);
  root.querySelector('#rp-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { repKind = b.dataset.k; rep = range(repKind); state.rerender(); } });
  const dates = () => {
    const f = root.querySelector('#rp-from').value, t = root.querySelector('#rp-to').value;
    if (f && t && f <= t) { rep = { from: f, to: t }; repKind = ''; state.rerender(); }
  };
  root.querySelector('#rp-from').addEventListener('change', dates);
  root.querySelector('#rp-to').addEventListener('change', dates);
}
on('dl', async (el) => { await download(el.dataset.url, el.dataset.name); });

/* ---------------- team ---------------- */
export async function team(root) {
  const { users } = await get('/api/users');
  mount(root, h`
    <div class="page-head"><div><h1>Team</h1><div class="sub">People who can sign in to run the business</div></div><button class="btn" data-action="user-add">${icon.plus} Add person</button></div>
    <section class="section"><div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last sign in</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => h`<tr><td class="first name" data-label="Name">${u.name}</td><td class="num" data-label="Username">${u.username}</td>
        <td data-label="Role">${u.role === 'owner' ? 'Owner' : 'Staff'}</td><td data-label="Last sign in">${u.last_login_at ? fmtDate(u.last_login_at) : 'Never'}</td>
        <td data-label="Status">${u.is_active ? badge('active', 'Active') : badge('closed', 'Disabled')}</td>
        <td class="r noLabel"><button class="btn quiet small" data-action="user-edit" data-id="${u.id}" data-name="${u.name}" data-role="${u.role}" data-active="${u.is_active ? 1 : 0}">Edit</button></td></tr>`)}</tbody></table></div></section>
    <section class="section"><div class="section-body" style="padding-top:18px"><p class="muted"><b>Owner</b> can see cash, reports and investments, give discounts, reverse payments and manage the team.
      <b>Staff</b> can add customers and loans and collect payments, but cannot see the business's cash or profit.</p></div></section>`);
}

const roleSelect = (v) => h`<select name="role"><option value="staff" ${v === 'staff' ? 'selected' : ''}>Staff: collects and enters loans</option><option value="owner" ${v === 'owner' ? 'selected' : ''}>Owner: full access</option></select>`;

on('user-add', () => {
  const s = openSheet({
    title: 'Add person',
    body: h`<form id="ua" class="form-grid" novalidate>
      <div class="field"><label for="ua-n">Full name</label><input id="ua-n" name="name" type="text" maxlength="120"></div>
      <div class="field"><label for="ua-u">Username</label><input id="ua-u" name="username" type="text" autocapitalize="none" maxlength="40"><div class="hint">Letters and digits, no spaces.</div></div>
      <div class="field"><label for="ua-r">Role</label>${roleSelect('staff')}</div>
      <div class="field"><label for="ua-p">Temporary password</label><input id="ua-p" name="password" type="text" autocomplete="off" maxlength="200"><div class="hint">At least 8 characters. They change it at first sign in.</div></div></form>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn" id="ua-go">Add person</button>`,
  });
  const form = s.el.querySelector('#ua');
  s.el.querySelector('#ua-go').addEventListener('click', async (e) => {
    clearErrors(form);
    busy(e.target, true);
    try { await post('/api/users', readForm(form)); s.close(); toast('Person added'); state.rerender(); }
    catch (err) { busy(e.target, false); if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return; toast(err.message, 'error'); }
  });
});

on('user-edit', (el) => {
  const id = el.dataset.id;
  const s = openSheet({
    title: `Edit ${el.dataset.name}`,
    body: h`<form id="ue" class="form-grid" novalidate>
      <div class="field"><label for="ue-n">Full name</label><input id="ue-n" name="name" type="text" maxlength="120" value="${el.dataset.name}"></div>
      <div class="field"><label for="ue-r">Role</label>${roleSelect(el.dataset.role)}</div>
      <div class="field"><label for="ue-a">Status</label><select id="ue-a" name="is_active"><option value="1" ${el.dataset.active === '1' ? 'selected' : ''}>Active</option><option value="0" ${el.dataset.active === '0' ? 'selected' : ''}>Disabled</option></select></div>
      <div class="field"><label for="ue-p">Reset password</label><input id="ue-p" name="new_password" type="text" autocomplete="off" placeholder="Leave empty to keep"><div class="hint">They must change it at next sign in.</div></div></form>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn" id="ue-go">Save</button>`,
  });
  const form = s.el.querySelector('#ue');
  s.el.querySelector('#ue-go').addEventListener('click', async (e) => {
    const f = readForm(form);
    clearErrors(form);
    busy(e.target, true);
    try {
      await patch(`/api/users/${id}`, { name: f.name, role: f.role, is_active: f.is_active === '1', new_password: strOrNull(f.new_password) });
      s.close(); toast('Saved'); state.rerender();
    } catch (err) { busy(e.target, false); if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return; toast(err.message, 'error'); }
  });
});

/* ---------------- settings ---------------- */
export async function settings(root) {
  const { settings: s } = await get('/api/settings');
  mount(root, h`
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Defaults for new loans. Existing loans keep the terms they were given.</div></div></div>
    <section class="section"><div class="section-body" style="padding-top:20px"><form id="st" class="form-grid" novalidate style="max-width:720px">
      <div class="field"><label for="st-n">Business name</label><input id="st-n" name="business_name" type="text" maxlength="80" value="${s.business_name}"><div class="hint">Shown on receipts and in the customer app.</div></div>
      <div class="field"><label for="st-p">Business phone</label><input id="st-p" name="business_phone" type="tel" maxlength="20" value="${s.business_phone}"></div>
      <div class="field"><label for="st-l">Late fee per day</label><div class="input-affix"><span>₹</span><input id="st-l" name="late_fee_per_day" type="number" min="0" step="0.01" value="${s.late_fee_per_day}"></div><div class="hint">For each late EMI instalment, each day. 0 means no late fee.</div></div>
      <div class="field"><label for="st-f">Foreclosure charge</label><div class="input-affix suffix"><span>%</span><input id="st-f" name="foreclosure_charge_pct" type="number" min="0" max="100" step="0.01" value="${s.foreclosure_charge_pct}"></div><div class="hint">Of principal outstanding when a customer closes early.</div></div>
      <div class="field full"><label for="st-pol">When a customer closes early, they pay</label>
        <select id="st-pol" name="foreclosure_interest_policy"><option value="accrued" ${s.foreclosure_interest_policy === 'accrued' ? 'selected' : ''}>Interest only till the closing date (fair, gives a rebate on unearned interest)</option>
          <option value="full" ${s.foreclosure_interest_policy === 'full' ? 'selected' : ''}>All the interest in the original schedule (no rebate)</option></select></div>
      <div class="full"><button class="btn" type="button" id="st-save">Save settings</button></div></form></div></section>`);
  const form = root.querySelector('#st');
  root.querySelector('#st-save').addEventListener('click', async (e) => {
    const f = readForm(form);
    clearErrors(form);
    busy(e.target, true);
    try {
      const r = await put('/api/settings', { business_name: f.business_name, business_phone: strOrNull(f.business_phone), late_fee_per_day: numOrNull(f.late_fee_per_day) || 0, foreclosure_charge_pct: numOrNull(f.foreclosure_charge_pct) || 0, foreclosure_interest_policy: f.foreclosure_interest_policy });
      state.settings = r.settings;
      toast('Settings saved');
      busy(e.target, false);
    } catch (err) { busy(e.target, false); if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return; toast(err.message, 'error'); }
  });
}

/* ---------------- mobile menu ---------------- */
export async function more(root) {
  const owner = isOwner();
  const items = [
    ...(owner ? [['#/cash', 'Cash book', icon.cash], ['#/invest', 'Investments', icon.invest], ['#/borrowed', 'Borrowed money', icon.borrow], ['#/analytics', 'Analytics', icon.chart], ['#/reports', 'Reports', icon.report], ['#/team', 'Team', icon.team], ['#/settings', 'Settings', icon.settings]] : []),
  ];
  mount(root, h`<div class="page-head"><div><h1>More</h1><div class="sub">Signed in as ${state.user.name}</div></div></div>
    <section class="section">${items.map(([href, label, ic]) => h`<a class="list-row" href="${href}" style="text-decoration:none;color:inherit"><span style="width:22px;display:inline-grid">${ic}</span><span class="t grow">${label}</span></a>`)}
      <button class="list-row" data-action="logout" style="width:100%;background:none;border:0;text-align:left;border-top:1px solid var(--rule-soft)"><span style="width:22px;display:inline-grid">${icon.logout}</span><span class="t grow">Sign out</span></button></section>`);
}

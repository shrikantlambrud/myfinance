import { get, post, del, ApiError } from '../api.js';
import {
  h, raw, mount, inr, fmtDate, todayLocal, badge, icon, on, toast, openSheet, confirmSheet, readForm, showErrors, clearErrors,
  numOrNull, strOrNull, busy,
} from '../ui.js';
import { state } from '../state.js';

const KIND = {
  capital_in: 'Capital added', capital_out: 'Capital withdrawn', loan_disbursement: 'Loan given', loan_repayment: 'Repayment received',
  borrowing_in: 'Money borrowed', borrowing_repayment: 'Repaid to lender', investment_out: 'Investment made', investment_return: 'Investment return',
  expense: 'Expense', other_in: 'Other income',
};
const GROUPS = [
  ['all', 'All', null],
  ['capital', 'Capital', ['capital_in', 'capital_out']],
  ['loans', 'Loans given', ['loan_disbursement']],
  ['repay', 'Repayments', ['loan_repayment', 'borrowing_repayment', 'borrowing_in']],
  ['other', 'Expenses & other', ['expense', 'other_in', 'investment_out', 'investment_return']],
];
let group = 'all';
let showBalance = true;

export async function cash(root) {
  const data = await get('/api/ledger?limit=500');
  const g = GROUPS.find((x) => x[0] === group);

  // Running balance is computed over the FULL history (not the filtered/grouped view),
  // oldest first, then looked up per row so it stays correct regardless of which group is shown.
  const chrono = [...data.entries].sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id));
  let running = data.cash - chrono.filter((e) => !e.reversed_at).reduce((t, e) => t + (e.direction === 'in' ? 1 : -1) * e.amount, 0);
  const balanceAfter = new Map();
  chrono.forEach((e) => { if (!e.reversed_at) running += (e.direction === 'in' ? 1 : -1) * e.amount; balanceAfter.set(e.id, running); });

  const rows = data.entries.filter((e) => !g[2] || g[2].includes(e.kind));

  mount(root, h`
    <div class="page-head"><div><h1>Cash book</h1><div class="sub">Every rupee that came in or went out</div></div>
      <div class="row wrap"><button class="btn" data-action="cash-entry" data-kind="capital_in">${icon.plus} Add capital</button>
        <button class="btn secondary" data-action="cash-entry" data-kind="expense">Add expense</button>
        <button class="btn secondary" data-action="cash-entry" data-kind="capital_out">Withdraw</button></div></div>
    <div class="strip">
      <div><div class="k">Cash in hand</div><div class="v ${data.cash < 0 ? 'neg' : ''}">${inr(data.cash)}</div></div>
      <div><div class="k">Your capital</div><div class="v">${inr(data.capital)}</div></div>
      <div><div class="k">Total in</div><div class="v pos">${inr(data.totals.money_in)}</div></div>
      <div><div class="k">Total out</div><div class="v">${inr(data.totals.money_out)}</div></div>
    </div>
    <div style="height:18px"></div>
    <section class="section">
      <div class="section-head"><div class="chips" id="cb-chips">${GROUPS.map(([k, l]) => h`<button class="chip" data-g="${k}" aria-pressed="${String(k === group)}">${l}</button>`)}</div>
        <button class="chip" id="cb-bal-toggle">${showBalance ? 'Hide balance' : 'Show balance'}</button></div>
      ${rows.length ? h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Date</th><th>Details</th><th class="r">In</th><th class="r">Out</th>${showBalance ? h`<th class="r">Balance</th>` : ''}<th></th></tr></thead><tbody>
        ${rows.map((e) => h`<tr class="${e.reversed_at ? 'is-waived' : ''}"><td class="first" data-label="Date">${fmtDate(e.entry_date)}</td>
          <td data-label="Details"><b>${KIND[e.kind] || e.kind}</b>${e.reversed_at ? h` <span class="badge overdue">Reversed</span>` : ''}<div class="sub">${e.note || ''}</div></td>
          <td class="r num pos" data-label="In">${e.direction === 'in' ? inr(e.amount) : ''}</td><td class="r num" data-label="Out">${e.direction === 'out' ? inr(e.amount) : ''}</td>
          ${showBalance ? h`<td class="r num" data-label="Balance">${inr(balanceAfter.get(e.id))}</td>` : ''}
          <td class="r noLabel">${e.manual && !e.reversed_at ? h`<button class="btn quiet small neg" data-action="cash-reverse" data-id="${e.id}">Reverse</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : h`<div class="empty"><strong>Nothing here yet</strong>Add your starting capital to begin.</div>`}
    </section>`);
  root.querySelector('#cb-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (b) { group = b.dataset.g; state.rerender(); } });
  root.querySelector('#cb-bal-toggle').addEventListener('click', () => { showBalance = !showBalance; state.rerender(); });
}

on('cash-entry', (el) => {
  const kind = el.dataset.kind;
  const titles = { capital_in: 'Add capital', capital_out: 'Withdraw capital', expense: 'Add expense' };
  const sheet = openSheet({
    title: titles[kind],
    body: h`<form id="ce" class="form-grid" novalidate>
      <div class="field"><label for="ce-a">Amount</label><div class="input-affix"><span>₹</span><input id="ce-a" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01"></div></div>
      <div class="field"><label for="ce-d">Date</label><input id="ce-d" name="entry_date" type="date" value="${todayLocal()}" max="${todayLocal()}"></div>
      <div class="field full"><label for="ce-n">Note</label><input id="ce-n" name="note" type="text" maxlength="300" placeholder="${kind === 'expense' ? 'Rent, salary, stationery…' : 'e.g. Own money added'}"></div></form>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn" id="ce-go">Save</button>`,
  });
  const form = sheet.el.querySelector('#ce');
  async function save(extra = {}) {
    const f = readForm(form);
    clearErrors(form);
    const btn = sheet.el.querySelector('#ce-go');
    busy(btn, true, 'Saving…');
    try {
      await post('/api/ledger', { kind, amount: numOrNull(f.amount), entry_date: f.entry_date, note: strOrNull(f.note), ...extra });
      sheet.close(); toast('Saved'); state.rerender();
    } catch (err) {
      busy(btn, false);
      if (err instanceof ApiError && err.data.code === 'LOW_CASH') {
        if (await confirmSheet({ title: 'Not enough cash', message: `Cash in hand is only ${inr(err.data.available)}. Continue anyway?`, confirmLabel: 'Continue' })) save({ allow_low_cash: true });
        return;
      }
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  }
  sheet.el.querySelector('#ce-go').addEventListener('click', () => save());
});

on('cash-reverse', async (el) => {
  if (!(await confirmSheet({ title: 'Reverse this entry?', message: 'It stays in the list, marked as reversed, and no longer counts towards your cash.', confirmLabel: 'Reverse', danger: true }))) return;
  await post(`/api/ledger/${el.dataset.id}/reverse`);
  toast('Entry reversed');
  state.rerender();
});

/* ---------------- investments ---------------- */
export async function invest(root) {
  const { investments } = await get('/api/investments');
  const outstanding = investments.reduce((s, i) => s + i.outstanding, 0);
  const profit = investments.reduce((s, i) => s + i.profit, 0);
  mount(root, h`
    <div class="page-head"><div><h1>Investments</h1><div class="sub">IPOs and other money you have put outside lending</div></div>
      <button class="btn" data-action="inv-add">${icon.plus} New investment</button></div>
    <div class="strip c3"><div><div class="k">Money invested</div><div class="v">${inr(outstanding)}</div><div class="s">Still outstanding</div></div>
      <div><div class="k">Profit booked</div><div class="v pos">${inr(profit)}</div></div>
      <div><div class="k">Investments</div><div class="v">${investments.length}</div><div class="s">${investments.filter((i) => i.status === 'active').length} active</div></div></div>
    <div style="height:18px"></div>
    <section class="section">
      ${investments.length ? h`<div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Name</th><th class="r">Invested</th><th class="r">Returned</th><th class="r">Profit</th><th class="r">Outstanding</th><th>Status</th></tr></thead><tbody>
        ${investments.map((i) => h`<tr class="click" data-action="inv-open" data-id="${i.id}"><td class="first name" data-label="Name">${i.name}<div class="sub">${fmtDate(i.invested_on)}</div></td>
          <td class="r num" data-label="Invested">${inr(i.amount)}</td><td class="r num" data-label="Returned">${inr(i.total_returned)}</td><td class="r num pos" data-label="Profit">${inr(i.profit)}</td>
          <td class="r num" data-label="Outstanding">${inr(i.outstanding)}</td><td data-label="Status">${badge(i.status)}</td></tr>`)}</tbody></table></div>`
    : h`<div class="empty"><strong>No investments yet</strong>Track IPO applications and other investments here. The money leaves your cash book when you add one.</div>`}
    </section>`);
}

on('inv-add', () => {
  const sheet = openSheet({
    title: 'New investment',
    body: h`<form id="iv" class="form-grid" novalidate>
      <div class="field full"><label for="iv-n">Name</label><input id="iv-n" name="name" type="text" maxlength="150" placeholder="e.g. Tata Capital IPO"></div>
      <div class="field"><label for="iv-a">Amount invested</label><div class="input-affix"><span>₹</span><input id="iv-a" name="amount" type="number" inputmode="decimal" min="1" step="0.01"></div></div>
      <div class="field"><label for="iv-d">Date</label><input id="iv-d" name="invested_on" type="date" value="${todayLocal()}" max="${todayLocal()}"></div>
      <div class="field full"><label for="iv-t">Note</label><input id="iv-t" name="note" type="text" maxlength="300"></div></form>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn" id="iv-go">Save investment</button>`,
  });
  const form = sheet.el.querySelector('#iv');
  sheet.el.querySelector('#iv-go').addEventListener('click', async (e) => {
    const f = readForm(form);
    clearErrors(form);
    busy(e.target, true);
    try {
      await post('/api/investments', { name: f.name, amount: numOrNull(f.amount), invested_on: f.invested_on, note: strOrNull(f.note) });
      sheet.close(); toast('Investment added'); state.rerender();
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
});

on('inv-open', async (el) => {
  const id = el.dataset.id;
  const { investment: i, returns } = await get(`/api/investments/${id}`);
  const sheet = openSheet({
    title: i.name, wide: true,
    body: h`<div class="stack">
      <div class="facts"><div><div class="k">Invested</div><div class="v num">${inr(i.amount)}</div></div><div><div class="k">Principal back</div><div class="v num">${inr(i.principal_returned)}</div></div>
        <div><div class="k">Profit</div><div class="v num pos">${inr(i.profit)}</div></div><div><div class="k">Outstanding</div><div class="v num">${inr(i.outstanding)}</div></div></div>
      <div class="row between"><h3>Returns</h3>${i.outstanding > 0 ? h`<button class="btn small" id="iv-addret">${icon.plus} Add return</button>` : ''}</div>
      ${returns.length ? h`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th class="r">Principal</th><th class="r">Profit</th><th></th></tr></thead><tbody>
        ${returns.map((r) => h`<tr class="${r.reversed_at ? 'is-waived' : ''}"><td>${fmtDate(r.returned_on)}${r.note ? h`<div class="sub">${r.note}</div>` : ''}</td><td class="r num">${inr(r.principal_part)}</td><td class="r num">${inr(r.profit_part)}</td>
          <td class="r">${r.reversed_at ? badge('overdue', 'Reversed') : h`<button class="btn quiet small neg" data-rev="${r.id}">Reverse</button>`}</td></tr>`)}</tbody></table></div>`
    : h`<p class="muted">No returns yet.</p>`}
      ${!returns.some((r) => !r.reversed_at) ? h`<div><button class="btn quiet small neg" id="iv-del">Delete this investment</button></div>` : ''}
    </div>`,
  });
  const reload = () => { sheet.close(); state.rerender(); };
  const addBtn = sheet.el.querySelector('#iv-addret');
  if (addBtn) addBtn.addEventListener('click', () => { sheet.close(); openReturn(i); });
  sheet.el.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Reverse this return?', message: 'The money will be taken out of your cash book again.', confirmLabel: 'Reverse', danger: true }))) return;
    await post(`/api/investment-returns/${b.dataset.rev}/reverse`); toast('Reversed'); reload();
  }));
  const delBtn = sheet.el.querySelector('#iv-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Delete investment?', message: 'The amount goes back into your cash book.', confirmLabel: 'Delete', danger: true }))) return;
    try { await del(`/api/investments/${id}`); toast('Investment deleted'); reload(); } catch (err) { toast(err.message, 'error'); }
  });
});

function openReturn(i) {
  const sheet = openSheet({
    title: `Return: ${i.name}`,
    body: h`<div class="stack"><p class="muted">Outstanding principal: <b class="num">${inr(i.outstanding)}</b>. Enter the profit and the principal you got back separately. If only profit came in, leave principal at 0.</p>
      <form id="ir" class="form-grid" novalidate>
        <div class="field"><label for="ir-p">Principal recovered</label><div class="input-affix"><span>₹</span><input id="ir-p" name="principal_part" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div></div>
        <div class="field"><label for="ir-f">Profit</label><div class="input-affix"><span>₹</span><input id="ir-f" name="profit_part" type="number" inputmode="decimal" min="0" step="0.01" value="0"></div></div>
        <div class="field"><label for="ir-d">Date</label><input id="ir-d" name="returned_on" type="date" value="${todayLocal()}" max="${todayLocal()}"></div>
        <div class="field"><label for="ir-n">Note</label><input id="ir-n" name="note" type="text" maxlength="300"></div></form></div>`,
    footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn good" id="ir-go">Save return</button>`,
  });
  const form = sheet.el.querySelector('#ir');
  sheet.el.querySelector('#ir-go').addEventListener('click', async (e) => {
    const f = readForm(form);
    clearErrors(form);
    busy(e.target, true);
    try {
      await post(`/api/investments/${i.id}/returns`, { principal_part: numOrNull(f.principal_part) || 0, profit_part: numOrNull(f.profit_part) || 0, returned_on: f.returned_on, note: strOrNull(f.note) });
      sheet.close(); toast('Return saved'); state.rerender();
    } catch (err) {
      busy(e.target, false);
      if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
      toast(err.message, 'error');
    }
  });
}

import { get } from '../api.js';
import { h, mount, inr, fmtDate, badge, icon, on, waLink, telLink, TYPE_LABEL } from '../ui.js';
import { state, isOwner } from '../state.js';
import { openCollect, openReceipt } from './payments.js';

function workRow(d, settings) {
  const late = d.overdue_days > 0;
  const msg = `Namaste ${d.name}, a reminder from ${settings.business_name}: ${inr(d.due_now)} is due on loan ${d.loan_no}. Please pay at the earliest. Thank you.`;
  const wa = waLink(d.phone, msg);
  const tel = telLink(d.phone);
  return h`<li class="work ${late ? 'late' : ''}">
    <div class="grow">
      <div class="who"><a href="#/loans/${d.loan_id}" style="color:inherit">${d.name}</a>
        ${late ? h`<span class="badge overdue">${d.overdue_days} day${d.overdue_days === 1 ? '' : 's'} late</span>` : h`<span class="badge due">Due today</span>`}</div>
      <div class="meta"><span class="num">${d.loan_no}</span><span>${TYPE_LABEL[d.type]}</span><span>Outstanding ${inr(d.principal_outstanding)}</span></div>
    </div>
    <div class="row wrap" style="justify-content:flex-end;gap:14px">
      <div class="amt">${inr(d.due_now)}</div>
      <div class="acts">
        ${tel ? h`<a class="btn secondary small" href="${tel}" aria-label="Call ${d.name}">${icon.phone}</a>` : ''}
        ${wa ? h`<a class="btn secondary small" href="${wa}" target="_blank" rel="noopener" aria-label="Send WhatsApp reminder to ${d.name}">${icon.chat}</a>` : ''}
        <button class="btn small" data-action="collect" data-loan="${d.loan_id}">Collect</button>
      </div>
    </div>
  </li>`;
}

export async function view(root) {
  const [dash, col] = await Promise.all([get('/api/dashboard'), get('/api/collections')]);
  const owner = isOwner();
  const t = col.totals;
  const expected = t.collected_today + t.due_now;
  const pct = expected > 0 ? Math.min(100, Math.round((t.collected_today / expected) * 100)) : 100;
  const upcomingTotal = col.upcoming.reduce((s, u) => s + u.next_due_amount, 0);

  const heroNote = t.due_count
    ? `${t.due_count} customer${t.due_count === 1 ? '' : 's'} to collect from${t.overdue_count ? ` · ${t.overdue_count} overdue` : ''}${col.upcoming.length ? ` · ${inr(upcomingTotal)} more due in the next 7 days` : ''}`
    : col.upcoming.length ? `Nothing due today. ${inr(upcomingTotal)} comes due in the next 7 days.` : 'Nothing due today.';

  const strip = owner
    ? h`<div class="strip">
        <div><div class="k">Cash in hand</div><div class="v">${inr(dash.cash)}</div><div class="s">Capital ${inr(dash.capital)}</div></div>
        <div><div class="k">Lent out</div><div class="v">${inr(dash.lent.principal_outstanding)}</div><div class="s">${dash.lent.count} active loan${dash.lent.count === 1 ? '' : 's'}</div></div>
        <div><div class="k">Overdue</div><div class="v ${dash.overdue.amount > 0 ? 'neg' : ''}">${inr(dash.overdue.amount)}</div><div class="s">${dash.overdue.count} loan${dash.overdue.count === 1 ? '' : 's'}${dash.overdue.par30_pct ? ` · ${dash.overdue.par30_pct}% of book is 30+ days late` : ''}</div></div>
        <div><div class="k">Earned this month</div><div class="v pos">${inr(dash.month.total)}</div><div class="s">Interest ${inr(dash.month.interest)} · Fees ${inr(dash.month.processing_fees + dash.month.late_fees + dash.month.charges)}</div></div>
      </div>`
    : h`<div class="strip c3">
        <div><div class="k">Lent out</div><div class="v">${inr(dash.lent.principal_outstanding)}</div><div class="s">${dash.lent.count} active loans</div></div>
        <div><div class="k">Overdue</div><div class="v ${dash.overdue.amount > 0 ? 'neg' : ''}">${inr(dash.overdue.amount)}</div><div class="s">${dash.overdue.count} loans</div></div>
        <div><div class="k">Collected today</div><div class="v pos">${inr(dash.today.collected)}</div></div>
      </div>`;

  mount(root, h`
    <div class="page-head"><div><h1>Today</h1><div class="sub">${fmtDate(col.as_of)}</div></div>
      <a class="btn" href="#/new">${icon.plus} New loan</a></div>

    <section class="section">
      <div class="hero">
        <div class="hero-top">
          <div><div class="cap">Collected today</div>
            <div class="big">${inr(t.collected_today)} <small>of ${inr(expected)}</small></div></div>
        </div>
        <div class="meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Collection progress"><i data-w="${pct}"></i></div>
        <div class="hero-note">${heroNote}</div>
      </div>
      ${col.due.length
        ? h`<ul class="worklist">${col.due.map((d) => workRow(d, state.settings))}</ul>`
        : h`<div class="empty"><strong>All caught up</strong>Nobody owes you anything today.<br><a class="btn secondary" href="#/new">Give a new loan</a></div>`}
    </section>

    ${col.upcoming.length ? h`<section class="section">
      <div class="section-head"><h2>Coming up this week</h2><span class="muted num">${inr(upcomingTotal)}</span></div>
      <div class="tbl-wrap"><table class="tbl stackable"><thead><tr><th>Customer</th><th>Due on</th><th class="r">Amount</th><th></th></tr></thead><tbody>
        ${col.upcoming.map((u) => h`<tr class="click" data-href="#/loans/${u.loan_id}">
          <td class="first name" data-label="Customer">${u.name}<div class="sub">${u.loan_no}</div></td>
          <td data-label="Due on">${fmtDate(u.next_due_date)}</td>
          <td class="r num" data-label="Amount">${inr(u.next_due_amount)}</td>
          <td class="r noLabel"><button class="btn secondary small" data-action="collect" data-loan="${u.loan_id}">Collect early</button></td></tr>`)}
      </tbody></table></div></section>` : ''}

    <div style="height:18px"></div>
    ${strip}

    <section class="section">
      <div class="section-head"><h2>Recent payments</h2></div>
      ${dash.recent_payments.length
        ? h`<div class="section-body flush">${dash.recent_payments.map((p) => h`<div class="list-row" data-action="receipt" data-id="${p.id}">
            <div class="grow"><div class="t">${p.party_name}</div><div class="s">${p.loan_no} · ${fmtDate(p.paid_on)} · ${p.receipt_no}</div></div>
            <div class="num ${p.direction === 'taken' ? 'neg' : 'pos'}" style="font-weight:600">${p.direction === 'taken' ? '−' : '+'}${inr(p.amount)}</div></div>`)}</div>`
        : h`<div class="empty">Payments you record will show up here.</div>`}
    </section>`);
}

on('collect', (el) => openCollect(Number(el.dataset.loan), () => state.rerender()));
on('receipt', (el) => openReceipt(Number(el.dataset.id)));

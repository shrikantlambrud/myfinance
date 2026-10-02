import { get } from '../api.js';
import { h, mount, inr, debounce } from '../ui.js';
import { barChart, lineChart, donutChart, hbars, legend, compact } from '../charts.js';
import { state } from '../state.js';

let nMonths = 12;
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (ym) => `${MN[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const mfull = (ym) => `${MN[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const RANGES = [[6, '6 months'], [12, '12 months'], [24, '24 months']];

function insights(d) {
  const k = d.kpis;
  const out = [];
  if (k.interest_prev_month > 0) {
    const ch = Math.round(((k.interest_this_month - k.interest_prev_month) / k.interest_prev_month) * 100);
    out.push({ tone: ch >= 0 ? 'good' : 'warn', text: `Interest collected this month is ${inr(k.interest_this_month)}, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}% from last month (${inr(k.interest_prev_month)}).` });
  } else if (k.interest_this_month > 0) {
    out.push({ tone: 'good', text: `Interest collected this month: ${inr(k.interest_this_month)}.` });
  }
  if (k.par_pct > 0) {
    out.push({ tone: k.par30_pct > 10 ? 'bad' : 'warn', text: `${k.par_pct}% of the money lent out is overdue (${inr(k.overdue_amount)} due now)${k.par30_pct ? `, and ${k.par30_pct}% is more than 30 days late` : ''}.` });
  } else if (k.active_loans) {
    out.push({ tone: 'good', text: 'Nothing is overdue right now. Every active loan is up to date.' });
  }
  const top = d.portfolio.by_customer.filter((c) => c.name !== 'Others')[0];
  if (top && d.portfolio.outstanding > 0) {
    const share = Math.round((top.value / d.portfolio.outstanding) * 100);
    if (share >= 30) out.push({ tone: 'warn', text: `${top.name} holds ${share}% of all money lent out. Consider spreading the risk across more customers.` });
  }
  const bt = d.portfolio.by_type[0];
  if (bt && d.portfolio.outstanding > 0 && d.portfolio.by_type.length > 1) {
    out.push({ tone: 'info', text: `${Math.round((bt.value / d.portfolio.outstanding) * 100)}% of your book is in ${bt.label} loans.` });
  }
  if (k.best_month_income > 0) out.push({ tone: 'info', text: `Best month in this period: ${mfull(k.best_month)} with ${inr(k.best_month_income)} income.` });
  if (k.net_window < 0) out.push({ tone: 'warn', text: `Costs were higher than income over this period (net ${inr(k.net_window)}).` });
  return out;
}

export async function view(root) {
  const d = await get(`/api/analytics?months=${nMonths}`);
  const k = d.kpis;

  // Charts are drawn at (roughly) the width they'll be shown at, so text stays readable on phones.
  const wide = window.innerWidth > 900;
  const avail = (root.clientWidth || 800) - (wide ? 72 : 32) - 32;
  const full = Math.max(280, Math.min(avail, 1080));
  const half = wide ? Math.max(280, (avail - 18) / 2 - 8) : full;
  const labels = d.months.map(mlabel);
  const tone = { good: 'good', warn: '', bad: 'bad', info: 'info' };
  const tips = insights(d);

  mount(root, h`
    <div class="page-head"><div><h1>Analytics</h1><div class="sub">How the business is doing, at a glance</div></div>
      <div class="chips" id="an-range">${RANGES.map(([n, l]) => h`<button class="chip" data-n="${n}" aria-pressed="${String(n === nMonths)}">${l}</button>`)}</div></div>

    <div class="strip">
      <div><div class="k">Money lent out</div><div class="v">${inr(k.outstanding)}</div><div class="s">${k.active_loans} active loan${k.active_loans === 1 ? '' : 's'} · ${k.active_customers} customer${k.active_customers === 1 ? '' : 's'}</div></div>
      <div><div class="k">Interest collected</div><div class="v pos">${inr(k.interest_window)}</div><div class="s">Last ${nMonths} months</div></div>
      <div><div class="k">Net profit</div><div class="v ${k.net_window < 0 ? 'neg' : 'pos'}">${inr(k.net_window)}</div><div class="s">Income ${inr(k.income_window)}</div></div>
      <div><div class="k">Overdue</div><div class="v ${k.par_pct > 0 ? 'neg' : ''}">${k.par_pct}%</div><div class="s">${k.par_pct > 0 ? `${inr(k.overdue_amount)} due now · ${k.par30_pct}% over 30 days` : 'Nothing overdue'}</div></div>
    </div>

    ${tips.length ? h`<section class="section" style="margin-top:18px"><div class="section-head"><h2>What stands out</h2></div>
      <ul class="insights">${tips.map((t) => h`<li class="ins ${tone[t.tone]}">${t.text}</li>`)}</ul></section>` : ''}

    <section class="section" style="margin-top:18px"><div class="section-head"><h2>Income per month</h2>${legend([{ name: 'Interest', c: 0 }, { name: 'Fees & charges', c: 2 }, { name: 'Investment profit', c: 4 }])}</div>
      <div class="chart-body">${barChart({ labels, stacked: true, w: full, tip: inr, series: [
    { name: 'Interest', values: d.series.interest, c: 0 }, { name: 'Fees & charges', values: d.series.fees_charges, c: 2 }, { name: 'Investment profit', values: d.series.investment_profit, c: 4 }] })}</div></section>

    <div class="an-grid">
      <section class="section"><div class="section-head"><h2>Net profit per month</h2></div>
        <div class="chart-body">${lineChart({ labels, w: half, tip: inr, series: [{ name: 'Net profit', values: d.series.net, c: 1 }] })}</div></section>
      <section class="section"><div class="section-head"><h2>Lent vs collected</h2>${legend([{ name: 'Lent out', c: 0 }, { name: 'Collected', c: 1 }])}</div>
        <div class="chart-body">${barChart({ labels, w: half, tip: inr, series: [{ name: 'Lent out', values: d.series.disbursed, c: 0 }, { name: 'Collected', values: d.series.collected, c: 1 }] })}</div></section>
    </div>

    <div class="an-grid">
      <section class="section"><div class="section-head"><h2>Money lent out, by loan type</h2></div>
        <div class="chart-body">${donutChart({ items: d.portfolio.by_type, centerValue: compact(d.portfolio.outstanding), centerLabel: 'outstanding', tip: inr })}</div></section>
      <section class="section"><div class="section-head"><h2>Money lent out, by customer</h2></div>
        <div class="chart-body">${donutChart({ items: d.portfolio.by_customer.map((c) => ({ label: c.name, value: c.value })), centerValue: compact(d.portfolio.outstanding), centerLabel: 'outstanding', tip: inr })}</div></section>
    </div>

    <div class="an-grid">
      <section class="section"><div class="section-head"><h2>Overdue ageing</h2><span class="muted">How late, and how much</span></div>
        <div class="chart-body">${d.portfolio.ageing.some((a) => a.amount > 0)
    ? hbars({ items: d.portfolio.ageing.map((a) => ({ label: a.label, value: a.amount, sub: a.count ? `${a.count} loan${a.count === 1 ? '' : 's'}` : '' })), fmt: inr, cls: 'ch-b4' })
    : h`<div class="chart-empty">Nothing is overdue. Nice.</div>`}</div></section>
      <section class="section"><div class="section-head"><h2>Top customers by interest</h2><span class="muted">All time</span></div>
        <div class="chart-body">${hbars({ items: d.top_interest.map((c) => ({ label: c.name, value: c.value })), fmt: inr, cls: 'ch-b2' })}</div></section>
    </div>

    <div class="an-grid">
      <section class="section"><div class="section-head"><h2>Interest earned, by loan type</h2><span class="muted">All time</span></div>
        <div class="chart-body">${donutChart({ items: d.interest_by_type, centerValue: compact(d.interest_by_type.reduce((t, i) => t + i.value, 0)), centerLabel: 'interest', tip: inr })}</div></section>
      <section class="section"><div class="section-head"><h2>Loans by status</h2></div>
        <div class="chart-body">${donutChart({ items: d.portfolio.status.map((s) => ({ label: s.label, value: s.count })), centerValue: String(d.portfolio.status.reduce((t, s) => t + s.count, 0)), centerLabel: 'loans', fmt: (n) => String(n), tip: (n) => `${n} loan${n === 1 ? '' : 's'}` })}</div></section>
    </div>
    <p class="faint" style="font-size:14px;margin-top:14px">Average loan size ${inr(k.avg_loan)}. Income = interest + fees + late fees + charges + investment profit. Net profit also subtracts interest paid on borrowings and expenses.</p>`);

  root.querySelector('#an-range').addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (b) { nMonths = Number(b.dataset.n); state.rerender(); }
  });
}

// Charts are sized to the screen when drawn, so redraw if the window changes size a lot (e.g. rotating a phone).
let lastW = window.innerWidth;
window.addEventListener('resize', debounce(() => {
  if (location.hash.startsWith('#/analytics') && Math.abs(window.innerWidth - lastW) > 60) { lastW = window.innerWidth; state.rerender(); }
}, 400));

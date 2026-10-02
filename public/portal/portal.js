// Customer app: a customer sees only their own loans, EMI dates, interest and payments.
import { get, post, session, ApiError } from '/assets/api.js';
import { h, mount, inr, icon, on, toast, readForm, showErrors, clearErrors, busy, badge, telLink, daysFromNow } from '/assets/ui.js';

const app = document.getElementById('app');
let lang = (() => { try { return localStorage.getItem('mf_lang') || 'mr'; } catch { return 'mr'; } })();
const S = { customer: null, business: { name: '', phone: '' } };

const T = {
  mr: {
    title: 'माझी कर्जे', hello: 'नमस्कार', signin: 'साइन इन', signin_hint: 'तुमच्या फायनान्स ऑफिसने दिलेला मोबाईल नंबर आणि पासवर्ड वापरा.',
    username: 'मोबाईल नंबर', password: 'पासवर्ड', signout: 'साइन आउट', staff_login: 'ऑफिस कर्मचारी? येथे साइन इन करा',
    next_payment: 'पुढील भरणा', overdue_now: 'आता भरायची थकबाकी', due_today: 'आज देय', in_days: (n) => `${n} दिवसांनी`, late_days: (n) => `${n} दिवस उशीर`,
    no_due: 'सध्या कोणताही हप्ता बाकी नाही', outstanding: 'बाकी मुद्दल', active_loans: 'सुरू कर्जे', my_loans: 'माझी कर्जे',
    no_loans: 'तुमच्या नावावर अजून कर्ज नाही.', loan_amount: 'कर्ज रक्कम', installment: 'हप्ता', rate: 'व्याजदर', tenure: 'कालावधी', started: 'सुरू झाले',
    total_paid: 'आतापर्यंत भरले', interest_paid: 'आतापर्यंत भरलेले व्याज', schedule: 'हप्त्यांचे वेळापत्रक', payments: 'भरणा इतिहास', no_payments: 'अजून कोणताही भरणा नाही.',
    receipt: 'पावती', close_today: 'आज कर्ज बंद करायचे असल्यास', close_hint: (b) => `हा आजचा अंदाज आहे. अंतिम रक्कम ${b} कडून निश्चित करून घ्या.`,
    principal: 'मुद्दल', interest: 'व्याज', late_fee: 'विलंब शुल्क', charge: 'लवकर बंद करण्याचे शुल्क', total_pay: 'एकूण भरायचे', rebate: 'आधी भरलेल्या व्याजाची सूट',
    contact: 'ऑफिसला कॉल करा', back: 'मागे', per_month: (r) => `${r}% दरमहा`, per_day: (r) => `${r}% रोज`, fixed: 'ठरलेला हप्ता',
    months: (n) => `${n} महिने`, days: (n) => `${n} दिवस`, io_note: 'व्याज दर महिन्याला बाकी मुद्दलावर आकारले जाते. मुद्दल कधीही भरता येते.',
    interest_due: 'व्याज', cur_pw: 'सध्याचा पासवर्ड', new_pw: 'नवीन पासवर्ड', save_continue: 'सेव्ह करा व पुढे जा', new_pw_title: 'नवीन पासवर्ड ठरवा',
    new_pw_hint: 'ऑफिसने दिलेला पासवर्ड बदलून फक्त तुम्हाला माहीत असलेला पासवर्ड ठेवा (किमान ८ अक्षरे).',
    types: { interest_only: 'फक्त व्याज', emi_monthly: 'मासिक हप्ते', emi_daily: 'दैनिक हप्ते' },
    st: { active: 'सुरू', closed: 'बंद', foreclosed: 'लवकर बंद', written_off: 'बंद', paid: 'भरले', overdue: 'थकीत', due: 'आज देय', upcoming: 'येणारे', waived: 'रद्द', penalty_due: 'शुल्क बाकी' },
    late_note: (n) => `${n} दिवस थकीत. कृपया लवकर भरा.`, paid_on: 'भरले', loading_err: 'माहिती मिळाली नाही.', retry: 'पुन्हा प्रयत्न करा', total_row: 'एकूण', due_col: 'देय तारीख', amount_col: 'रक्कम',
    lang_note: 'भाषा',
  },
  en: {
    title: 'My loans', hello: 'Hello', signin: 'Sign in', signin_hint: 'Use the mobile number and password your finance office gave you.',
    username: 'Mobile number', password: 'Password', signout: 'Sign out', staff_login: 'Office staff? Sign in here',
    next_payment: 'Next payment', overdue_now: 'Overdue amount to pay now', due_today: 'Due today', in_days: (n) => `in ${n} day${n === 1 ? '' : 's'}`, late_days: (n) => `${n} day${n === 1 ? '' : 's'} late`,
    no_due: 'Nothing is due right now', outstanding: 'Principal outstanding', active_loans: 'Active loans', my_loans: 'My loans',
    no_loans: 'You have no loans yet.', loan_amount: 'Loan amount', installment: 'Instalment', rate: 'Interest rate', tenure: 'Tenure', started: 'Started',
    total_paid: 'Paid so far', interest_paid: 'Interest paid so far', schedule: 'Repayment schedule', payments: 'Payment history', no_payments: 'No payments yet.',
    receipt: 'Receipt', close_today: 'If you close this loan today', close_hint: (b) => `This is today's estimate. Please confirm the final amount with ${b}.`,
    principal: 'Principal', interest: 'Interest', late_fee: 'Late fee', charge: 'Early closure charge', total_pay: 'Total to pay', rebate: 'Rebate on interest paid ahead',
    contact: 'Call the office', back: 'Back', per_month: (r) => `${r}% per month`, per_day: (r) => `${r}% per day`, fixed: 'Fixed instalment',
    months: (n) => `${n} months`, days: (n) => `${n} days`, io_note: 'Interest is charged every month on the principal outstanding. You can repay principal any time.',
    interest_due: 'Interest', cur_pw: 'Current password', new_pw: 'New password', save_continue: 'Save and continue', new_pw_title: 'Choose a new password',
    new_pw_hint: 'Replace the password you were given with one only you know (at least 8 characters).',
    types: { interest_only: 'Interest only', emi_monthly: 'Monthly EMI', emi_daily: 'Daily EMI' },
    st: { active: 'Active', closed: 'Closed', foreclosed: 'Closed early', written_off: 'Closed', paid: 'Paid', overdue: 'Overdue', due: 'Due today', upcoming: 'Upcoming', waived: 'Cancelled', penalty_due: 'Fee due' },
    late_note: (n) => `${n} days overdue. Please pay soon.`, paid_on: 'Paid', loading_err: 'Could not load your details.', retry: 'Try again', total_row: 'Total', due_col: 'Due date', amount_col: 'Amount',
    lang_note: 'Language',
  },
};
const t = () => T[lang];
const MONTHS = {
  mr: ['जाने', 'फेब्रु', 'मार्च', 'एप्रि', 'मे', 'जून', 'जुलै', 'ऑग', 'सप्टें', 'ऑक्टो', 'नोव्हें', 'डिसें'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
function fd(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[lang][m - 1]} ${y}`;
}
const rateText = (l) => (l.type === 'emi_daily' ? t().per_day(l.rate) : t().per_month(l.rate));

function langSwitch() {
  return h`<div class="lang" role="group" aria-label="${t().lang_note}"><button data-lang="mr" aria-pressed="${String(lang === 'mr')}">मराठी</button><button data-lang="en" aria-pressed="${String(lang === 'en')}">English</button></div>`;
}
on('lang', () => {});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b) return;
  lang = b.dataset.lang;
  try { localStorage.setItem('mf_lang', lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  route();
});

function top() {
  return h`<div class="p-top"><div class="brand"><div class="brand-mark">₹</div><div class="brand-name">${S.business.name || t().title}</div></div>${langSwitch()}</div>`;
}

/* ---------------- login ---------------- */
function loginScreen(msg) {
  document.title = t().title;
  mount(app, h`<div class="p-wrap"><div class="p-top"><div class="brand"><div class="brand-mark">₹</div><div class="brand-name">${t().title}</div></div>${langSwitch()}</div>
    <form id="lf" novalidate class="stack" style="gap:14px;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:22px 20px">
      <div><h1 style="font-family:var(--font-num);font-size:22px">${t().signin}</h1><p class="muted" style="margin-top:4px">${t().signin_hint}</p></div>
      ${msg ? h`<div class="notice bad">${msg}</div>` : ''}
      <div class="field"><label for="lf-u">${t().username}</label><input id="lf-u" name="username" type="text" inputmode="numeric" autocomplete="username" autocapitalize="none"></div>
      <div class="field"><label for="lf-p">${t().password}</label><input id="lf-p" name="password" type="password" autocomplete="current-password"></div>
      <button class="btn block" type="submit" id="lf-go" style="min-height:48px">${t().signin}</button>
      <a href="/" class="faint" style="font-size:14px;text-align:center">${t().staff_login}</a></form></div>`);
  const form = document.getElementById('lf');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('lf-go');
    busy(btn, true, '…');
    try {
      const r = await post('/api/auth/login', readForm(form));
      if (r.user.role !== 'customer') { loginScreen(lang === 'mr' ? 'हे ग्राहकांसाठी आहे. ऑफिस लॉगिन मुख्य पानावर वापरा.' : 'This page is for customers. Staff please use the main sign in.'); return; }
      session.set(r.token);
      await boot();
    } catch (err) { busy(btn, false); loginScreen(err.message); }
  });
}

function forcePassword() {
  return new Promise((resolve) => {
    mount(app, h`<div class="p-wrap">${top()}<form id="pf" novalidate class="stack" style="gap:14px;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:22px 20px">
      <div><h1 style="font-family:var(--font-num);font-size:22px">${t().new_pw_title}</h1><p class="muted" style="margin-top:4px">${t().new_pw_hint}</p></div>
      <div class="field"><label for="pf-c">${t().cur_pw}</label><input id="pf-c" name="current_password" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pf-n">${t().new_pw}</label><input id="pf-n" name="new_password" type="password" autocomplete="new-password"></div>
      <button class="btn block" type="submit" id="pf-go" style="min-height:48px">${t().save_continue}</button></form></div>`);
    const form = document.getElementById('pf');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      const btn = document.getElementById('pf-go');
      busy(btn, true, '…');
      try { const r = await post('/api/auth/change-password', readForm(form)); session.set(r.token); resolve(); }
      catch (err) { busy(btn, false); if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return; toast(err.message, 'error'); }
    });
  });
}

/* ---------------- home ---------------- */
async function home() {
  const [me, { loans }] = await Promise.all([get('/api/portal/me'), get('/api/portal/loans')]);
  S.customer = me.customer; S.business = me.business;
  const tt = me.totals, nd = tt.next_due, late = tt.overdue_amount > 0;
  let when = '';
  if (nd) {
    const dd = daysFromNow(nd.due_date);
    when = late ? h`<div class="when late">${t().late_days(loans.find((l) => l.id === nd.loan_id).summary.overdue_days)} · ${fd(nd.due_date)}</div>`
      : dd === 0 ? h`<div class="when">${t().due_today}</div>` : h`<div class="when">${fd(nd.due_date)} · ${t().in_days(dd)}</div>`;
  }
  const tel = telLink(me.business.phone);
  mount(app, h`<div class="p-wrap">${top()}
    <div class="p-hello">${t().hello}, ${me.customer.name}</div>
    <div class="due-card ${late ? 'late' : ''}">
      ${nd ? h`<div class="cap">${late ? t().overdue_now : t().next_payment}</div><div class="amt">${inr(late ? tt.due_now : nd.amount)}</div>${when}`
      : h`<div class="cap">${t().next_payment}</div><div class="when" style="margin-top:6px">${t().no_due}</div>`}
    </div>
    <div class="p-sum"><div><div class="k">${t().outstanding}</div><div class="v">${inr(tt.principal_outstanding)}</div></div><div><div class="k">${t().active_loans}</div><div class="v">${tt.active_loans}</div></div></div>
    <h2 class="p-h">${t().my_loans}</h2>
    ${loans.length ? loans.map((l) => h`<a class="loan-card" href="#/loan/${l.id}"><div class="top"><span class="no">${l.loan_no}</span>
        ${l.summary && l.summary.overdue_amount > 0 ? badge('overdue', t().st.overdue) : badge(l.status === 'active' ? 'active' : 'closed', t().st[l.status])}</div>
      <div class="row2"><span>${t().types[l.type]}</span><span class="num">${inr(l.principal)}</span></div>
      <div class="row2"><span>${t().outstanding}</span><span class="num">${inr(l.principal_outstanding)}</span></div></a>`)
    : h`<div class="empty">${t().no_loans}</div>`}
    <div class="p-call">${tel ? h`<a class="btn secondary" href="${tel}">${icon.phone} ${t().contact}</a>` : ''}<button class="btn secondary" data-action="signout">${icon.logout} ${t().signout}</button></div>
  </div>`);
}

/* ---------------- loan ---------------- */
async function loan(id) {
  const [d, me] = await Promise.all([get(`/api/portal/loans/${id}`), S.customer ? Promise.resolve(null) : get('/api/portal/me')]);
  if (me) { S.customer = me.customer; S.business = me.business; }
  const l = d.loan, s = d.summary, io = l.type === 'interest_only', active = l.status === 'active';
  const late = s && s.overdue_amount > 0;
  const quote = active ? await get(`/api/portal/loans/${id}/foreclosure-quote`) : null;
  const tel = telLink(S.business.phone);
  const rowClass = (r) => r.status;
  mount(app, h`<div class="p-wrap">${top()}
    <p style="margin-bottom:10px"><a href="#/" class="row" style="gap:4px;display:inline-flex;width:auto">${icon.back} ${t().back}</a></p>
    <div class="row between" style="margin-bottom:10px"><h1 style="font-family:var(--font-num);font-size:24px;font-weight:600">${l.loan_no}</h1>${late ? badge('overdue', t().st.overdue) : badge(active ? 'active' : 'closed', t().st[l.status])}</div>
    ${active && s.next_due ? h`<div class="due-card ${late ? 'late' : ''}"><div class="cap">${late ? t().overdue_now : t().next_payment}</div>
      <div class="amt">${inr(late ? s.due_now_amount : s.next_due.amount)}</div>
      <div class="when ${late ? 'late' : ''}">${late ? t().late_note(s.overdue_days) : fd(s.next_due.due_date) + (daysFromNow(s.next_due.due_date) > 0 ? ' · ' + t().in_days(daysFromNow(s.next_due.due_date)) : ' · ' + t().due_today)}</div></div>` : ''}
    <div class="p-block" style="margin-top:14px"><div class="section-body" style="padding-top:16px"><div class="facts">
      <div><div class="k">${t().loan_amount}</div><div class="v num">${inr(l.principal)}</div></div>
      <div><div class="k">${t().outstanding}</div><div class="v num">${inr(l.principal_outstanding)}</div></div>
      ${io ? '' : h`<div><div class="k">${t().installment}</div><div class="v num">${inr(l.installment)}</div></div>`}
      <div><div class="k">${t().rate}</div><div class="v">${l.fixed_installment ? t().fixed : rateText(l)}</div></div>
      ${l.tenure ? h`<div><div class="k">${t().tenure}</div><div class="v">${l.type === 'emi_daily' ? t().days(l.tenure) : t().months(l.tenure)}</div></div>` : ''}
      <div><div class="k">${t().started}</div><div class="v">${fd(l.start_date)}</div></div>
      <div><div class="k">${io ? t().interest_paid : t().total_paid}</div><div class="v num">${inr(io ? s.total_interest_paid : s.total_principal_paid + s.total_interest_paid + s.total_penalty_paid)}</div></div>
    </div></div></div>

    ${quote ? h`<div class="p-block"><h3>${t().close_today}</h3><div class="section-body" style="padding-top:6px"><table class="sum">
      <tr><td>${t().principal}</td><td>${inr(quote.principal)}</td></tr>
      <tr><td>${quote.interest_payable < 0 ? t().rebate : t().interest}</td><td>${inr(quote.interest_payable)}</td></tr>
      ${quote.penalty ? h`<tr><td>${t().late_fee}</td><td>${inr(quote.penalty)}</td></tr>` : ''}
      ${quote.charge ? h`<tr><td>${t().charge}</td><td>${inr(quote.charge)}</td></tr>` : ''}
      <tr class="total"><td>${t().total_pay}</td><td>${inr(quote.total)}</td></tr></table>
      <p class="faint" style="font-size:14px;margin-top:8px">${t().close_hint(S.business.name)}</p></div></div>` : ''}

    <div class="p-block"><h3>${t().schedule}</h3>
      <ul class="p-sched">${d.schedule.map((r) => h`<li class="${rowClass(r)}"><div><div class="d">${fd(r.due_date)}</div><div class="s">${t().st[r.status] || r.status}${r.partial ? ' · ' + inr(r.paid_total) : ''}</div></div>
        <div class="num" style="font-weight:600">${inr(io ? r.interest_due : r.emi)}</div></li>`)}</ul>
      ${io ? h`<p class="faint" style="padding:10px 16px 14px;font-size:14px">${t().io_note}</p>` : ''}</div>

    <div class="p-block"><h3>${t().payments}</h3>
      ${d.payments.length ? h`<ul class="p-sched">${d.payments.map((p) => h`<li><div><div class="d">${fd(p.paid_on)}</div><div class="s">${t().receipt} ${p.receipt_no}</div></div><div class="num" style="font-weight:600">${inr(p.amount)}</div></li>`)}</ul>`
      : h`<p class="muted" style="padding:6px 16px 16px">${t().no_payments}</p>`}</div>
    <div class="p-call">${tel ? h`<a class="btn secondary" href="${tel}">${icon.phone} ${t().contact}</a>` : ''}</div>
  </div>`);
}

/* ---------------- router / boot ---------------- */
let renderId = 0;
async function route() {
  if (!session.token || !S.ready) return;
  const my = ++renderId;
  const m = /^#\/loan\/(\d+)$/.exec(location.hash);
  try { if (m) await loan(m[1]); else await home(); if (my === renderId) window.scrollTo(0, 0); }
  catch (err) {
    if (err.status === 401) return;
    mount(app, h`<div class="p-wrap">${top()}<div class="empty"><strong>${t().loading_err}</strong>${err.message}<br><button class="btn" data-action="retry">${t().retry}</button></div></div>`);
  }
}
window.addEventListener('hashchange', route);
on('retry', () => route());
on('signout', async () => {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  session.clear(); S.ready = false; S.customer = null; location.hash = ''; loginScreen();
});
window.addEventListener('mf:logout', () => { S.ready = false; loginScreen(lang === 'mr' ? 'सेशन संपले. कृपया पुन्हा साइन इन करा.' : 'Your session ended. Please sign in again.'); });

async function boot() {
  document.documentElement.lang = lang;
  if (!session.token) { loginScreen(); return; }
  try {
    let { user } = await get('/api/auth/me');
    if (user.role !== 'customer') { session.clear(); loginScreen(lang === 'mr' ? 'हे ग्राहकांसाठी आहे.' : 'This page is for customers.'); return; }
    if (user.must_change_password) await forcePassword();
  } catch (err) { if (err.status === 401) { session.clear(); loginScreen(); return; } mount(app, h`<div class="p-wrap"><div class="empty">${err.message}</div></div>`); return; }
  S.ready = true;
  document.title = t().title;
  route();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/portal/sw.js').catch(() => { /* offline shell is a nice-to-have, never block on it */ }); });
}

boot();

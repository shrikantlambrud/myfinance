// App shell: login, navigation, hash router.
import { get, post, session, ApiError } from './api.js';
import { h, mount, icon, on, toast, readForm, showErrors, clearErrors, busy, openSheet } from './ui.js';
import { state, isOwner } from './state.js';
import * as today from './views/today.js';
import * as loans from './views/loans.js';
import * as people from './views/people.js';
import * as money from './views/money.js';
import * as admin from './views/admin.js';

const app = document.getElementById('app');

/* ---------------- routes ---------------- */
const ROUTES = [
  { re: /^\/today$/, nav: 'today', view: today.view },
  { re: /^\/loans$/, nav: 'loans', view: loans.list('given') },
  { re: /^\/loans\/(\d+)$/, nav: 'loans', view: loans.detail },
  { re: /^\/new$/, nav: 'new', view: loans.create },
  { re: /^\/customers$/, nav: 'customers', view: people.list },
  { re: /^\/customers\/(\d+)$/, nav: 'customers', view: people.detail },
  { re: /^\/cash$/, nav: 'cash', owner: true, view: money.cash },
  { re: /^\/invest$/, nav: 'invest', owner: true, view: money.invest },
  { re: /^\/borrowed$/, nav: 'borrowed', owner: true, view: loans.list('taken') },
  { re: /^\/reports$/, nav: 'reports', owner: true, view: admin.reports },
  { re: /^\/team$/, nav: 'team', owner: true, view: admin.team },
  { re: /^\/settings$/, nav: 'settings', owner: true, view: admin.settings },
  { re: /^\/more$/, nav: 'more', view: admin.more },
];

const NAV = [
  { id: 'today', href: '#/today', label: 'Today', icon: icon.today },
  { id: 'loans', href: '#/loans', label: 'Loans', icon: icon.loans },
  { id: 'customers', href: '#/customers', label: 'Customers', icon: icon.people },
  { id: 'new', href: '#/new', label: 'New loan', icon: icon.plus },
  { sep: true, owner: true },
  { id: 'cash', href: '#/cash', label: 'Cash book', icon: icon.cash, owner: true },
  { id: 'borrowed', href: '#/borrowed', label: 'Borrowed', icon: icon.borrow, owner: true },
  { id: 'invest', href: '#/invest', label: 'Investments', icon: icon.invest, owner: true },
  { id: 'reports', href: '#/reports', label: 'Reports', icon: icon.report, owner: true },
  { sep: true, owner: true },
  { id: 'team', href: '#/team', label: 'Team', icon: icon.team, owner: true },
  { id: 'settings', href: '#/settings', label: 'Settings', icon: icon.settings, owner: true },
];

function shell() {
  const owner = isOwner();
  const items = NAV.filter((n) => !n.owner || owner);
  mount(app, h`
    <aside class="rail"><div class="brand"><div class="brand-mark">₹</div><div class="brand-name">${state.settings.business_name}</div></div>
      <nav class="nav" aria-label="Main">${items.map((n) => (n.sep ? h`<div class="nav-sep"></div>` : h`<a href="${n.href}" data-nav="${n.id}">${n.icon}<span>${n.label}</span></a>`))}</nav>
      <div class="rail-user"><div class="who">${state.user.name}</div><div class="faint" style="font-size:14px">${owner ? 'Owner' : 'Staff'}</div>
        <button class="linkbtn" data-action="logout" style="margin-top:6px">Sign out</button></div></aside>
    <nav class="tabbar" aria-label="Main">
      <a href="#/today" data-nav="today">${icon.today}<span>Today</span></a>
      <a href="#/loans" data-nav="loans">${icon.loans}<span>Loans</span></a>
      <a href="#/new" data-nav="new" class="add" aria-label="New loan"><span class="plus">${icon.plus}</span><span class="lbl">New</span></a>
      <a href="#/customers" data-nav="customers">${icon.people}<span>Customers</span></a>
      <a href="#/more" data-nav="more">${icon.more}<span>More</span></a>
    </nav>
    <main class="main" id="main" tabindex="-1"></main>`);
}

let renderToken = 0;
async function route(silent = false) {
  const main = document.getElementById('main');
  if (!main) return;
  const raw = location.hash.replace(/^#/, '') || '/today';
  const [path, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  let match = null, params = [];
  for (const r of ROUTES) { const m = r.re.exec(path); if (m) { match = r; params = m.slice(1); break; } }
  if (!match || (match.owner && !isOwner())) { location.hash = '#/today'; return; }

  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === match.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const my = ++renderToken;
  if (!silent) mount(main, h`<div class="loading"><div class="spinner"></div></div>`);
  try {
    await match.view(main, params, query);
    if (my === renderToken && !state.keepScroll) window.scrollTo(0, 0);
  } catch (err) {
    if (my !== renderToken || err.status === 401) return;
    mount(main, h`<div class="error-box"><h2>${err.status === 404 ? 'Not found' : 'Could not load this page'}</h2><p class="muted" style="margin:8px 0 16px">${err.message}</p>
      <button class="btn" data-action="reload">Try again</button></div>`);
  }
}
state.rerender = async () => {
  state.keepScroll = true;
  const y = window.scrollY;
  await route(true);
  window.scrollTo(0, y);
  state.keepScroll = false;
};
window.addEventListener('hashchange', route);
on('reload', () => route());

// whole-row links (rows can't be <a>): data-href
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-href]');
  if (!row || e.target.closest('a, button, input, select')) return;
  location.hash = row.dataset.href;
});

/* ---------------- auth ---------------- */
function loginScreen(msg) {
  mount(app, h`<div class="login-wrap"><div class="login">
    <div class="brand"><div class="brand-mark">₹</div><div class="brand-name">MyFinance</div></div>
    <form id="lf" novalidate class="stack" style="gap:14px"><div><h1>Sign in</h1><p class="muted">Use the username your owner gave you.</p></div>
      ${msg ? h`<div class="notice bad">${msg}</div>` : ''}
      <div class="field"><label for="lf-u">Username</label><input id="lf-u" name="username" type="text" autocomplete="username" autocapitalize="none" autofocus></div>
      <div class="field"><label for="lf-p">Password</label><input id="lf-p" name="password" type="password" autocomplete="current-password"></div>
      <button class="btn block" type="submit" id="lf-go">Sign in</button>
      <p class="faint" style="font-size:14px">Customer? <a href="/portal">Open the customer app</a></p></form></div></div>`);
  const form = document.getElementById('lf');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('lf-go');
    const f = readForm(form);
    busy(btn, true, 'Signing in…');
    try {
      const r = await post('/api/auth/login', f);
      session.set(r.token);
      await boot();
    } catch (err) {
      busy(btn, false);
      loginScreen(err.message);
    }
  });
}

function forcePasswordChange() {
  return new Promise((resolve) => {
    mount(app, h`<div class="login-wrap"><div class="login"><div class="brand"><div class="brand-mark">₹</div><div class="brand-name">MyFinance</div></div>
      <form id="pf" novalidate class="stack" style="gap:14px"><div><h1>Choose a new password</h1><p class="muted">Your password was set by someone else. Pick one only you know.</p></div>
        <div class="field"><label for="pf-c">Current password</label><input id="pf-c" name="current_password" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pf-n">New password</label><input id="pf-n" name="new_password" type="password" autocomplete="new-password"><div class="hint">At least 8 characters.</div></div>
        <button class="btn block" type="submit" id="pf-go">Save and continue</button></form></div></div>`);
    const form = document.getElementById('pf');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('pf-go');
      clearErrors(form);
      busy(btn, true);
      try {
        const r = await post('/api/auth/change-password', readForm(form));
        session.set(r.token);
        resolve();
      } catch (err) {
        busy(btn, false);
        if (err instanceof ApiError && err.fields && showErrors(form, err.fields)) return;
        toast(err.message, 'error');
      }
    });
  });
}

async function boot() {
  if (!session.token) { loginScreen(); return; }
  try {
    let { user } = await get('/api/auth/me');
    if (user.role === 'customer') { location.replace('/portal'); return; }
    if (user.must_change_password) { await forcePasswordChange(); ({ user } = await get('/api/auth/me')); }
    state.user = user;
    state.settings = (await get('/api/settings')).settings;
  } catch (err) {
    if (err.status === 401) { session.clear(); loginScreen(); return; }
    mount(app, h`<div class="login-wrap"><div class="login"><h1>Cannot connect</h1><p class="muted" style="margin:8px 0 16px">${err.message}</p><button class="btn" data-action="reload-page">Try again</button></div></div>`);
    return;
  }
  document.title = state.settings.business_name;
  shell();
  if (!location.hash) location.hash = '#/today';
  route();
}

on('reload-page', () => location.reload());
on('logout', async () => {
  try { await post('/api/auth/logout'); } catch { /* token may already be invalid */ }
  session.clear();
  state.user = null;
  location.hash = '';
  loginScreen();
});
window.addEventListener('mf:logout', () => { state.user = null; loginScreen('Your session ended. Please sign in again.'); });

boot();

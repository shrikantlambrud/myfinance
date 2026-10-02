// UI helpers: safe HTML templating, formatting, sheets, toasts, event delegation.

/* ---------- escaping template ---------- */
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function render(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
// h`<p>${userText}</p>` escapes every interpolation; nested h`` results are inserted as-is.
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
  return new Safe(out);
}
export function mount(el, safe) { el.innerHTML = safe instanceof Safe ? safe.s : esc(safe); applyDynamic(el); return el; }

// CSP forbids inline style attributes, so dynamic widths ride on data attributes.
export function applyDynamic(root) {
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.dataset.w + '%'; });
}

/* ---------- formatting ---------- */
export function inr(n, { sign = false } = {}) {
  const v = Number(n) || 0;
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + '₹' + s;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso, { year = true } = {}) {
  if (!iso) return '–';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${year ? ' ' + y : ''}`;
}
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function daysFromNow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const [ty, tm, td] = todayLocal().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}
export const TYPE_LABEL = { interest_only: 'Interest only', emi_monthly: 'Monthly EMI', emi_daily: 'Daily EMI' };
export const STATUS_LABEL = {
  active: 'Active', closed: 'Closed', foreclosed: 'Foreclosed', written_off: 'Written off', void: 'Void',
  paid: 'Paid', overdue: 'Overdue', due: 'Due today', upcoming: 'Upcoming', waived: 'Waived', penalty_due: 'Late fee due', partial: 'Part paid',
};
export const badge = (status, label) => h`<span class="badge ${status}">${label || STATUS_LABEL[status] || status}</span>`;
export function waLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return null;
  return `https://wa.me/91${digits}?text=${encodeURIComponent(text)}`;
}
export const telLink = (phone) => (phone ? 'tel:' + String(phone).replace(/[^\d+]/g, '') : null);
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- icons (stroke, currentColor) ---------- */
const svg = (d) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
export const icon = {
  today: svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/>'),
  loans: svg('<path d="M5 4h11l3 3v13H5z"/><path d="M8 11h8M8 15h8"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.6 3 2.3 3 5.2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  cash: svg('<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>'),
  invest: svg('<path d="M4 19V5"/><path d="M4 19h16"/><path d="m8 15 4-4 3 3 5-6"/>'),
  borrow: svg('<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>'),
  chart: svg('<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>'),
  report: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>'),
  team: svg('<circle cx="12" cy="8" r="3.4"/><path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
  print: svg('<path d="M7 9V4h10v5M7 17H5v-6h14v6h-2"/><path d="M7 14h10v6H7z"/>'),
  back: svg('<path d="M15 5 8 12l7 7"/>'),
  logout: svg('<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>'),
};

/* ---------- toasts ---------- */
export function toast(msg, kind = '') {
  let host = document.querySelector('.toast-host');
  if (!host) { host = document.createElement('div'); host.className = 'toast-host'; host.setAttribute('role', 'status'); document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 2800);
}

/* ---------- sheets (modal on desktop, bottom sheet on phones) ---------- */
export function openSheet({ title, body, footer, wide = false }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="x" type="button" data-sheet-close aria-label="Close">×</button></div>
    <div class="sheet-body"></div>${footer ? '<div class="sheet-foot"></div>' : ''}</div>`;
  const prevFocus = document.activeElement;
  const bodyEl = backdrop.querySelector('.sheet-body');
  const footEl = backdrop.querySelector('.sheet-foot');
  const api = {
    el: backdrop, body: bodyEl, foot: footEl,
    setBody(safe) { mount(bodyEl, safe); },
    setFooter(safe) { if (footEl) mount(footEl, safe); },
    close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('printing');
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    },
  };
  const onKey = (e) => { if (e.key === 'Escape') api.close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) api.close(); });
  backdrop.addEventListener('click', (e) => { if (e.target.closest('[data-sheet-close]')) api.close(); });
  api.setBody(body);
  if (footer) api.setFooter(footer);
  document.body.appendChild(backdrop);
  const first = backdrop.querySelector('input:not([readonly]):not([type=hidden]), select, textarea');
  if (first && window.matchMedia('(min-width: 701px)').matches) first.focus();
  return api;
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const s = openSheet({
      title, body: h`<p>${message}</p>`,
      footer: h`<button class="btn secondary" data-sheet-close>Cancel</button><button class="btn ${danger ? 'danger' : ''}" id="cs-ok">${confirmLabel}</button>`,
    });
    let done = false;
    s.el.querySelector('#cs-ok').addEventListener('click', () => { done = true; s.close(); resolve(true); });
    const obs = new MutationObserver(() => { if (!document.body.contains(s.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

/* ---------- event delegation: no inline handlers (CSP) ---------- */
const handlers = {};
export const on = (name, fn) => { handlers[name] = fn; };
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = handlers[el.dataset.action];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(err.message || 'Something went wrong', 'error'); }); }
});

/* ---------- forms ---------- */
export function readForm(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'radio' && !el.checked) return;
    if (el.type === 'checkbox') { out[el.name] = el.checked; return; }
    out[el.name] = el.value.trim();
  });
  return out;
}
export function clearErrors(root) {
  root.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  root.querySelectorAll('.field .err').forEach((e) => e.remove());
}
// Put each server-side field error under its input. Returns true if any input was matched.
export function showErrors(root, fields) {
  clearErrors(root);
  let first = null;
  Object.entries(fields || {}).forEach(([name, msg]) => {
    const input = root.querySelector(`[name="${name}"]`);
    const field = input && input.closest('.field');
    if (!field) return;
    field.classList.add('invalid');
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = msg;
    field.appendChild(e);
    if (!first) first = input;
  });
  if (first) first.focus();
  return !!first;
}
// Blank fields are sent as null so the server treats them as "not provided".
export const numOrNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
export const strOrNull = (v) => (v === '' || v === undefined ? null : v);
export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || 'Please wait…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}

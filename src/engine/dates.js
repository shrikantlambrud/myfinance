'use strict';
// Calendar dates are 'YYYY-MM-DD' strings. All maths goes through UTC epoch days so that
// server timezone / daylight saving can never shift a due date.

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isISODate(s) {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toEpochDay(s) {
  const m = RE.exec(s);
  if (!m) throw new Error('Invalid date: ' + s);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function fromEpochDay(n) {
  const d = new Date(n * 86400000);
  return String(d.getUTCFullYear()).padStart(4, '0') + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

const addDays = (s, n) => fromEpochDay(toEpochDay(s) + n);
// whole days from a to b (b - a); negative if b is before a
const diffDays = (a, b) => toEpochDay(b) - toEpochDay(a);

// Add calendar months, clamping to month end (31 Jan + 1 month = 28/29 Feb).
// Always add to the ORIGINAL anchor date (not cumulatively) so 31 Jan -> 28 Feb -> 31 Mar.
function addMonths(s, n) {
  const m = RE.exec(s);
  if (!m) throw new Error('Invalid date: ' + s);
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const total = y * 12 + mo + n;
  const ny = Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fromEpochDay(Math.round(Date.UTC(ny, nm, Math.min(d, dim)) / 86400000));
}

function parts(tz, now, withTime) {
  const opts = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = new Intl.DateTimeFormat('en-CA', opts).formatToParts(now);
  return (t) => p.find((x) => x.type === t).value;
}
// Today's date in the business timezone (default India), independent of server TZ.
function todayISO(tz = 'Asia/Kolkata', now = new Date()) {
  const g = parts(tz, now, false);
  return `${g('year')}-${g('month')}-${g('day')}`;
}
// 'YYYY-MM-DD HH:MM:SS' in the business timezone, for DATETIME columns
function nowStamp(tz = 'Asia/Kolkata', now = new Date()) {
  const g = parts(tz, now, true);
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

module.exports = { isISODate, addDays, addMonths, diffDays, todayISO, nowStamp, toEpochDay };

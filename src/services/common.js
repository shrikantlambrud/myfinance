'use strict';
const { fromPaise, toPaise } = require('../engine/money');

const pad = (n, w = 6) => String(n).padStart(w, '0');
const qmarks = (n) => Array(n).fill('?').join(',');
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// `env` is the request environment: { user, ip, now(), today(), cfg }
function envOf(ctx) {
  return { user: ctx.user, ip: ctx.ip, now: ctx.now, today: ctx.today, cfg: ctx.cfg };
}

async function audit(tx, env, action, entity, entityId, details) {
  await tx.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    [env.user ? env.user.id : null, action, entity || null, entityId || null, details ? JSON.stringify(details) : null, env.ip || null, env.now()],
  );
}

// amountPaise <= 0 is ignored (nothing moved)
async function addLedger(tx, env, { date, kind, direction, amountPaise, refType, refId, note }) {
  if (!(amountPaise > 0)) return null;
  const r = await tx.run(
    'INSERT INTO ledger (entry_date, kind, direction, amount, ref_type, ref_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [date, kind, direction, fromPaise(amountPaise), refType || null, refId || null, note || null, env.user ? env.user.id : null, env.now()],
  );
  return r.insertId;
}

async function reverseLedgerFor(tx, env, refType, refId) {
  await tx.run('UPDATE ledger SET reversed_at = ? WHERE ref_type = ? AND ref_id = ? AND reversed_at IS NULL', [env.now(), refType, refId]);
}

async function availableCashPaise(db) {
  const row = await db.get(
    "SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS bal FROM ledger WHERE reversed_at IS NULL",
  );
  return toPaise(row.bal);
}

async function getSettings(db) {
  const rows = await db.all('SELECT k, v FROM settings');
  const s = {};
  rows.forEach((r) => { s[r.k] = r.v; });
  return {
    business_name: s.business_name || 'MyFinance',
    business_phone: s.business_phone || '',
    late_fee_per_day: parseFloat(s.late_fee_per_day || '0') || 0,
    foreclosure_charge_pct: parseFloat(s.foreclosure_charge_pct || '0') || 0,
    foreclosure_interest_policy: s.foreclosure_interest_policy === 'full' ? 'full' : 'accrued',
  };
}

module.exports = { pad, qmarks, chunk, envOf, audit, addLedger, reverseLedgerFor, availableCashPaise, getSettings };

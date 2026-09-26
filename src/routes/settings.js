'use strict';
const { check } = require('../lib/validate');
const { staffArea, ownerOnly } = require('../lib/guards');
const { getSettings, audit, envOf } = require('../services/common');

module.exports = (router, { db }) => {
  router.get('/api/settings', ...staffArea, async () => ({ settings: await getSettings(db) }));

  router.put('/api/settings', ...ownerOnly, async (ctx) => {
    const b = check(ctx.body, {
      business_name: { t: 'str', req: true, max: 80 },
      business_phone: { t: 'str', max: 20 },
      late_fee_per_day: { t: 'num', min: 0, max: 1000000, def: 0 },
      foreclosure_charge_pct: { t: 'num', min: 0, max: 100, def: 0 },
      foreclosure_interest_policy: { t: 'enum', req: true, values: ['accrued', 'full'] },
    });
    await db.tx(async (tx) => {
      for (const [k, v] of Object.entries(b)) {
        const val = String(v === null ? '' : v);
        const exists = await tx.get('SELECT k FROM settings WHERE k = ?', [k]);
        if (exists) await tx.run('UPDATE settings SET v = ? WHERE k = ?', [val, k]);
        else await tx.run('INSERT INTO settings (k, v) VALUES (?, ?)', [k, val]);
      }
      await audit(tx, envOf(ctx), 'settings.update', 'settings', null, b);
    });
    return { settings: await getSettings(db) };
  });
};

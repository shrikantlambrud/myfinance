'use strict';
const { check } = require('../lib/validate');
const { ownerOnly } = require('../lib/guards');
const { analytics } = require('../services/analytics');

module.exports = (router, { db }) => {
  // Owner-only: this exposes profit and the whole book, same as Reports.
  router.get('/api/analytics', ...ownerOnly, async (ctx) => {
    const q = check(ctx.query, { months: { t: 'int', min: 3, max: 36, def: 12 } });
    return analytics(db, ctx.today(), q.months || 12);
  });
};

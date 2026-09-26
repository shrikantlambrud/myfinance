'use strict';
const { staffArea } = require('../lib/guards');
const views = require('../services/views');

module.exports = (router, { db }) => {
  router.get('/api/dashboard', ...staffArea, async (ctx) => {
    const d = await views.dashboard(db, ctx.today());
    if (ctx.user.role !== 'owner') {
      // Staff run collections; the business's own money position stays with owners.
      for (const k of ['cash', 'capital', 'month', 'borrowed', 'investments']) delete d[k];
    }
    return d;
  });
};

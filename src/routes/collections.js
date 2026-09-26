'use strict';
const { check } = require('../lib/validate');
const { staffArea } = require('../lib/guards');
const views = require('../services/views');

module.exports = (router, { db }) => {
  router.get('/api/collections', ...staffArea, async (ctx) => {
    const q = check(ctx.query, { date: { t: 'date', def: null } });
    return views.collections(db, q.date || ctx.today());
  });
};

'use strict';
const { unauthorized, forbidden } = require('./errors');
const jwt = require('./jwt');

// Loads the user behind the Bearer token. Checked against the DB on every request, so
// deactivating a user or changing their password cuts off old tokens immediately.
async function auth(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = jwt.verify(token, ctx.cfg.jwtSecret);
  if (!payload) throw unauthorized('Session expired. Please log in again');
  const user = await ctx.db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user || !user.is_active || user.token_version !== payload.tv) throw unauthorized('Session expired. Please log in again');
  ctx.user = user;
}

const roles = (...allowed) => (ctx) => {
  if (!ctx.user || !allowed.includes(ctx.user.role)) throw forbidden();
};

// Staff area = owner + staff. Customers may only use /api/portal.
const staffArea = [auth, roles('owner', 'staff')];
const ownerOnly = [auth, roles('owner')];
const customerOnly = [auth, roles('customer')];

module.exports = { auth, roles, staffArea, ownerOnly, customerOnly };

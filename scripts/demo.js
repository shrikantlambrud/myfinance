'use strict';
// Try MyFinance without MySQL: an in-memory demo database filled with sample data.
//   npm run demo      then open http://localhost:3000     (owner / demo1234   staff / demo1234)
// Data disappears when you stop it. Uses Node's built-in SQLite, which is for demos and tests only.
const http = require('http');
const path = require('path');
const { createSqliteDb } = require(path.join(__dirname, '..', 'test', 'helpers', 'sqlite-db'));
const { createApp } = require('../src/app');
const pw = require('../src/lib/password');
const { todayISO, addDays, addMonths } = require('../src/engine/dates');

const PORT = Number(process.env.PORT || 3000);

(async () => {
  const db = createSqliteDb();
  const cfg = { isProd: false, tz: 'Asia/Kolkata', jwtSecret: 'demo-secret-demo-secret-demo-secret-1234', tokenTtlHours: 12 };
  process.env.LOG_REQUESTS = '0';
  const server = http.createServer(createApp({ db, cfg }));
  await new Promise((r) => server.listen(PORT, r));
  const base = `http://127.0.0.1:${PORT}`;
  const today = todayISO(cfg.tz);

  const now = '2026-01-01 09:00:00';
  const hash = await pw.hash('demo1234');
  await db.run("INSERT INTO users (username, name, role, password_hash, must_change_password, created_at) VALUES ('owner','Ramesh Patil','owner',?,0,?)", [hash, now]);
  await db.run("INSERT INTO users (username, name, role, password_hash, must_change_password, created_at) VALUES ('staff','Amit Kale','staff',?,0,?)", [hash, now]);
  await db.run("UPDATE settings SET v = 'Patil Finance' WHERE k = 'business_name'");
  await db.run("UPDATE settings SET v = '9822012345' WHERE k = 'business_phone'");
  await db.run("UPDATE settings SET v = '25' WHERE k = 'late_fee_per_day'");
  await db.run("UPDATE settings SET v = '2' WHERE k = 'foreclosure_charge_pct'");

  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
    return data;
  };
  const { token } = await call('POST', '/api/auth/login', { username: 'owner', password: 'demo1234' });
  const post = (u, b) => call('POST', u, b, token);
  const ago = (d) => addDays(today, -d);
  const pay = (loan, amount, date, extra = {}) => post(`/api/loans/${loan}/payments`, { amount, paid_on: date, ...extra });

  await post('/api/ledger', { kind: 'capital_in', entry_date: ago(200), amount: 1500000, note: 'Opening capital' });

  const mk = async (name, phone, address, terms) => (await post('/api/loans', { new_party: { name, phone, address }, ...terms })).id;

  // 1. Monthly EMI, on time so far
  const s1 = addMonths(today, -4);
  const l1 = await mk('Ramesh Kadam', '9876500011', 'Hadapsar, Pune', { type: 'emi_monthly', principal: 50000, processing_fee: 1000, rate: 2, tenure: 12, start_date: s1 });
  for (let k = 1; k <= 3; k++) await pay(l1, 5166.67, addMonths(s1, k)); // (50,000 + 24% interest) / 12
  // 2. Interest only, one month missed
  const s2 = addMonths(today, -3);
  const l2 = await mk('Sunita Jadhav', '9876500022', 'Kothrud, Pune', { type: 'interest_only', principal: 100000, rate: 2, start_date: s2 });
  await pay(l2, 2000, addMonths(s2, 1));
  await pay(l2, 12000, addMonths(s2, 2), { principal_amount: 10000 });
  // 3. Daily EMI, mostly paid
  const s3 = ago(45);
  const l3 = await mk('Anil Shinde', '9876500033', 'Wakad, Pune', { type: 'emi_daily', principal: 10000, fixed_installment: 120, tenure: 100, start_date: s3 });
  await pay(l3, 120 * 38, ago(7));
  // 4. Monthly EMI, badly overdue
  const s4 = addMonths(today, -4);
  await mk('Vijay More', '9876500044', 'Baner, Pune', { type: 'emi_monthly', principal: 20000, rate: 3, tenure: 10, start_date: s4 });
  // 5. New interest-only loan
  await mk('Meena Pawar', '9876500055', 'Katraj, Pune', { type: 'interest_only', principal: 25000, rate: 3, start_date: ago(10) });
  // 6. Daily loan due today
  await mk('Sanjay Deshmukh', '9876500066', 'Pimpri, Pune', { type: 'emi_daily', principal: 5000, fixed_installment: 110, tenure: 50, start_date: ago(20) });
  // 7. Reducing balance
  const s7 = addMonths(today, -2);
  const l7 = await mk('Pooja Kulkarni', '9876500077', 'Shivajinagar, Pune', { type: 'emi_monthly', interest_method: 'reducing', principal: 80000, rate: 1.5, tenure: 12, start_date: s7 });
  await pay(l7, 7333.33, addMonths(s7, 1));
  // 8. A loan closed early
  const s8 = addMonths(today, -5);
  const l8 = await mk('Ganesh Bhosale', '9876500088', 'Aundh, Pune', { type: 'emi_monthly', principal: 15000, rate: 2, tenure: 6, start_date: s8 });
  await pay(l8, 2800, addMonths(s8, 1));
  await post(`/api/loans/${l8}/foreclose`, { date: ago(20) });

  // borrowed money + investment
  await post('/api/loans', { direction: 'taken', new_party: { name: 'Suresh Financiers', phone: '9822000000' }, type: 'interest_only', principal: 200000, processing_fee: 2000, rate: 1.25, start_date: ago(60) });
  const inv = await post('/api/investments', { name: 'Tata Capital IPO', amount: 30000, invested_on: ago(30) });
  await post(`/api/investments/${inv.id}/returns`, { returned_on: ago(12), principal_part: 30000, profit_part: 2400 });
  await post('/api/ledger', { kind: 'expense', entry_date: ago(5), amount: 12000, note: 'Office rent' });

  // customer app login for the first customer
  const parties = (await call('GET', '/api/parties?q=Ramesh', undefined, token)).parties;
  const pa = await post(`/api/parties/${parties[0].id}/portal-access`, {});
  await db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = ?", [hash, pa.username]);

  console.log('\nMyFinance demo is running');
  console.log(`  Admin app:      http://localhost:${PORT}/        owner / demo1234   (or staff / demo1234)`);
  console.log(`  Customer app:   http://localhost:${PORT}/portal   ${pa.username} / demo1234`);
  console.log('  (in-memory demo data, resets on restart)\n');
})().catch((e) => { console.error(e); process.exit(1); });

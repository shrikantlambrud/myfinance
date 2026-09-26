# MyFinance

Loan management for a small finance business. Node.js + MySQL, one admin web app for you and your staff,
and a Marathi/English customer app where customers see their loans, EMI dates, interest and payments.

## Kay kay ahe

**Business side (admin app, `/`)**
- Login (owner / staff), lockout after 5 wrong passwords, every change goes in an audit log
- Customers, lenders, **Loans: Monthly EMI, Daily EMI, Interest-only**, flat or reducing-balance interest, fixed-EMI option
- Payment collection with receipts (print / WhatsApp), late fee, part payments, advance payments
- **Foreclosure**: exact quote for any date, foreclosure charge %, owner discount, receipt; can be reopened by owner
- Write-off, void (entered by mistake), reverse a payment (owner, with reason)
- "Today" screen: who to collect from today, call / WhatsApp reminder / collect in one tap
- Cash book (every rupee in/out), capital, expenses, investments (IPO etc.), borrowed money from lenders
- Reports: profit & loss for any period, CSV downloads for Excel

**Customer side (`/portal`)**: own loans only, next payment and due date, full EMI schedule, payment history,
"how much to close today" figure. Marathi by default, English toggle. Same API can power a mobile app later.

## 1. Try it in 1 minute (no MySQL)

```bash
npm run demo          # needs Node 22.13+ ; sample data, resets when stopped
```
Open http://localhost:3000  (owner / demo1234, staff / demo1234). Customer app: http://localhost:3000/portal (9876500011 / demo1234).

## 2. Real setup (MySQL)

Needs Node 20+ and MySQL 8 (or MariaDB 10.6+).

```sql
-- in MySQL, once:
CREATE DATABASE myfinance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'myfinance'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL ON myfinance.* TO 'myfinance'@'localhost';
```
```bash
npm install
cp .env.example .env         # fill DB_* and JWT_SECRET (instructions inside the file)
npm run migrate              # creates all tables (safe to run again later for updates)
npm run create-user -- --username ramesh --name "Ramesh Patil" --role owner
npm start                    # http://localhost:3000
```
First login asks for a new password. Add your second user from **Team** (or with `create-user`).
Then: **Cash book -> Add capital**, and start with **New loan**.

## 3. Going live (important)

- **Use HTTPS.** Put nginx / Caddy in front and set `TRUST_PROXY=1` in `.env`. Never expose plain http on the internet.
- Run with `pm2 start src/server.js --name myfinance` or a systemd service so it restarts itself.
- **Backups**: daily `mysqldump myfinance | gzip > backup-$(date +%F).sql.gz`, copy off the server. This is your books.
- Keep `.env` private. Give the MySQL user access to this database only. Do not store full Aadhaar numbers (last 4 digits is enough).
- Server time zone does not matter: all dates use `BUSINESS_TZ` (default Asia/Kolkata).

## 4. How the money is calculated

| Loan type | Rule |
|---|---|
| Monthly EMI, flat | Interest = principal x rate% x months. EMI = (principal + interest) / months |
| Monthly EMI, reducing | Standard EMI formula, interest each month on the remaining balance |
| Daily EMI, flat | Interest = principal x rate% **per day** x days (or enter the fixed daily amount) |
| Fixed EMI | You enter the EMI and tenure; interest = EMI x tenure - principal |
| Interest only | Every month: outstanding principal x rate%. Principal can be repaid in parts; the loan is closed through **Foreclose** |

- Processing fee is kept out of the amount handed over (cash out = amount - fee) and counted as income.
- A payment is applied to the oldest unpaid instalment first: **late fee, then interest, then principal**. Extra amount rolls to the next instalment.
- Late fee = flat rupees per day for each late EMI instalment (0 by default; set in Settings or per loan). Not applied to interest-only loans.
- **Foreclosure amount** = principal outstanding + interest + late fees + foreclosure charge.
  Setting "interest till closing date" gives a pro-rata rebate on unearned interest; "all scheduled interest" keeps the full interest payable.
  Discounts (owner only) come off charge, then late fee, then interest, never principal.
- Loan terms are frozen when the loan is created. Changing Settings later affects only new loans.
- Amounts are stored as DECIMAL(14,2) and calculated in whole paise, so totals always add up to the paisa.

## 5. Who can do what

| | Owner | Staff | Customer |
|---|---|---|---|
| Customers, new loans, collect payments, foreclose | yes | yes | no |
| See own loans, EMI dates, payments | | | yes (own only) |
| Cash book, investments, borrowed money, reports, profit | yes | no | no |
| Discount, reverse payment, write off, void, reopen, team, settings | yes | no | no |

## 6. Folder guide

```
db/migrations/     SQL schema (add new numbered files for future changes; never edit an applied one)
src/engine/        loan maths (pure functions, fully unit tested)
src/services/      loans, payments, foreclosure, dashboard
src/routes/        REST API   /api/...
public/            admin app (/), customer app (/portal)
scripts/           migrate, create-user, demo
test/              npm test   (engine + full API flow)
```
Adding a mobile app later: it just calls the same `/api/auth/login` and `/api/portal/*` endpoints.

## 7. Tests
`npm test` runs 48 tests: the loan engine (EMI, flat/reducing, late fee, foreclosure, month-end dates) and the whole API
flow (login, roles, loan, payment, reversal, foreclosure, customer app, reports). Tests use an in-memory SQLite copy of the schema.

## 8. Things to check for your business
- Rules for money-lending licences, interest/late-fee/foreclosure disclosure and data privacy depend on your registration type
  (Maharashtra Money-Lending Act, NBFC, etc.). Show customers the terms before disbursing and confirm the details with your CA / lawyer.
- Customer app passwords are set by you (Customers -> Create login). SMS/WhatsApp OTP login is a good next step.

## 9. Ideas for next
WhatsApp/SMS reminders before due date, PDF receipts, import of old loans from the earlier single-file app, collection-agent routes,
document uploads (KYC photos), multiple branches, penalty grace days, Android/iOS app for customers.

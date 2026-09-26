-- MyFinance initial schema (MySQL 8.x / MariaDB 10.6+)
-- Money columns are DECIMAL(14,2) in rupees. The app does all arithmetic in integer paise.
-- Dates are DATE (business-local calendar dates), timestamps are DATETIME in business timezone.

-- People we lend to (customer) or borrow from (lender)
CREATE TABLE parties (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('customer','lender') NOT NULL DEFAULT 'customer',
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NULL,
  alt_phone VARCHAR(20) NULL,
  address VARCHAR(255) NULL,
  id_proof_type VARCHAR(30) NULL,
  id_proof_no VARCHAR(40) NULL,
  notes VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  KEY idx_parties_phone (phone),
  KEY idx_parties_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff / owners / customer-portal logins
CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role ENUM('owner','staff','customer') NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  party_id INT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  token_version INT NOT NULL DEFAULT 0,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_users_username (username),
  KEY idx_users_party (party_id),
  CONSTRAINT fk_users_party FOREIGN KEY (party_id) REFERENCES parties(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  k VARCHAR(60) PRIMARY KEY,
  v VARCHAR(500) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per loan, both directions.
--   direction 'given' = we lent to a customer, 'taken' = we borrowed from a lender.
--   rate meaning:
--     interest_only : % per month on outstanding principal
--     emi_monthly   : % per month (flat on original principal, or on reducing balance if interest_method='reducing')
--     emi_daily     : % per day, flat on original principal
--   When fixed_installment is set, rate is only the derived effective per-period flat rate (for display).
--   Loan terms are frozen at creation: later changes to Settings never alter existing loans.
CREATE TABLE loans (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loan_no VARCHAR(20) NULL,
  direction ENUM('given','taken') NOT NULL DEFAULT 'given',
  party_id INT UNSIGNED NOT NULL,
  type ENUM('interest_only','emi_monthly','emi_daily') NOT NULL,
  interest_method ENUM('flat','reducing') NOT NULL DEFAULT 'flat',
  principal DECIMAL(14,2) NOT NULL,
  processing_fee DECIMAL(14,2) NOT NULL DEFAULT 0,
  rate DECIMAL(9,4) NOT NULL DEFAULT 0,
  fixed_installment DECIMAL(14,2) NULL,
  tenure INT NULL,
  start_date DATE NOT NULL,
  first_due_date DATE NULL,
  total_interest DECIMAL(14,2) NULL,
  total_payable DECIMAL(14,2) NULL,
  late_fee_per_day DECIMAL(10,2) NOT NULL DEFAULT 0,
  foreclosure_charge_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  foreclosure_interest_policy ENUM('accrued','full') NOT NULL DEFAULT 'accrued',
  status ENUM('active','closed','foreclosed','written_off','void') NOT NULL DEFAULT 'active',
  principal_outstanding DECIMAL(14,2) NOT NULL DEFAULT 0,
  closed_on DATE NULL,
  note VARCHAR(500) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_loans_no (loan_no),
  KEY idx_loans_party (party_id),
  KEY idx_loans_status (status, direction),
  CONSTRAINT fk_loans_party FOREIGN KEY (party_id) REFERENCES parties(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fixed repayment schedule for EMI loans (interest-only loans have no stored schedule)
CREATE TABLE installments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loan_id INT UNSIGNED NOT NULL,
  seq INT NOT NULL,
  due_date DATE NOT NULL,
  principal_due DECIMAL(14,2) NOT NULL,
  interest_due DECIMAL(14,2) NOT NULL,
  principal_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  interest_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  penalty_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  cleared_on DATE NULL,
  status ENUM('pending','partial','paid','waived') NOT NULL DEFAULT 'pending',
  UNIQUE KEY uq_inst_loan_seq (loan_id, seq),
  KEY idx_inst_due (due_date, status),
  CONSTRAINT fk_inst_loan FOREIGN KEY (loan_id) REFERENCES loans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every rupee received (or paid, for 'taken' loans). Reversals are soft: reversed_at is set.
CREATE TABLE payments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  receipt_no VARCHAR(20) NULL,
  loan_id INT UNSIGNED NOT NULL,
  kind ENUM('regular','foreclosure') NOT NULL DEFAULT 'regular',
  paid_on DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  principal_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  interest_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  penalty_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  charge_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  pay_mode ENUM('cash','upi','bank','cheque','other') NOT NULL DEFAULT 'cash',
  ref_no VARCHAR(60) NULL,
  note VARCHAR(300) NULL,
  received_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  reversed_at DATETIME NULL,
  reversed_by INT UNSIGNED NULL,
  reverse_reason VARCHAR(300) NULL,
  UNIQUE KEY uq_payments_receipt (receipt_no),
  KEY idx_payments_loan (loan_id),
  KEY idx_payments_date (paid_on),
  CONSTRAINT fk_payments_loan FOREIGN KEY (loan_id) REFERENCES loans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Foreclosure / write-off record for a loan
CREATE TABLE loan_closures (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loan_id INT UNSIGNED NOT NULL,
  kind ENUM('foreclosure','write_off') NOT NULL,
  closed_on DATE NOT NULL,
  principal_settled DECIMAL(14,2) NOT NULL DEFAULT 0,
  interest_settled DECIMAL(14,2) NOT NULL DEFAULT 0,
  penalty_settled DECIMAL(14,2) NOT NULL DEFAULT 0,
  charge DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_received DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_id INT UNSIGNED NULL,
  note VARCHAR(300) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  reversed_at DATETIME NULL,
  KEY idx_closures_loan (loan_id),
  CONSTRAINT fk_closures_loan FOREIGN KEY (loan_id) REFERENCES loans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cash book. Available cash = SUM(in) - SUM(out) over non-reversed rows.
-- kinds: capital_in, capital_out, loan_disbursement, loan_repayment, borrowing_in, borrowing_repayment,
--        investment_out, investment_return, expense, other_in
CREATE TABLE ledger (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entry_date DATE NOT NULL,
  kind VARCHAR(30) NOT NULL,
  direction ENUM('in','out') NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  ref_type VARCHAR(20) NULL,
  ref_id INT UNSIGNED NULL,
  note VARCHAR(300) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  reversed_at DATETIME NULL,
  KEY idx_ledger_date (entry_date),
  KEY idx_ledger_ref (ref_type, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE investments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  invested_on DATE NOT NULL,
  note VARCHAR(300) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE investment_returns (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  investment_id INT UNSIGNED NOT NULL,
  returned_on DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  principal_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  profit_part DECIMAL(14,2) NOT NULL DEFAULT 0,
  note VARCHAR(300) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  reversed_at DATETIME NULL,
  KEY idx_invret_inv (investment_id),
  CONSTRAINT fk_invret_inv FOREIGN KEY (investment_id) REFERENCES investments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who did what, when. Never updated or deleted by the app.
CREATE TABLE audit_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  action VARCHAR(50) NOT NULL,
  entity VARCHAR(30) NULL,
  entity_id INT UNSIGNED NULL,
  details TEXT NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL,
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (k, v) VALUES ('business_name', 'MyFinance');
INSERT INTO settings (k, v) VALUES ('late_fee_per_day', '0');
INSERT INTO settings (k, v) VALUES ('foreclosure_charge_pct', '0');
INSERT INTO settings (k, v) VALUES ('foreclosure_interest_policy', 'accrued');
INSERT INTO settings (k, v) VALUES ('business_phone', '');

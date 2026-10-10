-- ============================================================================
-- 001_core.sql  (Milestone 1)
-- Core ledger schema. Goal: make invalid money states impossible *in the DB*,
-- not only in application code.
--
-- Conventions: plural snake_case tables, singular snake_case columns,
-- BIGINT identity primary keys, money as whole paise in BIGINT (never FLOAT).
-- ============================================================================

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  email       TEXT        NOT NULL,   -- data we do NOT control -> never a key
  phone       TEXT        NOT NULL,   -- data we do NOT control -> never a key
  kyc_status  TEXT        NOT NULL DEFAULT 'PENDING'
              CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unique (business rule: one account per email/phone) but NOT primary keys.
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uq ON users (phone);

-- ------------------------------------------------------------- accounts ----
-- User wallets AND system accounts live in one table so that a ledger entry has
-- exactly one foreign key target ("an entry hits exactly one account") and the
-- same code path moves money in every case.
CREATE TABLE accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT        NOT NULL CHECK (kind IN ('USER_WALLET', 'SYSTEM')),
  user_id      BIGINT      REFERENCES users (id),
  name         TEXT        NOT NULL CHECK (length(btrim(name)) > 0),  -- 'main', 'savings', ...
  system_code  TEXT,                                                  -- 'CASH_IN', ...
  currency     CHAR(3)     NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  -- Stored (cached) balance in paise. The ledger is the source of truth; the
  -- nightly job proves this column still equals the sum of its entries.
  balance      BIGINT      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A wallet belongs to a user and has no system code; a system account is the
  -- opposite. Impossible mixed states are rejected by the database.
  CONSTRAINT accounts_owner_ck CHECK (
       (kind = 'USER_WALLET' AND user_id IS NOT NULL AND system_code IS NULL)
    OR (kind = 'SYSTEM'      AND user_id IS NULL     AND system_code IS NOT NULL)
  ),
  -- THE overdraft guard. Whatever the application does, a user wallet can never
  -- be stored below zero. System accounts may go negative (cash-in always does).
  CONSTRAINT accounts_wallet_nonnegative_ck CHECK (kind = 'SYSTEM' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_user_name_uq   ON accounts (user_id, name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_code_uq ON accounts (system_code)   WHERE system_code IS NOT NULL;

INSERT INTO accounts (kind, name, system_code) VALUES
  ('SYSTEM', 'Cash-in (top-ups)',        'CASH_IN'),
  ('SYSTEM', 'Cash-out (withdrawals)',   'CASH_OUT'),
  ('SYSTEM', 'Fee revenue',              'FEE_REVENUE');

-- ------------------------------------------------------------ transfers ----
-- The business event. Money moves ONLY through a transfer.
CREATE TABLE transfers (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type                    TEXT   NOT NULL
                          CHECK (type IN ('TOPUP', 'PEER_TRANSFER', 'WITHDRAWAL', 'FEE', 'REVERSAL')),
  -- HELD      : fraud rule stopped it; NO ledger entries exist yet
  -- COMPLETED : entries written
  -- REVERSED  : completed, later undone by a REVERSAL transfer
  -- REJECTED  : held, then refused by an admin; never moved money
  status                  TEXT   NOT NULL
                          CHECK (status IN ('HELD', 'COMPLETED', 'REVERSED', 'REJECTED')),
  amount                  BIGINT NOT NULL CHECK (amount > 0),   -- principal, in paise
  fee                     BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
  -- The intent of the transfer (who pays, who receives). Held transfers have no
  -- entries yet, so we need this here; the risk rules also query it.
  source_account_id       BIGINT NOT NULL REFERENCES accounts (id),
  destination_account_id  BIGINT NOT NULL REFERENCES accounts (id),
  initiated_by_user_id    BIGINT REFERENCES users (id),         -- NULL = system/admin
  reverses_transfer_id    BIGINT REFERENCES transfers (id),
  note                    TEXT   CHECK (note IS NULL OR length(note) <= 280),  -- user input!
  -- clock_timestamp() (not now()): the real insert time, taken while we hold the
  -- account locks, so per-account ordering by (created_at, id) follows commit order.
  created_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT transfers_distinct_accounts_ck CHECK (source_account_id <> destination_account_id),
  CONSTRAINT transfers_reversal_ck CHECK ((type = 'REVERSAL') = (reverses_transfer_id IS NOT NULL))
);
-- A transfer can be reversed at most once (concurrent double-reverse -> unique violation).
CREATE UNIQUE INDEX transfers_one_reversal_uq ON transfers (reverses_transfer_id)
  WHERE reverses_transfer_id IS NOT NULL;
-- Risk rules: velocity + daily volume ("what did this wallet send recently?").
CREATE INDEX transfers_source_created_idx ON transfers (source_account_id, created_at DESC);
-- Risk rule: "has this wallet ever paid this recipient?"
CREATE INDEX transfers_source_dest_idx    ON transfers (source_account_id, destination_account_id);
-- Statement Q&A: "what did this wallet receive in a date range?"
CREATE INDEX transfers_dest_created_idx   ON transfers (destination_account_id, created_at DESC);
-- Admin review queue: tiny partial index, only HELD rows pay for it.
CREATE INDEX transfers_held_idx           ON transfers (created_at) WHERE status = 'HELD';

-- -------------------------------------------------------- ledger_entries ----
-- Amount is ALWAYS positive; direction is stored separately.
--   Why not signed amounts? Signed makes SUM() trivial, but then "debits equal
--   credits" is the less readable "sum is zero", a zero/wrong-sign row is easy to
--   write by accident, and auditors think in debit/credit columns. With positive
--   amounts the CHECK (amount > 0) kills a whole class of bugs, and the sign
--   convention lives in exactly one place (balance = credits - debits).
CREATE TABLE ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT      NOT NULL REFERENCES transfers (id),
  account_id  BIGINT      NOT NULL REFERENCES accounts (id),
  direction   CHAR(1)     NOT NULL CHECK (direction IN ('D', 'C')),
  amount      BIGINT      NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Statement query: one wallet, newest first, keyset-paginatable on (created_at, id).
CREATE INDEX ledger_entries_account_time_idx ON ledger_entries (account_id, created_at DESC, id DESC);
-- "Show me the entries of transfer X" + the per-transfer balance check.
CREATE INDEX ledger_entries_transfer_idx     ON ledger_entries (transfer_id);

-- ------------------------------------------------- audit log of statuses ----
CREATE TABLE transfer_status_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  BIGINT      NOT NULL REFERENCES transfers (id),
  from_status  TEXT,                               -- NULL for the first row
  to_status    TEXT        NOT NULL,
  changed_by   TEXT        NOT NULL,               -- 'user:12' | 'admin' | 'system'
  reason       TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX transfer_status_history_transfer_idx ON transfer_status_history (transfer_id, id);

-- ============================================================================
-- Guard rails implemented as triggers
-- ============================================================================

-- 1) Append-only tables: no UPDATE, DELETE or TRUNCATE. A mistake is fixed with a
--    new REVERSAL transfer, never by editing history.
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';   -- object_not_in_prerequisite_state
END $$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER transfer_status_history_append_only
  BEFORE UPDATE OR DELETE ON transfer_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- 2) A transfer's money facts are immutable; only its status may change.
CREATE FUNCTION transfers_freeze_money_columns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type                   IS DISTINCT FROM OLD.type
  OR NEW.amount                 IS DISTINCT FROM OLD.amount
  OR NEW.fee                    IS DISTINCT FROM OLD.fee
  OR NEW.source_account_id      IS DISTINCT FROM OLD.source_account_id
  OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
  OR NEW.reverses_transfer_id   IS DISTINCT FROM OLD.reverses_transfer_id
  THEN
    RAISE EXCEPTION 'transfer % money columns are immutable; only status may change', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transfers_freeze_money
  BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_freeze_money_columns();

CREATE TRIGGER transfers_no_delete
  BEFORE DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- 3) Double entry, enforced by the database: at COMMIT time, every transfer that
--    has entries must have debits == credits. DEFERRED, because entries are
--    inserted one row at a time and are only balanced once all of them are in.
CREATE FUNCTION check_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d BIGINT;
  c BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
    INTO d, c
    FROM ledger_entries
   WHERE transfer_id = NEW.transfer_id;
  IF d <> c THEN
    RAISE EXCEPTION 'transfer % is unbalanced: debits=% credits=%', NEW.transfer_id, d, c
      USING ERRCODE = '23514';   -- check_violation
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transfer_balanced();

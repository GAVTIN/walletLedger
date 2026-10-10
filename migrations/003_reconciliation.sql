-- ============================================================================
-- 003_reconciliation.sql  (Milestone 4)
-- ============================================================================

-- One row per background job. A run starts with
--   SELECT ... FROM job_locks WHERE job_name = $1 FOR UPDATE NOWAIT
-- so only one run can exist at a time, even across several worker processes.
CREATE TABLE job_locks (
  job_name  TEXT PRIMARY KEY
);
INSERT INTO job_locks (job_name) VALUES ('reconciliation');

CREATE TABLE reconciliation_runs (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger                  TEXT        NOT NULL CHECK (trigger IN ('CRON', 'MANUAL')),
  status                   TEXT        NOT NULL DEFAULT 'RUNNING'
                           CHECK (status IN ('RUNNING', 'CLEAN', 'ISSUES_FOUND', 'ERROR')),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at              TIMESTAMPTZ,
  checks_run               INT         NOT NULL DEFAULT 0,
  issues_found             INT         NOT NULL DEFAULT 0,
  ledger_entries_scanned   BIGINT,
  error                    TEXT
);

CREATE TABLE reconciliation_issues (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        BIGINT      NOT NULL REFERENCES reconciliation_runs (id),
  check_name    TEXT        NOT NULL,   -- GLOBAL_BALANCE | TRANSFER_BALANCE | STORED_BALANCE | NO_OVERDRAFT | ORPHAN
  subject_type  TEXT        NOT NULL,   -- LEDGER | TRANSFER | ACCOUNT | ENTRY
  subject_id    BIGINT,                 -- NULL for whole-ledger checks
  expected      TEXT        NOT NULL,
  actual        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_issues_run_idx ON reconciliation_issues (run_id);

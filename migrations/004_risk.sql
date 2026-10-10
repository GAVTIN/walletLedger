-- ============================================================================
-- 004_risk.sql  (Milestone 5)
-- Thresholds live in a table, not in code.
-- ============================================================================
CREATE TABLE risk_rules (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT        NOT NULL UNIQUE,
  description  TEXT        NOT NULL,
  action       TEXT        NOT NULL CHECK (action IN ('HOLD', 'FLAG')),  -- hold = no money moves
  params       JSONB       NOT NULL,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Amounts are paise: 5_000_000 paise = Rs 50,000.
INSERT INTO risk_rules (code, description, action, params) VALUES
  ('LARGE_AMOUNT',
   'Single outgoing transfer at or above the threshold',
   'HOLD', '{"threshold_paise": 5000000}'),
  ('DAILY_VOLUME',
   'Rolling 24h outgoing total (including this transfer) above the limit',
   'HOLD', '{"limit_paise": 10000000, "window_hours": 24}'),
  ('VELOCITY',
   'Too many outgoing transfers from one wallet in a short window',
   'FLAG', '{"max_transfers": 5, "window_minutes": 10}'),
  ('NEW_RECIPIENT_HIGH',
   'First-ever payment to this recipient and amount at or above the threshold',
   'FLAG', '{"threshold_paise": 1000000}');

CREATE TABLE risk_flags (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id       BIGINT      NOT NULL REFERENCES transfers (id),
  rule_code         TEXT        NOT NULL REFERENCES risk_rules (code),
  action_taken      TEXT        NOT NULL CHECK (action_taken IN ('HELD', 'FLAGGED')),
  detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- measured value vs threshold
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT,
  -- Filled by the nightly job (Milestone 5, part B). The LLM only EXPLAINS a
  -- decision the rules already made; it never makes one.
  llm_label         TEXT        CHECK (llm_label IN ('likely_ok', 'review', 'likely_fraud')),
  llm_explanation   TEXT,
  llm_explained_at  TIMESTAMPTZ,
  UNIQUE (transfer_id, rule_code)
);
-- Nightly "what still needs an explanation?" lookup. Partial: stays tiny.
CREATE INDEX risk_flags_unexplained_idx ON risk_flags (created_at) WHERE llm_explained_at IS NULL;
-- Admin review queue: "which flags has nobody looked at yet?"
CREATE INDEX risk_flags_unreviewed_idx ON risk_flags (transfer_id) WHERE reviewed_at IS NULL;

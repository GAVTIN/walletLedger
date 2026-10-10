-- ============================================================================
-- 002_idempotency.sql  (Milestone 3)
-- ============================================================================
CREATE TABLE idempotency_keys (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL for requests that have no user yet (POST /users) and for admin calls.
  user_id        BIGINT      REFERENCES users (id),
  key            UUID        NOT NULL,
  request_hash   CHAR(64)    NOT NULL,         -- sha256(method + path + canonical body)
  status         TEXT        NOT NULL DEFAULT 'IN_PROGRESS'
                 CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code  INT,
  response_body  TEXT,                         -- exact bytes we returned the first time
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  CONSTRAINT idempotency_completed_ck CHECK (
    (status = 'COMPLETED') = (response_code IS NOT NULL AND response_body IS NOT NULL)
  )
);
-- THE constraint that does the hard part: a key is unique per user. COALESCE makes
-- the "no user" scope (NULL) unique too, which a plain UNIQUE(user_id, key) would not.
CREATE UNIQUE INDEX idempotency_user_key_uq ON idempotency_keys ((COALESCE(user_id, 0)), key);
-- For the 24h cleanup in the nightly job.
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

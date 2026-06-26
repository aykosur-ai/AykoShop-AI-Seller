-- ============================================================================
-- AykoShop migration (2026-06-25d) — Wizard funnel events (monitoring substrate)
-- Append-only event log powering the System «🧪 Wizard» monitoring card:
--   started / step / payment_submitted / payment_verified / order_created /
--   delivery_completed / error(reason) / abandoned.
-- is_test separates Test-Wizard simulations from real customer flows.
-- Additive · idempotent. Owned by the app user (n8n) — safe to create.
-- ============================================================================
BEGIN;
CREATE TABLE IF NOT EXISTS aykoshop_wizard_events (
  id              BIGSERIAL    PRIMARY KEY,
  ts              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  session_key     VARCHAR(80),                 -- one wizard run
  subscriber_id   VARCHAR(64),
  event           VARCHAR(40)  NOT NULL,        -- started|step|payment_submitted|payment_verified|order_created|delivery_completed|error|abandoned
  step            VARCHAR(40),                  -- product|payment_method|payment_proof|verify|order|delivery
  product_id      INTEGER,
  amount_centimes INTEGER,
  payment_method  VARCHAR(40),
  error_reason    VARCHAR(60),                  -- payment_verify_failed|order_failed|missing_policy|missing_payment_account|runtime_error
  is_test         BOOLEAN      NOT NULL DEFAULT false,
  meta            JSONB        NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_wizev_ts      ON aykoshop_wizard_events(ts);
CREATE INDEX IF NOT EXISTS idx_wizev_session ON aykoshop_wizard_events(session_key);
CREATE INDEX IF NOT EXISTS idx_wizev_event   ON aykoshop_wizard_events(event);
COMMIT;
-- ROLLBACK: DROP TABLE IF EXISTS aykoshop_wizard_events;

-- ============================================================================
-- AykoShop migration — Type-Inheritance + the money "spine" (first brick)
-- Date: 2026-06-25 · Additive · Idempotent / re-runnable · ONE VPS Postgres
-- STATUS: REVIEW ARTIFACT — NOT YET APPLIED TO PROD. Apply behind the flag only
--   after owner sign-off + on the deploy gate. OFF flag = byte-identical behaviour.
--
-- Contents:
--   1) aykoshop_product_type_policies  — Type-Contract (policy written ONCE per
--      type, inherited by every product of that type). Two-plane model.
--   2) Money SPINE — idempotent orders + append-only payments/ledger + reconcile.
--   3) Decision flight-recorder column on agent_trail (replayable decisions).
--   4) Seeds — ONLY policies the owner actually stated (adversarially verified:
--      zero invented facts). FF account 16d; codes; recharge. PES/social NOT seeded.
--
-- Correctness note: the contract is keyed on a precise `type_key` (e.g. ff_account)
--   NOT on product_type, because product_type='account' covers BOTH Free Fire AND
--   PES — keying on product_type alone would leak FF's 16-day warranty onto PES.
--   The runtime resolves a product -> type_key from (product_type, game).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) TYPE-CONTRACT (the net-new structure agreed 2026-06-25)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aykoshop_product_type_policies (
  id                       SERIAL       PRIMARY KEY,
  type_key                 VARCHAR(48)  UNIQUE NOT NULL,   -- ff_account | ff_code | ff_recharge | pes_account | social_account ...
  display_name             VARCHAR(120) NOT NULL,
  -- resolution hints: a product maps here via (product_type, game). NULL game = any.
  match_product_type       VARCHAR(40),
  match_game               VARCHAR(60),

  -- ---- WARRANTY contract ----------------------------------------------------
  warranty_days            INTEGER,                              -- ff_account=16; code/recharge=NULL (none stated)
  warranty_covers          TEXT        DEFAULT '',
  warranty_void_conditions JSONB       NOT NULL DEFAULT '[]',
  remedy                   VARCHAR(16) NOT NULL DEFAULT 'none',  -- replacement | redo | compensate | none
  refund_allowed           BOOLEAN     NOT NULL DEFAULT false,

  -- ---- DELIVERY / fulfillment ----------------------------------------------
  binding_methods          JSONB       NOT NULL DEFAULT '[]',
  delivery_steps           JSONB       NOT NULL DEFAULT '[]',
  forbidden_after_delivery JSONB       NOT NULL DEFAULT '[]',
  predelivery_script       TEXT        DEFAULT '',              -- verbatim owner wording, AI must emit, never paraphrase
  delivery_message         TEXT        DEFAULT '',
  verify_before_delivered  BOOLEAN     NOT NULL DEFAULT false,  -- recharge = true (100% success check)

  -- ---- SALES contract (inherited) ------------------------------------------
  buyer_requirements       JSONB       NOT NULL DEFAULT '[]',
  default_objections       JSONB       NOT NULL DEFAULT '[]',
  allowed_payment_methods  JSONB       NOT NULL DEFAULT '["all"]',
  sales_dna                JSONB       NOT NULL DEFAULT '{}',

  policy_version           INTEGER     NOT NULL DEFAULT 1,      -- bump on owner edit -> serve-time cache-bust
  notes                    TEXT        DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ptp_remedy_valid CHECK (remedy IN ('replacement','redo','compensate','none'))
);
CREATE INDEX IF NOT EXISTS idx_ptp_match ON aykoshop_product_type_policies(match_product_type, match_game);

-- ----------------------------------------------------------------------------
-- 2) MONEY SPINE — exactly-once orders + reconcilable ledger
-- ----------------------------------------------------------------------------
-- 2a) Make orders idempotent (additive ALTERs over the LIVE table).
ALTER TABLE aykoshop_orders ADD COLUMN IF NOT EXISTS idempotency_key        VARCHAR(80);
ALTER TABLE aykoshop_orders ADD COLUMN IF NOT EXISTS transaction_ref        VARCHAR(120);
ALTER TABLE aykoshop_orders ADD COLUMN IF NOT EXISTS payment_method         VARCHAR(40);
ALTER TABLE aykoshop_orders ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
ALTER TABLE aykoshop_orders ADD COLUMN IF NOT EXISTS price_centimes         INTEGER;   -- money as INTEGER minor units, never VARCHAR
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_idempotency ON aykoshop_orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_txn_ref     ON aykoshop_orders(transaction_ref) WHERE transaction_ref IS NOT NULL;
-- (App-side: INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING — one txn, no dup paid order.)

-- 2b) Append-only payments + ledger (never UPDATE in place; reconcilable).
CREATE TABLE IF NOT EXISTS aykoshop_payments (
  id              SERIAL       PRIMARY KEY,
  subscriber_id   VARCHAR(64)  NOT NULL,             -- join on stable id, NOT customer_name
  order_id        INTEGER      REFERENCES aykoshop_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  method          VARCHAR(40),
  amount_centimes INTEGER      NOT NULL,
  currency        VARCHAR(8)   NOT NULL DEFAULT 'MAD',
  transaction_ref VARCHAR(120) UNIQUE,               -- one real transfer settles one payment
  screenshot_url  TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'claimed',  -- claimed | verified | rejected
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_sub ON aykoshop_payments(subscriber_id);

CREATE TABLE IF NOT EXISTS aykoshop_ledger (
  id              BIGSERIAL    PRIMARY KEY,
  ts              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  subscriber_id   VARCHAR(64),
  order_id        INTEGER,
  payment_id      INTEGER,
  event           VARCHAR(32)  NOT NULL,             -- order_created | payment_claimed | payment_verified | delivered | replaced | voided
  amount_centimes INTEGER      NOT NULL DEFAULT 0,
  ref             VARCHAR(160),                       -- e.g. links a replacement to the original order
  meta            JSONB        NOT NULL DEFAULT '{}'
);  -- append-only: INSERT only, never UPDATE/DELETE
CREATE INDEX IF NOT EXISTS idx_ledger_order ON aykoshop_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_event ON aykoshop_ledger(event);

-- 2c) Reconcile view — nightly cron asserts these are empty + alerts on mismatch.
CREATE OR REPLACE VIEW aykoshop_reconcile_anomalies AS
  -- delivered orders with no single verified payment
  SELECT o.id AS order_id, 'delivered_without_verified_payment' AS anomaly
    FROM aykoshop_orders o
    WHERE o.delivered_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM aykoshop_payments p
                      WHERE p.order_id = o.id AND p.status = 'verified');

-- ----------------------------------------------------------------------------
-- 3) DECISION FLIGHT-RECORDER — make agent_trail replayable (additive column)
-- ----------------------------------------------------------------------------
ALTER TABLE aykoshop_agent_trail ADD COLUMN IF NOT EXISTS decision_envelope JSONB;
-- decision_envelope = { in_msg, grounding_facts_used, model, prompt_version,
--                       nba:{buying_prob,stage,slots}, compose_out, verify:{pass,reason} }
-- PII-redacted at write time; prune raw payloads after N days, keep the verdict.

-- ----------------------------------------------------------------------------
-- 4) SEEDS — ONLY owner-stated policy (adversarially verified: 0 invented facts)
-- ----------------------------------------------------------------------------
-- Free Fire ACCOUNT — 16-day replacement warranty, full pre-delivery script.
INSERT INTO aykoshop_product_type_policies
  (type_key, display_name, match_product_type, match_game, warranty_days, warranty_covers,
   warranty_void_conditions, remedy, refund_allowed, binding_methods, forbidden_after_delivery,
   predelivery_script, verify_before_delivered, allowed_payment_methods, notes)
VALUES (
  'ff_account', 'Free Fire account', 'account', 'Free Fire', 16,
  'ONLY problems caused by AykoShop',
  '["cancel/delete recovery","change security settings blocking recovery","violate delivery instructions","any self-modification that loses the account"]'::jsonb,
  'replacement', false,
  '["Gmail","Facebook","Apple ID","VK","X","new recovery email in customer name"]'::jsonb,
  '["cancel recovery","delete recovery","change security settings blocking recovery"]'::jsonb,
  E'هاد الحساب دابا مربوط بيك\nما تلغيش/ما تمسحش الاستعادة (recovery)\nما تبدّلش إعدادات الأمان (security settings) إلا إلا طلبنا منك\nإلا اتبعتي هاد التعليمات، الضمان يبقى صالح 16 يوم',
  false,
  '["Cash Plus","Wafacash","CIH","Attijari","Barid Bank","Binance"]'::jsonb,
  'Hand over promptly: recovery email can go invalid in ~14-15 days.'
) ON CONFLICT (type_key) DO NOTHING;

-- Free Fire CODE — responsibility split; NO warranty period stated (not invented).
INSERT INTO aykoshop_product_type_policies
  (type_key, display_name, match_product_type, match_game, remedy, refund_allowed, allowed_payment_methods, notes)
VALUES (
  'ff_code', 'Free Fire code', 'code', 'Free Fire', 'none', false, '["all"]'::jsonb,
  'If AykoShop enters the code -> AykoShop responsible. If customer self-enters after delivery -> responsibility passes to customer. Remedy on AykoShop-entry failure NOT stated — needs owner input; do not invent.'
) ON CONFLICT (type_key) DO NOTHING;

-- Free Fire RECHARGE — verify 100% before delivered; redo-or-compensate (specifics open).
INSERT INTO aykoshop_product_type_policies
  (type_key, display_name, match_product_type, match_game, remedy, refund_allowed,
   verify_before_delivered, buyer_requirements, notes)
VALUES (
  'ff_recharge', 'Free Fire recharge', 'recharge', 'Free Fire', 'redo', false, true,
  '[{"key":"recharge_mode","label":"طريقة الشحن (ID / login)","required":true},{"key":"game_id","label":"ID اللعبة","required_if":"recharge_mode=id"}]'::jsonb,
  'Two modes: by game ID, or by login to customer account. Verify 100% success before delivered. On AykoShop-error: re-do OR compensate per policy — WHEN/amount NOT stated; package price list + floor NOT set — needs owner input.'
) ON CONFLICT (type_key) DO NOTHING;

-- Flag OFF — runtime ignores inherited policy until owner enables (OFF = byte-identical).
INSERT INTO aykoshop_settings (key, value)
  VALUES ('ff_type_inheritance', 'off') ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ROLLBACK (if needed before the flag is turned on — all additive):
--   DROP VIEW IF EXISTS aykoshop_reconcile_anomalies;
--   DROP TABLE IF EXISTS aykoshop_ledger;  DROP TABLE IF EXISTS aykoshop_payments;
--   DROP TABLE IF EXISTS aykoshop_product_type_policies;
--   ALTER TABLE aykoshop_agent_trail DROP COLUMN IF EXISTS decision_envelope;
--   (orders columns/indexes are additive and safe to leave.)

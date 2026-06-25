-- ============================================================================
-- AykoShop migration (2026-06-25b) — feed the spine with owner-provided data:
--   A) aykoshop_payment_accounts  — the REAL payment destinations (from DB only,
--      per owner rule). Customer-facing pay-to accounts (low confidentiality:
--      knowing a RIB lets one SEND money, not take it). Integrity-protected by
--      DB access control, not secrecy.
--   B) Free Fire RECHARGE packages (id 39) — diamonds/price/floor, owner-given.
--   C) ff_recharge Type-Contract — Player-ID-only policy, delivery, compensation,
--      AI rules (no fixed time, never invent price/package).
-- Additive · idempotent · transcribed verbatim from owner 2026-06-25.
-- VERIFIED faithful: every value matches the owner's message; the ONLY altered
--   item is the Attijari account number "001027X300400415" (contains a masked X)
--   -> stored as needs_confirmation so the Wizard won't render a broken number.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A) PAYMENT ACCOUNTS  (the #1 blocker — now provided)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aykoshop_payment_accounts (
  id           SERIAL       PRIMARY KEY,
  method_key   VARCHAR(24)  UNIQUE NOT NULL,        -- cashplus|wafacash|cih|attijari|barid|binance
  display_name VARCHAR(60)  NOT NULL,
  holder_name  VARCHAR(80),
  fields       JSONB        NOT NULL DEFAULT '[]',  -- [{"label","value","status":"ok|needs_confirmation","note"}]
  currency     VARCHAR(8)   NOT NULL DEFAULT 'MAD',
  active       BOOLEAN      NOT NULL DEFAULT true,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  notes        TEXT         DEFAULT '',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO aykoshop_payment_accounts (method_key, display_name, holder_name, fields, currency, sort_order) VALUES
 ('cashplus','Cash Plus','Ayoub Akarfi',
  '[{"label":"الرقم (Cash Plus)","value":"0620250691","status":"ok"}]'::jsonb,'MAD',1),
 ('wafacash','Wafacash','Ayoub Akarfi',
  '[{"label":"الرقم (Wafacash)","value":"0620250691","status":"ok"}]'::jsonb,'MAD',2),
 ('cih','CIH Bank','ay ko',
  '[{"label":"تحويل من بنك آخر إلى CIH — RIB","value":"230380300547221102350017","status":"ok"},
    {"label":"تحويل من CIH إلى CIH — رقم الحساب","value":"3005472211023500","status":"ok"}]'::jsonb,'MAD',3),
 ('attijari','Attijari Bank','ay ko',
  '[{"label":"RIB","value":"007380001027730040041542","status":"ok"},
    {"label":"رقم الحساب","value":"001027X300400415","status":"needs_confirmation","note":"يحتوي X — رقم مقنّع، خاص تأكيد المالك قبل العرض للزبون"}]'::jsonb,'MAD',4),
 ('barid','Barid Bank','ay ko',
  '[{"label":"RIB","value":"350810000000001312260114","status":"ok"},
    {"label":"رقم الحساب","value":"13122601","status":"ok"}]'::jsonb,'MAD',5),
 ('binance','Binance (USDT)',NULL,
  '[{"label":"Binance ID (USDT)","value":"1141018907","status":"ok"}]'::jsonb,'USDT',6)
ON CONFLICT (method_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- B) FREE FIRE RECHARGE PACKAGES (catalog id 39) — diamonds / price / floor
--    floor_dh = null  => owner-decides (5 big packages still need a floor)
-- ----------------------------------------------------------------------------
UPDATE aykoshop_products SET recharge_packages =
 '[{"diamonds":110,"price_dh":13,"floor_dh":12},
   {"diamonds":230,"price_dh":25,"floor_dh":23},
   {"diamonds":340,"price_dh":36,"floor_dh":34},
   {"diamonds":580,"price_dh":60,"floor_dh":57},
   {"diamonds":1045,"price_dh":115,"floor_dh":110},
   {"diamonds":1188,"price_dh":120,"floor_dh":null},
   {"diamonds":2000,"price_dh":190,"floor_dh":null},
   {"diamonds":2420,"price_dh":225,"floor_dh":null},
   {"diamonds":5000,"price_dh":430,"floor_dh":null},
   {"diamonds":10000,"price_dh":850,"floor_dh":null}]'::jsonb,
   updated_at = NOW()
 WHERE id = 39;

-- ----------------------------------------------------------------------------
-- C) ff_recharge Type-Contract — Player-ID-only policy (owner-stated verbatim)
-- ----------------------------------------------------------------------------
UPDATE aykoshop_product_type_policies SET
  buyer_requirements = '[{"key":"player_id","label":"Player ID","required":true,"note":"تأكد أن الـ ID خاص الزبون؛ ID خاطئ أو معلومات خاطئة = على مسؤولية الزبون"}]'::jsonb,
  delivery_steps = '["شحن Free Fire عبر Player ID فقط.",
    "اطلب Player ID صحيح وتأكد أنه خاص الزبون.",
    "المدة المعتادة: من دقيقة إلى 5 دقائق.",
    "عند الضغط أو مشكل من المزوّد: لا تذكر وقتاً محدداً، قل: «كاين ضغط شوية دابا، وغادي يوصلك الشحن فأقرب وقت.»",
    "تأكد من نجاح الشحن 100% قبل اعتباره مُسلَّماً."]'::jsonb,
  delivery_message = 'كاين ضغط شوية دابا، وغادي يوصلك الشحن فأقرب وقت.',
  remedy = 'redo',
  verify_before_delivered = true,
  notes = 'FF recharge via Player ID only. Compensation: AykoShop/provider error -> re-recharge OR full compensation. Wrong Player ID / wrong customer info -> NOT covered. AI rules: never promise a fixed time; never invent a price or a package; all prices AND payment methods come from the DB only. Floors: 5 big packages (1188+) still owner-decides.',
  policy_version = policy_version + 1,
  updated_at = NOW()
 WHERE type_key = 'ff_recharge';

COMMIT;

-- ROLLBACK (additive): DROP TABLE IF EXISTS aykoshop_payment_accounts;
--   (recharge_packages / ff_recharge updates are owner data — re-run to change.)

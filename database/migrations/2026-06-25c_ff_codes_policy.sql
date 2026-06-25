-- ============================================================================
-- AykoShop migration (2026-06-25c) — Free Fire CODES Type-Contract (owner-stated)
-- Closes the code-failure-remedy gap. First explicit REFUND case in the project:
--   AykoShop-entered code fails -> try another code of the SAME type -> if none
--   available -> REFUND the customer (so ff_code.refund_allowed = true, last-resort).
-- Additive · idempotent · transcribed verbatim from owner 2026-06-25.
-- ============================================================================

BEGIN;

UPDATE aykoshop_product_type_policies SET
  remedy         = 'replacement',   -- try another code of the same type until it works
  refund_allowed = true,            -- LAST RESORT only: when no equivalent replacement code exists
  delivery_steps = '["أكواد Free Fire (سكنات، أسلحة، رقصات، جدران Gloo Wall، ثلجات، وعناصر أخرى داخل اللعبة).",
    "إلا كان الزبون كيعرف يدخل الكود بنفسه: نسلموه الكود مباشرة.",
    "إلا طلب الزبون أن AykoShop يدخل الكود: الفريق كيدخلو داخل حسابه.",
    "جميع الأكواد كتُختبر قبل التسليم قدر الإمكان."]'::jsonb,
  buyer_requirements = '[{"key":"code_mode","label":"طريقة الاستلام (ناخذ الكود بنفسي / AykoShop يدخلو)","required":true},
    {"key":"account_access","label":"الوصول للحساب لإدخال الكود","required_if":"code_mode=aykoshop_enters"}]'::jsonb,
  warranty_void_conditions = '["الزبون اختار يدخل الكود بنفسه ثم أدخله بطريقة خاطئة",
    "استعمل الكود في حساب غير صحيح",
    "الكود أصبح غير صالح بسبب خطأ من الزبون"]'::jsonb,
  warranty_covers = 'AykoShop-entered codes: replacement (then refund if none). Self-entered: customer error is not covered.',
  notes = 'Codes = in-game items (skins/weapons/emotes/Gloo Wall/freezes/etc.). Tested before delivery as much as possible. FAILURE PATH (AykoShop entered & did not work): try another code of the SAME type until it works; if NO replacement available -> REFUND the customer (first explicit refund case). CUSTOMER RESPONSIBILITY: if the customer self-receives and enters it wrong / uses a wrong account / invalidates it by own error -> on the customer. AI RULES: never invent codes or non-existent items; all codes + prices from DB only; if no code available, state it plainly, never invent stock.',
  policy_version = policy_version + 1,
  updated_at = NOW()
 WHERE type_key = 'ff_code';

COMMIT;
-- ROLLBACK: re-run the prior ff_code seed values (additive owner-data update).

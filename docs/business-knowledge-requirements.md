# AykoShop — Business Knowledge Pack required BEFORE building (CTO intake)

**The honest finding (measured from the live DB, not assumed):** the *architecture and schema are largely built* (the `aykoshop_products` table already has 70+ "Product DNA" columns; evidence/agent/trace infra exists). **What is missing is the BUSINESS KNOWLEDGE that fills them.** Today:
- `selling_angle 0/6 · objections 0/6 · target_customer 0/6 · guarantee_note 0/6 · delivery_promise 0/6 · do_not_recommend 0/6` filled.
- Objection Library = **0 rows**. FAQs/Training/Suppliers/Macros = **0**. Only **6 products** (you have 80+). 8 payment methods live as one loose `settings` blob, not a structured model.

**Conclusion:** a world-class engine reading empty selling fields behaves like a chatbot. The #1 blocker to a real Sales AI is **knowledge, not code.** Provide the pack below (most fits the existing schema = data entry, not redesign), then we build.

For each item: **WHY · IMPACT on AI quality · IF MISSING.**

---

## TIER 0 — Money-critical (blocks a *correct* sale; provide FIRST)

**1. Full product catalog (80+), structured** — per product: name, game/category, `product_type` (account/recharge/code/subscription/service), price (+ `price_usd/eur` if used), **`min_price` (negotiation floor)**, variants/packages (e.g. recharge tiers), **`buyer_requirements`** (what to collect to fulfill — e.g. game ID for recharge), **stock/availability**, `cost_price` (for margin/discount limits).
 · WHY: the entire money path reads this. · IMPACT: correct product + correct price + what-to-ask + can-we-fulfill. · IF MISSING: wrong/hallucinated product or price = money loss; the verifier has nothing to check against; only 6/80 sellable today.

**2. Pricing & discount policy** — negotiable or fixed (per product)? the floor (`min_price`)? `max_discount`? bundles? currency shown to the customer? **who/what may authorize a discount.**
 · WHY: negotiation + "غالي" handling + the close. · IF MISSING: AI either invents discounts (loss) or refuses to move on price (lost sales).

**3. Payment methods + accounts (the 8), as STRUCTURED data** — each: name, type (bank/wallet/crypto), the **exact** account number / wallet / Binance-ID / USDT address, currency, per-method instructions, min/max, and **which are currently LIVE.** (Today this is one loose settings blob — it needs a real `payment_methods` + `payment_accounts` model for the dynamic Wizard.)
 · WHY: the Wizard shows the customer where to pay. · IMPACT: this is the SINGLE highest-risk datum. · IF MISSING/WRONG: customer pays the wrong account = direct, unrecoverable loss + destroyed trust.

**4. Fulfillment / delivery definition per product type** — account (what's handed over: credentials? login-bot? change-password steps?), recharge (collect game ID → top-up → confirm), code (send the code), subscription (activation). Manual vs automated. Exact post-sale steps + realistic timing.
 · WHY: create_order + deliver + the "تسليم فـ…" promise. · IF MISSING: closes sales it can't fulfill; false promises → disputes.

**5. Payment-verification rules** — how you confirm a transfer screenshot (valid vs fake), auto vs manual review, scam-screenshot patterns, refund-before-deliver risk.
 · WHY: the verify step gates delivery. · IF MISSING: deliver on a fake screenshot = loss + fraud exposure.

---

## TIER 1 — The "salesperson" knowledge (currently EMPTY — this is *why* it sells like a bot)

**6. Per-product selling knowledge** (the 0/6 fields): `selling_angle` (why buy THIS), `key_features`/`key_benefits`, `target_customer`, `social_proof`, `guarantee_note`, `delivery_promise`, `urgency_message`, `do_not_recommend` (when NOT to push it).
 · WHY: the COMPOSE step turns these into persuasion. · IF MISSING: "عندنا X بـY. واش عجبك؟" — no reason to buy, low conversion. **The main cause of chatbot-feel.**

**7. Objection Library (0 rows today)** — YOUR real common objections + YOUR best closing replies: "غالي", "معندش ثقة", "كاين أرخص", "نشوف/غادي نخمّم", "واش مضمون", scam fear, "حساب غادي يتسرق". 
 · WHY: the objection handler is only as good as this library. · IF MISSING: AI escalates or channel-dumps instead of closing — exactly today's 171 escalations.

**8. Selling playbook / rules** — the ideal flow per product TYPE (an account sale ≠ a recharge ≠ a code ≠ a subscription), upsell/cross-sell rules (recharge after an account? bundle codes?), when to offer what, deposit/installment options if any.
 · WHY: the deterministic DECIDE policy encodes YOUR process. · IF MISSING: I'd guess your sales method → a generic seller, not *your best* seller.

**9. Warranty / guarantee + refund/return policy** — do you guarantee accounts (not banned / recovery-safe)? for how long? replacement vs refund conditions? per product type?
 · WHY: trust objections + after-sale + must be ACCURATE. · IF MISSING: AI invents a policy (dispute risk) or can't reassure (lost trust/sales).

---

## TIER 2 — Trust, tone, and the long tail

**10. Escalation / human-handoff contract** — beyond (product absent / asked-for-human / tech error): which situations MUST go to a human (high-value order? a dispute? a specific risky game/product?)? response SLA? what context the operator needs handed over?
 · IF MISSING: over-escalates (today) or under-escalates into a money mistake.

**11. Brand voice / persona / tone** — how should it sound (warm/professional/street-Darija)? emoji use? reply length? Darija vs French/English (your bot is multilingual)? and **what it must NEVER say** (no over-promising, no fake urgency, no guarantees you don't offer).
 · IF MISSING: inconsistent, off-brand, or risky replies.

**12. Customer segments** — new vs returning vs VIP vs reseller — different pricing/treatment/priority?
 · IF MISSING: one-size-fits-all; missed loyalty + reseller upsell.

**13. Edge cases / exceptions** — out-of-stock mid-sale · price changed mid-chat · wrong amount sent · partial/duplicate payment · customer vanishes mid-wizard · asks for a product you don't have · refund request · chargeback.
 · IF MISSING: the system errs exactly on the long-tail where money is lost.

---

## TIER 3 — Governance & success definition

**14. Success criteria + acceptable error rate** — target conversion? what counts as a "win"? max tolerable money-error rate? → defines the eval rubric + the daily KPIs.
**15. Compliance / sensitive boundaries** — Garena/ToS grey areas? anything the AI must not promise/claim? region/age constraints?
**16. Governance** — who may change prices / payment accounts / products, and the approval flow (the Key Manager handles API keys; money-data governance needs the same rigor).

---

## How to collect this fast (actionable, not a homework dump)
- **Products + selling fields:** the **Product Studio** (bulk-paste, already built) is the entry path; its **AI-DNA draft assistant** can DRAFT `selling_angle`/`objections`/`benefits` from your short input, you **approve** (prices/min_price always set by you, never AI). → 80 products become a guided session, not 80 forms.
- **Payment methods:** a short structured list (8 rows) → I model a `payment_methods` table.
- **Policies (warranty/refund/escalation/delivery) + Objection Library + brand voice:** a one-page answer each; I turn them into the Contracts.

**Build does not start until Tier 0 + Tier 1 are in.** Tier 0 prevents money errors; Tier 1 is what makes it sell. Tier 2-3 can land in parallel with the build. This is the difference between "we shipped and discovered missing data a month later" and "we filled the contracts first."

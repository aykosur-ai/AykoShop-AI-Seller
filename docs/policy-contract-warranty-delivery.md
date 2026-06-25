# AykoShop — Policy Contract: Warranty, Delivery, Buy/Objection Lexicons (owner-provided 2026-06-25)

> Machine-readable ground truth the Sales AI **quotes verbatim and may NEVER invent**. Source: founder's Knowledge Pack 2026-06-25. This is a frozen Contract — changes go through the owner only. Companion to [docs/aykoshop-ai-sales-platform-2026.md](aykoshop-ai-sales-platform-2026.md) and [docs/business-knowledge-requirements.md](business-knowledge-requirements.md).

---

## 0. DATA MODEL — Type-Inheritance (owner's idea 2026-06-25, ADOPTED)
**Proven by the live catalog:** `guarantee_note` is filled 0/6 even though the 16-day warranty exists — because there is **no type-level place to store it** (no type table; schema check returned none). Copying every policy into all 80 products is unmaintainable. The fix = **inheritance**:

- **TYPE-CONTRACT (write ONCE per type — ~6 total):** warranty days · delivery/fulfillment steps · forbidden-after-delivery · warranty-void conditions · remedy + refund stance · mandatory pre-delivery/delivery script · `buyer_requirements` template · default objections · allowed payment methods. Types: `Free Fire account` · `Social-media account` · `Recharge` · `Codes` · `PS4 game title` · `Subscription` · (`PES account` → decide: own contract or inherits FF-account).
- **PRODUCT-OVERRIDE (per product — only 4–6 fields):** name · price · `min_price` floor · description/specific content (rank/skins/recharge amount) · image · stock. The `selling_angle`/benefits are **auto-drafted** from the description, owner reviews.
- **A new product = pick its type → inherits the whole contract → owner fills only price + floor + description.** Maximally scalable + maintainable (change the FF warranty once → all FF products update). This is **per-field BOTH layers**: TYPE owns the rules, PRODUCT owns the few facts. Implementation = a `product_type_policies` table the products read at serve time (no policy duplicated into rows).

## 1. FREE FIRE ACCOUNT — warranty & delivery
- **Warranty: 16 days** from delivery.
- **Binding methods:** Gmail · Facebook · Apple ID · VK · X (Twitter) · or a new recovery email in the customer's name (depending on account type).
- **Delivery steps:** payment confirmed first → bind by customer's chosen supported method (else add recovery email in their name) → if account has a Primary Email it becomes the customer's → set up recovery for the customer → send the mandatory pre-delivery script → hand over promptly (recovery email can go invalid in ~14–15 days).
- **Warranty covers:** ONLY problems caused by AykoShop.
- **Void if customer:** cancels/deletes recovery · changes security settings (blocking recovery / against instructions) · violates instructions · any self-modification that loses the account.
- **Remedy:** REPLACEMENT with an account of same value/specs. **`refund_allowed: false`** (no cash refund stated).
- **Mandatory pre-delivery script (Darija, AI must say before handover):**
  - «هاد الحساب دابا مربوط بيك»
  - «ما تلغيش / ما تمسحش الاستعادة (recovery)»
  - «ما تبدّلش إعدادات الأمان (security settings) إلا إلا طلبنا منك»
  - «إلا اتبعتي هاد التعليمات، الضمان يبقى صالح 16 يوم»
- **AI hard constraints:** FF-only rules · never invent warranty/recovery info · different account type → use THAT policy only · remedy = replacement, never promise cash refund.

## 2. SOCIAL-MEDIA ACCOUNT (Instagram/Facebook/TikTok/X/Snapchat/…) — warranty & delivery
- **Warranty: 10 days** from delivery.
- **Pre-delivery securing (AykoShop does):** change email/phone/password as needed · remove previous-owner data · bind account to customer's data → fully bound to customer after delivery.
- **Void if customer:** changes security randomly · deletes recovery methods · adds/removes verification risking the account · any modification that loses/breaks it → warranty ends, no AykoShop liability.
- **Remedy:** REPLACEMENT same value/specs if the problem is from AykoShop **or from the account itself** within 10 days. **`refund_allowed: false`.**
- **Mandatory delivery message (Darija, replace X with 10):**
  «شكراً لاختياركم متجر AykoShop 🌸 تم تسليم الحساب وربطه ببياناتكم. ✅ الحساب مرتبط ببياناتك ✅ بريد الاستعادة بريدك ❌ ممنوع حذف/إلغاء الاستعادة ❌ إلغاء الاستعادة = نهاية الضمان. مدة الضمان 10 أيام ضد أي مشكلة من AykoShop.»

## 2b. RECHARGE (شحن) — fulfillment & warranty (owner-provided 2026-06-25)
- **Two delivery types:** (a) **by game ID** (like Free Fire — customer gives ID, AykoShop tops up); (b) **by logging into the customer's account** (some games/apps).
- **Pre-delivery rule:** AykoShop **always verifies the recharge succeeded 100%** before considering it delivered.
- **Remedy if recharge fails due to an AykoShop error:** **re-do the service OR compensate the customer** per policy.
- **AI hard constraints:** must collect the right input per type (game **ID** for ID-type; login handling per account-type policy) before promising fulfillment; never confirm a recharge it cannot fulfill; never invent the compensation amount.
- ⚠️ **Still vague (owner to confirm):** WHEN is it re-do vs compensate, and what exactly is the compensation (refund? store credit? partial?).

## 2c. CODES (أكواد) — fulfillment & responsibility (owner-provided 2026-06-25)
- **Catalog today:** **Free Fire codes only.**
- **Responsibility split:**
  - If the customer asks **AykoShop to enter the code** into their account → **AykoShop is responsible** for execution.
  - If the customer asks to **receive the code and enter it themselves** → after the code is delivered, **responsibility passes to the customer.**
- **AI hard constraints:** ask the customer which mode (we-enter vs you-receive) before delivery; state the responsibility split plainly; once a self-entry code is delivered, do not promise any post-delivery remedy.
- ⚠️ **Still vague (owner to confirm):** when AykoShop enters the code and it fails, what is the remedy (re-enter? replacement code? compensation?).

## 3. Cross-cutting rules (all product types)
- The AI **NEVER invents** warranty/recovery/price/product/payment/order info — "error-free like a big company" is the owner's #1 demand.
- **Policy is PER-PRODUCT-TYPE** — never apply one type's rules to another.
- **Only official numbers:** +212 632-588578 and +212 620-685987 (the owner's ONLY numbers; anything else = impersonation).
- Warranty counts from delivery · remedy = replacement same value/specs · no cash refund stated for any documented type.
- Any customer action that loses/breaks the account or blocks recovery → warranty ends immediately.
- AI must run the mandatory pre-delivery / delivery message for the type, in the owner's exact wording.

---

## 4. Buy-ready signal lexicon (seed for OPEN_WIZARD / NBA triggers)
| Phrase (Darija) | Meaning | System action |
|---|---|---|
| بغيت / باغي / بغيت نشري | explicit buy | prob >0.70 → confirm exact product+price (DB) → OPEN_WIZARD; never escalate |
| فين نخلص / كيفاش نخلص | "where do I pay" (strongest) | → Wizard Stage 9 Payment: confirm, show OUR account from DB, ask screenshot |
| صيفط / صيفط ليا الحساب | "send it" | if unpaid → recap+route to payment; if paid → Delivery; never re-ask money |
| وريني / وريني لي عندك / أرا | "show me" (mid-funnel) | prob 0.30–0.70 → Recommend 1 best-fit (image+price+why) + micro-close; no channel-dump |
| نشوف / نشوفو | **AMBIGUOUS** | with أرا/وريني/product-noun → show-me; bare نشوف → "think-about-it" objection (known prod bug) |
| شحال / بشحال / الثمن | price-ask = engagement | state EXACT catalog price (no cross-game MIN/MAX leak) + value + "واش نكمّل؟" |
| عجبني / واخا هادا | approval → green light | → Close: confirm+recap+micro-close → Wizard; reset clarify/loop |
| متوفر / واش كاين / عندك | availability check | check live stock; available→advance; OOS→nearest equivalent |
| نطلب / أكد ليا الطلب | order-commit | prob >0.70 → Wizard creates the order row (CODE) |
| أوكي / كمّل / زيد | go-ahead | forward-consent → advance one stage |
| راني مستعد / جاهز نخلص | readiness | prob >0.70 → Wizard straight to payment |

## 5. Objection lexicon (seed for `aykoshop_conversation_examples(entry_type=objection)` — 0 rows today)
| Phrase | Type | System action (Stage 7 — NEVER escalate) |
|---|---|---|
| غالي / غالي بزاف | price | gap-to-floor: <~30% → value reframe+close; at floor → floor-honesty ONCE → nearest cheaper. Discounts only within DB max_discount/min_price |
| عطيني تخفيض | discount-request | move toward (never below) min_price; trade discount for the close; at floor → hold+reframe |
| نصب / سكام / احتيال | trust/fraud-fear | cite REAL warranty (FF 16d / social 10d) + secure handover + social proof + official numbers; remedy=replacement (never refund) → close. Escalate ONLY if reporting an actual past fraud |
| واش مضمون / غارانتي | warranty question | answer EXACT policy by type; state void-conditions; pre-delivery binding script → close |
| نبغي نفكر / نخمّم / مزال | stall/hesitation | soft urgency + reserve; address unspoken reason; 1 of 3 attempts (engagement resets); raise cap 3→5 before human |
| كاين أرخص | competitor | value reframe (warranty+secure handover+verified brand vs risky cheap), not price collapse |
| ماعجبني / بدلها | product-mismatch | re-discovery: record rejection (anti-repeat), probe, recommend a DIFFERENT fit; no escalate |
| الحساب غادي يتسرق / يرجع لصاحبو | account-security fear | explain binding mechanics (recovery in customer's name) + warranty; customer's responsibilities; close |
| ماعندي ثقة | trust (general) | warranty+secure-handover+social-proof+numbers; offer reserve/trusted method; close |
| ماعندي فلوس / آخر الشهر | budget/timing | floor or cheaper alt; reserve+follow-up; installments ONLY if DB allows; log, no escalate |
| بزاف ديال السؤال | friction | minimum-questions qualify; jump to Recommend/Close; don't escalate |

## 6. Human-handoff triggers (narrow, last-resort — NOT turn-3)
Product truly absent (after catalog check + alternative) · customer explicitly asks for a human · technical/provider error (with holding message) · customer wants to SELL to us · **active complaint/dispute on a delivered order** (→ human with order+warranty status) · **payment-verification ambiguity** (fake/wrong/duplicate screenshot → hold delivery, manual confirm) · high-value/sensitive order over threshold · N genuine objection failures (with history) · **wrong-data risk on the money path** (product/price/account/warranty not resolvable from DB → STOP, hand over rather than guess).

---

## 7. How "error-free like big companies" is enforced (the guarantee, demonstrated)
LLM **proposes**, code **disposes**. Five mechanisms make money/trust errors *structurally* impossible:
1. **Grounding** — every fact (warranty days, price, payment account, product existence, remedy) is fetched from the DB/policy and injected; the model is never the source of a number.
2. **Deterministic DECIDE** — a bounded next-action policy; the model extracts intent + phrases, CODE picks the move and applies policy gates (recovery-question → warranty-void warning; warranty-claim → replacement-only).
3. **Output verifier (fail-closed, pre-send)** — scans the draft; any off-catalog product, out-of-floor price, non-allowlisted phone, or forbidden promise (cash refund, "you can delete recovery") is blocked/clamped + regenerated.
4. **Purchase Wizard** — the money path (product→payment account→screenshot→verify→order→deliver) is deterministic, DB-driven, ZERO LLM → payment numbers/amounts impossible to hallucinate.
5. **Gated deploys** — golden+smoke evals, flag-gated (OFF=byte-identical), reversible.

**Six proven catches** (a prompt-only bot errs → a guard stops it before send):
| A naive chatbot says | The error | Guard | What ships instead |
|---|---|---|---|
| "FF warranty is 30 days" | real = 16d → false obligation | grounding | "16 يوم من التسليم ضد أي مشكل من AykoShop…" |
| "Pay to 632-55**8878**" (transposed digit) | money to a stranger | wizard | DB renders exact 632-588578 / 620-685987; verifier strips non-allowlisted numbers |
| "I'll drop it to 500" (no floor) | gives away margin | output-verifier | clamps to catalog price/floor; reframe value at real price |
| "We'll refund your money" | policy = replacement only | grounding | "كنبدلو الحساب بواحد بنفس القيمة" |
| "Yes we have Valorant for 300" | not in catalog → fabricated | grounding | "ماعنديش Valorant دابا، عندي FF/PES/PS4…" |
| "Sure, you can cancel the recovery" | **voids warranty** (policy inversion) | decide-policy | the mandatory "ماتلغيش الاستعادة… الضمان يسالي" warning |

---

## 8. OPEN — owner must still confirm (business knowledge gaps)
**Type policies DEFINED:** FF account (16d) · social account (10d) · recharge (verify-100% + redo/compensate) · FF codes (responsibility split). **Still missing:**
- **PES / eFootball account policy** + **PS4 game-title policy** (warranty/delivery/fulfillment) — listed as products, no policy yet → AI will stall on them.
- **Refund stance** when no equivalent replacement exists (partial refund? store credit? explicit "no refund"?).
- **Recharge remedy specifics** — re-do vs compensate WHEN, and what compensation.
- **Code remedy** when AykoShop enters the code and it fails (re-enter? replacement? compensation?).
- **Per-product price + `min_price` floor** + **discount/negotiation room** (the lowest acceptable price; AI can't invent it).
- **The 8 payment methods' ACTUAL account details** (bank account numbers / Binance ID / USDT wallet that customers pay TO) + which methods are allowed per product (or "all").
- **The full 80+ catalog** factual data (only 6/80 entered) — name/type/price/what's-included/stock.
- *(optional)* customer segments (new/returning/VIP/reseller), explicit brand voice.

// QA-2793 (S2): whether a fee-capture UI surface exists in the product.
//
// Rule 54 (src/lib/rules.ts) refuses enrollment completion when
// defaults.fee_required_for_enrollment is ON and the candidate has no fee_paid_on, and tells
// the operator to "Record the payment on the candidate first." Commit e8e57a5 (14 Aug 15:59)
// added Rule 54 together with the three Candidate fee fields (fee_amount, fee_paid_on,
// fee_reference), the Defaults toggle and a candidates-page fee UI. Commit 231e687
// (14 Aug 19:35, "fees OFF") removed the fee UI and left the gate armed — Umesh, 15 Aug:
// "is program me payment nahi leni". Restoring the fee-capture UI was considered on
// 2026-09-20 and NOT chosen; the fields stay writable only through the candidates API
// allow-lists and are exercised only by scripts/e2e.mjs.
//
// So today there is nowhere on screen to record a payment, and this constant is the single
// source of truth for that fact. src/app/api/defaults/route.ts reads it to refuse arming
// fee_required_for_enrollment while it is false. If a fee-capture screen is ever built, flip
// this to true IN THE SAME COMMIT as that UI — do not flip it ahead of the UI landing, and do
// not leave it stale after the UI ships either way.
export const FEE_CAPTURE_UI_EXISTS = false;

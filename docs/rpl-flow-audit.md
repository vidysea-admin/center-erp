# RPL ERP Process Flow (25 modules) vs Built System — Audit

Source: `RPL_ERP_Process_Flow.docx.pdf` (Manish, 2026-08-11). Verdict per module:
✅ built & tested · 🟡 partial (core works, doc adds detail) · ❌ gap · ⚖️ conflicts with a locked decision.

| # | Module | Verdict | Notes |
|---|---|---|---|
| 1 | Location Master | 🟡 | Location + program-wise targets + SPOC/Principal + dual status ✅. Missing: geo-coords, Centre Head, doc-upload validation, **auto Completed/Remaining Target** |
| 2 | Location Change / Sync | ✅ | Exact match: daily crawl + Sync Now, field-level diff, review/approve per change, never blind overwrite, stop-workflow via FollowUpActions. 33 tests. Missing: 48h-pending SLA alert |
| 3 | Infrastructure Planning | 🟡 | Rooms + hard clash-blocking + lab requirement ✅. Missing: required-vs-available capacity computation, deficiency status, documented exception approvals |
| 4 | Trainer Master | 🟡 | Record/skills/status/cost ✅ (TOT lives on TrainerRequest — acceptable). Missing: document uploads, employment type |
| 5 | Trainer Pool | 🟡 | Filterable pool + home-location + concurrency cap enforced ✅. Missing: active-batch workload column, explicit Independent vs Location-Attached split, "Under Consideration" state |
| 6 | Trainer Planning | ✅ | Capacity math system-computed (Rule 2 satisfied), availability check, request raise, earliest-start recompute |
| 7 | Trainer Hiring & TOT | 🟡 | Request + hiring/TOT/availability dates + status ✅; trainer can't start batch before availability ✅. Missing: **backward-planned Hiring/TOT dates auto-computed from batch start**; TOT-completion auto-updating Trainer Master |
| 8 | Candidate Pool | 🟡 | Pool + source + lifecycle ✅. Missing: **duplicate detection (mobile/ID)**, verification step, DOB/email/ID fields |
| 9 | Candidate Location Mapping | ✅ | Location-attached pool, SPOC sees only own centre (28 role tests), assigned candidate leaves free pool (hard rule) |
| 10 | Batch Planning | ✅ | Four-gate readiness + enrollment threshold. Missing: auto-raise Trainer Request on gate fail (manual), exception-override on gates, **Location must be Active check** (quick fix) |
| 11 | Batch Master / Creation | ✅ | Immutable auto Batch ID, links, approver, audit |
| 12 | Batch Opening & Enrollment | ✅ | Bulk select, manual portal steps, mandatory failure reasons, % tracked. Missing: **hard cap enrolled ≤ capacity** (quick fix) |
| 13 | Batch Management | ✅⚖️ | Daily cockpit + dropouts + consolidated view ✅. **Batch Health Score: doc wants composite G/A/R; our locked spec deliberately removed it** (explicit signals instead) — needs a decision |
| 14 | Daily Attendance | 🟡 | Per-student tap attendance + evidence + % ✅. Missing: Leave/Holiday/NA statuses (we have operating-days instead) |
| 15 | Govt Portal Verification | ✅ | Two distinct values (never merged), screenshot proof, gap amber/red, Home queue. Missing: separate Verification-Team role, formal escalate state |
| 16 | Daily Learning & Evidence | ✅ | Topic/plan/work + date-linked photos/videos + completeness queue. Missing: SPOC review-complete step |
| 17 | Assessment | ❌ | Ours is **batch-level** (appeared/passed/result file). Doc requires **per-candidate** result (Pass/Fail/Absent, score, failure reason, reassessment) — biggest functional gap |
| 18 | Certification | ❌ | Same: batch-level count+file vs doc's **per-candidate certificate number/date/document**, cert-only-on-Pass rule |
| 19 | Invoice Management | 🟡 | Eligibility gate → Draft → Raised → Paid ✅. Missing: Submitted/Approved states, candidate-count/rate/gross/net/deduction fields |
| 20 | Cost Management | 🟡 | Cost at source (trainer/location/batch categories) + totals ✅. Missing: margin = invoice revenue − cost rollup |
| 21 | Batch Closure | 🟡 | Gates on assessment+certification+invoice ✅. Doc's fuller checklist (attendance complete, evidence complete, govt verified, costs captured) not enforced as a single closure checklist |
| 22 | Notifications & Alerts | 🟡⚖️ | Home Action Center = pull-based exception queues ✅. Doc wants push alert engine with severity/SLA/ack — locked spec deferred "notification centre" from v1 |
| 23 | Dashboard & MIS | ✅ | Role-scoped Home + KPIs + drill-down (all clickable) |
| 24 | User & Role Mgmt | 🟡⚖️ | 4 roles + location scoping + view-only, server-enforced ✅. Doc's finer roles (Verification, Mobilisation, Trainer login) + **Approval Matrix (initiator/approver)** — locked spec deferred permission-builder from v1 |
| 25 | Audit Trail | ✅ | Every write: who/what/old/new/when/actor-type, append-only, Activity tab per record |

**Score: 10 ✅ · 11 🟡 · 2 ❌ · (3 items conflict with locked v1 decisions ⚖️)**

## Quick fixes (small, no schema change — can ship immediately)
1. Block batch creation when location operational_status is not Active/Not Started (doc Rule 1).
2. Block adding members beyond `target_size` (doc M12 rule).
3. Duplicate-candidate warning on same mobile number (doc Rule 7, basic version).
4. Show Completed/Remaining Target on Capacity tab (completed = enrolled in completed batches).

## Medium builds (need prioritisation)
- **Per-candidate Assessment + Certification (M17/M18)** — the one genuinely new sub-system; touches Closure tab + candidate lifecycle. Highest-value gap.
- Backward hiring/TOT date computation (M7) — doc itself marks this Phase 2.
- Infra required-vs-available capacity planning (M3).
- Invoice detail fields + Submitted/Approved states (M19); margin rollup (M20).
- Full closure checklist (M21).

## Decisions needed (doc vs locked v1 spec)
1. **Batch Health Score** — doc mandates composite G/A/R; locked spec §5 explicitly removed it in favour of named signals. Reinstate or keep?
2. **Approval Matrix** (two-person initiator/approver on critical actions) — v1 deferred; doc treats it as cross-cutting. Phase-2?
3. **Alert engine with SLAs** — v1 deferred (Home queues instead). Phase-2 per the doc's own phasing.

Note: doc's own **Phased Build Priority** puts Modules 2, 7, 15, 22 in Phase 2 — our build already covers 2 and 15, so we are AHEAD of the doc's Phase-1 expectation everywhere except per-candidate assessment/certification.

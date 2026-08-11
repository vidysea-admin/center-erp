# RPL ERP Process Flow (25 modules) vs Built System — Audit

Source: `RPL_ERP_Process_Flow.docx.pdf` (Manish, 2026-08-11).
First audited 2026-08-11; **closed out 2026-08-11** — see "What changed" at the bottom.

Verdict: ✅ built & tested · 🟡 partial (core works, doc adds detail we chose not to build yet).

| # | Module | Verdict | Notes |
|---|---|---|---|
| 1 | Location Master | ✅ | Program-wise targets, SPOC/Principal, dual approval+operational status, and **achieved/remaining on both enrolled and certified bases**. Still absent by choice: geo-coordinates, Centre Head, document-upload validation |
| 2 | Location Change / Sync | ✅ | Daily crawl + Sync Now, field-level diff, review/approve per change, never a blind overwrite, stop-workflow via FollowUpActions, **48h-stale alert**. 33 tests |
| 3 | Infrastructure Planning | 🟡 | Rooms with identity, session/date clash hard-blocks, lab requirement. Absent: required-vs-available capacity computation and documented exception approvals |
| 4 | Trainer Master | 🟡 | Record, skills, derived status, day rate, incentive note (TOT lives on TrainerRequest). Absent: document uploads, employment type |
| 5 | Trainer Pool | ✅ | Filterable pool, home location, **5-batch concurrency cap enforced** (doc M5), request pipeline |
| 6 | Trainer Planning | ✅ | Trainer requirement system-computed from target, batch size, duration **and the concurrency cap** — never typed |
| 7 | Trainer Hiring & TOT | 🟡 | Request with hiring/TOT/availability dates; a trainer cannot start a batch before availability. Absent: dates auto-computed *backward* from batch start (doc's own Phase 2) |
| 8 | Candidate Pool | ✅ | Pool, source, lifecycle, DOB + ID reference, and **advisory duplicate detection** on create, on lookup, and in the Excel import preview |
| 9 | Candidate Location Mapping | ✅ | Location-attached pool, SPOC sees only their centre, assigned candidates leave the free pool |
| 10 | Batch Planning | ✅ | Four-gate readiness + enrollment threshold + **Rule 1 location gating** on creation, start, member-add and daily logs |
| 11 | Batch Master / Creation | ✅ | Immutable auto batch ID, cross-module links, audit |
| 12 | Batch Opening & Enrollment | ✅ | Bulk select, manual portal steps, mandatory failure reasons, **enrolled count capped at capacity** (over-target assignment warns instead of blocking) |
| 13 | Batch Management | ✅ | Daily cockpit, dropouts, consolidated view, **Batch Health Score (Green/Amber/Red) shown with its reasons** |
| 14 | Daily Attendance | 🟡 | Per-student tap attendance, evidence, frozen roster denominator. Absent: Leave/Holiday/NA statuses (operating-days config covers the common case) |
| 15 | Govt Portal Verification | ✅ | Two distinct values never merged, screenshot proof, amber/red gap, Home queue, **critical alert past the red threshold** |
| 16 | Daily Learning & Evidence | ✅ | Topic/plan/work, date-linked photos and videos, completeness surfaced in health |
| 17 | Assessment | ✅ | **Per candidate**: Pass/Fail/Absent, score, assessor, failure reason, reassessment with attempt history. Assessment cannot complete while anyone is Pending (Rule 43) |
| 18 | Certification | ✅ | **Per candidate**: number, date, document, Pending→Processing→Generated→Issued with a Rejected→resubmit path. No certificate without a Pass (Rule 45) |
| 19 | Invoice Management | 🟡 | Eligibility gate → Ready → Raised → Paid, ordering now enforced server-side, optionally approval-gated. Absent: Submitted/Approved states and rate/gross/net/deduction fields |
| 20 | Cost Management | 🟡 | Cost captured at source against location/batch/trainer with categories and totals. Absent: margin = invoice revenue − cost |
| 21 | Batch Closure | 🟡 | Gated on assessment → certification → invoice; per-candidate completeness now gates both. Absent: a single consolidated closure checklist covering attendance/evidence/costs |
| 22 | Notifications & Alerts | ✅ | Seven SLA/threshold rules on a locked background tick, deduped and auto-resolving, delivered in-app with a bell count, acknowledge and resolve |
| 23 | Dashboard & MIS | ✅ | Role-scoped Home, KPIs, every card and row clickable through to the source record |
| 24 | User & Role Mgmt | ✅ | 4 roles, location scoping, view-only, server-enforced, plus a **configurable approval matrix** (initiator ≠ approver), shipped switched off |
| 25 | Audit Trail | ✅ | Every write: who/what/old/new/when/actor-type, append-only, per-record Activity tab |

**Score: 19 ✅ · 6 🟡 · 0 ❌** (was 10 ✅ · 11 🟡 · 2 ❌ at first audit)

## What changed on 2026-08-11 (6 phases, 226 assertions green)

- **Phase 0** — nightly backup of the database and uploaded files. There was none.
- **Phase 1** — Rule 1 location gating (allowing "Not Started" so advance planning survives),
  capacity cap on enrolment with a warning on assignment, advisory duplicate detection,
  trainer concurrency raised to 5 with the capacity formula taking the max of both
  constraints, achieved/remaining targets.
- **Phase 2** — eight pre-existing bugs found while auditing: unscoped Home KPIs, scope checks
  that missed Enrollment users, candidate creation with no scope check, invoice states that
  could skip via the API, a hardcoded readiness threshold, and raw Mongo errors reaching users.
- **Phase 3** — Batch Health Score, always rendered together with the reasons behind it.
- **Phase 4** — per-candidate assessment and certification (Rules 41–47) with derived
  aggregates written through to the existing Closure record, and zero writes to existing data.
- **Phase 5** — the alert engine, plus a DB lock so background jobs cannot double-fire.
- **Phase 6** — the approval matrix, shipped with every action off.

## Still open — deliberate, not forgotten

Invoice rate/candidate-count/margin work, infrastructure required-vs-available planning,
backward-computed hiring/TOT dates, a consolidated closure checklist, Leave/Holiday
attendance statuses, and server-side pagination (needed before candidates pass ~5k).

## Questions for Manish / boss — these change behaviour, so they were not guessed

1. **`appeared`** currently excludes Absent candidates. Correct for the client contract?
2. **Mid-batch replacement** — the doc never defines it. Can a dropout's seat be refilled on the
   government portal? Current behaviour allows it with a later joining date.
3. **Reassessment after Closing** — currently blocked once a certificate exists or the batch is
   Completed. Right call?
4. **Dropped-but-passed candidates** — do they count for invoicing?
5. **Video evidence** — uploads cap at 25MB and only images are compressed. Raise the cap, or
   state a "photos and short clips only" policy?
6. **Batch reopening** — a Completed batch is frozen, so a mistyped certificate number has no fix
   path. Add an Admin-only override, or accept?

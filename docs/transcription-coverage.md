# Meeting transcription → feature coverage

Source: `d:\erp\transcribe1.md` / `transcribe2.md` (2026-08-08 meeting). Status: ✅ built+tested · 🟡 partial · 🔵 deliberately deferred (spec'd seam exists).

| # | Meeting requirement (timestamp) | Where it lives | Status |
|---|---|---|---|
| 1 | SDP/VPA sheet crawl **daily at a set time**, diff → DB update (04:41) | SyncSource + field mappings + in-app scheduler (`instrumentation.ts`) | ✅ (needs real sheet URL — links are 401) |
| 2 | Changed fields highlighted, OK/OK review, actions: start/stop/close location (06:17) | Sync Inbox: SheetChange review, impact snapshot, apply actions, FollowUpActions | ✅ 33 tests |
| 3 | Location master: SPOC + Principal name/phone updated (06:48) | Location detail Overview | ✅ |
| 4 | Program-wise targets per location (09:42) | LocationTarget (unique location+program) | ✅ |
| 5 | Trainers-required math: 210 → 7 batches × 20d = 140 trainer-days → 2 trainers in 3 months (07:11–08:28) | `capacitySummary()` shown on Capacity & Target tab | ✅ tested exact numbers |
| 6 | Trainer planning: available/when, hiring date, TOT date, expected availability (10:03) | TrainerRequest (hiring_target, tot_scheduled/done, expected_available_from) | ✅ |
| 7 | Infra planning: classrooms/labs, "can that be managed or not" (08:28) | Room rows + session/date conflict hard-blocks (Rules 13–14) | ✅ tested |
| 8 | SPOC + Principal per-location access (08:58) | Users with role=Location, location_scope, can_edit | ✅ 16 role tests |
| 9 | Batch planning: pick location+course+candidates+trainer; no trainer → request; **earliest start date** (11:17) | New Batch drawer + TrainerRequest; earliest-start hint shown live in the drawer (mobilisation lead + trainer availability) | ✅ |
| 10 | Batches visible globally AND per-center (11:51) | Batches list (Admin/Ops = all; Location role = scoped) | ✅ |
| 11 | Candidate pool: independent + location-attached (16:38) | Candidates module + location filter + per-location pool in batch detail | ✅ |
| 12 | Assign candidate → enrollment process; mark done 1,2,3; failure reason (OTP, already-registered) (16:38–17:23) | BatchMember worklist: 3 toggles, issue enum, failure never poisons candidate (Rule 22) | ✅ tested |
| 13 | Selenium auto-fill optional, "type karna pade to koi dikkat nahi" (17:23) | Manual-first; `source`/`actor_type` seams ready for the bot | 🔵 by design (v1 scope) |
| 14 | Daily: kitne bacche aaye, photo, video, kya kaam hua (13:12) | DailyLog: attendance tap-grid, topics, photos/videos, compression+retry | ✅ |
| 15 | **Govt portal attendance % daily** + screenshot proof; "20 din aaya par govt me nahi to bekar" (13:48–14:33) | govt_present vs internal %, gap amber/red, screenshot upload; login-id manual entry per boss ("aadmi bitha dunga") | ✅ |
| 16 | Assessment completion → certification → invoice (14:33) | Closure + Invoice state machine (Rules 34–36) | ✅ tested |
| 17 | Cost capture at every stage incl. trainer incentive (14:58) | CostEntry (location/batch/trainer anchors) + categories | ✅ |
| 18 | Har aadmi ko limited access (18:22) | 4 roles + scoping + view-only, server-enforced | ✅ tested |
| 19 | Web-based system (18:22) | Responsive Next.js web app | ✅ |
| 20 | Sample sheet format download for candidate data (00:58) | Candidates → Import Excel (upload→map→preview→confirm) + "Download sample sheet format" (`/api/candidates/template`) | ✅ |

**Open items:** real SDP sheet URL + column mapping for #1 (links are 401 — needs access); #13 Selenium is deferred by the meeting's own decision, seams ready.

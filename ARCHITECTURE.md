# Center Management ERP — Architecture Map

> **Anti-drift map. Read this BEFORE editing to locate existing code and edit it in place.**
> Next.js 16 App Router · Mongoose 9 · Auth.js v5 · `basePath: /erp` · live at https://www.vidysea.com/erp
> 189 `.ts/.tsx` files, ~30,000 lines under `src/`. Release marker: `src/lib/version.ts`.
>
> **The one rule this document exists to enforce:** before you add a file, a constant, or a helper,
> search this map for the concept. It almost certainly already exists, and this codebase's bug history
> is overwhelmingly *"the second copy did not get the fix."* §3 is the list of second copies.
>
> Created 2026-08-18 by `/anti-drift` (checker). Keep it current — a stale map is worse than none.

---

## 1. Modules → responsibilities

### 1.1 `src/lib/rules.ts` — the business-rule engine (~2,300 lines)

The single server-side home of every numbered rule. **Never re-implement any of these in a route or a
page.** It imports models, so client components can't import it — client-safe extracts live in
`slot-rules.ts`, `candidate-journey.ts`, `validate.ts`, `trainer-select.ts`.

| Area | Key exports (line) | Governs / throws |
|---|---|---|
| Location gate | `assertLocationOperational` (21) | **Rule 1** — blocks activity at On Hold/Stopped/Closed centres. `HALTED_LOCATION_STATUSES` private at :19 |
| Scope (Rule 38) | `assertBatchInScope` (52) · `assertMemberInScope` (65) · `assertTrainerInScope` (93) · `assertTrainerDocInScope` (85) · `assertTrainerDocDeleteInScope` (104) · `assertResultInScope` (1408) | 403 out-of-scope. Doc **delete** is deliberately narrower than doc read/upload |
| Trainer identity | `trainerForLogin` (35) | The ONE place a login becomes a Trainer (link → email → self-heal) |
| Scheme hours | `minAttendancePctForScheme` (121) · `assessmentHoursBar` (2000) · `requiredAssessmentHours` (1983) | QA-093/119 — scheme master's absolute hours win |
| Dates | `addDays` · `dayStart` · `parseSheetDate` (159) · `istToday` (189) · `dayKey` · `dayRange` | **Rule 53** · `istToday()` is THE definition of "today" |
| Planning | `computePlannedEnd` · `capacitySummary` · `planBatchBackward` · `planArtifact` · `nextBatchCode` · `createBatchWithCode` | **Rule 15**; codes `CENTRE-PROGRAMCODE-NN`, the number **derived from the batches on record** (`counters` no longer governs them, -225). `createBatchWithCode` is the ONLY place a batch is written — the code is minted after validation |
| Trainer booking | `assertSlotWithinGuidelines` · `assertTrainerAvailableForBatch` · `trainerBookingWarnings` · `deriveTrainerStatus` · `assertRoomFreeForBatch` | **Rules 10–14** · QA-144 `max_daily_hours` |
| Roster | `rosterOnDate` · `activeRoster` · `addMemberChecked` (400) · `updateEnrollment` · `dropMemberChecked` | **Rules 20–26, 48, 54** |
| Batch lifecycle | `batchReadiness` (543) · `activateFromEvidence` (605) · `transitionBatch` (639, edge `switch` at :650) | **Rules 16–19, 47, 52** |
| Daily log | `validateDailyLog` · `createDailyLogChecked` · `canEditDailyLog` | **Rules 27–32, 51, 53** |
| Health | `attendanceGap` · `missingLogStreak` · `batchHealth` · `settlementStage` · `missingLogQueue` | **Rules 31, 33** |
| Results | `summarizeResults` · `recomputeClosureAggregates` (1067) · `settleCertificatesFromFiles` · `deriveCompletion` (1138) · `upsertCandidateResult` · `upsertCandidateCertificate` (1301) · `bulkMarkResults` | **Rules 41–47** + **DEC-4** + **DEC-6**. `CERT_FLOW` at :1240 |
| Closure / money | `upsertClosureChecked` · `updateInvoiceChecked` · `assertCostEntryValid` | **Rules 34–37, 43, 46, 52** |
| Trainer pipeline | `MANDATORY_TRAINER_DOCS` (1788) · `TRAINER_FLOW` (1792) · `trainerDocSummary` · `transitionTrainer` (1833) | **Rules T2–T8** — T2 docs (:1882) · T3 vacancy (:1885) · T4 remarks (:1899) · T5 TR ID (:1938) · T6 drop reason · T7 assigned-batch · T8 bypass (:1847) |
| Attendance hours | `memberAttendedHours` · `eligibilityVerdict` (2069) · `courseIsFinished` | Six states incl. `"trainer"`, which it never returns — the grid constructs it |
| Readiness rollup | `NOMINATED_STATES` · `trainerCountsFor` · `mappingReadinessBulk` · `mappingReadiness` | Counts are DERIVED, never stored |

### 1.2 `src/models/index.ts` — schemas + the enum catalogue (~1,170 lines)

**Every exported const list here is a source of truth.** Where a UI hardcodes the same strings, that
pairing is listed in §3.

Key enums: `TRAINER_PIPELINE` (:26) · `TRAINER_DOC_TYPE` (:42) · `SCHEME` · `LIFECYCLE_STATUS` ·
`ASSESSMENT_RESULT` · `CERTIFICATE_STATUS` (:65) · `BATCH_STATUS` (:68) · `ENROLLMENT_ISSUE` (:70) ·
`CANDIDATE_DOC_TYPE` (:310) · `EDUCATION_LEVEL` (:340) · `SIDH_STATUS` · `GOVT_MATCH_STATUS` ·
`USER_ROLE` · `MAIL_STATUS` · `PUBLIC_TOKEN_PURPOSE`.

Models exported ~:1110–1167: `Program, Location, Room, Trainer, TrainerDocument, TrainerRequest,
Candidate, Batch, BatchMember, DailyLog, GovtAttendanceImport, GovtAttendanceRow, Closure,
CandidateResult, Invoice, CostEntry, SyncSource, SheetChange, TabMapping, WorkbookSnapshot,
WorkbookChange, PublicToken, Feedback, FollowUpAction, User, RolePermission, Notification, MailLog,
StoredFile, ApprovalRule, ApprovalRequest, AuditLog, Scheme, JobRole, CandidateDocument, Defaults` …

**`DefaultsSchema` (:1030) is strict and silent** — a knob added to the PUT whitelist and to
`DEFAULT_VALUES` but not to this schema is dropped by `$set` with no error. Shipped twice.

### 1.3 `src/lib/` — one line each

| File | What it is |
|---|---|
| `authz.ts` | `HttpError` · `requireUser` · `requireRole` · `requireEdit` · `locationFilter` · **`apiHandler`** — the server error chokepoint (HttpError→`plain()`, E11000→409, Cast→404, Validation→400) |
| `permissions.ts` | `PERMISSIONS` (**20 keys** — QA-904 added `candidates.delete` / `trainers.delete` / `batches.delete`) · `DEFAULT_ROLE_PERMISSIONS` · `hasPermission` · `requireView` · `requirePerm`. Deny wins; Admin bypasses |
| `crud.ts` | `collectionRoutes` / `itemRoutes` / `pick` — the REST factory. **`CrudConfig.fields` IS the write whitelist** |
| `validate.ts` | **`canonicalPhone` · `phoneError` · `emailError` · `canonicalAadhaar` · `aadhaarError`** — THE write-time canon for phone/email/Aadhaar. Client-safe (imports nothing — §3.0) |
| `duplicates.ts` | `normalizePhone` (deliberately LOOSE compare key — a different job) · `findDuplicateCandidates` (Rule 7, advisory) |
| `user-copy.ts` | **`plain(msg)`** — strips `Rule 45` / `DEC-6` / `QA-142` / `Rule T3` from anything a user reads |
| `version.ts` | `RELEASE` · `RELEASE_NOTE_CURRENT` · private `RELEASE_NOTE_ARCHIVE`. **Must stay ASCII** |
| `base-path.ts` | `BASE_PATH = "/erp"` — must match `next.config.ts` |
| `client.ts` | `api()` fetch wrapper (prefixes BASE_PATH) · `fmtDate` · `fmtDT` (IST) · `pipelineLabel` |
| `mailer.ts` / `sms.ts` | `sendMail` / `sendSms` — never throw, ALWAYS write a MailLog row (channel email/sms) |
| `messaging.ts` | Pure link builders: `tenDigits` · `waLink` · `smsLink` · `bulkSmsCsv` |
| `storage.ts` | Evidence adapter (GCS → Drive → local) · `putFile` · `getFileStream` · `ALLOWED_UPLOAD_EXT` · `storageHealth` |
| `upload.ts` | Client side: `compressImage/Video` · `uploadResumable` · `uploadWithRetry` · offline queue |
| `govt-attendance.ts` | `parseGovtAttendance` · `isTrainerRow` · `matchGovtRows` · `reconcileAgainstLogs` · `hhmmssToMinutes` |
| `sync.ts` / `workbook.ts` / `tab-mapping.ts` / `field-catalog.ts` | The sheet ingest stack. **`sourceAllowed()` in `workbook.ts` is the single-truth OneDrive policy — in code, not prose.** **`classifyChange()` in `sync.ts` is the single truth for which Sync-Inbox action fits which row** — the apply switch refuses THROUGH it (`verdictFor`) and `GET /api/sheet-changes` ships its verdicts to the drawer, so an offered option and a refusal cannot disagree (QA-946) |
| `alerts.ts` | `evaluateAlerts()` — 10 dedup'd notification rules |
| `rate-limit.ts` | `clientKey` · `rateLimit` · `phoneChallengeGate` (SMS toll-fraud) |
| `safe-fetch.ts` | SSRF guard: `assertPublicUrl` · `safeFetch` · `internalFileToken` |
| `slot-rules.ts` · `candidate-journey.ts` · `trainer-select.ts` | Client-safe extracts of rules the UI also needs |

### 1.4 `src/app/api/**` — route families

- **CRUD-factory:** `candidates`, `locations`, `programs`, `rooms`, `sync-sources`, `trainer-requests`, `trainers` (+ their `[id]`) — all via `crud.ts`, which supplies authz + permissions + audit for free.
- **Batches:** `transition`, `complete`, `members`(+`bulk-enroll`), `logs`, `attendance`, `results`, `closure`, `certificates`, `invoice`, `milestones`, `plan`, `feedback`, `link-portal-ids`.
- **Candidates:** `assign`, `check-duplicate`, `import`, `template`, `export-sidh`, `[id]/drop`, `[id]/results`, `[id]/documents`.
- **Trainers:** `import`, `quick-invite`, `[id]/transition`, `[id]/documents`, `[id]/create-login`, `open-positions`.
- **Govt attendance:** `govt-attendance`, `[id]`, `[id]/rows/[rowId]/match`.
- **Sheet/sync:** `sheet-changes`, `sync-sources/[id]/{run,snapshots,tab-mappings}`, `workbook-changes`, `mapping/readiness`.
- **Files:** `upload`, `upload/{intent,complete,abort}`, `files/[name]`.
- **Admin/system:** `defaults`, `users`, `permissions`, `master-lists/[list]`, `approvals`, `notifications`, `audit/*`, `home`, `invoices`, `costs`, `test-email`, `test-storage`.
- **Reporting (Karunn sir's two, -170/-171/-174):** `reports/rollup` + `reports/rollup/export` (QA-398/QA-441) · `plan-tracker` + `plan-tracker/export` (QA-399/QA-526) · `plan-batch` (the standalone backward planner, `?start=&location=&program=&trainer=`).
  **Each screen and its export MUST read the same function** — `reportRollup` and `planTrackerRows` in `rules.ts`. An export that recomputes is an export that eventually disagrees, and then nobody can say which one is the report. If you change either function, both doors move together; there is no second copy to update, and there must never be one.
  **`reportRollup` ships four things beyond the rollup itself (QA-1074, -245):** `detail[]` — one entry per `LocationTarget` row, pushed inside the SAME loop that sums the cells, so `sum(detail[k]) === total[k]` holds by construction and the drill-down panel cannot disagree with the tile that opened it (pinned in `scripts/e2e.mjs`); `measured_at`, because the screen is a snapshot and used to render exactly like a live figure; `sync_gap`, which counts pending sheet changes **through `targetRowField()` imported from `lib/sync.ts`** — never a local list — so it reports what can actually move a figure rather than how full the inbox is; and `labels: REPORT_LABELS`. **`REPORT_LABELS` is the ONE place the seven measures are named** (`Total Target` · `Approved Target` · `Pending Target` · …). It travels in the payload because the report page is `"use client"` and cannot import `rules.ts`, and it is read by three surfaces: the tiles, the table's Grand Total headers, and the Excel workbook's info tab. **The Excel DATA sheet's headings are frozen** on Umesh's explicit instruction (the workbook is treated as a duplicate of the client's own sheet) — a `check-user-copy.mjs` pin fails if any of them is renamed, and the new vocabulary lives on the "where the numbers come from" tab instead. `centreVerdict()`'s words are untouched by that renaming, because they are written straight into that sheet's `Status` column.
- **PUBLIC (no session — a token IS the credential):** `public/register/[token]` · `public/enrol-otp` · `public/trainer-apply` · `public/attendance/[token]` · `public/feedback/[token]` · `public/plan/[token]` · `public/portal-lookup` · `public/geography` (LGD state/district/sub-district lists, bundled at `src/data/lgd-geography.json`) · `public/ses-notifications` · `public/version`.

### 1.5 `src/app/(app)/**` — authenticated screens

| Path | Lines | Notes |
|---|---|---|
| `page.tsx` | 343 | Home / Action Center. **Structure pinned by `scripts/check-home-structure.mjs`** |
| `batches/[id]/page.tsx` | **2,988** | The monster. Tab components: `Overview`(128) `EditDetails`(525) `Roster`(663) `Enrollment`(917) `AttendanceTab`(1001) `DailyExecution`(1266) `ClosureTab`(1844) `CandidateResults`(2109) `FeedbackTab`(2762) `CostsTab`(2831) |
| `batches/page.tsx` | ~830 | List + create drawer + CSV import + **`PlanningTable`** (the Planning tab, QA-399) + the **"Plan a batch" drawer** (QA-501: it takes centre + job role and renders `earliest_possible_start`) |
| `reports/page.tsx` | ~200 | Karunn sir's five-column report (QA-398). ONE table, `Approved` is a COLUMN — both readings sit together, decided by Umesh 2026-08-21 |
| `candidates/page.tsx` | 878 | Pool, buckets, drawer (incl. the 9 government-portal fields), SIDH walk, docs, import |
| `trainers/page.tsx` | 769 | Directory · availability tags (`availabilityTag` :22) · stage strip · Requests · Open Positions · quick-invite |
| `trainers/[id]/page.tsx` | 476 | Pipeline rail · **Move drawer (`doMove` :91)** · Documents · Profile · Assignments |
| `locations/page.tsx` · `locations/[id]/page.tsx` | 283 · 524 | Centres, targets, rooms, contacts, trainer rollups |
| `govt-attendance/page.tsx` | 468 | Import preview/commit · variance · qualification grid |
| `admin/page.tsx` | 1,190 | `Programs` `Users` `Permissions` `SyncSources` `Approvals` `MasterLists` `Defaults` `Files` `Mail` |
| `sheet-watch/` · `sync/` · `costs/` · `notifications/` | | Inboxes and ledgers |

### 1.6 `src/app/p/**` — PUBLIC pages

`p/register/[token]` (176) · `p/enrol` (165) · `p/trainer-apply` (115) · `p/attendance/[token]` ·
`p/feedback/[token]` · `p/plan/[token]` · `p/me`.

**There are TWO public candidate-intake doors** — `p/register/[token]` and `p/enrol`. Any change to
what a self-registering student supplies must be applied to **both**. See §3.2.

### 1.7 `src/components/ui.tsx` — shared primitives (840 lines)

`BackLink` `RouteTabs` `HealthChip` `Chip`(147, colours at :40) `Btn` `Field` `inputCls` **`Drawer`**(192)
`Tabs` `FilterPills` **`DataTable`**(259 — owns sort, search, funnel filters, column resize/hide,
pagination, mobile cards, skeletons) `CopyBtn` `ShareLinkPanel` `Notice` **`ErrorBanner`**(764) `KPI`
`Section`.

**`ErrorBanner`/`Notice` at :766 is the client-side `plain()` chokepoint.** `Drawer` takes an `error`
prop — use it, so a rejection renders where the user is looking rather than on the page behind.

Siblings: `shell.tsx` (`AppShell`, `usePerms`, `NAV` :67), `icons.tsx`, `providers.tsx`,
`activity.tsx`, `sheet-sources.tsx`, `tab-mapping-wizard.tsx`.

### 1.8 `scripts/` — the wall and the pins

`npm test` → **`scripts/run-e2e.mjs`** (suite list at :11–33 — the ONLY place it lives), ~1,100
assertions across 17 suites, no fail-fast, per-suite table, exit 1 on any failure.

Structural pins that exist because a fix regressed while the wall stayed green:
`check-user-copy.mjs` (no ledger code may reach a user-facing string) and
`check-home-structure.mjs` (the trainer attendance strip's exact position in `(app)/page.tsx`).

Suites: `e2e` · `e2e-roles` · `e2e-sync` · `e2e-blindspot` · `e2e-govt` · `e2e-trainer-pipeline` ·
`e2e-rpl-blindspot` · `e2e-flows-blindspot` · `e2e-eval-{home,notifications,trainers-ui,candidates,enrollment,locations-admin,data}`.

**THREE local databases, and they are not interchangeable** (`-175`, QA-530):

| Database | Whose | Never |
|---|---|---|
| `center_erp_ci` | the wall. Fixtures, dropped and rebuilt every run — CI parity depends on it holding exactly those | never point the mirror here |
| `center_erp_local` | **`scripts/mirror-prod.mjs`** — a copy of production for LOOKING at real screens, with one local-only login password | never the wall's |
| `center_erp` | production | read here, written never |

`mirror-prod.mjs` takes **two Mongo clients** and refuses when the target host equals the source
host. That guard exists because the first draft used one client, so `client.db("center_erp_local")`
was created ON THE PRODUCTION HOST — a database is not local because its NAME says local, it is
local because of the URL it was opened on. It also **redacts by field name** (`locations.tc_password`
— ten live government-portal logins — and `users.password_hash`) and prints how many it removed;
skipping whole collections was not enough, because the worst secret here is a field (QA-536).

---

## 2. Data flow

**(a) Candidate intake — three doors, and they do not agree**
```
INTERNAL  candidates drawer → POST /api/candidates  [crud fields whitelist]
          beforeCreate: phoneError/canonicalPhone/emailError, scope, centre-required-if-scoped
PUBLIC-1  p/register/[token] → POST /api/public/register/[token]
          token → rateLimit → honeypot → phoneError + emailError → Candidate.create
          + the 9 government fields (explicit allowlist)
PUBLIC-2  p/enrol → POST /api/public/enrol-otp {request|verify|register}
          OTP by email or SMS (phoneChallengeGate) → Candidate.create
          NO government fields  ← see §3.2
BULK      POST /api/candidates/import — upload → map → preview → confirm
```

**(b) Trainer hiring** — entry via Add Trainer / quick-invite / public apply / bulk import; movement
ONLY via `POST /api/trainers/[id]/transition` → `transitionTrainer` → `TRAINER_FLOW` edge check →
per-target gate (T2 docs, T3 nomination, T4 remarks, T5 TR ID, T6 reason, T7 no live batch), or the
T8 bypass branch. `GET /api/trainers/[id]` returns `allowed_next` so the UI offers only legal moves.

**(c) Batch lifecycle** — `Planning →Ready` (Rule 16 readiness) `→Active` (Rule 17, or
`activateFromEvidence` from a portal row / daily log) `→Closing` (assessment Completed) `→Completed`
(certification Completed; Rule 47 stamps candidate lifecycle) `→Closed` (Rule 52: cert + invoice Paid
+ dues). After **every** result/certificate save: `recomputeClosureAggregates` →
`settleCertificatesFromFiles` → `summarizeBatchResults` → `deriveCompletion`.

`Cancelled` is reachable from `Planning`/`Ready`/`Active` (Rule 19) and, since -240, is no longer
terminal: **`Cancelled →Planning|Ready|Active`** is one fall-through arm in `transitionBatch`,
Admin-only, reason required, audited as `restored_from_cancelled`. It RESTORES a status and does
nothing else — it clears `cancel_reason`, refuses any `actual_start`/`backdate_override` sent with
it, re-runs Rule 16 when the target is `Ready`, and refuses `→Active` unless `actual_start` is
already stamped. That last guard is what stops restore becoming a second, ungated Start: a batch
that never ran has no Active state to be put back into, and jumping there would pass Rule 17 AND
-226's `backdate_override` in one step. `Closed` and `Completed` remain unreachable from
`Cancelled`; the only other backwards edge is Admin `Completed →Closing` (DEC-6 escape).

**(d) Government attendance** — `parseGovtAttendance` → `resolveLocationFromFile` → `matchGovtRows`
(`isTrainerRow` first) → `reconcileAgainstLogs` → preview → confirm writes rows + stamps
`sidh_candidate_id` → `activateFromEvidence`. Verdicts via `assessmentHoursBar` →
`memberAttendedHours` → `eligibilityVerdict`.

**(e) Upload** — small: `uploadWithRetry` → `POST /api/upload` → `putFile` → GCS/Drive/local →
`StoredFile` → `/erp/api/files/<hash>.<ext>`. Large: `upload/intent` → browser PUTs 8 MiB chunks
direct to Google → `upload/complete`. Reads require a login (or the HMAC internal header).

**(f) Mail/SMS** — `sendMail`/`sendSms` suppress structurally (test env → disabled → unconfigured →
invalid recipient) and **always** write a MailLog row. Bounces: SNS → `public/ses-notifications`.

---

## 3. THE DUPLICATION MAP — read this before changing any shared concept

### 3.0 Collapsed in -155 (2026-08-20) — one definition each, do not re-grow the copies

- **"the fields a Candidate has" (import surface):** was FIVE hand-typed copies (FIELD_CATALOG,
  the candidates-page mapping dropdown, the import writer, both drawer routes). The dropdown and
  the writer now BOTH read `CANDIDATE_IMPORT_FIELDS` (`field-catalog.ts`) — cost of the drift was
  55 live portal IDs landing in `id_reference` (QA-414 S1). `trainers/import` `TEXT_FIELDS` is the
  same disease waiting to repeat (QA-424 residue — still hand-typed).
- **shifted-column signature:** `shiftSignature()` in `lib/govt-attendance.ts` is the ONLY
  definition; readers = the -154 import guard, the portal-id-health screen, the ID-re-match.
- **CAN normalisation:** `normalizeCan()` is DEFINED in `lib/validate.ts`; `lib/govt-attendance.ts`
  RE-EXPORTS it (`export { normalizeCan, looksLikeCan, storedCanIsUnreadable } from "@/lib/validate"`),
  so live callers import it from both — `certificates/route.ts` from `validate`, `link-portal-ids`
  and `candidates/import` from `govt-attendance`. `link-portal-ids` aliases its old local `canOf` to
  it. Never write a near-copy of that regex.
  <!-- QA-756 (-234): this bullet used to say the function lived in `lib/govt-attendance.ts`, which
       contradicted the paragraph FOUR LINES BELOW IT saying its home is the pure module. A map that
       disagrees with itself inside one bullet is worse than one that is merely out of date: both
       statements look authoritative and the reader cannot tell which to trust. The paragraph was
       right; the lead sentence was stale from before the move. -->

  **THREE named tests on this one concept. Their home is `lib/validate.ts` — the PURE module, which
  imports nothing, because the CLIENT screens need them too and `lib/govt-attendance.ts` imports the
  mongoose models. `govt-attendance` re-exports all three, so server callers may import from either.
  Keeping `lib/validate.ts` import-free is load-bearing: one added import there breaks every client
  screen that now depends on it. They are not interchangeable — importing the wrong one is a shipped
  bug both ways:**
  - `normalizeCan(s)` — the **matcher**. Reads only the DIGITS after CAN, returns `CAN<digits>` or
    null. Everything that decides *who matches whom* uses this: the certification gate
    (`enrolledWithoutCan`), the certificate matcher, the health screen, `link-portal-ids`.
  - `looksLikeCan(s)` — the **shape test** for a hand-typed value (begins with CAN, has a digit).
    Used only by the two candidate write doors. Using `normalizeCan` here instead refused
    `CAN_ED0711202`, a shape this product stores — eleven wall assertions, -210 run 1.
  - `storedCanIsUnreadable(s)` — "there is a value on record and the matcher cannot read it". The
    honest gap between the two above, which is what the batch screen prints on a blocked row.
  **They disagree by design** (`looksLikeCan("CAN_CHK208A")` is true, `normalizeCan` of it is null)
  and that disagreement is **QA-719, an open decision of Umesh's** — widening the matcher changes
  who matches whom across imports, health and certificates. Do not close it in passing.
  **Collapsed in `-213` after the qa-212 checker found them (QA-755):** `canOf` in
  `api/batches/[id]/certificates/route.ts` was a byte-copy of the matcher, **inside the certificate
  matcher this very entry claimed used the shared one** — the sixth spelling, found in the release
  that rewrote this section to say there were three. It now aliases `normalizeCan`, as
  `link-portal-ids` already did.
  A remaining spelling is NOT collapsed and is deliberately listed: `CAN_SHAPE` (`/CAN/i`) in
  `api/candidates/portal-id-health/route.ts:33`. **Before adding any new test of "does this look
  like a CAN", grep this entry — six copies of it have been written by people who had read this
  file.**
- **TWO 12-DIGIT VALIDATORS IN `lib/validate.ts`, AND THEY DISAGREE ON PURPOSE (QA-902, 2026-08-24).**
  `aadhaarError` / `canonicalAadhaar` and `apaarError` / `canonicalApaar` both take a 12-digit
  government number, and the temptation to collapse them into one "12-digit id" helper is obvious and
  **wrong**. The Aadhaar pair refuses any number beginning `0` or `1` and runs a **Verhoeff** check
  digit; the APAAR pair does neither, because **APAAR has no published check digit and a real live
  APAAR begins with 1** — Umesh's own screenshot, `190305516076`. Routing APAAR through `aadhaarError`
  would refuse a correct id read straight off the government's screen, and inventing a checksum this
  product cannot verify would be worse than accepting a typo. **Do not "harmonise" them.** The comment
  above each in `lib/validate.ts` says the same thing; this row exists because the third person to
  read that file is the one who usually writes the seventh copy.
  APAAR has **two** named tests, on the CAN pattern above and for the same reason — they answer
  different questions:
  - `apaarError(s, {optional})` — the **hand-typed shape test**, and the words a person is shown.
    Used by the two candidate write doors, the Closure card's `crossCheck` table, and the drawer's
    live hint. One rule, one sentence, whether the refusal comes from the form or from the API.
  - `storedApaarIsUnreadable(s)` — "there **is** a value on record and this system cannot read it."
  - `sameGovtNumber(a, b)` — **the FIFTH export, and the one that exists because the other four are
    the wrong tool for one question** (QA-977, QA-1025). It asks *"are these two government numbers
    THE SAME NUMBER"* as a **digits** comparison, and all four write doors ask it through this and
    nothing else. Every door used to ask it through `canonicalAadhaar()` — a **validity** test — so
    the guard could not fire whenever the Aadhaar side was not a *valid* Aadhaar, and the headline
    instance is the first live APAAR this product was ever given: `190305516076`, which begins with
    1, which `canonicalAadhaar` rejects. The edit door returned 200 and stored both government-ID
    fields holding the same digits. **Equality is not validity.** Proved by mutation: reverting this
    helper to the validity form reproduces that exact 200, and restoring it returns the suite to
    green.
    Not the same question: the bulk importer REPORTS a malformed APAAR and stores it anyway (QA-141 —
    a client's sheet is never dropped over format), so this state really occurs, and a screen showing
    a blank box on such a record would be lying about what is stored. `apaarIdState()` in the batch
    page is the single caller that turns it into a colour.
- **New door:** `api/candidates/portal-id-health` (GET plan / POST selected fixes, audited,
  never overwrites) — the link-portal-ids contract one level up. UI: the Candidates page
  "Portal ID health" drawer.

### 3.0c "The earliest a centre could start" — collapsed in -168 (QA-509)

**FOUR implementations, and the concept was not on this map at all** — which is how it reached four.
A checker found it while checking the unit that added the fourth.

**Read the next sentence carefully, because it is the whole method:** the row QA-461 was written from
said *"the identifier appears NOWHERE in `src/`"*. Measured (QA-521): the **identifier appeared
ONCE** — in a comment, on the line directly above one of the implementations, spelling out the
formula and its weakness — while the **concept had THREE implementations**. A grep for the name found
one hit; a census of the behaviour found three. **Searching for a name is not a census**, and this
row exists because the difference between those two numbers is where the other three copies lived.

| Was | Formula |
|---|---|
| `batches/page.tsx` — computed IN THE BROWSER | `max(mobilisation lead, trainer.available_from)` |
| `api/batches/route.ts` — the create door | the same thing, written again |
| `api/batches/[id]/route.ts` — the reschedule door | the same thing, a third time |
| `rules.ts earliestPossibleStart` — added by -164 | `max(mobilisation, trainer availability AND cap, first free room)` |

The first three knew nothing about **rooms**. Measured on a centre whose only room was held until
22 June 2029: a create with a start of 15 January 2029 produced **`warning: ""`** — not a different
date, **no warning at all**. Silence about a date that cannot work is worse than a wrong date,
because there is nothing there to doubt.

**Now:** `earliestPossibleStart(location, { trainerId })` in `rules.ts` is the ONLY definition, and
`earliestStartNote(res)` beside it is the ONLY sentence — built from the same `basis` the
calculation returns, so the words cannot drift from the number they explain. Readers: the create
door, the reschedule door, and `GET /api/plan-batch` (which the batch form now asks instead of
computing). `mobilisation_lead_days` is READ in exactly one place in `src/`.

**Do not re-grow this.** A screen that wants the figure asks `/api/plan-batch?location=…&trainer=…`;
it does not recompute. Pinned by the QA-509 block in `scripts/e2e.mjs`, which asserts the three
doors name the SAME date on a room-constrained centre — a disagreement test, not a presence test.

### 3.0b "How a person is named" — collapsed over -160/-161, and a warning about this row's own history

**The rule (REQ-389):** wherever a list can contain two people with the same name, each row shows
something that tells them apart — **the portal ID when present, otherwise the phone**. A name alone
is never sufficient identification on a screen a person acts on.

**Where it lives:** `lib/person.ts` — `personLabel` (name + separator), `personSeparator` (the
separator alone, for surfaces that render the name themselves), `personList` (a joined list).
It sits in a **neutral** module, not `lib/client.ts`, because that file opens with `"use client"`
and no API route could import it — which is *why* seven server-side copies existed.

**Readers, measured at `-161` rather than asserted:** `batches/[id]/page.tsx` (the Closure blockers,
the portal-ID line, the complete-batch plan, the Attendance name column, the tap-present grid),
`candidates/page.tsx`, `trainers/page.tsx`, `api/candidates/import`, `api/trainers/import`,
`lib/duplicates.ts`.

**Read this part before trusting the row above it.** Three consecutive releases claimed this
concept was collapsed and each claim was false when measured:

| Release | Claimed | Measured by the check |
|---|---|---|
| `-158` | one tooltip fixed, "a class" | the sibling one line above still bare |
| `-159` | four surfaces, "the class" | **seven**, one printing three identical names in visible copy |
| `-160` | *"the ONLY definition"* | **seven more** hand-written copies elsewhere in `src/`, one of them inside `lib/duplicates.ts` — the duplicate-**candidate** detector's own message |

The surface that hid longest was `batches/[id]/page.tsx`'s Attendance name column
(`sub={r.sidh_candidate_id ?? undefined}`) — **the line REQ-389 was written from**, and an open S2
(QA-430) on this project's own ledger the whole time. It survived three censuses because every one
of them searched for `.map(…).name` joins, and that line has no join and no `.name` in it.

**What guards it, and what the guard cannot do** (`scripts/check-user-copy.mjs`):

- **Check A — whole-app, precise.** No file outside `lib/person.ts` may write the
  `name (separator)` template by hand. This caught a seventh copy the maker had missed.
- **Check B — scoped, and the scope is a confession.** It flags a `.map(…)` that reaches a bare
  name and joins it, on the three screens this concept was measured against. Run app-wide the same
  shape reported 11 sites of which four were centres, a generic array renderer, and a
  certificate-filename list whose file column *is* the separator. **Asking "is this list people?"
  is a semantic question and a regex cannot answer it.** A check that fails on non-defects gets
  narrowed by the next person until it is green — which is how three previous versions of this
  check came to exist.
- **Known blind spots**, listed so nobody rediscovers them: a person list on a screen outside the
  scoped set (filed as **QA-487**); a name rendered with no join and no `.name` token, which is how
  QA-430 hid; string concatenation instead of a template literal in check A.

**The transferable lesson, which is why this row is this long:** the failure was never the tooltips.
It was asserting closure — on this map, which is the first thing every session reads. Three times a
wrong row here would have told the next reader the concept was safe. Say what was measured, and
name what was not.

### 3.1 Two roster-add paths that already disagree — **live defect, QA-273**
| Copy | Where | Walk-in (no centre) |
|---|---|---|
| Single add | `api/batches/[id]/members/route.ts:87` | `if (cand.location && …)` — **exempt**, and it *sets* the centre + audits it (:99) |
| Bulk assign | `api/candidates/assign/route.ts:43` | `if (String(c0.location) !== …)` — **refused**: `String(undefined)` = `"undefined"`. No adoption either |
**SoT:** extract the join-eligibility + adoption block into `rules.ts` beside `addMemberChecked` (:400)
and have both routes call it.

### 3.2 The candidate intake doors — **live gap, QA-275**, and it has now bitten twice more

`public/register/[token]` writes the 9 government fields; `public/enrol-otp` (:150) writes **none**.
S18-02/QA-261 fixed one door. **SoT:** one shared `publicCandidatePayload()` both routes call.

**Count the doors before adding a field: there are FOUR, not two.** The staff create route, the staff
edit route, and the two public ones — and a field is only real when every one of them accepts it. The
recorded failure mode is not a 500, it is silence: a door that does not accept a field returns 200 and
drops it, so the value looks saved and is gone on the next read (the -116 lesson, which cost a whole
release when the government fields were creatable but not editable).

Two fields added 2026-08-24 are the current test of whether this row is being read:

| Field | Staff create | Staff edit | `public/register` | `public/enrol-otp` | Import catalog |
|---|---|---|---|---|---|
| `aadhaar_no` (QA-903) | yes | yes | yes | yes | yes |
| `apaar_id` (QA-902) | yes | yes | **no, deliberately** | **no, deliberately** | yes |
| `batch_interest` (Unit C) | pending | pending | pending | pending | pending |

**Read `apaar_id`'s two "no"s as a decision, not as this row biting a third time.** Asked directly on
2026-08-24, Umesh chose the staff doors, the drawer, the Excel import and the batch roster, and did
**not** choose the public self-registration forms — the same posture `sidh_candidate_id` has always
had, and for the same reason: a portal-issued id is read off the government portal by a centre, not
recalled by a student filling in a form. If a later cycle adds it to the public doors, that is a new
decision of Umesh's and this line is the evidence that its absence was never an oversight. It also has
a **FIFTH** write door the other rows do not have — `PUT /api/batches/[id]/results`, the Closure card,
on `closure.manage` so a Trainer can fill one in (QA-747's ruling, now serving two fields).

**`aadhaar_no` also reversed a standing decision, so do not trust older comments about it.** Until
2026-08-24 this product deliberately held no Aadhaar number: `models/index.ts` said `id_reference` is
"NOT the Aadhaar number itself" and `export-sidh` shipped its `aadhaar_or_vid` column blank on purpose.
Umesh reversed both. THREE consequences ride with it and are not optional — `scripts/mirror-prod.mjs`
REDACT (QA-536: no local mirror may carry live Aadhaar), `lib/audit.ts` `AUDIT_MASK_FIELDS` (the audit
trail must not become the leak), and its deliberate absence from `searchFields` and every table column.

**There are now FOUR government-ID fields on a Candidate and they are not interchangeable** —
`aadhaar_no` (the Aadhaar), `apaar_id` (the APAAR academic account), `sidh_candidate_id` (the portal
CAN id), `id_reference` (anything else). QA-414 measured 55 live candidates whose portal id landed in
`id_reference` because it was the closest-looking option on a screen that did not offer the right one.
Four such boxes side by side is that same trap, widened again — and **two of the four are 12-digit
numbers**, which is the closest resemblance any pair on this schema has ever had.

That pair has one guard, and **it is NOT uniform across the doors — say it exactly, because the
first version of this paragraph said "every door … refuses" and that was a false universal in the
anti-drift map itself** (QA-949, found by the qa-232 checker). The truth, per door:

| Door | On an APAAR equal to that candidate's Aadhaar |
|---|---|
| `api/candidates/route.ts` (create) | **refuses**, 400, naming which box it is |
| `api/candidates/[id]/route.ts` (edit) | **refuses**, 400 — and in BOTH directions since QA-950, because asking only "is this APAAR the Aadhaar?" let the operator set the APAAR first and the Aadhaar second and walk straight past it |
| `api/batches/[id]/results/route.ts` (Closure card) | **refuses**, 400, via the `crossCheck` hook |
| `api/candidates/import/route.ts` (Excel) | **REPORTS, never refuses** — `apaar_same_as_aadhaar` on the preview and the confirm |

The importer differs on purpose and the difference is the QA-141 ruling, not an oversight: a client's
sheet is client data and a row is never dropped over format. What is unacceptable there is silence —
and silence is what it did until QA-949, on the one door where QA-414's 55 records actually arrived.
This is the only one of the four confusions that is knowable at the door at all; the rest are
discoverable only when the government portal rejects that student. `apaar_id` also rides `scripts/mirror-prod.mjs`
REDACT with `aadhaar_no`, but is **NOT** in `AUDIT_MASK_FIELDS` and **is** in `searchFields` — it is a
number a centre quotes back to the government and searches on, which Aadhaar is not. That split is a
decision; if it is wrong, it is Umesh's to flip.

### 3.2b Delete is a RIGHT now, not a role — QA-904 (2026-08-24)

All three delete verbs already existed with their safety refusals and were shut behind a hard-coded
`user.role !== "Admin"`. The team saw no button and reported the feature as absent, which is worth
remembering: **a capability nobody can reach is indistinguishable from one that was never built.**

`candidates.delete` · `trainers.delete` · `batches.delete` — three separate keys (Umesh's call), so a
centre principal can clear a junk candidate row without also being able to erase a trainer or a batch.
Defaults: Operations all three, Location only `candidates.delete`, Enrollment and Trainer none.

**Delete is deliberately NOT folded into `.manage`.** Editing a record and destroying it are different
powers — `assertTrainerDocDeleteInScope` exists in `rules.ts` for exactly this reason, because document
DELETE had to be narrower than document read/upload.

**The safety refusals are unchanged and must stay that way**: a candidate with batch history is Dropped
(409), a trainer referenced by a batch is Dropped (409), a batch carrying any recorded work is Cancelled
(409). Widening who may press a verb is the reason to keep what it refuses strict, not to relax it.

**Readers to keep in step (four UI gates + three routes):** `api/candidates/[id]`, `api/trainers/[id]`,
`api/batches/[id]`, and the buttons in `trainers/page.tsx`, `batches/page.tsx` (Planning row, Edit mode
only — pinned in `check-user-copy.mjs`), `batches/[id]/page.tsx`, and `candidates/page.tsx`.

**Live-behaviour warning (QA-036 pattern, and it has caught people here before):** changing
`DEFAULT_ROLE_PERMISSIONS` changes NOTHING on production. `getRolePermissions` (`permissions.ts:98`)
returns a role's STORED `RolePermission` row when one exists and only falls back to the defaults when it
does not — and every role on production already has a stored row. The three new toggles must be ticked
in the matrix (`PUT /api/permissions`) and read back, or Operations and Location see exactly the missing
buttons they see today.

### 3.2c A comment does not enforce the rule it states — and the author is the least protected

**Four times on 2026-08-24, in three different sessions, someone wrote a true sentence beside code
that contradicted it — and in every case the person who wrote the sentence was the one who broke it.**
This is not a documentation problem. Every one of these shipped or nearly shipped, and none was caught
by a type checker, a lint rule, or a wall, because nothing in the toolchain compares prose to code.

| What the words said | What the code did | Found by |
|---|---|---|
| `validate.ts`: "bulk import keeps the normalize-and-report lane" | there was **no such lane** for that field; a checksum failure and the literal `NOT-AN-AADHAAR` both imported silently | checker, QA-941 |
| Import warning: "the SIDH export will carry it as-is" | the **same commit** made the export carry nothing (QA-942) | checker, QA-971 |
| `validate.ts`, in capitals: APAAR must NOT go through the Aadhaar rules, because a real APAAR begins with 1 | the comparison was routed through `canonicalAadhaar()`, which refuses leading 0/1 — so the guard **could not fire on the live sample number** | checker |
| A commit message: "placed above the optional government block" | it was **inside** that block, under a heading reading *"All optional"* — on the one question that decides whether a candidate joins the batch | **a live screenshot**, not a diff |

**Why the author is the worst-placed person to catch it:** they read their own intent. The sentence
describes what they meant to build; the code is what they built; and re-reading the pair confirms the
intent both times. QA-727 is the earliest instance on this ledger — an excuse that named a safeguard
which did not exist — and it was repeated one release later **by someone who had read QA-727 and
quoted it in the commit message**.

**What actually catches it, in the order they proved effective:**

1. **A pin on the SENTENCE.** Where a message states what another part of the system will do, assert
   the string. `e2e-blindspot.mjs` now asserts the import warning does not say `carry it as-is` and
   does say `blank` — a string assertion, because no behaviour changed and only a string was wrong.
2. **Reading the published page, not the diff.** The placement fault was invisible in review and
   obvious in one screenshot. A rendered page answers "where is this, and what is it next to"; a diff
   cannot.
3. **A fresh reader who has no access to the intent.** Three of the four were found by a checker.
4. **Writing the history rather than a clean sentence.** When one of these is corrected, leave the
   correction visible — `validate.ts` keeps *why* its claim was once false. The failure was never the
   missing code; it was asserting the code existed, and a tidied comment erases the only evidence of
   that.

**A pin on prose has its own trap, and it bit within the hour.** The first placement pin searched for
the bare phrase `Government registration details` — and matched the fix's own COMMENT, which names
that block while explaining the mistake. The pin failed while the code was right. **Match the rendered
markup (`? *`, `>...<`), never the bare words:** a check that cannot tell code from a comment about the
code is not a check.

### 3.3 `public/trainer-apply` never adopted `lib/validate` — **live hole, QA-274**
`:26` `S(body.phone).replace(/\D/g,"").slice(-10)` + `:56` `length !== 10` + `:58` its own email regex.
`99999999999999` → last ten → passes. This is exactly what -126 fixed on `p/register`, whose comment
says *"every other path in the product uses lib/validate."* It did not. **SoT:** `validate.ts`.

### 3.4 Two `parseSheetDate`, same name, different semantics — wires PINNED 2026-08-25 (QA-1103), and this row's own fix prescription was UNSHIPPABLE
`rules.ts:166` (Excel serials, ISO, day-first, range-validated, null on failure — "never guess,
never drop silently") vs `field-catalog.ts:29` (no serials, parses "6th July", **defaults the year
to the current one**). Callers: the two importers (`candidates/import`, `batches/import` → rules)
vs the automated watch ingest (`tab-mapping` → field-catalog). Same signature — a crossed import
compiles silently and changes which YEAR a dob or planned_start lands in.
**This row used to prescribe:** *"SoT: `rules.ts`; `field-catalog` should delegate and keep only
its extension."* **That instruction cannot be followed and never could:** `field-catalog.ts` is the
SECOND import-free pure module — `candidates/page.tsx:8` (a client component) imports it, and
`rules.ts` pulls the mongoose models, so delegating would drag mongoose into a client page. Kept
here corrected rather than deleted (§3.2c: the history is the evidence). The real merge is roadmap
unit **D12** — parser moves DOWN into a pure module, `rules.ts` re-exports (the `normalizeCan`
shape from §3.0) — and is **gated on two open Umesh decisions**: D-1 (the "6th July" year rule:
keep the guess, report-by-row, or sheet-anchored) and D-2 (bless `lib/dates.ts` or widen a pure
module's charter). Until then `check-user-copy.mjs` pins the freeze: exactly TWO declarations
(rules + field-catalog), each caller wired to its own parser, and `field-catalog.ts` import-free.

### 3.5 Five phone normalizers — and the SIXTH this row never listed, which was the worst one
`validate.ts:14` `canonicalPhone` (STRICT — the canon) · `duplicates.ts:7` `normalizePhone` (LOOSE
compare key, deliberately different) · `field-catalog.ts:25` `phone10` · `messaging.ts:16` `tenDigits`
(byte-identical to `phone10`) · `locations/page.tsx:52` `normPhone` (inline 5th).
**A sixth existed and this row did not know it (deleted 2026-08-25, QA-1087):** `lib/rules.ts`
exported a SECOND `canonicalPhone` — same name as the canon, INVERTED contract (`"12345"` came back
`"12345"`; the canon returns null and the caller refuses). Residue of the `-191` plan-share key that
`-195`/QA-618 removed; measured at zero callers before deletion. The hazard was the name, not the
dead code: every call site writes `canonicalPhone(x)!`, which compiles unchanged against either copy,
so one auto-import stored an unvalidated fragment as a phone of record. Now pinned in
`check-user-copy.mjs`: exactly ONE `canonicalPhone` declaration in `src/`, at `lib/validate.ts`,
declaration-matched (the identifier appears in ~8 comments and a release-note string).

### 3.6 `TRAINER_PIPELINE` — 8 copies of one 11-value list
`models/index.ts:26` (**SoT**) · `rules.ts:1792` `TRAINER_FLOW` (edges — keys must match) ·
`rules.ts:2137` `NOMINATED_STATES` · `trainers/[id]/page.tsx:19` `JOURNEY` (9) ·
`trainers/page.tsx:121` `STAGES` (10) · `ui.tsx:74` `CHIP_COLORS` (a missing key silently greys) ·
`open-positions/route.ts:23` `STAGE_BUCKETS` · `trainers/import/route.ts:19` `STAGE_ALIASES` ·
`trainers/page.tsx:278` `FULL`. **Adding a stage today needs eight coordinated edits.**

### 3.7 `TRAINER_DOC_TYPE` — 3 copies + a subset
`models/index.ts:42` (**SoT**, 9 values) · `trainers/[id]/page.tsx:25` (verbatim re-declaration feeding
the upload select) · `admin/page.tsx:161` (the "extra 4" hardcoded as programme checkboxes) ·
`rules.ts:1788` `MANDATORY_TRAINER_DOCS` (the standard-5 floor).
Also **two filename→doc-type guessers** that differ: `trainers/[id]/page.tsx:121` (7 rules) vs
`candidates/page.tsx:256` (5 rules) — they disagree on `aadhar`/`adhar` and `pic`.

### 3.8 Other enum re-declarations
`EDUCATION_LEVEL` ×4 (models · `candidates/page.tsx:610` · again at `:860` · `coerceEducation`) —
note the **public** pages get this right by rendering `meta.education_levels` from the API; the
internal page is the one that hardcodes. `HALTED_LOCATION_STATUSES` — 6 inline copies (`rules.ts:19`
is private; export it). `ACTIVE_BATCH_STATUSES` (`rules.ts:14` vs `sync.ts:13`). `BATCH_STATUS`
(models vs `batches/page.tsx:99`). `ENROLLMENT_ISSUE` (models vs `batches/[id]/page.tsx:908`).
`["Issued","Not Issued"]` — the settled-certificate predicate, **3 copies** (`rules.ts:1230`,
`certificates/route.ts:254`, `complete/route.ts:38`) — should be `isCertificateSettled()`.
`CANDIDATE_DOC_TYPE` (models :310) never reaches its own UI at all — only a `guess()` infers it.
**`SHEET_CHANGE_ACTION` — COLLAPSED 2026-08-24 (QA-946), and worth reading as the worked example.**
It had **six** copies: `models/index.ts:87`, `sync/page.tsx:7` (all seven), `:10` (the entity two),
`:326` (the reason-needing three), `:329` (the follow-up two), `:275` (the revertable two). The cost
was not cosmetic: the page's copy could not see `field_name`, while the apply door accepts at most
one of `Update target` / `Apply value` per row and those two conditions are exact complements — so
**every row's dropdown carried a guaranteed-400 option at the top and nothing said which one**.
Now: `classifyChange()` in `lib/sync.ts` derives from `LOCATION_FIELDS` + `TARGET_ROW_FIELDS`, emits
in `SHEET_CHANGE_ACTION` order, the door refuses through it, the screen renders it, and
`check-user-copy.mjs` pins both that the page names no lifecycle action of its own and that every
enum member has a verdict. **One copy survives on purpose:** `page.tsx:275` still names
`["Update target","Apply value"]` for the **revert** button — a different question (what can be
undone, owned by `revert/route.ts:21`), deliberately excluded from the pin rather than half-covered.

### 3.9 Field whitelists — create vs edit
Byte-identical duplicated lists in `locations`, `programs`, `sync-sources`. Deliberate differences in
`candidates` (create carries `lifecycle_status`) and `trainers` (create carries `pipeline_status`;
stages otherwise move only through `/transition`). **Divergent by omission:** `batches` PATCH accepts
`govt_batch_id`, `drive_folder_url`, `planned_end`; POST accepts none.
**The one place this is done right:** `trainers/route.ts:21` exports `SENSITIVE_FIELDS` +
`maskTrainerSecrets` and `[id]/route.ts:10` imports them, with a comment saying they had drifted before.

### 3.9b `CORRECTABLE_TRAINER_DATES` — 2 copies, one of them guarded (added -202)
`rules.ts` (**SoT**, exported) · `trainers/[id]/page.tsx` `PIPELINE_DATES` (labels + order for the
card's Edit mode). The screen cannot import the SoT — `rules.ts` pulls mongoose and that page is a
client component, the same wall `DOC_TYPES` hits in 3.7. **The copy is pinned**:
`check-user-copy.mjs` fails if the two lists differ in members or order, and separately if any of
the six ever reaches the plain `PATCH /api/trainers/[id]` allow-list (3.9), which is what qa-196's
ratified invariant I2 rests on. These six are written **only** through
`/api/trainers/[id]/transition` — `POST` stamps them on a stage move, `PATCH` corrects them after.

### 3.11 How the batch-code PREFIX is spelled — 3 writers, 2 of them byte-identical (added -225)
`nextBatchCode` builds `${Location.code}-${Program.code}-NN`, and **both of those codes are minted
upstream by the same three pieces of logic, written out twice**:

| Concept | App copy | Script copy |
|---|---|---|
| `slug()` — institution → centre code (`"Govt. ITI Charthwal, Muzaffarnagar"` → `MUZ-CHAR`) | `api/admin/avpl-rebase/route.ts:38-43` | `scripts/seed-rpl.mjs:46-51` |
| `JOB_ROLE_CODES` (DST · BSRT · SPIT · DSWT) | `avpl-rebase/route.ts:28-33` | `seed-rpl.mjs:36-41` |
| programme-code formula (scheme letters, first 6, + job-role code) | `avpl-rebase/route.ts:139` | `seed-rpl.mjs:182` |

They are byte-identical apart from TypeScript annotation, and the route's own header admits the
arrangement: *"the parsing rules are kept in lockstep with that script."* Kept in lockstep **by
hand** is what this whole section is a list of. **They cannot be collapsed** — a Next route cannot
import from `scripts/`, and the script cannot import the route — so they are **pinned** by
`check-user-copy.mjs` (all three branches proved to go red under mutation before the pin shipped),
the same answer `reparse-govt-hours`' `hhmmssToMinutes` copy got.

**Why a drift here is expensive and silent:** it re-partitions every prefix in the product. The same
institution begins minting under a different centre code, its existing batches keep the old prefix,
and the numbering restarts at `-01` — with nothing on any screen saying why. Note the same hazard
without any drift at all: `Location.code` and `Program.code` are **PATCHable**
(`api/locations/[id]/route.ts`, `api/programs/[id]/route.ts`), so editing either has exactly this
effect deliberately.

**A THIRD writer bypasses both:** `scripts/seed-avpl-master.mjs:244,426` takes the batch code
**verbatim from the client's workbook column** and upserts **by code** — so it can create a batch
under a code our own minter would never issue (the legacy three-part `GGM-DST-01` shape), and it is
the reason a rename in Mongo alone is dangerous: re-running that seeder afterwards creates a SECOND
batch under the old code.

### 3.12 The batch-status gate has a SECOND copy on the client, and this file never said so (added -240)

`transitionBatch` (`lib/rules.ts`) decides which status moves are legal. `batches/[id]/page.tsx`
decides which ones to OFFER — `canTransition` (:177, a role literal), `isAdmin` (:191), `running`
(:170, a status literal), and the per-control conditions inside `statusActions` (:324-386). That is a
second implementation of the same question, and until this row it appeared nowhere in section 3
because a grep for a shared NAME finds nothing: the two copies share no identifier. Section 3.0c's
standard applies — *searching for a name is not a census*.

Its bug history is the argument for the row: **QA-693 (S1)** — every status control unreachable for
92 releases; **QA-696** — the pin that could not fail for the defect it named; **QA-733** — the
widened pin defeated by one renamed local; **QA-478** — an opener and its panel gated on different
expressions, so the panel was dead UI; **QA-798** — a class sweep finding ~25 further controls that
decide from a role or status literal where the server decides from a permission; **QA-828/825/785** —
`closed = ["Completed","Cancelled"].includes(status)` conflating permission with status on the
Closure tab.

**SoT:** the server. The client's job is to EXPLAIN, never to decide — and where it cannot act, it
must say why rather than render nothing. -240's restore drawer follows that: it offers all three
targets and greys the impossible ones **with the reason** (`restoreBlocked`, derived from `r.ready`
and `b.actual_start`), because a picker that silently omits a choice cannot tell you why it is
missing. The standing risk is that those two strings drift from the server's two refusals; both are
pinned in `e2e-flows-blindspot.mjs` FL19.

**Note the render sites, because -204/-205/-677 were all about this:** `statusActions` is ONE value
rendered in TWO places (:479 inside the "Right now" card while a batch runs, :537 inside the
readiness Section before it starts). `Cancelled` is NOT in `running` (:170), so a cancelled batch
takes the readiness branch — which is why the Restore control lands there.

### 3.13 "Was this batch recorded AFTER it ran?" — COLLAPSED (QA-957/958/965), do not re-grow it

**This row was first written, in this very file, saying the opposite — that the gate reads only one of
two markers. That was false when it was written, and it was written without checking.** The claim came
from a reading of QA-958/965 while those rows were still Open; they had since been fixed, and one look
at the function would have said so. A wrong map row is worse than a missing one, because the next
person spends their budget on a defect that is not there. Corrected here rather than deleted, so the
correction is part of the record.

What is actually true:

```ts
// lib/rules.ts
export async function startWasRecordedAfterTheFact(batchId: unknown): Promise<boolean> {
  return !!(await AuditLog.exists({
    entity: "Batch", entity_id: batchId,
    field: { $in: ["backdated_start", "auto_activated"] },   // BOTH markers
  }));
}
```

Two markers exist because two paths reach the same state: `transitionBatch` writes `backdated_start`
when an operator records a batch after it ran (-226), and `activateFromEvidence` writes
`auto_activated` when a portal row or daily log activates one (-88). The predicate asks for both, and
the screens do not re-derive it — `candidates/page.tsx` reads the server's own
`start_recorded_after_the_fact` off the batch row rather than guessing from `actual_start < today`,
which is the mistake -231 cycle 2 shipped and cycle 3 removed.

**Do not re-grow it.** The failure mode this row guards is a THIRD spelling: any new caller that asks
"did this batch run before it was entered?" by comparing dates instead of calling this predicate. A
date comparison is true of nearly every running batch, which is why the last one leaked.

**The live consequence, so nobody re-derives it either:** `addMemberChecked` uses this predicate to
choose a late joiner's default `joined_on`. Get it wrong in the permissive direction and a walk-in
enrolled today is written weeks early (QA-907); get it wrong in the strict direction and a real July
batch cannot have its attendance entered at all (QA-892). Both have happened.

### 3.10 Other predicates with more than one copy
**`totNeeded` — 4 copies of "does this trainer still need a TOT"**: `rules.ts:1865`
(`planBatchBackward`) · `rules.ts:2587` (`planTrackerRows`, flips six of the 18 columns to
"Not needed") · `api/plan-batch/route.ts:69` (`tot_skipped`) · `batches/page.tsx:953` (the planner's
"TOT skipped" note). All four read `pipeline_status === "Certified" || tot_done_on` — **either
signal alone is enough**, which is why writing `tot_done_on` on a non-Certified trainer silently
removes three milestones from every future plan.
**`tot_lead_ok` — 2 copies**: `rules.ts:567` (`batchReadiness.plan_flags`) · `rules.ts:1806`
(`planArtifact`). Neither consults `pipeline_status`, so this one moves for **any** trainer — and
`planArtifact` is served through the **public plan-token door**, so a correction changes the payload
of a link already sent outside the company.

`nameKey` for match normalisation (×4: `govt-attendance.ts:207`, the row-match route, `locations/page.tsx:53`,
inline in `trainers/page.tsx:140`) · `offerable()` retired-programme filter declared **three times**
(`batches/page.tsx:16`, `candidates/page.tsx:18`, `locations/[id]/page.tsx:12`) · the ledger-code
stripping regex (`user-copy.ts` + copy-pasted into three scripts) · hardcoded
`https://www.vidysea.com/erp…` in five places that bypass `BASE_PATH`.

---

## 4. Key entry points

```
npm run dev | build | start | lint
npm test                 → scripts/run-e2e.mjs   (17 suites, ~1,100 assertions)
npm run seed | seed:sample | seed:rpl | purge
```
**Release:** bump `RELEASE` in `src/lib/version.ts`, write `RELEASE_NOTE_CURRENT`, move the old text
into the private archive. `GET /erp/api/public/version` publishes `RELEASE` +
`RELEASE_NOTE_CURRENT` + `storageHealth()` **only** — the archive must never be published (QA-265).

**Deploy:** push to `master` → CodePipeline → ECR → ECS (3–10 min). GitHub Actions is verification
only. The **only** proof a deploy landed:
```
curl https://www.vidysea.com/erp/api/public/version
```

---

## 5. Landmines

1. **Mongoose enums with live data behind them.** `TRAINER_PIPELINE`, `LIFECYCLE_STATUS`,
   `CERTIFICATE_STATUS`, `BATCH_STATUS`, `SIDH_STATUS`, `TRAINER_DOC_TYPE`. Renaming a value makes
   every existing row fail validation on the next `save()`. **Add → migrate → remove, in that order.**
   Dropping a column cannot be undone — `address_type`/`differently_abled` are kept as dead columns
   for exactly this reason.
2. **`DefaultsSchema` is strict and silent** (§1.2).
3. **`basePath: "/erp"`.** `next.config.ts` and `lib/base-path.ts` must agree. `next/link` prefixes
   automatically; **raw `fetch`, `window.open` and every URL stored in Mongo do not.**
   `src/auth.ts:30` pins `basePath: "/api/auth"` deliberately — an `AUTH_URL` carrying a path makes
   **every login fail** while the rest of the app looks healthy.
4. **Every API route must be wrapped:** `apiHandler` → `requireUser` → `requireEdit` →
   `requirePerm`/`requireView` → the scope assertion. The recorded failure is *"the list hides it, the
   item route allows it"* — it happened seven times. `crud.ts` gives you all of this for free.
5. **`plain()` has exactly two chokepoints:** `authz.ts:108` (server) and `ui.tsx:766` (client).
   A rule code mid-sentence cannot be stripped and is forbidden outright.
6. **Storage backends fail differently.** `local` is the container's own disk and is **wiped on every
   deploy** while URLs stay in Mongo. There is deliberately **no silent fallback**; `storageHealth()`
   is the honest flag.
7. **Sheet-source policy lives in code** (`workbook.ts` `sourceAllowed()`), because a runbook sentence
   did not stop a script re-arming two Google sheets on every run. Do not add a bypass.
8. **`version.ts` must stay ASCII** — Devanagari broke the Turbopack build for every route importing it.
9. **DEC-6 freeze:** a `Completed` batch locks results, certificates and closure with no override. The
   single escape is Admin `Completed→Closing` with a reason.
10. **`deriveCompletion` is reversible on purpose** — it derives sign-offs from rows, never the batch
    transition, because the batch ladder is one-way.
11. **Unique indexes that will 409 you:** `Trainer.phone`, `Trainer.tr_id` (partial),
    `Location.institution_id` (sparse), `BatchMember{batch,candidate}` and the partial-unique
    `{candidate}` on `left_on:null` (Rule 20), `CandidateResult{batch,candidate}` + partial-unique
    `certificate_no`, `Closure.batch`, `Invoice.batch`, `Feedback.batch_member`, `StoredFile.name`,
    `User.email`. `apiHandler` turns E11000 into a readable 409 — don't add your own.
12. **Timezone.** Business dates are stored at **UTC midnight** via `dayKey()`; "today" is `istToday()`
    — the server runs UTC on Fargate. A `new Date().setHours(0,0,0,0)` anywhere new re-opens this bug.

---

## 6. Two checkouts of this repo exist on this machine

`d:/erp/center-erp-audit` (branch `feat/cert-bulk-upload`, carries the live release) and
`d:/erp/center-erp` (branch `master`, stale). **All work happens in `center-erp-audit`.** Editing the
other one produces changes that look saved and never ship.

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
| Planning | `computePlannedEnd` · `capacitySummary` · `planBatchBackward` · `planArtifact` · `nextBatchCode` | **Rule 15**; codes `CENTRE-PROGRAMCODE-NN` via `counters` |
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
| `permissions.ts` | `PERMISSIONS` (17 keys) · `DEFAULT_ROLE_PERMISSIONS` · `hasPermission` · `requireView` · `requirePerm`. Deny wins; Admin bypasses |
| `crud.ts` | `collectionRoutes` / `itemRoutes` / `pick` — the REST factory. **`CrudConfig.fields` IS the write whitelist** |
| `validate.ts` | **`canonicalPhone` · `phoneError` · `emailError`** — THE write-time canon for phone/email. Client-safe |
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
| `sync.ts` / `workbook.ts` / `tab-mapping.ts` / `field-catalog.ts` | The sheet ingest stack. **`sourceAllowed()` in `workbook.ts` is the single-truth OneDrive policy — in code, not prose** |
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
- **PUBLIC (no session — a token IS the credential):** `public/register/[token]` · `public/enrol-otp` · `public/trainer-apply` · `public/attendance/[token]` · `public/feedback/[token]` · `public/plan/[token]` · `public/portal-lookup` · `public/ses-notifications` · `public/version`.

### 1.5 `src/app/(app)/**` — authenticated screens

| Path | Lines | Notes |
|---|---|---|
| `page.tsx` | 343 | Home / Action Center. **Structure pinned by `scripts/check-home-structure.mjs`** |
| `batches/[id]/page.tsx` | **2,988** | The monster. Tab components: `Overview`(128) `EditDetails`(525) `Roster`(663) `Enrollment`(917) `AttendanceTab`(1001) `DailyExecution`(1266) `ClosureTab`(1844) `CandidateResults`(2109) `FeedbackTab`(2762) `CostsTab`(2831) |
| `batches/page.tsx` | 744 | List + create drawer + CSV import |
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
- **CAN normalisation:** `normalizeCan()` in `lib/govt-attendance.ts`; `link-portal-ids` aliases
  its old local `canOf` to it. Never write a near-copy of that regex.
- **New door:** `api/candidates/portal-id-health` (GET plan / POST selected fixes, audited,
  never overwrites) — the link-portal-ids contract one level up. UI: the Candidates page
  "Portal ID health" drawer.

### 3.0c "The earliest a centre could start" — collapsed in -168 (QA-509)

**FOUR implementations, and the concept was not on this map at all** — which is how it reached four.
A checker found it while checking the unit that added the fourth; it also recorded that the row it
had itself written for QA-461 was wrong ("the identifier appears NOWHERE in `src/`" — it appeared
three times).

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

### 3.2 The two public intake doors — **live gap, QA-275**
`public/register/[token]` writes the 9 government fields; `public/enrol-otp` (:150) writes **none**.
S18-02/QA-261 fixed one door. **SoT:** one shared `publicCandidatePayload()` both routes call.

### 3.3 `public/trainer-apply` never adopted `lib/validate` — **live hole, QA-274**
`:26` `S(body.phone).replace(/\D/g,"").slice(-10)` + `:56` `length !== 10` + `:58` its own email regex.
`99999999999999` → last ten → passes. This is exactly what -126 fixed on `p/register`, whose comment
says *"every other path in the product uses lib/validate."* It did not. **SoT:** `validate.ts`.

### 3.4 Two `parseSheetDate`, same name, different semantics
`rules.ts:159` (Excel serials, ISO, day-first, null on failure) vs `field-catalog.ts:29` (no serials,
parses "6th July", **defaults the year to the current one**). Callers: the two importers vs the
automated watch ingest. **SoT:** `rules.ts`; `field-catalog` should delegate and keep only its extension.

### 3.5 Five phone normalizers
`validate.ts:14` `canonicalPhone` (STRICT — the canon) · `duplicates.ts:7` `normalizePhone` (LOOSE
compare key, deliberately different) · `field-catalog.ts:25` `phone10` · `messaging.ts:16` `tenDigits`
(byte-identical to `phone10`) · `locations/page.tsx:52` `normPhone` (inline 5th).

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

### 3.9 Field whitelists — create vs edit
Byte-identical duplicated lists in `locations`, `programs`, `sync-sources`. Deliberate differences in
`candidates` (create carries `lifecycle_status`) and `trainers` (create carries `pipeline_status`;
stages otherwise move only through `/transition`). **Divergent by omission:** `batches` PATCH accepts
`govt_batch_id`, `drive_folder_url`, `planned_end`; POST accepts none.
**The one place this is done right:** `trainers/route.ts:21` exports `SENSITIVE_FIELDS` +
`maskTrainerSecrets` and `[id]/route.ts:10` imports them, with a comment saying they had drifted before.

### 3.10 Other predicates with more than one copy
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

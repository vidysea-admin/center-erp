# Center ERP — Operations & Landmines (read before touching config or auth)

This file is the durable memory of how this system is deployed and which changes have broken it
before. It lives in the repo so it travels with the code and survives any single work session.
**If you are about to change environment variables, the reverse proxy, auth, or the database
connection — read the LANDMINES section first.** Every entry there is a real incident, not a
hypothetical.

Verify what is deployed at any time, no login needed:

    curl https://www.vidysea.com/erp/api/public/version

---

## Deployment shape

- **Public URL:** https://www.vidysea.com/erp  (the app is served under the `/erp` basePath; the
  bare host `vidysea.com` 301-redirects to `www`).
- **Hosting & deployment (per the devops team, 2026-08-13):** the app runs on an **AWS ECS
  cluster**. Deployments are AWS-native — **CodePipeline/CodeBuild build the Docker image, push
  it to ECR, and CodeDeploy rolls it onto ECS** — triggered by pushes to `master`. Observed
  end-to-end latency: a merge is live in ~4–10 minutes. **GitHub Actions has NO role in
  deployment** (a legacy `deploy.yml` used to sit in the repo as a gated no-op — it skipped
  whenever EC2 secrets were absent, so its green runs never deployed anything; removed
  2026-08-13 to end the confusion).
- **Build marker:** `src/lib/version.ts` → `RELEASE`. Bump it every meaningful release; the
  release-stamp curl above is the ONLY reliable way to confirm a deploy landed — never infer
  from pipeline/workflow status.
- **Database:** MongoDB at `mongodb://13.202.206.101:27017`, db `center_erp`. (Auth on the DB and
  file/upload storage are tracked as deferred infra — see DEFERRED.)
- **CI (verification only, not deployment):** `.github/workflows/ci.yml` builds AND runs
  `npm test` (`scripts/run-e2e.mjs` — all 15 e2e suites, ~1,100 assertions, per-suite summary
  table, no fail-fast) against a mongo:7 service container on every push/PR. Coverage map:
  `d:\erp\qa\EVAL-MATRIX.md`.
- **Media storage decision (Umesh, 2026-08-13):** photos/videos for attendance evidence live in
  the shared Google Drive (RPL project → All Locations → district folders) —
  https://drive.google.com/drive/folders/1NOfRCw9lIyRoJTEFAg4--HIJiTG-Of0G (the
  `Defaults.drive_root_url` default). Server-side auto-upload needs a Google service-account
  credential — pending with devops/Umesh (goal.json H-DRIVE-CRED).

## Logins (seeded)

| Email | Password | Role |
|---|---|---|
| admin@vidysea.com | **`ErpBGO5XbCn!`** (NOT `admin123`) | Admin |
| ops@vidysea.com | `Vidysea@123` | Operations |
| spoc.jpr03@vidysea.com | `Vidysea@123` | Location (Jaipur 03) |
| principal.jpr03@vidysea.com | `Vidysea@123` | Location, view-only |
| enroll@vidysea.com | `Vidysea@123` | Enrollment |

`admin123` is only the fresh-seed default and is **wrong on production** — the prod admin password
was rotated to `ErpBGO5XbCn!`. A failed admin login with `admin123` is expected, not a bug.

---

## LANDMINES — changes that have taken production down

### L1 · `AUTH_URL` must be the public ORIGIN only — never carry a path (2026-08-12, sign-in outage)

Setting `AUTH_URL=https://www.vidysea.com/erp/api/auth` took **all** sign-in down: every
`/erp/api/auth/*` endpoint returned a bare `"Bad request."` — no CSRF token, nobody could log in —
while the rest of the app kept serving, so it did not look like an outage.

**Why:** Next strips the `/erp` basePath before the Auth.js handler runs, so Auth.js always sees
`/api/auth/*`. When `AUTH_URL` carries a path, Auth.js derives its basePath from it and starts
expecting `/erp/api/auth/*`, which never arrives.

**Now guarded in code:** `src/auth.ts` pins `basePath: "/api/auth"`, so a stray path in `AUTH_URL`
can no longer move the route. **Do not remove that pin.** And keep the env value clean:

    AUTH_URL=https://www.vidysea.com      # origin only — this is what fixes the sign-out redirect

`AUTH_URL` is still required in production (without it Auth.js builds URLs from the instance's
private address, which no browser can reach). It just must not contain a path.

### L2 · `AUTH_SECRET` must be identical everywhere (deploy hazard)

If a deploy sets a different `AUTH_SECRET` than the one already in the server `.env`, **every
logged-in user is signed out** (their JWT can no longer be verified). If GitHub Actions ever takes
over deploy, its `AUTH_SECRET` secret must equal the server's exact value.

### L3 · `DailyLog.log_date` is a timezone-independent calendar date (2026-08-12)

Attendance dates are stored at **UTC midnight** via `dayKey()` in `src/lib/rules.ts`, and looked up
by day range, not exact-instant equality. Do not reintroduce `dayStart()` (server-local midnight)
for `log_date`, and **pin the container `TZ`**. Writing a log from a process in a different
timezone can otherwise create two rows for one calendar day and double-count attendance. A
migration for legacy rows exists: `scripts/migrate-logdate-tz.mjs` (dry-run default; back up first).

### L4 · Scope is enforced by applying the filter LAST (2026-08-12, S0 data exposure)

`src/lib/crud.ts` allow-lists client query filters and applies the Rule 38 location scope **after**
them, so `?location=<other centre>` cannot widen a scoped user's view. Do not reorder this: if a
client filter is ever assigned after the scope filter again, every centre's candidate PII leaks to
every scoped user. There is a regression test in `scripts/e2e-roles.mjs` (`F-000`).

---

## One-time / periodic ops tasks

- **Policy migration (run once on prod):** `node --env-file=.env scripts/migrate-policy-2026-08-11.mjs`
  — trainer concurrency cap 5 → 4. Idempotent. Prod Defaults still shows 5 until this runs.
- **Attendance date migration (run once, AFTER a DB backup):**
  `node --env-file=.env scripts/migrate-logdate-tz.mjs` (dry run), then `--apply`.
- **Sheet Watch setup:** `node scripts/setup-watch-source.mjs` registers the client OneDrive
  workbook; the scheduler then polls every 30 min.
- **Backup:** confirm `scripts/backup.sh` runs nightly and note where backups land.

## Sync sources — single-truth policy (2026-08-13)

- **Location Master's only source of truth is the client's OneDrive `Vidysea-RPL.xlsx`**
  (Umesh: "iss sheet ke exact column and data chahiye, aur koi nahi"). Prod keeps exactly
  two sync sources, BOTH pointing at that workbook: `Vidysea-RPL (OneDrive)` (mapped →
  Sync Inbox) and `Vidysea-RPL (client workbook)` (watch → Sheet Watch cell history).
- The Google-workbook watches (`AVPL-RPL Project (13-tab master)`, `Trainer hiring`) were
  DELETED via the app API on 2026-08-13 (4,925 tracked changes + 63 snapshots cascaded;
  audit-logged). Do not re-add them — two masters race. The Google export stays reachable
  only for manual comparison (`seed-rpl.mjs --google`).
- Remnant sweeps: `node scripts/cleanup-sync-remnants.mjs` (dry-run; `--apply` to write) —
  orphaned watch data, stale target pairs vs the truth sheet, leaked `@vidysea-test.local`
  users. Never touches `counters` (batch-code sequence) or `sheetchanges` (audit trail).
- Backup taken before this cleanup: `backups/2026-08-13-pre-sync-cleanup/` (full
  `center_erp` mongodump, 5.2 MB, 38 collections).

## ⚠️ Infra flag for devops (2026-08-13, report-only)

The shared prod Mongo at 13.202.206.101:27017 is **reachable without authentication**,
hosts 40+ Vidysea databases, and carries a `READ__ME_TO_RECOVER_YOUR_DATA` ransomware
calling-card database — evidence scanners have reached it at some point. Needs: bind to
private IP / security-group restriction + `--auth` with per-app users + a look at what
(if anything) that ransom DB touched. Outside this repo's scope; raised 2026-08-13.

Note (Umesh, 2026-08-13): the Claude Code dev machine's access to this Mongo is
**IP-based locked** (security-group allowlist). When devops tightens the SG / adds auth,
preserve that dev-IP allowlist entry (plus the ECS app's access) so tooling and deploys
keep working — and have devops verify the CURRENT inbound rules, since the ransom-note DB
implies 27017 was world-open at least once.

## How to verify a release end-to-end

    curl https://www.vidysea.com/erp/api/public/version          # RELEASE running
    # login round-trip: GET /api/auth/csrf → POST /api/auth/callback/credentials → GET /api/auth/session

## Post-deploy LIVE SMOKE — run after EVERY merge (Umesh, 2026-08-14)

Version stamp alone is not verification. After the release stamp flips, run the
authenticated read-only smoke (curl, never Playwright against Umesh's own Chrome):

1. `GET /api/public/version` — release matches the merged PR's version.ts.
2. Admin login → `GET /api/home` — KPIs sane (no zeros where data exists, counts match
   the OneDrive sheet's arithmetic: job-role rows vs centres both).
3. `GET /api/locations?limit=5` — rollups present (job_roles, trainers_*_total, tc_ids).
4. One detail page's API (`/api/locations/[id]/targets` or `/api/batches/[id]`) — 200 +
   shape.
5. One NON-admin role login (principal/trainer) — scoped list + one gate that must 403.
6. Eyeball the release's OWN feature via its API surface (whatever the PR shipped).

Record the result in qa/STATE.md with the release number.

UI click-throughs (QA-010 update, 2026-08-14): the independent CHECKER session runs its
own browser and screenshots every release from its deploy-watch — visual verification is
its lane. The maker verifies via the API surface above. The old blanket warning
("Playwright drives Umesh's own Chrome") applied to THIS maker session's MCP browser
only; it must not block the checker's own tooling.

See `d:\erp\qa\STATE.md` for the full remediation ledger (every fix, where, and its test) and
`d:\erp\qa\CHANGELOG.jsonl` for the machine-readable one-row-per-fix log.

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
- **Hosting:** Docker on an EC2 instance behind nginx. `cd /opt/center-erp && git pull &&
  docker compose up -d --build`. An auto-deploy picks up pushes to `master` in ~5 minutes.
- **Build marker:** `src/lib/version.ts` → `RELEASE`. Bump it every meaningful release so
  `/api/public/version` tells you exactly what is running.
- **Database:** MongoDB at `mongodb://13.202.206.101:27017`, db `center_erp`. (Auth on the DB and
  file/upload storage are tracked as deferred infra — see DEFERRED.)
- **CI:** `.github/workflows/ci.yml` builds AND runs `npm test` (`scripts/run-e2e.mjs` — all 15
  e2e suites, ~1,100 assertions, per-suite summary table, no fail-fast) against a mongo:7
  service container on every push/PR. Coverage map: `d:\erp\qa\EVAL-MATRIX.md`.
  `deploy.yml` auto-deploys pushes to `master`.

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

## How to verify a release end-to-end

    curl https://www.vidysea.com/erp/api/public/version          # RELEASE running
    # login round-trip: GET /api/auth/csrf → POST /api/auth/callback/credentials → GET /api/auth/session

See `d:\erp\qa\STATE.md` for the full remediation ledger (every fix, where, and its test) and
`d:\erp\qa\CHANGELOG.jsonl` for the machine-readable one-row-per-fix log.

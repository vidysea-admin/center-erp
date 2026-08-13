# Center Management & Execution ERP

Internal web app for end-to-end skilling-program operations: **Location & Target → Trainer
Capacity → Infra → Batch Planning → Candidate Pool → Enrollment → Daily Execution → Govt
Attendance → Assessment → Certification → Costs → Invoice.**

Stack: Next.js 16 (App Router, TypeScript) · MongoDB (Mongoose) · Auth.js v5 · Tailwind.
Spec source of truth: `d:\erp\center-erp-data-model-rules.md` (18 entities, 40 numbered rules).

## Run locally
```bash
npm install
# .env.local needs: MONGODB_URL, MONGODB_DB, AUTH_SECRET, AUTH_TRUST_HOST=true
node --env-file=.env.local scripts/seed.mjs          # defaults + master lists + admin user (idempotent)
npm run build && npm start                           # production on :3000
# or: npm run dev
```
Login: `admin@vidysea.com` (see SECURITY.md — rotate the bootstrap password).

## Scripts
| Script | What it does |
|---|---|
| `scripts/seed.mjs` | Core seed: defaults (§8), cost categories, drop reasons, admin user |
| `scripts/seed-sample.mjs` | Demo dataset via the live API (8 locations, 5 programs, batches in every lifecycle state). Server must be running |
| `scripts/run-e2e.mjs` | **`npm test`** — runs all 15 e2e suites (no fail-fast), prints a per-suite table. ~1,100 assertions total. The suite list lives only in this file; the coverage map is `d:\erp\qa\EVAL-MATRIX.md` |
| `scripts/e2e-*.mjs` | Individual suites (each also has an `npm run test:<name>` alias): lifecycle/rules · roles/permissions · sheet sync + tab mappings · edge cases · govt attendance · trainer pipeline · RPL/flow gaps · 7 section-wise eval suites (home, notifications, trainers-ui, candidates, enrollment, locations-admin, data shapes) |
| `scripts/e2e-lib.mjs` | Shared harness for the eval suites (login/req/ok/stamp) |

## Wiring the real SDP sheet
Admin → Sync Source → add the sheet's **CSV export URL** + field mappings
(`{"Center ID": "external_id", "Status": "approval_status", "Target": "approved_target:<PROGRAM_CODE>"}`).
One column must map to `external_id` and each Location's `external_id` must match that column's
value. Set frequency **Daily** + a sync time — the in-app scheduler (`src/instrumentation.ts`)
runs it; "Sync Now" works anytime. Column drift stops the sync as `Partial` (Rule 2), never a
silent partial import.

## Deploy checklist
1. Provision a Linux VM (or reuse the Mongo EC2). Install Node 20+.
2. **Do SECURITY.md first** — Mongo auth + firewall + fresh `AUTH_SECRET` + admin password.
3. `git clone` / copy `center-erp`, create `.env.local` (production values), `npm ci`,
   `npm run build`, run under a process manager: `pm2 start npm --name center-erp -- start`.
4. Reverse proxy with HTTPS (Caddy: `caddy reverse-proxy --from erp.yourdomain.com --to :3000`).
5. **Backups** — install the nightly job (DB + uploaded files, 14-day retention):
   ```bash
   chmod +x /opt/center-erp/scripts/backup.sh
   (crontab -l 2>/dev/null; echo "0 2 * * * /opt/center-erp/scripts/backup.sh >> /var/log/center-erp-backup.log 2>&1") | crontab -
   /opt/center-erp/scripts/backup.sh      # run once now and check the output
   ```
   Restore is documented in the header of `scripts/backup.sh` — always restore into a scratch DB name first.
6. Seed: `node --env-file=.env.local scripts/seed.mjs`, then create real users in Admin.

## Architecture notes
- Every business rule lives server-side: `src/lib/rules.ts` (Rules 10–37), `src/lib/sync.ts`
  (Rules 1–9), `src/lib/authz.ts` (Rules 38–40). UI never enforces alone.
- Every write is audited (`AuditLog`, `actor_type: USER/SYSTEM/AUTOMATION/EXTERNAL_SYNC`).
- Automation seam (future Selenium/crawler): call the same HTTP APIs with
  `source: "Automation"` — no schema or UI change needed (spec §7).
- Uploads: client-compressed images, 3× retry + offline queue (`src/lib/upload.ts`),
  served via 128-bit capability URLs (`/api/files/...`).

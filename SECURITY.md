# Security checklist — Center ERP

## 🔴 P0 — MongoDB is currently UNAUTHENTICATED on a public IP

`<YOUR-MONGO-SERVER-IP>:27017` accepts connections with **no username/password**. Anyone who can
reach that port can read/write every candidate's name and phone number. Fix before go-live:

### 1. Create an admin + app user (run on the EC2 box hosting Mongo)
```js
// mongosh
use admin
db.createUser({ user: "root", pwd: "<STRONG-PASSWORD-1>", roles: ["root"] })
use center_erp
db.createUser({ user: "center_erp_app", pwd: "<STRONG-PASSWORD-2>", roles: [{ role: "readWrite", db: "center_erp" }] })
```

### 2. Enable auth (`/etc/mongod.conf`)
```yaml
security:
  authorization: enabled
net:
  bindIp: 127.0.0.1,<private-ip>   # remove 0.0.0.0 if present
```
Then `sudo systemctl restart mongod`.

### 3. Firewall (AWS security group)
Restrict inbound 27017 to the app server's IP / office IPs only. Never 0.0.0.0/0.

### 4. Update the app's env
```
MONGODB_URL=mongodb://center_erp_app:<STRONG-PASSWORD-2>@<YOUR-MONGO-SERVER-IP>:27017/center_erp?authSource=center_erp
```
(both `.env` in d:\erp and `center-erp/.env.local`, and the deploy host's env)

## 🔴 P0 — Rotate the default admin password
`admin@vidysea.com / admin123` was seeded for bootstrap. Change it: Admin → Users & Access →
Admin → set a strong password. Sample users (`ops@`, `spoc.jpr03@`, `principal.jpr03@`,
`enroll@` — password `Vidysea@123`) are demo accounts: rotate or deactivate before real use.

## 🟡 Recommended
- Serve over HTTPS in production (reverse proxy — Caddy/nginx + certbot). NextAuth cookies
  become `__Secure-*` automatically; the app already handles both cookie names.
- `AUTH_SECRET` is per-environment; generate a fresh one for production
  (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
- Backups: nightly `mongodump --db center_erp` to S3/Drive. There are currently NO backups.
- Uploaded files live in `center-erp/uploads/` — include in backups. Access is by
  128-bit unguessable capability URL; switch to signed URLs if files become sensitive.

## Already enforced in the app
- All API routes require a session (proxy + `requireUser()`); role gates per Rule 40.
- Location-scoped queries server-side (Rule 38) — verified by `scripts/e2e-roles.mjs` (16/16).
- `can_edit=false` users are view-only everywhere (Rule 39).
- Every write goes to AuditLog with actor + actor_type.
- Passwords bcrypt-hashed (cost 10). Session JWTs encrypted (Auth.js v5).
- Upload whitelist by extension; NO app-side size cap (removed 2026-08-15 on Umesh's
  instruction — "koi bhi cap nahi"; the reverse proxy's body cap is the only limit and is
  with devops to raise); filenames are 128-bit random hex.

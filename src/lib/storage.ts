// QA-145 (2026-08-15) — durable evidence storage. Umesh's design, verbatim intent: photos,
// videos, voice notes, documents go to OUR Google Drive, folder-wise ("proper folder wise
// aana chahiye — kya hai, kaha hai"), with a database entry for every file ("koi bhi data
// miss na ho"); the USER never sees Drive — "wo hamara backend ka process hai". S3 was
// considered and rejected in favour of Drive.
//
// Why: the checker proved (upload on -73 → 24/24 reads; deploy -74 → same URL 16/16 404)
// that process.cwd()/uploads is the ECS task's own disk and every deploy wipes it, while
// the URLs stay in Mongo pointing at nothing. min_daily_evidence: 2 was asking for evidence
// the product could not keep.
//
// Shape follows mailer.ts: a graceful-off adapter. Configured → Drive is the primary store,
// the app proxies reads. Not configured → the old local write (still lost on deploy) plus a
// LOUD, honest health flag the admin panel shows in red — never a silent fallback.
//
// Gate (Umesh only, like the SES env vars): GDRIVE_SA_JSON (base64 of the service-account
// key JSON) + GDRIVE_ROOT_FOLDER_ID (the shared folder, shared WITH the service-account
// email as Editor). Steps: d:/erp/drive-storage-setup.md.
import { google, drive_v3 } from "googleapis";
import { Readable } from "stream";
import { mkdir, readFile, stat, writeFile, unlink } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import crypto from "crypto";
import path from "path";
import { getDefaults } from "@/lib/defaults";
const execFileP = promisify(execFile);

let cachedDrive: drive_v3.Drive | null = null;
let cachedAuth: any = null; // the auth client behind cachedDrive — needed for a bearer token (-90 resumable session)
let cachedErr: string | null = null;
const folderCache = new Map<string, string>(); // "parentId/name" → folderId

// Umesh (15/08): "drive ka link hard code kar de" — the ROOT FOLDER is not a secret (it is
// the same Drive folder Defaults.drive_root_url already points at), so it is the default
// here and the env var only overrides it. What CANNOT be hardcoded is the service-account
// key: that is a private credential, and without it Google will not let the app write.
export const DEFAULT_DRIVE_ROOT_FOLDER_ID = "1NOfRCw9lIyRoJTEFAg4--HIJiTG-Of0G";
export function rootFolderId(): string {
  return String(process.env.GDRIVE_ROOT_FOLDER_ID || DEFAULT_DRIVE_ROOT_FOLDER_ID);
}

// Two ways to be the app's Google identity — env-first, whichever is set:
//   (a) service account: GDRIVE_SA_JSON (base64 key JSON)
//   (b) OAuth user (Umesh, 15/08: "mere credentials jo already available hain, .env me daal
//       do"): GDRIVE_OAUTH_CLIENT_ID + GDRIVE_OAUTH_CLIENT_SECRET + GDRIVE_OAUTH_REFRESH_TOKEN
//       — the same triple the gws CLI holds; the app then writes AS that user.
// -89 (Umesh 15/08 23:45: "sab .env me hai, tu check kar le, gap ho to fix kar"): the app used
// to be strict — exact names, raw values — and mute about what it saw. Now it reads liberally
// (aliases; trimmed; surrounding quotes stripped — a `.env`-style KEY="value " pasted into a
// console field is the classic silent miss) and can SAY which names reached the container.
export const ENV_ALIASES = {
  client_id: ["GDRIVE_OAUTH_CLIENT_ID", "GDRIVE_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_CLIENT_ID"],
  client_secret: ["GDRIVE_OAUTH_CLIENT_SECRET", "GDRIVE_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  refresh_token: ["GDRIVE_OAUTH_REFRESH_TOKEN", "GDRIVE_REFRESH_TOKEN", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_REFRESH_TOKEN"],
  sa_json: ["GDRIVE_SA_JSON", "GOOGLE_SA_JSON", "GOOGLE_APPLICATION_CREDENTIALS_JSON"],
  // -92 (QA-161, Umesh 16/08 "gcs wala hi mere bhai"): evidence storage is Google Cloud Storage —
  // company-owned bucket, service account is the normal writer, signed/resumable direct uploads.
  gcs_bucket: ["GCS_BUCKET", "GOOGLE_CLOUD_BUCKET", "EVIDENCE_BUCKET"],
  gcs_sa_json: ["GCS_SA_JSON", "GCS_SERVICE_ACCOUNT_JSON", "GOOGLE_CLOUD_SA_JSON"],
  // -93: Workload Identity Federation — an external_account config (NO private key, so it can be
  // baked into the image at config/gcs-wif.json); the container proves who it is with its AWS
  // task role and Google hands back a token for the impersonated service account.
  gcs_wif_json: ["GCS_WIF_JSON", "GOOGLE_WIF_JSON"],
  gcs_wif_file: ["GCS_WIF_FILE", "GOOGLE_APPLICATION_CREDENTIALS"],
  // -95: env-only WIF — devops' "5 vars" package (audience + service-account email) builds the
  // same external_account config in code; the baked file is the default, these override it.
  gcs_wif_audience: ["GCP_WIF_AUDIENCE", "GCS_WIF_AUDIENCE", "GOOGLE_WIF_AUDIENCE"],
  gcs_sa_email: ["GCP_SA_EMAIL", "GCS_SA_EMAIL", "GOOGLE_SA_EMAIL"],
  gcp_project: ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"],
} as const;
// -95 (Umesh 16/08, console verified): the bucket is named in code — no env needed anywhere;
// GCS_BUCKET still overrides (Drive-folder-id pattern).
export const DEFAULT_GCS_BUCKET = "vidysea-erp-storage";
export const DEFAULT_WIF_FILE = "config/gcs-wif.json";
// -95: the browser PUTs resumable chunks straight to storage.googleapis.com from THIS origin, so
// the bucket's CORS must name it (checker, 16/08: "curl chalega, browser nahi"). APP_ORIGIN env →
// origin of AUTH_URL → the production default. localhost stays listed so a local run against the
// real bucket behaves the same.
export const DEFAULT_APP_ORIGIN = "https://www.vidysea.com";
export function appOrigin(): string {
  const explicit = parseEnvValue(process.env.APP_ORIGIN);
  if (explicit) return explicit.replace(/\/+$/, "");
  const auth = parseEnvValue(process.env.AUTH_URL);
  if (auth) { try { return new URL(auth).origin; } catch { /* fall through */ } }
  return DEFAULT_APP_ORIGIN;
}
export function gcsCorsRule(): { origin: string[]; method: string[]; responseHeader: string[]; maxAgeSeconds: number } {
  const origins = Array.from(new Set([appOrigin(), DEFAULT_APP_ORIGIN, "http://localhost:3000", "http://localhost:3001"]));
  return {
    origin: origins,
    method: ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
    responseHeader: ["Content-Type", "Content-Length", "Content-Range", "Range", "Location", "x-goog-resumable", "x-goog-upload-status"],
    maxAgeSeconds: 3600,
  };
}
// -95: with the bucket named in code every build would talk to the REAL bucket — including the CI
// wall on a laptop / GitHub runner, whose AWS identity the pool must NOT trust. This is the one
// explicit off-switch (CI/test only; never set on prod): storage behaves exactly as unconfigured,
// and the diagnostic says so instead of pretending the bucket is missing.
export const STORAGE_DISABLE_NAMES = ["STORAGE_DISABLE", "EVIDENCE_STORAGE_DISABLE"] as const;
export function storageDisabled(): { on: boolean; name: string | null } {
  for (const n of STORAGE_DISABLE_NAMES) { const v = parseEnvValue(process.env[n]).toLowerCase(); if (v && v !== "0" && v !== "false" && v !== "no" && v !== "off") return { on: true, name: n }; }
  return { on: false, name: null };
}
export function parseEnvValue(raw: string | undefined | null): string {
  let v = String(raw ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  return v;
}
function readEnv(aliases: readonly string[]): { value: string; name: string } | null {
  for (const n of aliases) { const v = parseEnvValue(process.env[n]); if (v) return { value: v, name: n }; }
  return null;
}
function oauthTriple(): { id: string; secret: string; refresh: string; names: string[] } | null {
  const id = readEnv(ENV_ALIASES.client_id), secret = readEnv(ENV_ALIASES.client_secret), refresh = readEnv(ENV_ALIASES.refresh_token);
  return id && secret && refresh ? { id: id.value, secret: secret.value, refresh: refresh.value, names: [id.name, secret.name, refresh.name] } : null;
}
function saJson(): { raw: string; name: string } | null {
  const e = readEnv(ENV_ALIASES.sa_json);
  return e ? { raw: e.value, name: e.name } : null;
}
function wifFilePath(): string | null {
  const e = readEnv(ENV_ALIASES.gcs_wif_file);
  const cands = [e?.value, DEFAULT_WIF_FILE, path.join(process.cwd(), DEFAULT_WIF_FILE)].filter(Boolean) as string[];
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}
function readWifJson(): { json: any; source: string } | null {
  const inline = readEnv(ENV_ALIASES.gcs_wif_json);
  if (inline) {
    try { const raw = inline.value.trim().startsWith("{") ? inline.value : Buffer.from(inline.value, "base64").toString("utf8"); const j = JSON.parse(raw); if (j?.type === "external_account") return { json: j, source: inline.name }; } catch { /* fall through */ }
  }
  // -95: env-only shape (GCP_WIF_AUDIENCE + GCP_SA_EMAIL) — the same client, built in code.
  const aud = readEnv(ENV_ALIASES.gcs_wif_audience), sa = readEnv(ENV_ALIASES.gcs_sa_email);
  if (aud && sa) {
    return {
      json: {
        type: "external_account",
        audience: aud.value,
        subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa.value}:generateAccessToken`,
        universe_domain: "googleapis.com",
      },
      source: `${aud.name} + ${sa.name}`,
    };
  }
  const fp = wifFilePath();
  if (fp) {
    try { const j = JSON.parse(require("fs").readFileSync(fp, "utf8")); if (j?.type === "external_account") return { json: j, source: `file ${fp}` }; } catch { /* unreadable → not configured */ }
  }
  return null;
}
// -95: the GCP project id for the Storage client — env (GOOGLE_CLOUD_PROJECT) or derived from the
// impersonated service account's domain (<sa>@<project>.iam.gserviceaccount.com). Bucket
// operations do not strictly need it; naming it avoids the SDK's project lookup.
export function gcpProjectId(): string | null {
  const e = readEnv(ENV_ALIASES.gcp_project);
  if (e) return e.value;
  const w = readWifJson();
  const m = w ? /@([^.]+)\.iam\.gserviceaccount\.com/.exec(String(w.json.service_account_impersonation_url ?? "")) : null;
  return m ? m[1] : null;
}
type GcsCfg = { bucket: string; bucketFrom: string; kind: "sa" | "wif"; raw?: string; wif?: any; credFrom: string };
function gcsConfig(): GcsCfg | null {
  const b = readEnv(ENV_ALIASES.gcs_bucket);
  const bucket = b?.value || DEFAULT_GCS_BUCKET;
  if (!bucket) return null;
  const sa = readEnv(ENV_ALIASES.gcs_sa_json);
  if (sa) return { bucket, bucketFrom: b?.name ?? "default", kind: "sa", raw: sa.value, credFrom: sa.name };
  const w = readWifJson();
  if (w) return { bucket, bucketFrom: b?.name ?? "default", kind: "wif", wif: w.json, credFrom: w.source };
  return null;
}
export function gcsWifPresent(): { present: boolean; source: string | null; impersonating: string | null } {
  const w = readWifJson();
  const m = w ? /serviceAccounts\/([^:]+):/.exec(String(w.json.service_account_impersonation_url ?? "")) : null;
  return { present: !!w, source: w?.source ?? null, impersonating: m ? m[1] : null };
}
// Order (QA-161): GCS wins when present (the decided backend); the Drive shapes stay for the
// files already there and for the interim.
export function storageMode(): "gcs" | "sa" | "oauth" | null {
  if (storageDisabled().on) return null; // -95: CI/test switch — never set on prod
  return storageModeRaw();
}
// What the mode WOULD be without the switch — the diagnostic reports it so a disabled build still
// says which bucket it is built for.
export function storageModeRaw(): "gcs" | "sa" | "oauth" | null {
  if (gcsConfig()) return "gcs";
  if (saJson()) return "sa";
  if (oauthTriple()) return "oauth";
  return null;
}
// Names only — never values. What the running container actually holds, so the "we put it in
// .env" conversation ends with a fact instead of a guess.
export function envDiagnostic() {
  const seen: Record<string, { present: boolean; length: number }> = {};
  const all = [...ENV_ALIASES.gcs_bucket, ...ENV_ALIASES.gcs_sa_json, ...ENV_ALIASES.gcs_wif_json, ...ENV_ALIASES.gcs_wif_file, ...ENV_ALIASES.gcs_wif_audience, ...ENV_ALIASES.gcs_sa_email, ...ENV_ALIASES.gcp_project, ...STORAGE_DISABLE_NAMES, ...ENV_ALIASES.client_id, ...ENV_ALIASES.client_secret, ...ENV_ALIASES.refresh_token, ...ENV_ALIASES.sa_json, "SES_SMTP_USER", "MONGODB_URL", "AUTH_SECRET"];
  for (const n of all) { const v = parseEnvValue(process.env[n]); seen[n] = { present: n in process.env, length: v.length }; }
  const other = Object.keys(process.env).filter((k) => /GDRIVE|DRIVE|GOOGLE|OAUTH|GAPI|GCS|BUCKET/i.test(k) && !all.includes(k)).map((k) => ({ name: k, length: parseEnvValue(process.env[k]).length }));
  const t = oauthTriple(), sa = saJson(), g = gcsConfig(), wif = gcsWifPresent(), off = storageDisabled();
  const anyDriveName = Object.entries(seen).some(([k, v]) => v.present && !["SES_SMTP_USER", "MONGODB_URL", "AUTH_SECRET", ...STORAGE_DISABLE_NAMES].includes(k));
  let hint: string;
  if (off.on) hint = `Storage forced OFF by ${off.name} (CI/test switch — never set on production). Without it this build would use ${g ? `Google Cloud Storage bucket ${g.bucket} (${g.bucketFrom}; ${g.kind === "wif" ? `WIF ${g.credFrom}` : g.credFrom})` : storageModeRaw() ? "Google Drive" : "nothing (unconfigured)"}.`;
  else if (g) hint = g.kind === "wif"
    ? `Google Cloud Storage via Workload Identity Federation (${g.credFrom}; impersonating ${wif.impersonating ?? "?"}) — bucket ${g.bucket} (${g.bucketFrom}). If the probe fails, the fix is IAM, not env: the AWS task role must be trusted by the pool provider, hold roles/iam.workloadIdentityUser on the service account, and the service account must hold roles/storage.objectAdmin on the bucket.`
    : `Google Cloud Storage configured (${g.credFrom} + bucket ${g.bucket}).`;
  else if (wif.present) hint = `WIF identity is baked in (${wif.source}, impersonating ${wif.impersonating ?? "?"}) but NO BUCKET NAME — set GCS_BUCKET (or the DEFAULT_GCS_BUCKET constant) and redeploy; nothing secret is needed.`;
  else if (sa) hint = `Service-account key found as ${sa.name}.`;
  else if (t) hint = `OAuth triple found as ${t.names.join(" / ")}${t.names.join() !== ENV_ALIASES.client_id[0] + "," + ENV_ALIASES.client_secret[0] + "," + ENV_ALIASES.refresh_token[0] ? " (accepted via alias)" : ""}.`;
  else if (anyDriveName) {
    const empties = Object.entries(seen).filter(([k, v]) => v.present && v.length === 0 && !["SES_SMTP_USER", "MONGODB_URL", "AUTH_SECRET"].includes(k)).map(([k]) => k);
    const partial = Object.entries(seen).filter(([k, v]) => v.present && v.length > 0 && !["SES_SMTP_USER", "MONGODB_URL", "AUTH_SECRET"].includes(k)).map(([k]) => k);
    hint = `Some Drive names reached this container but not a complete set — present with a value: ${partial.join(", ") || "none"}; present but EMPTY: ${empties.join(", ") || "none"}. All three OAuth names (or the SA key) are needed.`;
  } else hint = `None of the storage names reached this container (GCS_BUCKET + GCS_SA_JSON, or the Drive names)${seen.SES_SMTP_USER.present ? " — SES_SMTP_USER did, so register them in the same place (task definition / pipeline variable list) and redeploy" : ""}.`;
  return { env_seen: seen, other_names: other, hint, disabled: off, would_be: { mode: storageModeRaw(), bucket: g?.bucket ?? null, bucket_from: g?.bucketFrom ?? null, cred_from: g?.credFrom ?? null }, app_origin: appOrigin(), cors_rule: gcsCorsRule(), project: gcpProjectId(), wif: { present: wif.present, source: wif.source, impersonating: wif.impersonating }, aws: { region: parseEnvValue(process.env.AWS_REGION) || parseEnvValue(process.env.AWS_DEFAULT_REGION) || null, container_creds: !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, execution_env: parseEnvValue(process.env.AWS_EXECUTION_ENV) || null } };
}
export function storageConfigured(): boolean {
  return storageMode() !== null;
}

export function storageHealth(): { backend: "gcs" | "drive" | "local"; configured: boolean; mode: "gcs" | "sa" | "oauth" | null; reason: string; hint: string } {
  const mode = storageMode();
  const diag = envDiagnostic();
  if (mode === "gcs") { const g = gcsConfig()!; return { backend: "gcs", configured: true, mode, reason: cachedErr ? `Storage error: ${cachedErr}` : `Google Cloud Storage connected (${g.kind === "wif" ? "Workload Identity Federation" : "service-account key"}) — bucket ${g.bucket} — uploads survive deploys`, hint: diag.hint }; }
  if (mode) return { backend: "drive", configured: true, mode, reason: cachedErr ? `Drive error: ${cachedErr}` : `Google Drive connected via ${mode === "sa" ? "service account" : "OAuth user"} (root folder ${rootFolderId()}) — uploads survive deploys`, hint: diag.hint };
  const off = storageDisabled();
  return {
    backend: "local",
    configured: false,
    mode: null,
    reason: off.on
      ? `Evidence storage NOT connected — forced off by ${off.name} (CI/test switch); uploads go to the server's own disk and are LOST on every deploy. Set GCS_BUCKET + WIF (or GCS_SA_JSON) for Google Cloud Storage, the decided backend.`
      : "Evidence storage NOT connected — uploads are written to the server's own disk and are LOST on every deploy. Set GCS_BUCKET + GCS_SA_JSON (Google Cloud Storage, the decided backend) — or, interim, GDRIVE_SA_JSON / GDRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN.",
    hint: diag.hint,
  };
}

// ---------- -93: AWS credentials for the WIF exchange, WITHOUT the AWS SDK (a 40-line resolver
// mirrors the SDK's default chain: env keys → ECS/Fargate task-role endpoint (169.254.170.2 via
// AWS_CONTAINER_CREDENTIALS_RELATIVE_URI / FULL_URI) → EC2 IMDSv2). Cached until expiry. The
// SDK was tried first and Turbopack could not bundle its IMDS provider into the edge
// instrumentation graph; this is smaller and does exactly what the container needs. ----------
type AwsCreds = { accessKeyId: string; secretAccessKey: string; token?: string };
let awsCache: { creds: AwsCreds; expiresAt: number } | null = null;
async function awsCredentials(): Promise<AwsCreds> {
  if (awsCache && awsCache.expiresAt - Date.now() > 60_000) return awsCache.creds;
  const envId = parseEnvValue(process.env.AWS_ACCESS_KEY_ID), envSecret = parseEnvValue(process.env.AWS_SECRET_ACCESS_KEY);
  if (envId && envSecret) {
    const creds = { accessKeyId: envId, secretAccessKey: envSecret, token: parseEnvValue(process.env.AWS_SESSION_TOKEN) || undefined };
    awsCache = { creds, expiresAt: Date.now() + 3600_000 };
    return creds;
  }
  const rel = parseEnvValue(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI), full = parseEnvValue(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  if (rel || full) {
    const url = full || `http://169.254.170.2${rel}`;
    const headers: Record<string, string> = {};
    const tok = parseEnvValue(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN);
    if (tok) headers["Authorization"] = tok;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`ECS credential endpoint answered ${r.status}`);
    const j: any = await r.json();
    const creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, token: j.Token };
    awsCache = { creds, expiresAt: j.Expiration ? new Date(j.Expiration).getTime() : Date.now() + 15 * 60_000 };
    return creds;
  }
  // EC2 launch type without a task role: instance metadata (IMDSv2)
  try {
    const t = await fetch("http://169.254.169.254/latest/api/token", { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" }, signal: AbortSignal.timeout(2000) });
    const token = t.ok ? await t.text() : "";
    const h: Record<string, string> = token ? { "X-aws-ec2-metadata-token": token } : {};
    const roleRes = await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", { headers: h, signal: AbortSignal.timeout(2000) });
    if (!roleRes.ok) throw new Error(`IMDS role list ${roleRes.status}`);
    const role = (await roleRes.text()).split(String.fromCharCode(10))[0].trim();
    const cr = await fetch(`http://169.254.169.254/latest/meta-data/iam/security-credentials/${role}`, { headers: h, signal: AbortSignal.timeout(2000) });
    const j: any = await cr.json();
    const creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, token: j.Token };
    awsCache = { creds, expiresAt: j.Expiration ? new Date(j.Expiration).getTime() : Date.now() + 15 * 60_000 };
    return creds;
  } catch (e: any) {
    throw new Error(`No AWS credentials in this container (no env keys, no ECS task-role endpoint, IMDS unreachable: ${String(e?.message ?? e).slice(0, 60)})`);
  }
}

// -93: "who is this container on AWS?" — the exact principal ARN the WIF pool binding needs. Signed
// GetCallerIdentity with the same credentials the exchange uses; cached; names only, no keys.
let awsIdentityCache: { at: number; arn: string | null; error?: string } | null = null;
export async function awsIdentity(): Promise<{ arn: string | null; account?: string | null; error?: string }> {
  if (awsIdentityCache && Date.now() - awsIdentityCache.at < 10 * 60_000) return { arn: awsIdentityCache.arn, error: awsIdentityCache.error };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AwsRequestSigner } = require("google-auth-library");
    const region = parseEnvValue(process.env.AWS_REGION) || parseEnvValue(process.env.AWS_DEFAULT_REGION) || "ap-south-1";
    const signer = new AwsRequestSigner(async () => awsCredentials(), region);
    const url = `https://sts.${region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15`;
    const opts = await signer.getRequestOptions({ url, method: "POST" });
    const r = await fetch(url, { method: "POST", headers: opts.headers as any, signal: AbortSignal.timeout(5000) });
    const txt = await r.text();
    const arn = /<Arn>([^<]+)<\/Arn>/.exec(txt)?.[1] ?? null;
    const account = /<Account>([^<]+)<\/Account>/.exec(txt)?.[1] ?? null;
    awsIdentityCache = { at: Date.now(), arn, error: arn ? undefined : `STS ${r.status}: ${txt.slice(0, 120)}` };
    return { arn, account, error: awsIdentityCache.error };
  } catch (e: any) {
    awsIdentityCache = { at: Date.now(), arn: null, error: String(e?.message ?? e).slice(0, 160) };
    return { arn: null, error: awsIdentityCache.error };
  }
}

// ---------- -92 GCS client (lazy; the SDK is only touched when the mode is gcs) ----------
let cachedGcs: any = null;
let cachedGcsAuth: any = null; // -95: the auth client itself, so the probe can prove the token step alone
function gcs(): { bucket: any; name: string } {
  const cfg = gcsConfig()!;
  if (!cachedGcs) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Storage } = require("@google-cloud/storage");
    if (cfg.kind === "sa") {
      const raw = cfg.raw!.trim().startsWith("{") ? cfg.raw! : Buffer.from(cfg.raw!, "base64").toString("utf8");
      const credentials = JSON.parse(raw);
      cachedGcs = new Storage({ credentials, projectId: credentials.project_id });
      cachedGcsAuth = null;
    } else {
      // -93 WIF. The file's own credential_source points at EC2 IMDS (169.254.169.254); on ECS the
      // task role lives at 169.254.170.2 (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) and Fargate has no
      // IMDS at all — so AWS credentials come from the AWS SDK's default provider chain (ECS task
      // role, EC2 instance role, env, profile — all handled), and the WIF json supplies only the
      // audience + impersonation target. No secret anywhere in the container.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AwsClient } = require("google-auth-library");
      const region = parseEnvValue(process.env.AWS_REGION) || parseEnvValue(process.env.AWS_DEFAULT_REGION) || "ap-south-1";
      const supplier = {
        getAwsRegion: async () => region,
        getAwsSecurityCredentials: async () => awsCredentials(),
      };
      const { credential_source: _drop, ...rest } = cfg.wif;
      void _drop;
      // AwsClient directly (fromJSON dispatches on credential_source.environment_id, which we
      // deliberately drop — our supplier replaces it).
      const authClient = new AwsClient({ ...rest, aws_security_credentials_supplier: supplier });
      // -96: full_control, not read_write — the prod ladder stopped at "cors" with "Provided
      // scope(s) are not authorized": bucket-metadata PATCH (setCorsConfiguration) needs it.
      // Same scopes the Storage SDK asks for by default; IAM (bucket-level Storage Admin) was fine.
      authClient.scopes = ["https://www.googleapis.com/auth/devstorage.full_control", "https://www.googleapis.com/auth/cloud-platform"];
      cachedGcsAuth = authClient;
      cachedGcs = new Storage({ authClient, projectId: gcpProjectId() ?? undefined });
    }
  }
  return { bucket: cachedGcs.bucket(cfg.bucket), name: cfg.bucket };
}

// ---------- -95: the probe ladder (checker, 16/08: "har test ek hi cheez tode") ----------
// Rung 1 — token: AWS→GCP federation + impersonation, nothing else. Length only, never the token.
export async function gcsAccessToken(): Promise<{ token_length: number; expires_at: string | null }> {
  gcs(); // builds the client
  const auth = cachedGcsAuth ?? cachedGcs.authClient;
  const r = await auth.getAccessToken();
  const token = typeof r === "string" ? r : r?.token;
  if (!token) throw new Error("no access token returned");
  const exp = cachedGcsAuth?.credentials?.expiry_date ? new Date(cachedGcsAuth.credentials.expiry_date).toISOString() : null;
  return { token_length: String(token).length, expires_at: exp };
}
// Rung 2 — bucket: metadata (proves bucket IAM + name), and the immutable facts the checker asked
// to confirm — location, uniform bucket-level access, public access prevention — plus CORS state.
export type BucketReport = { name: string; location: string | null; location_type: string | null; storage_class: string | null; ubla: boolean | null; pap: string | null; cors_origins: string[]; cors_ok: boolean; expected: { location: string; ubla: boolean; pap: string }; warnings: string[]; checked_at: string };
let lastBucketReport: BucketReport | null = null;
export function lastBucketReportCached(): BucketReport | null { return lastBucketReport; }
export async function gcsBucketReport(): Promise<BucketReport> {
  const { bucket, name } = gcs();
  const [m] = await bucket.getMetadata();
  const location = m.location ? String(m.location) : null;
  const ubla = m.iamConfiguration?.uniformBucketLevelAccess?.enabled ?? null;
  const pap = m.iamConfiguration?.publicAccessPrevention ? String(m.iamConfiguration.publicAccessPrevention) : null;
  const corsOrigins: string[] = Array.from(new Set(((m.cors ?? []) as any[]).flatMap((c) => (c.origin ?? []) as string[])));
  const want = gcsCorsRule();
  const corsOk = ((m.cors ?? []) as any[]).some((c) => (c.origin ?? []).includes(appOrigin()) && ["PUT", "POST"].every((x) => (c.method ?? []).includes(x)) && ["Location", "Range", "Content-Range"].every((h) => (c.responseHeader ?? []).map((s: string) => s.toLowerCase()).includes(h.toLowerCase())));
  const expected = { location: "ASIA-SOUTH1", ubla: true, pap: "enforced" };
  const warnings: string[] = [];
  if (location && location.toUpperCase() !== expected.location) warnings.push(`location is ${location} — expected ${expected.location} (Mumbai). Location is immutable: a wrong region needs a new bucket while this one is still empty.`);
  if (ubla !== true) warnings.push("uniform bucket-level access is OFF — expected ON.");
  if ((pap ?? "").toLowerCase() !== "enforced") warnings.push(`public access prevention is ${pap ?? "unset"} — expected enforced.`);
  if (!corsOk) warnings.push(`CORS does not yet allow ${appOrigin()} (${want.method.join("/")}, exposing Location/Range/Content-Range) — the probe applies it.`);
  lastBucketReport = { name, location, location_type: m.locationType ? String(m.locationType) : null, storage_class: m.storageClass ? String(m.storageClass) : null, ubla, pap, cors_origins: corsOrigins, cors_ok: corsOk, expected, warnings, checked_at: new Date().toISOString() };
  return lastBucketReport;
}
// CORS self-apply (idempotent). Bucket-level Storage Admin covers storage.buckets.update; if it is
// refused, the answer carries the exact gcloud line + JSON so nothing is silent.
export async function ensureBucketCors(): Promise<{ state: "present" | "applied" | "failed"; origins: string[]; error?: string; gcloud?: string }> {
  const rule = gcsCorsRule();
  const gcloud = `gcloud storage buckets update gs://${gcsConfig()?.bucket ?? DEFAULT_GCS_BUCKET} --cors-file=cors.json   # cors.json = ${JSON.stringify([rule])}`;
  try {
    const rep = lastBucketReport ?? await gcsBucketReport();
    if (rep.cors_ok) return { state: "present", origins: rep.cors_origins };
    const { bucket } = gcs();
    await bucket.setCorsConfiguration([rule]);
    lastBucketReport = null; // re-read next time
    return { state: "applied", origins: rule.origin };
  } catch (e: any) {
    return { state: "failed", origins: rule.origin, error: String(e?.message ?? e).slice(0, 200), gcloud };
  }
}
let corsOnce: Promise<unknown> | null = null;
function ensureCorsOnce(): void {
  if (!corsOnce) corsOnce = ensureBucketCors().catch(() => null);
}
// Rung 5 — the server itself PUTs bytes to a session URI (the curl-equivalent: no CORS involved),
// so a browser failure right after this can only be CORS.
export async function putToSession(sessionUri: string, buf: Buffer, mime = "application/octet-stream"): Promise<{ status: number; ok: boolean; body: string }> {
  const r = await fetch(sessionUri, { method: "PUT", headers: { "Content-Type": mime, "Content-Length": String(buf.length), "Content-Range": `bytes 0-${buf.length - 1}/${buf.length}` }, body: new Uint8Array(buf), signal: AbortSignal.timeout(20_000) });
  const body = await r.text().catch(() => "");
  return { status: r.status, ok: r.ok, body: body.slice(0, 200) };
}
// GCS has no folders — the "tree" <Centre>/<Batch>/<kind>/<name> is the object key (QA-155).
export function gcsKey(folderSegments: string[], name: string): string {
  const segs = folderSegments.map((s) => String(s).trim().replace(/[\\/]+/g, "-")).filter(Boolean);
  return [...segs, name].join("/");
}

function drive(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const mode = storageMode();
  if (mode === "sa") {
    const sa = saJson()!;
    // base64 OR raw JSON (a console field may hold the JSON itself)
    const raw = sa.raw.trim().startsWith("{") ? sa.raw : Buffer.from(sa.raw, "base64").toString("utf8");
    const creds = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
    cachedAuth = auth;
    cachedDrive = google.drive({ version: "v3", auth });
  } else {
    const t = oauthTriple()!;
    const auth = new google.auth.OAuth2(t.id, t.secret);
    auth.setCredentials({ refresh_token: t.refresh });
    cachedAuth = auth;
    cachedDrive = google.drive({ version: "v3", auth });
  }
  return cachedDrive;
}
async function accessToken(): Promise<string> {
  drive(); // ensures cachedAuth
  const a = cachedAuth;
  if (typeof a.getAccessToken === "function") {
    const r = await a.getAccessToken();
    const tok = typeof r === "string" ? r : r?.token;
    if (tok) return tok;
  }
  if (typeof a.getClient === "function") {
    const c = await a.getClient();
    const r = await c.getAccessToken();
    const tok = typeof r === "string" ? r : r?.token;
    if (tok) return tok;
  }
  throw new Error("Could not obtain a Google access token");
}

// ---------- -90 (checker's DESIGN-video-upload.md, Umesh's "how the video upload really works"):
// the server AUTHORISES and RECORDS; the bytes go browser → Drive. A resumable session URI is
// minted here with the app's identity (the browser never sees keys), scoped to the intended
// folder; the browser PUTs chunks straight to Google; the server confirms with Drive and marks
// the row ready. Nothing large passes through the container — no RAM spike, no OOM, resume on
// a dropped 4G, a real progress bar.
export async function createResumableSession(opts: { name: string; mime: string; size: number; folderSegments: string[]; origin?: string | null }): Promise<{ session_uri: string; folder_id: string; folder_path: string; backend: "gcs" | "drive" }> {
  if (storageMode() === "gcs") {
    // GCS resumable upload session, opened by the server with the SA, PUT by the browser (same
    // 308/Range protocol the -90 client already speaks); the object key is the folder tree.
    const key = gcsKey(opts.folderSegments, opts.name);
    ensureCorsOnce(); // -95: the browser is about to PUT cross-origin — make sure the bucket allows it (once per process, best-effort)
    const [uri] = await gcs().bucket.file(key).createResumableUpload({ origin: opts.origin ?? undefined, metadata: { contentType: opts.mime || "application/octet-stream", cacheControl: "private, max-age=86400" } });
    cachedErr = null;
    return { session_uri: uri, folder_id: key, folder_path: opts.folderSegments.map((s) => String(s).trim()).filter(Boolean).join("/"), backend: "gcs" };
  }
  const folder = await ensureFolder(opts.folderSegments);
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": opts.mime || "application/octet-stream",
    "X-Upload-Content-Length": String(opts.size),
  };
  if (opts.origin) headers["Origin"] = opts.origin; // lets the browser PUT to the session (CORS on Google's side)
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
    method: "POST", headers, body: JSON.stringify({ name: opts.name, parents: [folder.id] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    cachedErr = `resumable session ${res.status}: ${txt.slice(0, 200)}`;
    throw new Error(`Drive refused to open an upload session (${res.status}). ${txt.slice(0, 160)}`);
  }
  const loc = res.headers.get("location");
  if (!loc) throw new Error("Drive did not return a session URI");
  cachedErr = null;
  return { session_uri: loc, folder_id: folder.id, folder_path: folder.path, backend: "drive" };
}
// -92: confirm a GCS object after the browser's resumable PUTs — size from metadata.
export async function finalizeGcsObject(key: string): Promise<{ key: string; size: number; md5?: string | null }> {
  const [m] = await gcs().bucket.file(key).getMetadata();
  return { key, size: Number(m.size ?? 0), md5: (m.md5Hash as string) ?? null };
}
export async function deleteGcsObject(key: string): Promise<void> {
  try { await gcs().bucket.file(key).delete({ ignoreNotFound: true }); } catch { /* best-effort */ }
}
export async function finalizeDriveFile(fileId: string): Promise<{ id: string; size: number; md5?: string | null; parents: string[]; name?: string | null }> {
  const r = await drive().files.get({ fileId, fields: "id,size,md5Checksum,parents,name", supportsAllDrives: true });
  return { id: String(r.data.id), size: Number(r.data.size ?? 0), md5: r.data.md5Checksum ?? null, parents: (r.data.parents ?? []) as string[], name: r.data.name ?? null };
}
export async function deleteDriveFile(fileId: string): Promise<void> {
  try { await drive().files.delete({ fileId, supportsAllDrives: true }); } catch { /* best-effort — an abandoned pending row is swept anyway */ }
}
export function rssMb(): number { return Math.round(process.memoryUsage().rss / 1048576); }

// Folder-wise, auto-created, id-cached: <root>/<seg1>/<seg2>/... Names are used as given
// (centre code, batch code, kind) — human-readable in Drive for anyone who does look.
async function ensureFolder(segments: string[]): Promise<{ id: string; path: string }> {
  const d = drive();
  let parent = rootFolderId();
  const walked: string[] = [];
  for (const seg of segments.map((s) => String(s).trim()).filter(Boolean)) {
    walked.push(seg);
    const key = `${parent}/${seg}`;
    let id = folderCache.get(key);
    if (!id) {
      const q = `'${parent}' in parents and name = '${seg.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const found = await d.files.list({ q, fields: "files(id)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
      id = found.data.files?.[0]?.id ?? undefined;
      if (!id) {
        const made = await d.files.create({ requestBody: { name: seg, mimeType: "application/vnd.google-apps.folder", parents: [parent] }, fields: "id", supportsAllDrives: true });
        id = String(made.data.id);
      }
      folderCache.set(key, id);
    }
    parent = id;
  }
  return { id: parent, path: walked.join("/") };
}

export type PutResult = {
  backend: "gcs" | "drive" | "local"; drive_file_id?: string; folder_path?: string;
  // -87 (QA-157): what the ONE door did to the bytes — recorded on every StoredFile row.
  name: string; mime: string; original_size: number; size: number; compressed: boolean; compression: string; compression_ms: number; needs_compression: boolean;
};

// ---------- -87 (QA-157, Umesh 15/08 22:55: "jo kuch bhi media jaye — photo, certificate PDF, sab
// compress hone chahiye"). Compression lives HERE, at the one door every write passes, so no
// screen can bypass it again (the closure upload did). Client-side compression stays for the
// trainer's 4G data; the server is what makes the rule true. Tools are optional at runtime —
// missing → store as-is and RECORD why, never silently.
// The one allowlist every upload door uses (multipart route + direct-to-Drive intent).
export const ALLOWED_UPLOAD_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf", ".mp4", ".mov", ".3gp", ".webm", ".mp3", ".m4a", ".wav", ".amr", ".xlsx", ".xls", ".csv", ".doc", ".docx"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".3gp", ".webm"]);
let gsPath: string | null | undefined; // undefined = not probed yet
function findGs(): string | null {
  if (gsPath !== undefined) return gsPath;
  const cands = [process.env.GS_PATH, "/usr/bin/gs", "/usr/local/bin/gs", "gs"].filter(Boolean) as string[];
  gsPath = null;
  for (const c of cands) {
    if (c === "gs") { gsPath = "gs"; break; } // resolved via PATH by execFile; verified by the first run
    if (existsSync(c)) { gsPath = c; break; }
  }
  return gsPath;
}
let gsVerified: boolean | null = null;
async function gsAvailable(): Promise<boolean> {
  if (gsVerified !== null) return gsVerified;
  const g = findGs();
  if (!g) return (gsVerified = false);
  try { await execFileP(g, ["--version"], { timeout: 5000 }); gsVerified = true; } catch { gsVerified = false; }
  return gsVerified;
}
let sharpMod: any | null | undefined;
function loadSharp(): any | null {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = require("sharp"); } catch { sharpMod = null; }
  return sharpMod;
}
export async function compressionTools(): Promise<{ sharp: boolean; gs: boolean }> {
  return { sharp: !!loadSharp(), gs: await gsAvailable() };
}

export type Compressed = { buf: Buffer; name: string; mime: string; compressed: boolean; compression: string; ms: number; needs_compression: boolean };
export async function compressForStorage(name: string, buf: Buffer, mime: string): Promise<Compressed> {
  const t0 = Date.now();
  const ext = path.extname(name).toLowerCase();
  const done = (out: Buffer, n: string, m: string, label: string, needs = false): Compressed =>
    ({ buf: out, name: n, mime: m, compressed: out !== buf, compression: label, ms: Date.now() - t0, needs_compression: needs });
  let knobs: any = {};
  try { knobs = await getDefaults(); } catch { /* defaults unreachable → built-in numbers */ }
  const maxPx = Number(knobs.image_max_px ?? 1600) || 1600;
  const quality = Math.min(95, Math.max(30, Number(knobs.image_quality ?? 75) || 75));
  const pdfOn = knobs.pdf_compress !== false;

  if (IMAGE_EXT.has(ext)) {
    const sharp = loadSharp();
    if (!sharp) return done(buf, name, mime, "none:sharp unavailable");
    try {
      const img = sharp(buf, { failOn: "none" }).rotate(); // EXIF orientation baked in
      const meta = await img.metadata();
      const w = meta.width ?? 0, h = meta.height ?? 0;
      const within = Math.max(w, h) <= maxPx;
      const isHeic = ext === ".heic" || ext === ".heif";
      if (within && buf.length < 300 * 1024 && !isHeic) return done(buf, name, mime, "none:already small");
      let pipe = img.resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true });
      let outName = name, outMime = mime, label = `image-${maxPx}-q${quality}`;
      if (ext === ".png" && meta.hasAlpha) { pipe = pipe.png({ compressionLevel: 9, palette: true }); label = `image-${maxPx}-png`; }
      else if (ext === ".png") { pipe = pipe.jpeg({ quality, mozjpeg: true }); outName = name.replace(/\.png$/i, ".jpg"); outMime = "image/jpeg"; }
      else if (ext === ".webp") { pipe = pipe.webp({ quality }); label = `image-${maxPx}-webp-q${quality}`; }
      else { pipe = pipe.jpeg({ quality, mozjpeg: true }); if (isHeic) { outName = name.replace(/\.hei[cf]$/i, ".jpg"); outMime = "image/jpeg"; label = `image-heic-${maxPx}-q${quality}`; } }
      const out = await pipe.toBuffer();
      if (out.length >= buf.length && outName === name) return done(buf, name, mime, "none:original smaller");
      return done(out, outName, outMime, label);
    } catch (e: any) {
      const why = /heif|heic|unsupported image format/i.test(String(e?.message)) ? "heic undecodable" : `image error: ${String(e?.message ?? e).slice(0, 60)}`;
      return done(buf, name, mime, `none:${why}`);
    }
  }
  if (ext === ".pdf") {
    if (!pdfOn) return done(buf, name, mime, "none:pdf compression off");
    if (buf.length > 200 * 1024 * 1024) return done(buf, name, mime, "none:too large for pdf pass");
    if (!(await gsAvailable())) return done(buf, name, mime, "none:gs unavailable");
    const tmpIn = path.join(os.tmpdir(), `erp-${crypto.randomBytes(8).toString("hex")}-in.pdf`);
    const tmpOut = tmpIn.replace(/-in\.pdf$/, "-out.pdf");
    try {
      await writeFile(tmpIn, buf);
      await execFileP(findGs()!, ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER", `-sOutputFile=${tmpOut}`, tmpIn], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const out = await readFile(tmpOut);
      if (!out.length || out.length >= buf.length) return done(buf, name, mime, "none:original smaller");
      return done(out, name, mime, "pdf-gs-ebook");
    } catch (e: any) {
      return done(buf, name, mime, `none:gs error: ${String(e?.message ?? e).slice(0, 60)}`);
    } finally {
      await unlink(tmpIn).catch(() => {}); await unlink(tmpOut).catch(() => {});
    }
  }
  if (VIDEO_EXT.has(ext)) return done(buf, name, mime, "none:video (compress-first client, -89)", buf.length > 20 * 1024 * 1024);
  return done(buf, name, mime, "none:not compressible here");
}

// Write bytes under the given folder segments. Drive when configured, else local disk.
// -87: the bytes are compressed FIRST (images via sharp, PDFs via Ghostscript) — the returned
// name/mime may differ from the request (PNG→JPEG, HEIC→JPEG); callers store what came back.
export async function putFile(nameIn: string, bufIn: Buffer, mimeIn: string, folderSegments: string[]): Promise<PutResult> {
  const c = await compressForStorage(nameIn, bufIn, mimeIn);
  const name = c.name, buf = c.buf, mime = c.mime;
  const meta = { name, mime, original_size: bufIn.length, size: buf.length, compressed: c.compressed, compression: c.compression, compression_ms: c.ms, needs_compression: c.needs_compression };
  if (storageMode() === "gcs") {
    try {
      const key = gcsKey(folderSegments, name);
      await gcs().bucket.file(key).save(buf, { contentType: mime || "application/octet-stream", resumable: false, metadata: { cacheControl: "private, max-age=86400" } });
      cachedErr = null;
      return { backend: "gcs", drive_file_id: key, folder_path: folderSegments.map((s) => String(s).trim()).filter(Boolean).join("/") || undefined, ...meta };
    } catch (e: any) {
      cachedErr = e?.message ?? String(e);
      throw e;
    }
  }
  if (storageConfigured()) {
    try {
      const folder = await ensureFolder(folderSegments);
      const res = await drive().files.create({
        requestBody: { name, parents: [folder.id] },
        media: { mimeType: mime || "application/octet-stream", body: Readable.from(buf) },
        fields: "id",
        supportsAllDrives: true,
      });
      cachedErr = null;
      return { backend: "drive", drive_file_id: String(res.data.id), folder_path: folder.path, ...meta };
    } catch (e: any) {
      cachedErr = e?.message ?? String(e);
      throw e; // configured-but-failing must be a visible error, not a silent local write
    }
  }
  const dir = path.join(process.cwd(), "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);
  // -83: even the (deploy-wiped) local write records WHERE the file belongs, so the row
  // already answers "which batch / which folder" and a later move to Drive needs no guess.
  return { backend: "local", folder_path: folderSegments.map((s) => String(s).trim()).filter(Boolean).join("/") || undefined, ...meta };
}

// -83 (honest file reads): STREAM bytes back, with an optional byte range, instead of
// loading the whole file into the heap. Video seeking (206) and iOS playback need Range;
// a 200 MB clip must not be a 200 MB allocation per request. Drive answers Range on
// alt=media; local disk uses createReadStream(start, end). Returns the total size and the
// resolved range so the route can write Content-Range/Content-Length itself.
export type FileStream = { stream: NodeJS.ReadableStream; size: number; start: number; end: number; partial: boolean };
export async function getFileStream(
  rec: { backend: string; drive_file_id?: string | null; size?: number | null } | null,
  name: string,
  range?: { start: number; end?: number } | { suffix: number } | null,
): Promise<FileStream> {
  const resolve = (size: number) => {
    if (!range) return { start: 0, end: size - 1, partial: false };
    if ("suffix" in range) return { start: Math.max(0, size - range.suffix), end: size - 1, partial: true };
    return { start: Math.max(0, range.start), end: Math.min(range.end ?? size - 1, size - 1), partial: true };
  };
  if (rec?.backend === "gcs" && rec.drive_file_id && storageMode() === "gcs") {
    const file = gcs().bucket.file(rec.drive_file_id);
    let size = Number(rec.size ?? 0);
    if (!size) { const [m] = await file.getMetadata(); size = Number(m.size ?? 0); }
    const { start, end, partial } = resolve(size);
    if (partial && (start >= size || start > end)) throw Object.assign(new Error("Range not satisfiable"), { code: 416, size });
    return { stream: file.createReadStream({ start, end }) as unknown as NodeJS.ReadableStream, size, start, end, partial };
  }
  if (rec?.backend === "drive" && rec.drive_file_id && storageConfigured()) {
    let size = Number(rec.size ?? 0);
    if (!size) {
      const meta = await drive().files.get({ fileId: rec.drive_file_id, fields: "size", supportsAllDrives: true });
      size = Number(meta.data.size ?? 0);
    }
    const { start, end, partial } = resolve(size);
    if (partial && (start >= size || start > end)) throw Object.assign(new Error("Range not satisfiable"), { code: 416, size });
    const res = await drive().files.get(
      { fileId: rec.drive_file_id, alt: "media", supportsAllDrives: true },
      { responseType: "stream", headers: partial ? { Range: `bytes=${start}-${end}` } : {} },
    );
    return { stream: res.data as unknown as NodeJS.ReadableStream, size, start, end, partial };
  }
  const fp = path.join(process.cwd(), "uploads", name);
  const st = await stat(fp); // throws ENOENT → the route says 404
  const size = st.size;
  const { start, end, partial } = resolve(size);
  if (partial && (start >= size || start > end)) throw Object.assign(new Error("Range not satisfiable"), { code: 416, size });
  return { stream: createReadStream(fp, { start, end }), size, start, end, partial };
}

// Read bytes back. Drive by file id when the record says so, else local disk.
export async function getFile(rec: { backend: string; drive_file_id?: string | null } | null, name: string): Promise<Buffer> {
  if (rec?.backend === "gcs" && rec.drive_file_id && storageMode() === "gcs") {
    const [buf] = await gcs().bucket.file(rec.drive_file_id).download();
    return buf as Buffer;
  }
  if (rec?.backend === "drive" && rec.drive_file_id && storageConfigured()) {
    const res = await drive().files.get({ fileId: rec.drive_file_id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }
  return readFile(path.join(process.cwd(), "uploads", name));
}

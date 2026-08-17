import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { awsIdentity, compressionTools, createResumableSession, deleteGcsObject, ensureBucketCors, envDiagnostic, getFile, gcsAccessToken, gcsBucketReport, gcsWifPresent, lastBucketReportCached, putFile, putToSession, rssMb, storageHealth } from "@/lib/storage";

// QA-145 rider (Umesh, 15/08: "Drive wala code local me test karke dekha ki information ja
// rahi hai ya bas push kar diya?") — the honest answer was: the Drive branch could not be
// exercised without a service-account key. This is the mail panel's "send test mail to me"
// for storage: ONE click writes a tiny probe under <root>/_healthcheck/, reads it straight
// back through the same getFile() the file proxy uses, and reports exactly what happened —
// backend, Drive file id, folder path, round-trip match. Admin-only; nothing else is written.
export const GET = apiHandler(async () => {
  await requireUser().then((u) => requireRole(u, "Admin"));
  // -87 (QA-157): the tools behind the compression door + what it has done so far.
  const tools = await compressionTools();
  const { StoredFile } = await import("@/models");
  const agg = await StoredFile.aggregate([{ $group: { _id: null, files: { $sum: 1 }, stored: { $sum: "$size" }, original: { $sum: { $ifNull: ["$original_size", "$size"] } }, compressed: { $sum: { $cond: ["$compressed", 1, 0] } } } }]);
  const recent = await StoredFile.find({}).sort({ createdAt: -1 }).limit(20).select("original_name mime original_size size compressed compression createdAt").lean();
  // -89: names only (never values) — which Drive env names reached THIS container, with SES/Mongo as the control.
  // -90: rss_mb makes "the container's memory does not move with file size" measurable.
  // -93: with a WIF identity baked in, say WHO this container is on AWS (the ARN the pool binding needs).
  const identity = gcsWifPresent().present ? await awsIdentity() : null;
  return NextResponse.json({ storage: storageHealth(), env: envDiagnostic(), aws_identity: identity, bucket: lastBucketReportCached(), rss_mb: rssMb(), tools, compression: { totals: agg[0] ?? { files: 0, stored: 0, original: 0, compressed: 0 }, recent } });
});

// -93: when the probe fails on GCS/WIF the message says WHICH side to fix — STS (AWS role not
// trusted by the pool), impersonation (workloadIdentityUser missing), or bucket IAM (objectAdmin).
function classifyStorageError(msg: string): string {
  if (/sts:GetCallerIdentity|invalid_target|Unable to acquire impersonated credentials|Error code invalid_grant/i.test(msg)) return "AWS→Google exchange failed: the ECS task role is not trusted by the Workload Identity pool provider (attribute condition / provider config).";
  if (/generateAccessToken|impersonat|iam.serviceAccounts.getAccessToken|PERMISSION_DENIED.*serviceAccounts/i.test(msg)) return "Impersonation refused: grant roles/iam.workloadIdentityUser on the service account to the pool principal (principalSet://…/attribute.aws_role/…).";
  if (/storage\.objects\.(create|get|delete)|does not have storage\./i.test(msg)) return "Bucket IAM: grant roles/storage.objectAdmin on the bucket to the service account.";
  if (/bucket.*(not found|does not exist)|404/i.test(msg)) return "Bucket not found: check GCS_BUCKET / DEFAULT_GCS_BUCKET spelling and that the bucket exists.";
  if (/Could not load credentials|CredentialsProviderError|Unable to locate credentials|no AWS credentials/i.test(msg)) return "No AWS credentials in the container: the task has no IAM role (or the SDK cannot reach the ECS credential endpoint).";
  return "";
}

export const POST = apiHandler(async (_req: NextRequest) => {
  const user = await requireUser();
  requireRole(user, "Admin");
  const health = storageHealth();
  if (!health.configured) {
    throw new HttpError(400, `Evidence storage is not connected — the probe would only touch the server's own disk, which is the very thing that is lost on deploy. ${health.hint}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `healthcheck-${stamp}.txt`;
  const payload = Buffer.from(`Center ERP storage probe ${stamp} by ${user.email}`);
  const started = Date.now();
  // -95: a LADDER — each rung proves one thing, stops at the first failure and names the fix,
  // so a red result says what broke instead of inviting a guess (checker, 16/08).
  const steps: { step: string; ok: boolean; ms: number; detail: any }[] = [];
  const run = async (step: string, fn: () => Promise<any>) => {
    const t = Date.now();
    try { const detail = await fn(); steps.push({ step, ok: true, ms: Date.now() - t, detail }); return detail; }
    catch (e: any) { steps.push({ step, ok: false, ms: Date.now() - t, detail: String(e?.message ?? e).slice(0, 300) }); throw e; }
  };
  const fail = (e: any) => {
    const msg = String(e?.message ?? e);
    const why = classifyStorageError(msg);
    const failed = steps.find((x) => !x.ok)?.step ?? null;
    return NextResponse.json({ ok: false, backend: health.backend, ms: Date.now() - started, failed_step: failed, steps, bucket: lastBucketReportCached(), error: msg.slice(0, 300), note: why || `Storage refused the probe at step "${failed}" — see error.`, fix: why || null }, { status: 502 });
  };
  let put: any, back: Buffer, bucketReport: any = null, cors: any = null, session: any = null, sessionPut: any = null;
  let probeCleanup: { removed: boolean; error?: string } | null = null;
  try {
    if (health.backend === "gcs") {
      // 1 — token: federation + impersonation only
      await run("token", () => gcsAccessToken());
      // 2 — bucket: metadata (name + bucket IAM) + the immutable facts + CORS (self-applied)
      bucketReport = await run("bucket", () => gcsBucketReport());
      // -96: CORS is non-fatal for the ladder — the remaining rungs still report (a CORS miss
      // blocks the BROWSER, not the server), but the final verdict is red until it is in place.
      cors = await run("cors", async () => { const c = await ensureBucketCors(); if (c.state === "failed") throw new Error(`CORS could not be applied: ${c.error} — run: ${c.gcloud}`); return c; }).catch((e: any) => ({ state: "failed", error: String(e?.message ?? e).slice(0, 300) }));
    }
    // 3 — write + read-back through the same doors the app uses
    put = await run("write", () => putFile(name, payload, "text/plain", ["_healthcheck"]));
    back = await run("read", () => getFile({ backend: put.backend, drive_file_id: put.drive_file_id }, name));
    // -101: the probe used to LEAVE this object behind — every health check added another
    // `_healthcheck/healthcheck-<ISO>.txt` that no StoredFile row described and no app path could
    // remove, so the only cleanup was the console. The session rung below already deletes after
    // itself; the write rung now does the same. Non-fatal: the roundtrip has already been proved
    // by this point, so a failed tidy-up is reported, not thrown.
    if (put.backend === "gcs" && put.drive_file_id) {
      probeCleanup = await deleteGcsObject(String(put.drive_file_id)).then(() => ({ removed: true }))
        .catch((e: any) => ({ removed: false, error: String(e?.message ?? e).slice(0, 200) }));
    }
    if (health.backend === "gcs") {
      // 4 — a resumable session (what /api/upload/intent mints for the browser)
      session = await run("session", async () => { const sres = await createResumableSession({ name: `session-${name}`, mime: "text/plain", size: payload.length, folderSegments: ["_healthcheck"], origin: null }); return { host: new URL(sres.session_uri).host, key: sres.folder_id, uri: sres.session_uri }; });
      // 5 — the server PUTs to it (curl-equivalent, no CORS) — a browser failure after this is CORS only
      sessionPut = await run("session-put", async () => { const r = await putToSession(session.uri, payload, "text/plain"); if (!r.ok) throw new Error(`session PUT ${r.status}: ${r.body}`); await deleteGcsObject(session.key); return { status: r.status }; });
      delete session.uri;
    }
  } catch (e: any) {
    return fail(e);
  }
  const roundtrip = back!.equals(payload);
  const corsFailed = cors?.state === "failed";
  return NextResponse.json({
    ok: roundtrip && !corsFailed,
    probe_cleanup: probeCleanup,
    backend: put.backend,
    drive_file_id: put.drive_file_id ?? null,
    folder_path: put.folder_path ?? null,
    bytes: payload.length,
    roundtrip,
    ms: Date.now() - started,
    steps,
    bucket: bucketReport,
    cors,
    session,
    session_put: sessionPut,
    note: !roundtrip
      ? "Wrote to storage but the read-back did not match — do NOT trust storage until this passes."
      : corsFailed
        ? `Server side works (token, bucket, write, read, session, server PUT) but bucket CORS is NOT in place — browser uploads from ${health.backend === "gcs" ? "the app" : "the browser"} will be blocked until it is: ${cors.error}`
        : `${put.backend === "gcs" ? `Bucket write + read-back + resumable session + server PUT succeeded (${steps.length} steps)` : "Drive write + read-back succeeded"} — uploads on this build survive deploys.${bucketReport?.warnings?.length ? ` ⚠ ${bucketReport.warnings.join(" ")}` : ""}`,
  });
});

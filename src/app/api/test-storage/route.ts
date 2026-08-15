import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { awsIdentity, compressionTools, envDiagnostic, getFile, gcsWifPresent, putFile, rssMb, storageHealth } from "@/lib/storage";

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
  return NextResponse.json({ storage: storageHealth(), env: envDiagnostic(), aws_identity: identity, rss_mb: rssMb(), tools, compression: { totals: agg[0] ?? { files: 0, stored: 0, original: 0, compressed: 0 }, recent } });
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
  let put, back;
  try {
    put = await putFile(name, payload, "text/plain", ["_healthcheck"]);
    back = await getFile({ backend: put.backend, drive_file_id: put.drive_file_id }, name);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const why = classifyStorageError(msg);
    return NextResponse.json({ ok: false, backend: health.backend, ms: Date.now() - started, error: msg.slice(0, 300), note: why || "Storage refused the probe — see error.", fix: why || null }, { status: 502 });
  }
  const roundtrip = back.equals(payload);
  return NextResponse.json({
    ok: roundtrip,
    backend: put.backend,
    drive_file_id: put.drive_file_id ?? null,
    folder_path: put.folder_path ?? null,
    bytes: payload.length,
    roundtrip,
    ms: Date.now() - started,
    note: roundtrip
      ? `${put.backend === "gcs" ? "Bucket" : "Drive"} write + read-back succeeded — uploads on this build survive deploys.`
      : "Wrote to storage but the read-back did not match — do NOT trust storage until this passes.",
  });
});

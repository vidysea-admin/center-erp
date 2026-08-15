import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { getFile, putFile, storageHealth } from "@/lib/storage";

// QA-145 rider (Umesh, 15/08: "Drive wala code local me test karke dekha ki information ja
// rahi hai ya bas push kar diya?") — the honest answer was: the Drive branch could not be
// exercised without a service-account key. This is the mail panel's "send test mail to me"
// for storage: ONE click writes a tiny probe under <root>/_healthcheck/, reads it straight
// back through the same getFile() the file proxy uses, and reports exactly what happened —
// backend, Drive file id, folder path, round-trip match. Admin-only; nothing else is written.
export const GET = apiHandler(async () => {
  await requireUser().then((u) => requireRole(u, "Admin"));
  return NextResponse.json({ storage: storageHealth() });
});

export const POST = apiHandler(async (_req: NextRequest) => {
  const user = await requireUser();
  requireRole(user, "Admin");
  const health = storageHealth();
  if (!health.configured) {
    throw new HttpError(400, "Evidence storage is not connected (GDRIVE_SA_JSON missing) — the probe would only touch the server's own disk, which is the very thing that is lost on deploy. Connect Drive first (drive-storage-setup.md).");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `healthcheck-${stamp}.txt`;
  const payload = Buffer.from(`Center ERP storage probe ${stamp} by ${user.email}`);
  const started = Date.now();
  const put = await putFile(name, payload, "text/plain", ["_healthcheck"]);
  const back = await getFile({ backend: put.backend, drive_file_id: put.drive_file_id }, name);
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
      ? "Drive write + read-back succeeded — uploads on this build survive deploys."
      : "Wrote to Drive but the read-back did not match — do NOT trust storage until this passes.",
  });
});

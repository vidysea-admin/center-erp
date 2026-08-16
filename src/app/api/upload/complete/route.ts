import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { StoredFile } from "@/models";
import { finalizeDriveFile, finalizeGcsObject } from "@/lib/storage";
import { BASE_PATH } from "@/lib/base-path";

// -90 step 3: the browser says "Google gave me file id X for upload <name>". The server does
// not trust that: it asks Drive for the file, checks the size equals what the intent
// promised and that it sits in the folder we minted, then flips the row to READY. Only then
// does /api/files serve it. Body: { name, drive_file_id }
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "");
  const fileId = String(body.drive_file_id ?? "");
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad upload name");
  await dbConnect();
  const row = await StoredFile.findOne({ name });
  if (!row) throw new HttpError(404, "Unknown upload");
  if (row.status === "ready") return NextResponse.json({ url: `${BASE_PATH}/api/files/` + name, name: row.original_name, backend: row.backend, size: row.size, already: true });
  if (row.status !== "pending") throw new HttpError(409, "This upload was abandoned — start again.");
  if (String(row.uploaded_by) !== String(user.id) && user.role !== "Admin") throw new HttpError(403, "Not your upload.");
  let storedId: string, storedSize: number;
  if (row.backend === "gcs") {
    // -92: the object key was fixed at intent time (drive_folder_id holds it) — confirm with GCS by key.
    const meta = await finalizeGcsObject(String(row.drive_folder_id));
    if (row.bytes_expected && meta.size !== Number(row.bytes_expected)) throw new HttpError(409, `Storage holds ${meta.size} bytes but ${row.bytes_expected} were promised — the upload did not finish. Retry.`);
    storedId = meta.key; storedSize = meta.size;
  } else {
    if (!fileId) throw new HttpError(400, "drive_file_id is required");
    const meta = await finalizeDriveFile(fileId);
    if (row.bytes_expected && meta.size !== Number(row.bytes_expected)) {
      throw new HttpError(409, `Drive holds ${meta.size} bytes but ${row.bytes_expected} were promised — the upload did not finish. Retry.`);
    }
    if (row.drive_folder_id && !meta.parents.includes(String(row.drive_folder_id))) {
      throw new HttpError(409, "The file is not in the folder this upload was opened for.");
    }
    storedId = meta.id; storedSize = meta.size;
  }
  const ext = name.slice(name.lastIndexOf("."));
  const isVideo = [".mp4", ".mov", ".3gp", ".webm"].includes(ext);
  row.drive_file_id = storedId;
  row.size = storedSize;
  row.status = "ready";
  const clientDid = String(row.compression ?? "").startsWith("client:");
  row.needs_compression = !clientDid && isVideo && storedSize > 20 * 1024 * 1024;
  // -97 (QA-164): keep the device's own reason when it gave one ("(device: …)" from intent);
  // only a bare "none:direct-to-storage" gets the generic wording.
  if (!clientDid && !/\(device: /.test(String(row.compression ?? ""))) row.compression = isVideo ? "none:direct-to-storage (device did not compress)" : "none:direct-to-storage";
  await row.save();
  return NextResponse.json({ url: `${BASE_PATH}/api/files/` + name, name: row.original_name, backend: row.backend, size: storedSize, original_size: row.original_size, compression: row.compression });
});

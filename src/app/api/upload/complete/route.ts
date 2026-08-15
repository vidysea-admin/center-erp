import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { StoredFile } from "@/models";
import { finalizeDriveFile } from "@/lib/storage";
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
  if (!fileId) throw new HttpError(400, "drive_file_id is required");
  await dbConnect();
  const row = await StoredFile.findOne({ name });
  if (!row) throw new HttpError(404, "Unknown upload");
  if (row.status === "ready") return NextResponse.json({ url: `${BASE_PATH}/api/files/` + name, name: row.original_name, backend: "drive", size: row.size, already: true });
  if (row.status !== "pending") throw new HttpError(409, "This upload was abandoned — start again.");
  if (String(row.uploaded_by) !== String(user.id) && user.role !== "Admin") throw new HttpError(403, "Not your upload.");
  const meta = await finalizeDriveFile(fileId);
  if (row.bytes_expected && meta.size !== Number(row.bytes_expected)) {
    throw new HttpError(409, `Drive holds ${meta.size} bytes but ${row.bytes_expected} were promised — the upload did not finish. Retry.`);
  }
  if (row.drive_folder_id && !meta.parents.includes(String(row.drive_folder_id))) {
    throw new HttpError(409, "The file is not in the folder this upload was opened for.");
  }
  const ext = name.slice(name.lastIndexOf("."));
  const isVideo = [".mp4", ".mov", ".3gp", ".webm"].includes(ext);
  row.drive_file_id = meta.id;
  row.size = meta.size;
  row.status = "ready";
  row.needs_compression = isVideo && meta.size > 20 * 1024 * 1024;
  row.compression = isVideo ? "none:direct-to-drive (compress-first on the device is the next release)" : "none:direct-to-drive";
  await row.save();
  return NextResponse.json({ url: `${BASE_PATH}/api/files/` + name, name: row.original_name, backend: "drive", size: meta.size, original_size: row.original_size, compression: row.compression });
});

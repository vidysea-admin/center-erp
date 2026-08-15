import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { StoredFile } from "@/models";
import { deleteDriveFile, deleteGcsObject } from "@/lib/storage";

// -90: the browser gave up (user cancelled / too many retries). The pending row is marked
// failed and, if Google already assigned a file id, that partial file is removed.
// Body: { name, drive_file_id? }
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "");
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad upload name");
  await dbConnect();
  const row = await StoredFile.findOne({ name });
  if (!row) throw new HttpError(404, "Unknown upload");
  if (String(row.uploaded_by) !== String(user.id) && user.role !== "Admin") throw new HttpError(403, "Not your upload.");
  if (row.status === "ready") return NextResponse.json({ ok: true, note: "already complete — nothing aborted" });
  row.status = "failed";
  await row.save();
  if (row.backend === "gcs") { if (row.drive_folder_id) await deleteGcsObject(String(row.drive_folder_id)); }
  else { const fid = String(body.drive_file_id ?? ""); if (fid) await deleteDriveFile(fid); }
  return NextResponse.json({ ok: true });
});

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { Readable } from "stream";
import { apiHandler, HttpError, requireUser } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { StoredFile, DailyLog, CandidateDocument, TrainerDocument, CandidateResult, Closure } from "@/models";
import { getFileStream, removeStoredFile } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { INTERNAL_FILE_HEADER, internalFileToken } from "@/lib/safe-fetch";
import { auth } from "@/auth";

// -83: every extension /api/upload accepts is served with its real type and rendered
// inline where a browser can render it — .mov/.heic/.m4a were being handed out as
// application/octet-stream attachments (write-only evidence).
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".webm": "video/webm",
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".amr": "audio/amr", ".ogg": "audio/ogg",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
// QA-1562 (checker, cycle 1 FAIL): .heif belongs in BOTH sets, not just the upload allowlist.
// qa-1561 widened the door that ACCEPTS a file and not the door that SERVES it back, so a stored
// .heif came out as application/octet-stream + attachment while its .heic twin - the same bytes
// from the same camera - came out image/heic + inline. Measured live under three names: .heic
// inline, .heif ATTACHMENT, .jpg inline. Widening an allowlist is never one edit here; this file
// is the other half of it.
const INLINE = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".pdf", ".mp4", ".mov", ".3gp", ".webm", ".m4a", ".mp3", ".wav", ".amr", ".ogg"]);

function parseRange(h: string | null): { start: number; end?: number } | { suffix: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return { suffix: parseInt(m[2], 10) }; // last N bytes
  return { start: parseInt(m[1], 10), end: m[2] === "" ? undefined : parseInt(m[2], 10) };
}

// -98 (QA-163, checker measured live: certificates / candidate documents / trainee photos opened
// for an ANONYMOUS request and the link never expired): a read now needs a LOGIN — the 32-hex
// capability name stays as the second layer (no enumeration), the session is the first. Same-origin
// <img>/<video>/PDF viewers send the cookie themselves; the only server-side consumer (the sync
// engine reading a sheet uploaded into the ERP over loopback) proves itself with the internal
// header minted in safe-fetch. Public /p/* pages do not embed evidence.
// -83 (honest file reads): the bytes STREAM (no heap copy), Range is honoured (206) so
// video seeks and iOS plays, and failures are told apart — 404 missing, 416 bad range,
// 502 when the storage backend refused (was: everything became "File not found").
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad file name");
  const internal = req.headers.get(INTERNAL_FILE_HEADER);
  const isInternal = !!internal && internal === internalFileToken(name);
  if (!isInternal) {
    const session = await auth();
    if (!session?.user) throw new HttpError(401, "Please sign in to open this file.");
  }
  await dbConnect();
  const rec = await StoredFile.findOne({ name }).select("backend drive_file_id size status").lean<any>();
  // -97: a deleted file says so (410) — the row is kept as the audit trail, the object is gone.
  if (rec && rec.status === "deleted") throw new HttpError(410, "This file was removed.");
  if (rec && rec.status && rec.status !== "ready") throw new HttpError(404, rec.status === "pending" ? "This file is still uploading." : "This upload did not complete.");
  const ext = path.extname(name);
  const type = TYPES[ext] ?? "application/octet-stream";
  const disposition = `${INLINE.has(ext) ? "inline" : "attachment"}; filename="${name}"`;
  let fs;
  try {
    fs = await getFileStream(rec, name, parseRange(req.headers.get("range")));
  } catch (e: any) {
    if (e?.code === 416) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${e.size ?? "*"}` } });
    }
    if (e?.code === "ENOENT") throw new HttpError(404, "File not found");
    if (rec?.backend === "drive") throw new HttpError(502, "The storage backend could not return this file right now — try again in a moment.");
    throw new HttpError(404, "File not found");
  }
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox", // neutralizes any active content
    "Content-Disposition": disposition,
    "Content-Length": String(fs.end - fs.start + 1),
  };
  if (fs.partial) headers["Content-Range"] = `bytes ${fs.start}-${fs.end}/${fs.size}`;
  const body = Readable.toWeb(fs.stream as unknown as Readable) as unknown as ReadableStream;
  return new NextResponse(body, { status: fs.partial ? 206 : 200, headers });
});

// -97 (Umesh: view/edit/delete must all work): DISCARD an upload that is not attached to any
// record yet — the daily-log form's ✕ before Save (a wrong photo/video should not become an
// orphan in the bucket). Only the uploader (or an Admin) may discard, and only while nothing
// references it: a file that a saved log / document / certificate / closure points at is part
// of the record and leaves only through that record's own delete (which calls removeStoredFile).
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad file name");
  const user = await requireUser();
  await dbConnect();
  const rec = await StoredFile.findOne({ name }).select("status uploaded_by backend folder_path original_name entity entity_id").lean<any>();
  if (!rec) throw new HttpError(404, "File not found");
  if (rec.status === "deleted") return NextResponse.json({ ok: true, already: true });
  const isAdmin = user.role === "Admin";
  if (!isAdmin && String(rec.uploaded_by ?? "") !== String(user.id)) throw new HttpError(403, "Only the person who uploaded this file (or an Admin) can discard it.");
  const url = new RegExp(`/api/files/${name}$`);
  // -101: this list was missing three fields a record can point at — `Closure.result_file`, and
  // `CandidateResult.evidence_file` including the per-attempt copies. A file still shown on a
  // closure result sheet or an assessment attempt could therefore be discarded through this door,
  // leaving the record pointing at a 410. Everything a record references leaves through that
  // record, never here.
  const referenced =
    (await DailyLog.exists({ $or: [{ photos: url }, { videos: url }, { govt_screenshot: url }] })) ||
    (await CandidateDocument.exists({ file_url: url })) ||
    (await TrainerDocument.exists({ file_url: url })) ||
    (await CandidateResult.exists({ $or: [{ certificate_file: url }, { evidence_file: url }, { "attempts.evidence_file": url }] })) ||
    (await Closure.exists({ $or: [{ certificate_file: url }, { result_file: url }] }));
  if (referenced) throw new HttpError(409, "This file is attached to a saved record — remove it through that record, not here.");
  const r = await removeStoredFile(name, user.id);
  if (!r.removed) throw new HttpError(502, `Storage refused to delete the object: ${r.reason ?? "unknown"}`);
  await audit({ entity: "StoredFile", entityId: rec._id, field: "discarded", oldValue: `${rec.folder_path ?? ""}/${rec.original_name ?? name}`, newValue: `discarded by ${user.name} (${r.backend})`, actor: user.id });
  return NextResponse.json({ ok: true, backend: r.backend });
});

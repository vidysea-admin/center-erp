import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { BASE_PATH } from "@/lib/base-path";
import { dbConnect } from "@/lib/db";
import { StoredFile } from "@/models";
import { ALLOWED_UPLOAD_EXT, putFile } from "@/lib/storage";

// 2026-08-12 (Manish): 25 MB was too small for the twice-daily evidence videos.
// 15/08 (Umesh): the app-side ceiling is GONE entirely — no size check here at all.
// .mov/.3gp added — that is what the field phones actually record.
// 2026-08-12: .doc/.docx added — a trainer's industry and teaching experience certificates arrive
// as Word files, and without these the mandatory-document gate could never be satisfied.
// 15/08 (team feedback): .heic added — iPhones hand photos over as HEIC by default.
// 15/08 (team, via checker): audio too — voice notes are field evidence like photos are.
const ALLOWED = ALLOWED_UPLOAD_EXT; // -90: shared with /api/upload/intent (lib/storage.ts)

// POST multipart { file } → { url } (served from /uploads via next.config rewrite-free public dir)
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  // 15/08 live probe: multipart bodies over ~8-10 MB died inside the form parse. -81 found
  // the cause: with a proxy (src/proxy.ts) in the app, Next buffers the body capped at
  // experimental.proxyClientMaxBodySize (10 MB default) and truncates the rest, so
  // formData() failed. /api/upload is now excluded from the proxy matcher — the body streams
  // whole. If parsing still fails, name it; the operator's move is a smaller file, not a retry.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(413, "The upload could not be read on the server (body too large for the layer in front of the app). Compress the video or split the upload, and tell Admin the file size.");
  }
  const file = form.get("file") as File | null;
  if (!file) throw new HttpError(400, "file required");
  // 15/08 (Umesh): NO app-side size cap on uploads — "koi bhi cap nahi, space bahut hai".
  // The only remaining limit is the reverse proxy's multipart body cap (the 413 above),
  // which is infra, not ours, and is with devops to raise.
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED.has(ext)) throw new HttpError(400, "File type not allowed: " + ext);
  const name = crypto.randomBytes(16).toString("hex") + ext;
  const buf = Buffer.from(await file.arrayBuffer());
  // QA-145: durable, folder-wise storage (Drive when configured) + a StoredFile row for
  // every upload. Callers may say WHERE this belongs (folder segments + entity) so the
  // Drive tree reads like the product: <Centre code>/<Batch code>/<kind>/file.
  const seg = (k: string) => String(form.get(k) ?? "").trim();
  const folder = [seg("folder_centre"), seg("folder_batch"), seg("folder_kind") || "uploads"].filter(Boolean);
  // -87 (QA-157): the ONE door compresses (images via sharp, PDFs via Ghostscript) and may
  // hand back a different name/mime (PNG→JPEG, HEIC→JPEG); the row and the URL use what it stored.
  const put = await putFile(name, buf, file.type, folder);
  // -91: when the DEVICE already compressed a video (recorded in-app / re-encoded in the
  // browser) the client says so; the row records that label instead of "none:video".
  const clientComp = seg("client_compression").slice(0, 80);
  const clientOriginal = Number(seg("client_original_size")) || 0;
  const finalCompression = clientComp ? `client:${clientComp}` : put.compression;
  const finalOriginal = clientOriginal > put.original_size ? clientOriginal : put.original_size;
  await dbConnect();
  await StoredFile.create({
    name: put.name, original_name: file.name, mime: put.mime, size: put.size,
    original_size: finalOriginal,
    compressed: put.compressed || !!clientComp, compression: finalCompression, compression_ms: put.compression_ms,
    needs_compression: clientComp ? false : put.needs_compression,
    backend: put.backend, drive_file_id: put.drive_file_id, folder_path: put.folder_path,
    entity: seg("entity") || undefined, entity_id: /^[a-f0-9]{24}$/.test(seg("entity_id")) ? seg("entity_id") : undefined,
    uploaded_by: user.id,
  });
  // Served via /api/files/[name] — the app proxies the bytes; the user never sees Drive.
  // URL is stored in the DB, so it carries the basePath prefix explicitly.
  return NextResponse.json({ url: `${BASE_PATH}/api/files/` + put.name, name: file.name, backend: put.backend, original_size: finalOriginal, size: put.size, compression: finalCompression });
});

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { StoredFile } from "@/models";
import { ALLOWED_UPLOAD_EXT as ALLOWED, createResumableSession, storageConfigured, storageHealth } from "@/lib/storage";
import { BASE_PATH } from "@/lib/base-path";

// -90 (checker's DESIGN-video-upload.md; Umesh 15/08: "plan out how the video upload really
// works"): step 1 of the direct-to-Drive path. The server checks the permission and the
// extension, writes a PENDING StoredFile row, asks Drive for a resumable upload session in
// the right folder, and hands the SESSION URI (a per-file bearer, ~1 day) to the browser —
// never a key. The browser then PUTs the bytes straight to Google (step 2, lib/upload.ts),
// and /api/upload/complete (step 3) confirms with Drive and flips the row to ready.
// Body: { name, size, mime, folder_centre?, folder_batch?, folder_kind?, entity?, entity_id? }
// 409 when Drive is not connected — the client falls back to the multipart path.
const MAX_DIRECT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB — sanity, not a product cap
const CHUNK_BYTES = 8 * 1024 * 1024; // multiple of 256 KiB, as Google requires

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  const body = await req.json().catch(() => ({}));
  const original = String(body.name ?? "").trim();
  const size = Number(body.size ?? 0);
  const mime = String(body.mime ?? "application/octet-stream");
  if (!original) throw new HttpError(400, "name is required");
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED.has(ext)) throw new HttpError(400, "File type not allowed: " + (ext || "(none)"));
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "size must be a positive number of bytes");
  if (size > MAX_DIRECT_BYTES) throw new HttpError(413, "Files over 5 GB are not accepted.");
  if (!storageConfigured()) {
    const h = storageHealth();
    return NextResponse.json({ error: "Evidence storage is not connected — direct upload unavailable; use the standard upload.", fallback: true, hint: h.hint }, { status: 409 });
  }
  await dbConnect();
  // sweep: pendings older than a day are failed (their session URIs are dead by then)
  await StoredFile.updateMany({ status: "pending", expires_at: { $lt: new Date() } }, { $set: { status: "failed" } });

  const seg = (k: string) => String(body[k] ?? "").trim();
  const folder = [seg("folder_centre"), seg("folder_batch"), seg("folder_kind") || "uploads"].filter(Boolean);
  const name = crypto.randomBytes(16).toString("hex") + ext;
  const origin = req.headers.get("origin") || undefined;
  const session = await createResumableSession({ name, mime, size, folderSegments: folder, origin });
  await StoredFile.create({
    name, original_name: original, mime, size: 0, original_size: size, bytes_expected: size,
    backend: session.backend, folder_path: session.folder_path, drive_folder_id: session.folder_id,
    status: "pending", expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    // -97 (QA-164): a "none:<reason>" from the device is recorded as the REASON (why it was not
    // compressed), never as a compression.
    ...((): { compressed: boolean; compression: string } => {
      const c = String(body.client_compression ?? "").trim().slice(0, 120);
      if (!c) return { compressed: false, compression: "none:direct-to-storage" };
      if (c.startsWith("none:")) return { compressed: false, compression: `none:direct-to-storage (device: ${c.slice(5).trim()})` };
      return { compressed: true, compression: `client:${c}` };
    })(),
    ...(Number(body.client_original_size) > size ? { original_size: Number(body.client_original_size) } : {}),
    entity: seg("entity") || undefined, entity_id: /^[a-f0-9]{24}$/.test(seg("entity_id")) ? seg("entity_id") : undefined,
    // QA-1548: on THIS door the bytes go browser -> Google and never touch the container, so the
    // server can never read the EXIF itself — the coordinates the browser lifted off the original
    // file are the only ones that will ever exist for this row. Range-checked, never trusted; an
    // absent geo-tag stays absent rather than becoming a point in the Atlantic.
    ...((): { geo?: { lat: number; lng: number } } => {
      const lat = Number(body.geo_lat), lng = Number(body.geo_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return {};
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return {};
      if (lat === 0 && lng === 0) return {};
      return { geo: { lat, lng } };
    })(),
    uploaded_by: user.id,
  });
  return NextResponse.json({
    name, url: `${BASE_PATH}/api/files/` + name, session_uri: session.session_uri, chunk_bytes: CHUNK_BYTES, folder_path: session.folder_path,
  }, { status: 201 });
});

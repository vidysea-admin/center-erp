import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { StoredFile } from "@/models";
import { DEFAULT_GCS_BUCKET, storageHealth } from "@/lib/storage";
import { BASE_PATH } from "@/lib/base-path";

// -97 (Umesh: "server me kahan ja raha hai, kaise dekhen"): the Admin's answer to WHERE every
// file went — newest first, filterable by the folder prefix <Centre>/<Batch>/<kind>, with a
// direct link to the same folder in the Google Cloud console (bucket objects live at exactly
// that path). Admin-only; names/paths only, the bytes still go through /api/files/<name>.
export const GET = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireRole(user, "Admin");
  await dbConnect();
  const q = req.nextUrl.searchParams;
  const prefix = String(q.get("prefix") ?? "").trim().replace(/^\/+|\/+$/g, "");
  const status = String(q.get("status") ?? "").trim();
  const entity = String(q.get("entity") ?? "").trim();
  const backend = String(q.get("backend") ?? "").trim();
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const filter: any = {};
  if (prefix) filter.folder_path = { $regex: "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (status) filter.status = status;
  if (entity) filter.entity = entity;
  if (backend) filter.backend = backend;
  const rows = await StoredFile.find(filter).sort({ createdAt: -1 }).limit(limit)
    .select("name original_name mime size original_size compressed compression backend folder_path drive_file_id status entity entity_id uploaded_by createdAt deleted_at deleted_by")
    .populate("uploaded_by", "name").populate("deleted_by", "name").lean<any[]>();
  const health = storageHealth();
  const bucketName = /bucket ([A-Za-z0-9._-]+)/.exec(health.reason)?.[1] ?? DEFAULT_GCS_BUCKET;
  const consoleBase = `https://console.cloud.google.com/storage/browser/${bucketName}`;
  const items = rows.map((r) => ({
    name: r.name, original_name: r.original_name ?? null, mime: r.mime ?? null, size: r.size ?? 0, original_size: r.original_size ?? r.size ?? 0,
    compressed: !!r.compressed, compression: r.compression ?? null, backend: r.backend, folder_path: r.folder_path ?? null, status: r.status ?? "ready",
    entity: r.entity ?? null, entity_id: r.entity_id ? String(r.entity_id) : null,
    uploaded_by: r.uploaded_by?.name ?? null, created_at: r.createdAt, deleted_at: r.deleted_at ?? null, deleted_by: r.deleted_by?.name ?? null,
    url: `${BASE_PATH}/api/files/${r.name}`,
    object_path: r.backend === "gcs" && r.drive_file_id ? String(r.drive_file_id) : null,
    console_url: r.backend === "gcs" && r.folder_path ? `${consoleBase}/${String(r.folder_path).split("/").map(encodeURIComponent).join("/")}` : null,
  }));
  const agg = await StoredFile.aggregate([{ $match: filter }, { $group: { _id: "$status", n: { $sum: 1 }, bytes: { $sum: "$size" } } }]);
  return NextResponse.json({ items, count: items.length, by_status: Object.fromEntries(agg.map((a: any) => [a._id ?? "ready", { n: a.n, bytes: a.bytes }])), bucket: health.backend === "gcs" ? bucketName : null, console_url: health.backend === "gcs" ? consoleBase : null, backend: health.backend, layout: "<Centre>/<Batch>/<kind>/<file>" });
});

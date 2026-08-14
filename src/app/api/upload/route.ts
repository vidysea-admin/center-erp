import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { BASE_PATH } from "@/lib/base-path";
import { dbConnect } from "@/lib/db";
import { getDefaults } from "@/lib/defaults";

// 2026-08-12 (Manish): 25 MB was too small for the twice-daily evidence videos, so the ceiling
// moved to Defaults.max_upload_mb (100 MB out of the box) and can be tuned against the server's
// disk without a deploy. .mov/.3gp added — that is what the field phones actually record.
// 2026-08-12: .doc/.docx added — a trainer's industry and teaching experience certificates arrive
// as Word files, and without these the mandatory-document gate could never be satisfied.
// 15/08 (team feedback): .heic added — iPhones hand photos over as HEIC by default.
const ALLOWED = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf", ".mp4", ".mov", ".3gp", ".xlsx", ".xls", ".csv", ".doc", ".docx"]);

// POST multipart { file } → { url } (served from /uploads via next.config rewrite-free public dir)
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  // 15/08 live probe: multipart bodies over ~8-10 MB die inside the platform's form parse
  // with a bare exception, which apiHandler turned into "Something went wrong". Name the
  // real situation instead — the operator's move is a smaller file, not a retry.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(413, "The upload failed on the server — files over ~8 MB currently fail here (infra cap under investigation). Compress the video or split the upload.");
  }
  const file = form.get("file") as File | null;
  if (!file) throw new HttpError(400, "file required");
  await dbConnect();
  const maxMb = (await getDefaults()).max_upload_mb ?? 100;
  if (file.size > maxMb * 1024 * 1024) {
    throw new HttpError(400, `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${maxMb} MB. An Admin can raise it in Admin → Defaults.`);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED.has(ext)) throw new HttpError(400, "File type not allowed: " + ext);
  const name = crypto.randomBytes(16).toString("hex") + ext;
  const dir = path.join(process.cwd(), "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
  // Served via /api/files/[name] — public/ is not writable at runtime in production builds.
  // URL is stored in the DB, so it carries the basePath prefix explicitly.
  return NextResponse.json({ url: `${BASE_PATH}/api/files/` + name, name: file.name });
});

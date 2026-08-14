import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { BASE_PATH } from "@/lib/base-path";

// 2026-08-12 (Manish): 25 MB was too small for the twice-daily evidence videos.
// 15/08 (Umesh): the app-side ceiling is GONE entirely — no size check here at all.
// .mov/.3gp added — that is what the field phones actually record.
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
  // 15/08 (Umesh): NO app-side size cap on uploads — "koi bhi cap nahi, space bahut hai".
  // The only remaining limit is the reverse proxy's multipart body cap (the 413 above),
  // which is infra, not ours, and is with devops to raise.
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

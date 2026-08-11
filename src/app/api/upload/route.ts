import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { BASE_PATH } from "@/lib/base-path";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".mp4", ".xlsx", ".xls", ".csv"]);

// POST multipart { file } → { url } (served from /uploads via next.config rewrite-free public dir)
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  requireEdit(user);
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) throw new HttpError(400, "file required");
  if (file.size > MAX_BYTES) throw new HttpError(400, "File exceeds 25MB");
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

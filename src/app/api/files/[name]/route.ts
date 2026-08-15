import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { apiHandler, HttpError } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { StoredFile } from "@/models";
import { getFile } from "@/lib/storage";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
};

// Capability-URL access: the 16-hex random filename is the secret. No session required —
// lets <img> tags, PDF viewers and the sync engine's server-side fetch all work.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad file name");
  try {
    // QA-145: the StoredFile row says where the bytes live (Drive / local); the app proxies
    // them so the URL shape and the capability-name secret never change.
    await dbConnect();
    const rec = await StoredFile.findOne({ name }).select("backend drive_file_id").lean<any>();
    const buf = await getFile(rec, name);
    const ext = path.extname(name);
    const inline = [".jpg", ".jpeg", ".png", ".webp", ".pdf", ".mp4"].includes(ext);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox", // neutralizes any active content
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
      },
    });
  } catch {
    throw new HttpError(404, "File not found");
  }
});

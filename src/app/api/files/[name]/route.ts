import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { Readable } from "stream";
import { apiHandler, HttpError } from "@/lib/authz";
import { dbConnect } from "@/lib/db";
import { StoredFile } from "@/models";
import { getFileStream } from "@/lib/storage";

// -83: every extension /api/upload accepts is served with its real type and rendered
// inline where a browser can render it — .mov/.heic/.m4a were being handed out as
// application/octet-stream attachments (write-only evidence).
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".webm": "video/webm",
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".amr": "audio/amr", ".ogg": "audio/ogg",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const INLINE = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf", ".mp4", ".mov", ".3gp", ".webm", ".m4a", ".mp3", ".wav", ".amr", ".ogg"]);

function parseRange(h: string | null): { start: number; end?: number } | { suffix: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return { suffix: parseInt(m[2], 10) }; // last N bytes
  return { start: parseInt(m[1], 10), end: m[2] === "" ? undefined : parseInt(m[2], 10) };
}

// Capability-URL access: the 16-hex random filename is the secret. No session required —
// lets <img>/<video> tags, PDF viewers and the sync engine's server-side fetch all work.
// -83 (honest file reads): the bytes STREAM (no heap copy), Range is honoured (206) so
// video seeks and iOS plays, and failures are told apart — 404 missing, 416 bad range,
// 502 when the storage backend refused (was: everything became "File not found").
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) throw new HttpError(400, "Bad file name");
  await dbConnect();
  const rec = await StoredFile.findOne({ name }).select("backend drive_file_id size status").lean<any>();
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

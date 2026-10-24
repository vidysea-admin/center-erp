import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { PassThrough, Readable } from "stream";
import archiver from "archiver";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { Batch, DailyLog, StoredFile } from "@/models";
import { assertBatchInScope } from "@/lib/rules";
import { getFileStream } from "@/lib/storage";
import { mediaDays, storedNameFromUrl } from "@/lib/media-days";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// qa-batch-media-zip (field ask 2026-10-24): a batch's photos and videos as ONE ZIP, one folder per
// class day named by the date. ?date=YYYY-MM-DD = that day only; no date = every day with media.
// Same doors as GET /logs (login + Rule 38 batch scope): whoever can read the logs can read their
// media, nobody else. Bytes STREAM from storage into the ZIP one file at a time (a 15-day batch of
// videos can be gigabytes - nothing is held in memory), and entries are STORED, not compressed:
// photos and videos are already compressed, so deflating them costs CPU and saves nothing.
// A file a log names that storage cannot return is listed in MISSING.txt, never dropped silently.
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const date = req.nextUrl.searchParams.get("date");
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must look like 2026-10-24.");

  const batch = await Batch.findById(id).select("code").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const logs = await DailyLog.find({ batch: id }).select("log_date photos videos").lean<any[]>();
  const days = mediaDays(logs).filter((d) => !date || d.date === date).reverse(); // oldest first inside the ZIP
  if (!days.length) throw new HttpError(404, date ? "No photos or videos were logged on this day." : "No photos or videos were logged for this batch.");

  const names = days.flatMap((d) => [...d.photos, ...d.videos]).map(storedNameFromUrl).filter((n): n is string => !!n);
  const recs = await StoredFile.find({ name: { $in: names } }).select("name original_name backend drive_file_id size status").lean<any[]>();
  const byName = new Map(recs.map((r) => [r.name, r]));

  const archive = archiver("zip", { store: true });
  const out = new PassThrough();
  archive.on("error", (e) => out.destroy(e));
  archive.pipe(out);
  // The browser cancelling the download (or a storage stream failing) must end the loop below,
  // not leave it waiting on an entry that will never be written with a storage stream held open.
  let stop: (e: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  out.on("close", () => { if (!out.writableFinished) { archive.abort(); stop(new Error("download closed")); } });

  // Fill the archive AFTER the response starts flowing. One storage stream is opened at a time:
  // the next file is only fetched once the previous entry has been written.
  (async () => {
    const missing: string[] = [];
    for (const day of days) {
      const used = new Set<string>();
      const files = [...day.photos.map((u) => ({ u, kind: "photo" })), ...day.videos.map((u) => ({ u, kind: "video" }))];
      let n = 0;
      for (const { u, kind } of files) {
        n++;
        const name = storedNameFromUrl(u);
        const rec = name ? byName.get(name) : undefined;
        if (!name || !rec || (rec.status && rec.status !== "ready")) { missing.push(`${day.date}\t${kind}\t${name ?? u}\t${!rec ? "no stored file" : rec.status}`); continue; }
        let fs;
        try { fs = await getFileStream(rec, name); }
        catch (e: any) { missing.push(`${day.date}\t${kind}\t${name}\tstorage could not return it (${String(e?.code ?? e?.message ?? "error").slice(0, 60)})`); continue; }
        const entry = uniqueName(used, entryBase(rec.original_name, kind, n), path.extname(name));
        const src = fs.stream as unknown as Readable;
        const written = new Promise<void>((resolve, reject) => { archive.once("entry", () => resolve()); src.once("error", reject); });
        archive.append(src, { name: `${day.date}/${entry}` });
        try { await Promise.race([written, stopped]); }
        catch (e) { src.destroy(); throw e; }
      }
    }
    if (missing.length) {
      archive.append(["These files are named in the daily logs but storage could not return them:", "date\tkind\tfile\treason", ...missing, ""].join("\n"), { name: "MISSING.txt" });
    }
    await archive.finalize();
  })().catch((e) => out.destroy(e));

  const code = String(batch.code ?? id).replace(/[^A-Za-z0-9._-]+/g, "_");
  return new NextResponse(Readable.toWeb(out) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${code}_${date ?? "all-days"}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// The name the uploader's phone gave the file, without its extension (the stored extension wins:
// the upload door may re-encode, e.g. HEIC -> JPEG), made safe for every unzip tool.
function entryBase(original: unknown, kind: string, n: number): string {
  const base = path.basename(String(original ?? ""), path.extname(String(original ?? "")))
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80);
  return base || `${kind}-${n}`;
}
function uniqueName(used: Set<string>, base: string, ext: string): string {
  let name = base + ext, i = 2;
  while (used.has(name.toLowerCase())) name = `${base}-${i++}${ext}`;
  used.add(name.toLowerCase());
  return name;
}

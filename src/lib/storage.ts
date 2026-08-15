// QA-145 (2026-08-15) — durable evidence storage. Umesh's design, verbatim intent: photos,
// videos, voice notes, documents go to OUR Google Drive, folder-wise ("proper folder wise
// aana chahiye — kya hai, kaha hai"), with a database entry for every file ("koi bhi data
// miss na ho"); the USER never sees Drive — "wo hamara backend ka process hai". S3 was
// considered and rejected in favour of Drive.
//
// Why: the checker proved (upload on -73 → 24/24 reads; deploy -74 → same URL 16/16 404)
// that process.cwd()/uploads is the ECS task's own disk and every deploy wipes it, while
// the URLs stay in Mongo pointing at nothing. min_daily_evidence: 2 was asking for evidence
// the product could not keep.
//
// Shape follows mailer.ts: a graceful-off adapter. Configured → Drive is the primary store,
// the app proxies reads. Not configured → the old local write (still lost on deploy) plus a
// LOUD, honest health flag the admin panel shows in red — never a silent fallback.
//
// Gate (Umesh only, like the SES env vars): GDRIVE_SA_JSON (base64 of the service-account
// key JSON) + GDRIVE_ROOT_FOLDER_ID (the shared folder, shared WITH the service-account
// email as Editor). Steps: d:/erp/drive-storage-setup.md.
import { google, drive_v3 } from "googleapis";
import { Readable } from "stream";
import { mkdir, readFile, stat, writeFile, unlink } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import crypto from "crypto";
import path from "path";
import { getDefaults } from "@/lib/defaults";
const execFileP = promisify(execFile);

let cachedDrive: drive_v3.Drive | null = null;
let cachedErr: string | null = null;
const folderCache = new Map<string, string>(); // "parentId/name" → folderId

// Umesh (15/08): "drive ka link hard code kar de" — the ROOT FOLDER is not a secret (it is
// the same Drive folder Defaults.drive_root_url already points at), so it is the default
// here and the env var only overrides it. What CANNOT be hardcoded is the service-account
// key: that is a private credential, and without it Google will not let the app write.
export const DEFAULT_DRIVE_ROOT_FOLDER_ID = "1NOfRCw9lIyRoJTEFAg4--HIJiTG-Of0G";
export function rootFolderId(): string {
  return String(process.env.GDRIVE_ROOT_FOLDER_ID || DEFAULT_DRIVE_ROOT_FOLDER_ID);
}

// Two ways to be the app's Google identity — env-first, whichever is set:
//   (a) service account: GDRIVE_SA_JSON (base64 key JSON)
//   (b) OAuth user (Umesh, 15/08: "mere credentials jo already available hain, .env me daal
//       do"): GDRIVE_OAUTH_CLIENT_ID + GDRIVE_OAUTH_CLIENT_SECRET + GDRIVE_OAUTH_REFRESH_TOKEN
//       — the same triple the gws CLI holds; the app then writes AS that user.
function oauthTriple(): { id: string; secret: string; refresh: string } | null {
  const id = process.env.GDRIVE_OAUTH_CLIENT_ID, secret = process.env.GDRIVE_OAUTH_CLIENT_SECRET, refresh = process.env.GDRIVE_OAUTH_REFRESH_TOKEN;
  return id && secret && refresh ? { id, secret, refresh } : null;
}
export function storageMode(): "sa" | "oauth" | null {
  if (process.env.GDRIVE_SA_JSON) return "sa";
  if (oauthTriple()) return "oauth";
  return null;
}
export function storageConfigured(): boolean {
  return storageMode() !== null;
}

export function storageHealth(): { backend: "drive" | "local"; configured: boolean; mode: "sa" | "oauth" | null; reason: string } {
  const mode = storageMode();
  if (mode) return { backend: "drive", configured: true, mode, reason: cachedErr ? `Drive error: ${cachedErr}` : `Google Drive connected via ${mode === "sa" ? "service account" : "OAuth user"} (root folder ${rootFolderId()}) — uploads survive deploys` };
  return {
    backend: "local",
    configured: false,
    mode: null,
    reason: "Evidence storage NOT connected — uploads are written to the server's own disk and are LOST on every deploy. Set GDRIVE_SA_JSON (service-account key) OR GDRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN — the Drive folder is already known (see drive-storage-setup.md).",
  };
}

function drive(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const mode = storageMode();
  if (mode === "sa") {
    const raw = Buffer.from(String(process.env.GDRIVE_SA_JSON), "base64").toString("utf8");
    const creds = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
    cachedDrive = google.drive({ version: "v3", auth });
  } else {
    const t = oauthTriple()!;
    const auth = new google.auth.OAuth2(t.id, t.secret);
    auth.setCredentials({ refresh_token: t.refresh });
    cachedDrive = google.drive({ version: "v3", auth });
  }
  return cachedDrive;
}

// Folder-wise, auto-created, id-cached: <root>/<seg1>/<seg2>/... Names are used as given
// (centre code, batch code, kind) — human-readable in Drive for anyone who does look.
async function ensureFolder(segments: string[]): Promise<{ id: string; path: string }> {
  const d = drive();
  let parent = rootFolderId();
  const walked: string[] = [];
  for (const seg of segments.map((s) => String(s).trim()).filter(Boolean)) {
    walked.push(seg);
    const key = `${parent}/${seg}`;
    let id = folderCache.get(key);
    if (!id) {
      const q = `'${parent}' in parents and name = '${seg.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const found = await d.files.list({ q, fields: "files(id)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
      id = found.data.files?.[0]?.id ?? undefined;
      if (!id) {
        const made = await d.files.create({ requestBody: { name: seg, mimeType: "application/vnd.google-apps.folder", parents: [parent] }, fields: "id", supportsAllDrives: true });
        id = String(made.data.id);
      }
      folderCache.set(key, id);
    }
    parent = id;
  }
  return { id: parent, path: walked.join("/") };
}

export type PutResult = {
  backend: "drive" | "local"; drive_file_id?: string; folder_path?: string;
  // -87 (QA-157): what the ONE door did to the bytes — recorded on every StoredFile row.
  name: string; mime: string; original_size: number; size: number; compressed: boolean; compression: string; compression_ms: number; needs_compression: boolean;
};

// ---------- -87 (QA-157, Umesh 15/08 22:55: "jo kuch bhi media jaye — photo, certificate PDF, sab
// compress hone chahiye"). Compression lives HERE, at the one door every write passes, so no
// screen can bypass it again (the closure upload did). Client-side compression stays for the
// trainer's 4G data; the server is what makes the rule true. Tools are optional at runtime —
// missing → store as-is and RECORD why, never silently.
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".3gp", ".webm"]);
let gsPath: string | null | undefined; // undefined = not probed yet
function findGs(): string | null {
  if (gsPath !== undefined) return gsPath;
  const cands = [process.env.GS_PATH, "/usr/bin/gs", "/usr/local/bin/gs", "gs"].filter(Boolean) as string[];
  gsPath = null;
  for (const c of cands) {
    if (c === "gs") { gsPath = "gs"; break; } // resolved via PATH by execFile; verified by the first run
    if (existsSync(c)) { gsPath = c; break; }
  }
  return gsPath;
}
let gsVerified: boolean | null = null;
async function gsAvailable(): Promise<boolean> {
  if (gsVerified !== null) return gsVerified;
  const g = findGs();
  if (!g) return (gsVerified = false);
  try { await execFileP(g, ["--version"], { timeout: 5000 }); gsVerified = true; } catch { gsVerified = false; }
  return gsVerified;
}
let sharpMod: any | null | undefined;
function loadSharp(): any | null {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = require("sharp"); } catch { sharpMod = null; }
  return sharpMod;
}
export async function compressionTools(): Promise<{ sharp: boolean; gs: boolean }> {
  return { sharp: !!loadSharp(), gs: await gsAvailable() };
}

export type Compressed = { buf: Buffer; name: string; mime: string; compressed: boolean; compression: string; ms: number; needs_compression: boolean };
export async function compressForStorage(name: string, buf: Buffer, mime: string): Promise<Compressed> {
  const t0 = Date.now();
  const ext = path.extname(name).toLowerCase();
  const done = (out: Buffer, n: string, m: string, label: string, needs = false): Compressed =>
    ({ buf: out, name: n, mime: m, compressed: out !== buf, compression: label, ms: Date.now() - t0, needs_compression: needs });
  let knobs: any = {};
  try { knobs = await getDefaults(); } catch { /* defaults unreachable → built-in numbers */ }
  const maxPx = Number(knobs.image_max_px ?? 1600) || 1600;
  const quality = Math.min(95, Math.max(30, Number(knobs.image_quality ?? 75) || 75));
  const pdfOn = knobs.pdf_compress !== false;

  if (IMAGE_EXT.has(ext)) {
    const sharp = loadSharp();
    if (!sharp) return done(buf, name, mime, "none:sharp unavailable");
    try {
      const img = sharp(buf, { failOn: "none" }).rotate(); // EXIF orientation baked in
      const meta = await img.metadata();
      const w = meta.width ?? 0, h = meta.height ?? 0;
      const within = Math.max(w, h) <= maxPx;
      const isHeic = ext === ".heic" || ext === ".heif";
      if (within && buf.length < 300 * 1024 && !isHeic) return done(buf, name, mime, "none:already small");
      let pipe = img.resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true });
      let outName = name, outMime = mime, label = `image-${maxPx}-q${quality}`;
      if (ext === ".png" && meta.hasAlpha) { pipe = pipe.png({ compressionLevel: 9, palette: true }); label = `image-${maxPx}-png`; }
      else if (ext === ".png") { pipe = pipe.jpeg({ quality, mozjpeg: true }); outName = name.replace(/\.png$/i, ".jpg"); outMime = "image/jpeg"; }
      else if (ext === ".webp") { pipe = pipe.webp({ quality }); label = `image-${maxPx}-webp-q${quality}`; }
      else { pipe = pipe.jpeg({ quality, mozjpeg: true }); if (isHeic) { outName = name.replace(/\.hei[cf]$/i, ".jpg"); outMime = "image/jpeg"; label = `image-heic-${maxPx}-q${quality}`; } }
      const out = await pipe.toBuffer();
      if (out.length >= buf.length && outName === name) return done(buf, name, mime, "none:original smaller");
      return done(out, outName, outMime, label);
    } catch (e: any) {
      const why = /heif|heic|unsupported image format/i.test(String(e?.message)) ? "heic undecodable" : `image error: ${String(e?.message ?? e).slice(0, 60)}`;
      return done(buf, name, mime, `none:${why}`);
    }
  }
  if (ext === ".pdf") {
    if (!pdfOn) return done(buf, name, mime, "none:pdf compression off");
    if (buf.length > 200 * 1024 * 1024) return done(buf, name, mime, "none:too large for pdf pass");
    if (!(await gsAvailable())) return done(buf, name, mime, "none:gs unavailable");
    const tmpIn = path.join(os.tmpdir(), `erp-${crypto.randomBytes(8).toString("hex")}-in.pdf`);
    const tmpOut = tmpIn.replace(/-in\.pdf$/, "-out.pdf");
    try {
      await writeFile(tmpIn, buf);
      await execFileP(findGs()!, ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER", `-sOutputFile=${tmpOut}`, tmpIn], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      const out = await readFile(tmpOut);
      if (!out.length || out.length >= buf.length) return done(buf, name, mime, "none:original smaller");
      return done(out, name, mime, "pdf-gs-ebook");
    } catch (e: any) {
      return done(buf, name, mime, `none:gs error: ${String(e?.message ?? e).slice(0, 60)}`);
    } finally {
      await unlink(tmpIn).catch(() => {}); await unlink(tmpOut).catch(() => {});
    }
  }
  if (VIDEO_EXT.has(ext)) return done(buf, name, mime, "none:video (compress-first client, -89)", buf.length > 20 * 1024 * 1024);
  return done(buf, name, mime, "none:not compressible here");
}

// Write bytes under the given folder segments. Drive when configured, else local disk.
// -87: the bytes are compressed FIRST (images via sharp, PDFs via Ghostscript) — the returned
// name/mime may differ from the request (PNG→JPEG, HEIC→JPEG); callers store what came back.
export async function putFile(nameIn: string, bufIn: Buffer, mimeIn: string, folderSegments: string[]): Promise<PutResult> {
  const c = await compressForStorage(nameIn, bufIn, mimeIn);
  const name = c.name, buf = c.buf, mime = c.mime;
  const meta = { name, mime, original_size: bufIn.length, size: buf.length, compressed: c.compressed, compression: c.compression, compression_ms: c.ms, needs_compression: c.needs_compression };
  if (storageConfigured()) {
    try {
      const folder = await ensureFolder(folderSegments);
      const res = await drive().files.create({
        requestBody: { name, parents: [folder.id] },
        media: { mimeType: mime || "application/octet-stream", body: Readable.from(buf) },
        fields: "id",
        supportsAllDrives: true,
      });
      cachedErr = null;
      return { backend: "drive", drive_file_id: String(res.data.id), folder_path: folder.path, ...meta };
    } catch (e: any) {
      cachedErr = e?.message ?? String(e);
      throw e; // configured-but-failing must be a visible error, not a silent local write
    }
  }
  const dir = path.join(process.cwd(), "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);
  // -83: even the (deploy-wiped) local write records WHERE the file belongs, so the row
  // already answers "which batch / which folder" and a later move to Drive needs no guess.
  return { backend: "local", folder_path: folderSegments.map((s) => String(s).trim()).filter(Boolean).join("/") || undefined, ...meta };
}

// -83 (honest file reads): STREAM bytes back, with an optional byte range, instead of
// loading the whole file into the heap. Video seeking (206) and iOS playback need Range;
// a 200 MB clip must not be a 200 MB allocation per request. Drive answers Range on
// alt=media; local disk uses createReadStream(start, end). Returns the total size and the
// resolved range so the route can write Content-Range/Content-Length itself.
export type FileStream = { stream: NodeJS.ReadableStream; size: number; start: number; end: number; partial: boolean };
export async function getFileStream(
  rec: { backend: string; drive_file_id?: string | null; size?: number | null } | null,
  name: string,
  range?: { start: number; end?: number } | { suffix: number } | null,
): Promise<FileStream> {
  const resolve = (size: number) => {
    if (!range) return { start: 0, end: size - 1, partial: false };
    if ("suffix" in range) return { start: Math.max(0, size - range.suffix), end: size - 1, partial: true };
    return { start: Math.max(0, range.start), end: Math.min(range.end ?? size - 1, size - 1), partial: true };
  };
  if (rec?.backend === "drive" && rec.drive_file_id && storageConfigured()) {
    let size = Number(rec.size ?? 0);
    if (!size) {
      const meta = await drive().files.get({ fileId: rec.drive_file_id, fields: "size", supportsAllDrives: true });
      size = Number(meta.data.size ?? 0);
    }
    const { start, end, partial } = resolve(size);
    if (partial && (start >= size || start > end)) throw Object.assign(new Error("Range not satisfiable"), { code: 416, size });
    const res = await drive().files.get(
      { fileId: rec.drive_file_id, alt: "media", supportsAllDrives: true },
      { responseType: "stream", headers: partial ? { Range: `bytes=${start}-${end}` } : {} },
    );
    return { stream: res.data as unknown as NodeJS.ReadableStream, size, start, end, partial };
  }
  const fp = path.join(process.cwd(), "uploads", name);
  const st = await stat(fp); // throws ENOENT → the route says 404
  const size = st.size;
  const { start, end, partial } = resolve(size);
  if (partial && (start >= size || start > end)) throw Object.assign(new Error("Range not satisfiable"), { code: 416, size });
  return { stream: createReadStream(fp, { start, end }), size, start, end, partial };
}

// Read bytes back. Drive by file id when the record says so, else local disk.
export async function getFile(rec: { backend: string; drive_file_id?: string | null } | null, name: string): Promise<Buffer> {
  if (rec?.backend === "drive" && rec.drive_file_id && storageConfigured()) {
    const res = await drive().files.get({ fileId: rec.drive_file_id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }
  return readFile(path.join(process.cwd(), "uploads", name));
}

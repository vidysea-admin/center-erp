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
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

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

export function storageConfigured(): boolean {
  return !!process.env.GDRIVE_SA_JSON;
}

export function storageHealth(): { backend: "drive" | "local"; configured: boolean; reason: string } {
  if (storageConfigured()) return { backend: "drive", configured: true, reason: cachedErr ? `Drive error: ${cachedErr}` : `Google Drive connected (root folder ${rootFolderId()}) — uploads survive deploys` };
  return {
    backend: "local",
    configured: false,
    reason: "Evidence storage NOT connected — uploads are written to the server's own disk and are LOST on every deploy. Set GDRIVE_SA_JSON (service-account key, base64) — the Drive folder is already known (see drive-storage-setup.md).",
  };
}

function drive(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const raw = Buffer.from(String(process.env.GDRIVE_SA_JSON), "base64").toString("utf8");
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
  cachedDrive = google.drive({ version: "v3", auth });
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

export type PutResult = { backend: "drive" | "local"; drive_file_id?: string; folder_path?: string };

// Write bytes under the given folder segments. Drive when configured, else local disk.
export async function putFile(name: string, buf: Buffer, mime: string, folderSegments: string[]): Promise<PutResult> {
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
      return { backend: "drive", drive_file_id: String(res.data.id), folder_path: folder.path };
    } catch (e: any) {
      cachedErr = e?.message ?? String(e);
      throw e; // configured-but-failing must be a visible error, not a silent local write
    }
  }
  const dir = path.join(process.cwd(), "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);
  return { backend: "local" };
}

// Read bytes back. Drive by file id when the record says so, else local disk.
export async function getFile(rec: { backend: string; drive_file_id?: string | null } | null, name: string): Promise<Buffer> {
  if (rec?.backend === "drive" && rec.drive_file_id && storageConfigured()) {
    const res = await drive().files.get({ fileId: rec.drive_file_id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }
  return readFile(path.join(process.cwd(), "uploads", name));
}

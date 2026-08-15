"use client";
import { BASE_PATH } from "@/lib/base-path";

// Client-side image compression (spec §0: budget for compression + retry on weak connections).
// Downscales to max 1600px and re-encodes JPEG q0.75. Non-images pass through untouched.
export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.75));
    return blob ?? file;
  } catch {
    return file;
  }
}

// -83 (queue integrity): an item remembers WHICH batch and WHAT it is. Before this the
// queue was global — a photo parked on batch A landed on batch B's daily log at "Retry
// now", and document uploads queued from the trainer/candidate screens were jammed into a
// daily log's govt_screenshot. Only daily-log kinds queue at all; documents fail loudly.
type QueueItem = { dataUrl: string; name: string; kind: string; ts: number; batch_id?: string; hints?: UploadHints };
const QKEY = "erp_upload_queue";
const QUEUEABLE = new Set(["photos", "videos", "govt_screenshot"]);

// Where a file belongs — becomes the Drive folder <Centre>/<Batch>/<kind> and the
// StoredFile's entity link ("which files belong to this batch?" finally has an answer).
export type UploadHints = { folder_centre?: string; folder_batch?: string; folder_kind?: string; entity?: string; entity_id?: string; batch_id?: string };

export function getQueue(batchId?: string): QueueItem[] {
  try {
    const all: QueueItem[] = JSON.parse(localStorage.getItem(QKEY) ?? "[]");
    return batchId ? all.filter((i) => i.batch_id === batchId) : all;
  } catch { return []; }
}
// Returns false when the browser refused to keep it (quota) — the caller must SAY so.
function setQueue(q: QueueItem[]): boolean {
  try { localStorage.setItem(QKEY, JSON.stringify(q)); return true; } catch { return false; }
}

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(b);
  });
}

async function post(blob: Blob, name: string, hints?: UploadHints): Promise<string> {
  const fd = new FormData();
  fd.append("file", new File([blob], name, { type: blob.type }));
  for (const k of ["folder_centre", "folder_batch", "folder_kind", "entity", "entity_id"] as const) {
    if (hints?.[k]) fd.append(k, String(hints[k]));
  }
  // TEAM-BLOCKER root cause (15/08): this was the ONE fetch in the app without the
  // basePath prefix — on production every UI upload went to /api/upload (the marketing
  // site's 404) instead of /erp/api/upload, retried three times and died. The API-level
  // smokes always hit /erp directly, which is exactly why they never caught it.
  const res = await fetch(`${BASE_PATH}/api/upload`, { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.url as string;
}

// Upload with 3 retries (1s/3s backoff). On final failure, park in the offline queue
// and throw — caller shows the queued state.
export async function uploadWithRetry(file: File, kind: string, hints?: UploadHints): Promise<string> {
  const blob = await compressImage(file);
  const name = file.name.replace(/\.[a-z0-9]+$/i, "") + (blob !== file ? ".jpg" : file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "");
  let lastErr: unknown;
  for (const delay of [0, 1000, 3000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try { return await post(blob, name, hints); } catch (e) { lastErr = e; }
  }
  const msg = lastErr instanceof Error ? lastErr.message : "Upload failed";
  // Only daily-log evidence queues, and only bound to its batch. Documents are attached to a
  // record in the same breath as they upload — parking them somewhere else would only ever
  // land them in the wrong place.
  if (!QUEUEABLE.has(kind) || !hints?.batch_id) throw new Error(msg + " — please retry now");
  const dataUrl = await blobToDataUrl(blob);
  const kept = setQueue([...getQueue(), { dataUrl, name, kind, ts: Date.now(), batch_id: hints.batch_id, hints }]);
  throw new Error(msg + (kept ? " — saved to this batch's retry queue" : " — could not be saved for retry (browser storage full); keep the file and retry when online"));
}

// Retry THIS batch's queue; returns urls of successes (with their kind). Other batches' items stay put.
export async function flushQueue(batchId: string): Promise<{ kind: string; url: string }[]> {
  const all = getQueue();
  const done: { kind: string; url: string }[] = [];
  const remaining: QueueItem[] = [];
  for (const item of all) {
    if (item.batch_id !== batchId) { remaining.push(item); continue; }
    try {
      const blob = await (await fetch(item.dataUrl)).blob();
      const url = await post(blob, item.name, item.hints);
      done.push({ kind: item.kind, url });
    } catch {
      remaining.push(item);
    }
  }
  setQueue(remaining);
  return done;
}

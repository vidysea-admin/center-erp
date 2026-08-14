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

type QueueItem = { dataUrl: string; name: string; kind: string; ts: number };
const QKEY = "erp_upload_queue";

export function getQueue(): QueueItem[] {
  try { return JSON.parse(localStorage.getItem(QKEY) ?? "[]"); } catch { return []; }
}
function setQueue(q: QueueItem[]) {
  try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* storage full — queue is best-effort */ }
}

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(b);
  });
}

async function post(blob: Blob, name: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new File([blob], name, { type: blob.type }));
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
export async function uploadWithRetry(file: File, kind: string): Promise<string> {
  const blob = await compressImage(file);
  const name = file.name.replace(/\.[a-z0-9]+$/i, "") + (blob !== file ? ".jpg" : file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "");
  let lastErr: unknown;
  for (const delay of [0, 1000, 3000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try { return await post(blob, name); } catch (e) { lastErr = e; }
  }
  const dataUrl = await blobToDataUrl(blob);
  setQueue([...getQueue(), { dataUrl, name, kind, ts: Date.now() }]);
  throw new Error((lastErr instanceof Error ? lastErr.message : "Upload failed") + " — saved to retry queue");
}

// Retry everything in the queue; returns urls of successes (with their kind).
export async function flushQueue(): Promise<{ kind: string; url: string }[]> {
  const q = getQueue();
  const done: { kind: string; url: string }[] = [];
  const remaining: QueueItem[] = [];
  for (const item of q) {
    try {
      const blob = await (await fetch(item.dataUrl)).blob();
      const url = await post(blob, item.name);
      done.push({ kind: item.kind, url });
    } catch {
      remaining.push(item);
    }
  }
  setQueue(remaining);
  return done;
}

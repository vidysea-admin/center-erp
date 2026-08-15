"use client";
import { BASE_PATH } from "@/lib/base-path";

// Client-side image compression (spec §0: budget for compression + retry on weak connections).
// Downscales to max 1600px and re-encodes JPEG q0.75. Non-images pass through untouched.
export async function compressImage(file: File): Promise<Blob> {
  const isHeic = /\.hei[cf]$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
  if (!file.type.startsWith("image/") && !isHeic) return file;
  try {
    let src: Blob = file;
    // -87 (QA-157, checker): createImageBitmap cannot decode HEIC in Chrome/Firefox/Edge, so an
    // iPhone photo used to go through whole. Convert to JPEG in the browser first (lazy-loaded
    // libheif wasm); if that fails, the server tries and records "none:heic undecodable".
    if (isHeic) {
      try {
        const heic2any = (await import("heic2any")).default as any;
        const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
        src = Array.isArray(out) ? out[0] : out;
      } catch { return file; }
    }
    const bmp = await createImageBitmap(src);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400_000 && !isHeic) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.75));
    return blob ?? (isHeic ? src : file);
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
export type UploadHints = { folder_centre?: string; folder_batch?: string; folder_kind?: string; entity?: string; entity_id?: string; batch_id?: string; client_compression?: string; client_original_size?: number };

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
  for (const k of ["folder_centre", "folder_batch", "folder_kind", "entity", "entity_id", "client_compression", "client_original_size"] as const) {
    if (hints?.[k]) fd.append(k, String(hints[k]));
  }
  // TEAM-BLOCKER root cause (15/08): this was the ONE fetch in the app without the
  // basePath prefix — on production every UI upload went to /api/upload (the marketing
  // site's 404) instead of /erp/api/upload, retried three times and died. The API-level
  // smokes always hit /erp directly, which is exactly why they never caught it.
  const res = await fetch(`${BASE_PATH}/api/upload`, { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  // -87: remember what the server did with the last file so a screen can say "3.8 MB → 420 KB".
  lastUpload = { name, sent: blob.size, original_size: data.original_size ?? blob.size, size: data.size ?? blob.size, compression: data.compression ?? "" };
  return data.url as string;
}
export type LastUpload = { name: string; sent: number; original_size: number; size: number; compression: string };
let lastUpload: LastUpload | null = null;
export function getLastUploadInfo(): LastUpload | null { return lastUpload; }
export function fmtBytes(n: number): string { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

// ---------- -91: video compress-first ON THE DEVICE (Umesh: "pehle compress phir upload,
// highest compression — par chehre pehchane jaayen"; checker: fix transport first, then this).
// No dependency, no wasm: the clip plays into a canvas at ≤ video_max_height and a MediaRecorder
// re-encodes canvas + audio at video_bitrate_kbps. Real time (a 1-min clip takes ~1 min) — fine
// for field evidence, and the numbers are Admin knobs. Skipped when the clip is already within
// target (small, ≤ height, ≤ bitrate) or when the browser cannot do it (old Safari): then the
// original goes via the -90 resumable path and the row says needs_compression.
export type VideoKnobs = { video_compress: boolean; video_max_height: number; video_bitrate_kbps: number; video_audio_kbps: number };
let knobsCache: { at: number; k: VideoKnobs } | null = null;
export async function videoKnobs(): Promise<VideoKnobs> {
  if (knobsCache && Date.now() - knobsCache.at < 5 * 60_000) return knobsCache.k;
  const d: VideoKnobs = { video_compress: true, video_max_height: 720, video_bitrate_kbps: 1500, video_audio_kbps: 64 };
  try {
    const r = await fetch(`${BASE_PATH}/api/defaults`); const j = await r.json(); const it = j.item ?? j;
    if (it) { d.video_compress = it.video_compress !== false; d.video_max_height = Number(it.video_max_height) || 720; d.video_bitrate_kbps = Number(it.video_bitrate_kbps) || 1500; d.video_audio_kbps = Number(it.video_audio_kbps) || 64; }
  } catch { /* defaults unreachable → built-ins */ }
  knobsCache = { at: Date.now(), k: d };
  return d;
}
export function pickRecorderMime(): string {
  const cands = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const MR = (globalThis as any).MediaRecorder;
  if (!MR?.isTypeSupported) return "";
  return cands.find((c) => MR.isTypeSupported(c)) ?? "";
}
export function canCompressVideo(): boolean {
  return typeof (globalThis as any).MediaRecorder !== "undefined" && !!pickRecorderMime() && typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
}
export type VideoCompressResult = { file: File; label: string; skipped: boolean; reason?: string; original_size: number };
export async function compressVideo(file: File, onProgress?: (pct: number) => void): Promise<VideoCompressResult> {
  const knobs = await videoKnobs();
  const orig = file.size;
  if (!knobs.video_compress) return { file, label: "", skipped: true, reason: "video compression is off (Admin)", original_size: orig };
  if (!canCompressVideo()) return { file, label: "", skipped: true, reason: "this browser cannot re-encode video", original_size: orig };
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url; video.muted = false; video.playsInline = true; (video as any).crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => { video.onloadedmetadata = () => res(); video.onerror = () => rej(new Error("cannot decode this video")); });
  const dur = video.duration || 0, vw = video.videoWidth, vh = video.videoHeight;
  const bitrateKbps = dur > 0 ? (orig * 8) / dur / 1000 : Infinity;
  const withinHeight = vh > 0 && vh <= knobs.video_max_height;
  const withinBitrate = bitrateKbps <= knobs.video_bitrate_kbps * 1.25;
  if (withinHeight && withinBitrate) { URL.revokeObjectURL(url); return { file, label: "", skipped: true, reason: `already ≤ ${knobs.video_max_height}p / ≤ ${knobs.video_bitrate_kbps} kbps`, original_size: orig }; }
  if (!dur || !vw || !vh) { URL.revokeObjectURL(url); return { file, label: "", skipped: true, reason: "no duration/size metadata", original_size: orig }; }
  const scale = Math.min(1, knobs.video_max_height / vh);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale / 2) * 2; canvas.height = Math.round(vh * scale / 2) * 2;
  const ctx = canvas.getContext("2d")!;
  const fps = 25;
  const canvasStream = (canvas as any).captureStream(fps) as MediaStream;
  // audio: route the element's audio into the recording (muted for the user)
  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    for (const t of dest.stream.getAudioTracks()) canvasStream.addTrack(t);
  } catch { /* no audio track → video-only re-encode */ }
  const mime = pickRecorderMime();
  const rec = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: knobs.video_bitrate_kbps * 1000, audioBitsPerSecond: knobs.video_audio_kbps * 1000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  let raf = 0;
  const draw = () => { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); onProgress?.(Math.min(99, Math.round((100 * video.currentTime) / dur))); raf = requestAnimationFrame(draw); };
  rec.start(1000);
  await video.play();
  draw();
  await new Promise<void>((res) => { video.onended = () => res(); });
  cancelAnimationFrame(raf);
  rec.stop();
  await stopped;
  try { audioCtx?.close(); } catch { /* ignore */ }
  URL.revokeObjectURL(url);
  const ext = mime.startsWith("video/mp4") ? ".mp4" : ".webm";
  const out = new File(chunks, file.name.replace(/\.[a-z0-9]+$/i, "") + ext, { type: mime.split(";")[0] });
  if (!out.size || out.size >= orig) return { file, label: "", skipped: true, reason: "re-encode did not shrink it", original_size: orig };
  onProgress?.(100);
  return { file: out, label: `video-${canvas.height}p-${knobs.video_bitrate_kbps}k`, skipped: false, original_size: orig };
}

// ---------- -90: direct-to-Drive, resumable (the shape from qa/DESIGN-video-upload.md) ----------
// The server opens a Drive session (intent), the BROWSER puts the bytes to Google in 8 MiB
// chunks, the server confirms with Drive (complete). Nothing large passes through the
// container. Google answers 308 with a Range header for every chunk it has taken; on a
// dropped connection we ask Google where it stopped (Content-Range: bytes */total) and
// carry on from there — a 4G blip no longer costs the whole file. Progress is real.
export type Progress = { sent: number; total: number; pct: number; phase: "compressing" | "opening" | "uploading" | "finalising" | "done" };
const DIRECT_MIN_BYTES = 8 * 1024 * 1024; // below this the multipart door is fine (and gets server-side compression)
const isVideoName = (n: string) => /\.(mp4|mov|3gp|webm)$/i.test(n);
async function drivePut(sessionUri: string, body: Blob | null, range: string, type: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Range": range };
  if (body) headers["Content-Type"] = type || "application/octet-stream";
  return fetch(sessionUri, { method: "PUT", headers, body: body ?? undefined });
}
async function driveCommitted(sessionUri: string, total: number): Promise<number> {
  const r = await drivePut(sessionUri, null, `bytes */${total}`, "");
  if (r.status === 308) { const m = /bytes=0-(\d+)/.exec(r.headers.get("Range") ?? ""); return m ? Number(m[1]) + 1 : 0; }
  if (r.status === 200 || r.status === 201) return total;
  throw new Error(`Drive session status ${r.status}`);
}
export async function uploadResumable(file: File, hints: UploadHints | undefined, onProgress?: (p: Progress) => void): Promise<{ url: string; name: string; fileId: string } | null> {
  onProgress?.({ sent: 0, total: file.size, pct: 0, phase: "opening" });
  const intentRes = await fetch(`${BASE_PATH}/api/upload/intent`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, ...(hints ?? {}) }),
  });
  const intent = await intentRes.json().catch(() => ({}));
  if (intentRes.status === 409 && intent?.fallback) return null; // Drive not connected → caller uses the multipart door
  if (!intentRes.ok) throw new Error(intent.error || `Could not open the upload (${intentRes.status})`);
  const { name, url, session_uri, chunk_bytes } = intent as { name: string; url: string; session_uri: string; chunk_bytes: number };
  const chunk = Math.max(256 * 1024, Number(chunk_bytes) || DIRECT_MIN_BYTES);
  const total = file.size;
  let start = 0, attempts = 0, fileId = "";
  while (start < total) {
    const end = Math.min(start + chunk, total);
    try {
      const r = await drivePut(session_uri, file.slice(start, end), `bytes ${start}-${end - 1}/${total}`, file.type);
      if (r.status === 308) {
        const m = /bytes=0-(\d+)/.exec(r.headers.get("Range") ?? "");
        start = m ? Number(m[1]) + 1 : end;
        attempts = 0;
      } else if (r.status === 200 || r.status === 201) {
        const j = await r.json().catch(() => ({}));
        fileId = String(j.id ?? "");
        start = total;
      } else if (r.status >= 500 || r.status === 429) {
        throw new Error(`Drive answered ${r.status}`);
      } else {
        const t = await r.text().catch(() => "");
        await fetch(`${BASE_PATH}/api/upload/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {});
        throw new Error(`Drive refused the upload (${r.status}) ${t.slice(0, 120)}`);
      }
      onProgress?.({ sent: start, total, pct: Math.round((100 * start) / total), phase: "uploading" });
    } catch (e) {
      // network blip / 5xx: ask Google where it stopped and continue from there, with backoff
      attempts++;
      if (attempts > 8) {
        await fetch(`${BASE_PATH}/api/upload/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {});
        throw new Error(`Upload lost the connection too many times — ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempts)));
      try { start = await driveCommitted(session_uri, total); } catch { /* keep the last known start */ }
    }
  }
  if (!fileId) {
    // the final chunk's 200 was lost in transit — Google has it; ask once more
    const r = await drivePut(session_uri, null, `bytes */${total}`, "");
    const j = await r.json().catch(() => ({}));
    fileId = String(j.id ?? "");
  }
  onProgress?.({ sent: total, total, pct: 100, phase: "finalising" });
  const done = await fetch(`${BASE_PATH}/api/upload/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, drive_file_id: fileId }) });
  const dj = await done.json().catch(() => ({}));
  if (!done.ok) throw new Error(dj.error || `Could not finalise the upload (${done.status})`);
  lastUpload = { name: file.name, sent: total, original_size: total, size: dj.size ?? total, compression: dj.compression ?? "none:direct-to-drive" };
  onProgress?.({ sent: total, total, pct: 100, phase: "done" });
  return { url: dj.url ?? url, name, fileId };
}

// Upload with 3 retries (1s/3s backoff). On final failure, park in the offline queue
// and throw — caller shows the queued state.
// -90: large files and every video first try the direct-to-Drive resumable path (progress,
// resume, no server RAM); when Drive is not connected they fall back to the multipart door.
export async function uploadWithRetry(fileIn: File, kind: string, hintsIn?: UploadHints, onProgress?: (p: Progress) => void): Promise<string> {
  let file = fileIn; let hints = hintsIn;
  // -91: video is compressed on the device FIRST (Umesh's order), then travels.
  if (isVideoName(file.name) || file.type.startsWith("video/")) {
    try {
      const vc = await compressVideo(file, (pct) => onProgress?.({ sent: 0, total: file.size, pct, phase: "compressing" }));
      if (!vc.skipped) { file = vc.file; hints = { ...(hints ?? {}), client_compression: vc.label, client_original_size: vc.original_size }; }
    } catch { /* fall through: upload as recorded; the row will say needs_compression */ }
  }
  if (file.size >= DIRECT_MIN_BYTES || isVideoName(file.name) || file.type.startsWith("video/")) {
    try {
      const direct = await uploadResumable(file, hints, onProgress);
      if (direct) return direct.url;
    } catch (e) {
      // a refused/failed direct upload of a big file should not silently become a 500 MB multipart post
      if (file.size > 64 * 1024 * 1024) throw e;
    }
  }
  onProgress?.({ sent: 0, total: file.size, pct: 0, phase: "compressing" });
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

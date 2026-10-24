// qa-batch-media-zip (field ask 2026-10-24): a batch's photos and videos grouped by class day.
// ONE grouping, used by both the Daily Execution "Photos & videos by day" list and the
// /api/batches/[id]/logs/media-zip route, so the folders a user sees and the folders in the ZIP
// cannot disagree. Pure (no models, no server imports) so the client page can import it too.
// Photos and videos only: attendance sheets and the govt screenshot are not "media" here
// (the field team asked for photos and videos, "aur kuch nahi").

export type MediaDay = { date: string; photos: string[]; videos: string[] };

// A log's day as YYYY-MM-DD, read the same way the Daily Execution form reads it
// (String(log_date).slice(0, 10)) - a Date from Mongo and its JSON string give the same key.
export function logDayKey(logDate: unknown): string {
  if (logDate instanceof Date) return logDate.toISOString().slice(0, 10);
  return String(logDate ?? "").slice(0, 10);
}

// Newest day first (the order the Daily Execution history already uses). A day with neither a
// photo nor a video is not a folder.
export function mediaDays(logs: { log_date: unknown; photos?: string[] | null; videos?: string[] | null }[]): MediaDay[] {
  const byDay = new Map<string, MediaDay>();
  for (const l of logs ?? []) {
    const photos = (l.photos ?? []).filter(Boolean), videos = (l.videos ?? []).filter(Boolean);
    if (!photos.length && !videos.length) continue;
    const date = logDayKey(l.log_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const d = byDay.get(date) ?? { date, photos: [], videos: [] };
    for (const p of photos) if (!d.photos.includes(p)) d.photos.push(p);
    for (const v of videos) if (!d.videos.includes(v)) d.videos.push(v);
    byDay.set(date, d);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// The stored-file name inside a log's URL ("/erp/api/files/<32 hex>.<ext>"), or null.
export function storedNameFromUrl(url: string): string | null {
  return /([a-f0-9]{32}\.[a-z0-9]+)(?:[?#].*)?$/i.exec(String(url ?? ""))?.[1]?.toLowerCase() ?? null;
}

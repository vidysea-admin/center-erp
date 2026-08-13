// Workbook Watch engine (2026-08-11 meeting): fetch the client's live workbook, snapshot
// every tab/column, and turn each difference into a reviewable WorkbookChange.
// The client edits the sheet directly and tells nobody — this is the tracking that replaces
// the manual "किसने क्या बदला" hunt. The watch itself is advisory (WorkbookChanges never touch
// entities); entity writes happen only through user-approved TabMappings (lib/tab-mapping.ts),
// and even those turn changes to existing records into review items, never silent overwrites.
import * as XLSX from "xlsx";
import { Location, Notification, SyncSource, WorkbookChange, WorkbookSnapshot } from "@/models";
import { HttpError } from "@/lib/authz";
import { safeFetch } from "@/lib/safe-fetch";
import { getDefaults } from "@/lib/defaults";
import { runTabMappings } from "@/lib/tab-mapping";

// Content hash for change detection only (not security) — cyrb53, dependency-free so the
// Edge instrumentation trace stays clean (node:crypto is not Edge-safe).
function contentHash(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Public appId of the OneDrive web client — not a secret. Anonymous share links reject
// non-browser fetches (403), but the badger token flow the web client itself uses works
// without any credentials. Verified against the real Vidysea-RPL share on 2026-08-11.
const ONEDRIVE_BADGER_APP_ID = "5cbed6ac-a083-4e14-b191-b4ba07653de2";

let badgerToken: { token: string; fetched_at: number } | null = null;

async function getBadgerToken(): Promise<string> {
  // Tokens live ~1h; refresh after 45 min.
  if (badgerToken && Date.now() - badgerToken.fetched_at < 45 * 60_000) return badgerToken.token;
  const res = await fetch("https://api-badgerp.svc.ms/v1.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ appId: ONEDRIVE_BADGER_APP_ID }),
  });
  if (!res.ok) throw new Error(`Badger token request failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token) throw new Error("Badger token response had no token");
  badgerToken = { token: data.token, fetched_at: Date.now() };
  return data.token;
}

function isOneDriveShare(url: string): boolean {
  return /^(https:\/\/)(onedrive\.live\.com|1drv\.ms)\//i.test(url);
}

async function fetchOneDriveShare(url: string): Promise<Buffer> {
  // Strip query params (rtime etc.) — the share id is in the path.
  const clean = url.split("?")[0];
  const b64 = Buffer.from(clean, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const token = await getBadgerToken();
  const meta = await fetch(
    `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/u!${b64}/driveitem?%24select=id,name,size,%40content.downloadUrl`,
    { headers: { Authorization: `Badger ${token}`, Prefer: "autoredeem", "User-Agent": BROWSER_UA } },
  );
  if (!meta.ok) throw new Error(`OneDrive share lookup failed: HTTP ${meta.status}`);
  const item = await meta.json();
  const dl = item?.["@content.downloadUrl"];
  if (!dl) throw new Error("OneDrive share returned no download URL");
  // The download URL comes back from Microsoft, but it is still a URL this server is about to
  // fetch on a user's behalf — guard it like any other.
  const file = await safeFetch(dl, { headers: { "User-Agent": BROWSER_UA } });
  if (!file.ok) throw new Error(`OneDrive download failed: HTTP ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

/**
 * Turn whatever a person pasted out of their browser into something fetchable.
 *
 * Nobody copies a download URL — they copy what is in the address bar while looking at the
 * sheet. Requiring the "right" URL is how a sync source ends up silently broken, so the
 * translation happens here instead of in the user's head. Returns the URL unchanged when there
 * is nothing to do, so anything already correct (a published CSV, a raw file endpoint) is
 * passed straight through.
 */
export function normalizeSheetUrl(raw: string): string {
  const url = String(raw ?? "").trim();
  if (!url) return url;

  // Google Sheets: an /edit (or /view, or bare) link cannot be downloaded — the export endpoint
  // can. A single-tab export is requested as xlsx so every tab survives; ?gid= is dropped
  // deliberately, because pinning one tab is the opposite of watching the whole workbook.
  const g = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(url);
  if (g && !/\/export\b/.test(url) && !/\/pub\b/.test(url) && !/\/gviz\b/.test(url)) {
    return `https://docs.google.com/spreadsheets/d/${g[1]}/export?format=xlsx`;
  }
  // Google Drive file link (an .xlsx uploaded to Drive rather than a native Sheet).
  const d = /^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url);
  if (d) return `https://drive.google.com/uc?export=download&id=${d[1]}`;

  // Dropbox serves a preview page on dl=0 and the file itself on dl=1.
  if (/^https:\/\/(www\.)?dropbox\.com\//i.test(url)) {
    return url.replace(/([?&])dl=0(&|$)/, "$1dl=1$2") + (/[?&]dl=/.test(url) ? "" : (url.includes("?") ? "&dl=1" : "?dl=1"));
  }
  // SharePoint/OneDrive for Business: ?download=1 skips the web viewer.
  if (/sharepoint\.com\//i.test(url) && !/download=1/.test(url)) {
    return url + (url.includes("?") ? "&download=1" : "?download=1");
  }
  // Personal OneDrive share links are handled by the badger flow, which wants the path as-is.
  return url;
}

export async function fetchWorkbook(rawUrl: string): Promise<XLSX.WorkBook> {
  const url = normalizeSheetUrl(rawUrl);
  const buf = isOneDriveShare(url)
    ? await fetchOneDriveShare(url)
    : await (async () => {
        const res = await safeFetch(url, { headers: { "User-Agent": BROWSER_UA } });
        // A private sheet answers 401/403 outright — the HTML sign-in sniff below never gets a
        // chance. "HTTP 401" tells the person nothing actionable, so name the actual cause here.
        if (res.status === 401 || res.status === 403) {
          throw new Error("The link is private — the host refused access (sign-in required). Open sharing to “anyone with the link (Viewer)”, or publish the sheet to the web, then test again.");
        }
        if (res.status === 404) throw new Error("Nothing at that link (404) — the sheet may have been moved, renamed or deleted.");
        if (!res.ok) throw new Error(`The host returned HTTP ${res.status} for this link.`);
        return Buffer.from(await res.arrayBuffer());
      })();
  // Auth walls serve HTML with a spreadsheet content-type — catch it before XLSX guesses.
  const head = buf.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    // The commonest failure by far, and the one worth naming precisely: the sheet is private,
    // so the host served a sign-in page. Saying "login wall?" sends people hunting for a bug
    // that is not there.
    const signIn = /accounts\.google\.com|sign in|servicelogin|login\.microsoftonline/.test(head);
    throw new Error(signIn
      ? "The link is private — the host returned a sign-in page instead of the file. Open sharing to “anyone with the link (Viewer)”, or publish the sheet to the web, then test again."
      : "That link returned a web page, not a spreadsheet. Use the sheet's own link (not a folder or search page).");
  }
  return XLSX.read(buf, { type: "buffer" }); // handles xlsx, xls and csv alike
}

// ---- snapshot shape ----
type SnapRow = { key: string; cells: Record<string, string> };
type TabSnap = { header: string[]; header_row: number; rows: SnapRow[]; hash: string };

// The header row is the one that contains the configured key columns; failing that, the
// densest of the first 10 rows (the real Vidysea-RPL sheet has a totals row ABOVE the header).
function detectHeaderRow(rows: string[][], keyColumns: string[]): number {
  const limit = Math.min(rows.length, 10);
  if (keyColumns.length) {
    for (let i = 0; i < limit; i++) {
      const cells = rows[i].map((c) => c.trim());
      if (keyColumns.every((k) => cells.includes(k))) return i;
    }
  }
  let best = 0, bestCount = -1;
  for (let i = 0; i < limit; i++) {
    const count = rows[i].filter((c) => typeof c === "string" && c.trim() !== "").length;
    if (count > bestCount) { best = i; bestCount = count; }
  }
  return best;
}

// A serial number renumbers the moment a row is inserted, so keying on it makes every row below
// look "changed" — the noise that reads as "this tab isn't syncing properly".
const SERIAL_HEADER = /^(s\.?\s*(no|n)\.?|sl\.?\s*#?|sr\.?\s*no\.?|#|serial|sno)$/i;
// Headers that actually identify a row, in preference order.
const IDENTIFYING_HEADER = /(name|trainer|candidate|institution|location|centre|center|job\s*role|course|scheme|tc\s*id|tr\s*id|email|phone|mobile|code|id)$/i;

// One workbook can hold fifteen differently-shaped tabs, and a single source-level key_columns
// list cannot fit them all. When the configured keys are absent from THIS tab, pick that tab's own
// identifying columns instead of falling back to "first non-empty cell" (which was usually the
// serial number). 2026-08-13.
function autoKeyIndexes(header: string[]): number[] {
  const usable = header.map((h, i) => ({ h: h.trim(), i })).filter((x) => x.h && !SERIAL_HEADER.test(x.h));
  const identifying = usable.filter((x) => IDENTIFYING_HEADER.test(x.h)).slice(0, 3).map((x) => x.i);
  if (identifying.length) return identifying;
  return usable.slice(0, 3).map((x) => x.i); // composite of the first real columns, never just one
}

export function snapshotTab(sheet: XLSX.WorkSheet, keyColumns: string[]): TabSnap {
  const raw: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as string[][];
  const headerRow = detectHeaderRow(raw, keyColumns);
  const header = (raw[headerRow] ?? []).map((h) => String(h).trim());
  const configured = keyColumns.map((k) => header.indexOf(k)).filter((i) => i >= 0);
  const keyIdx = configured.length ? configured : autoKeyIndexes(header);
  const rows: SnapRow[] = [];
  const seen = new Map<string, number>();
  for (let r = headerRow + 1; r < raw.length; r++) {
    const line = raw[r] ?? [];
    if (line.every((c) => String(c).trim() === "")) continue;
    const cells: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      // A serial number is the row's position, not its data: inserting one row renumbers every
      // row below it, and reporting those as edits buried the one real change under a flood.
      if (SERIAL_HEADER.test(header[c])) continue;
      cells[header[c]] = String(line[c] ?? "").trim();
    }
    let key = keyIdx.map((i) => String(line[i] ?? "").trim()).filter(Boolean).join(" · ");
    if (!key.trim()) key = `row ${r + 1}`;
    // Duplicate keys (two rows for the same institution+role) get a stable ordinal suffix.
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key} (#${n})`;
    rows.push({ key, cells });
  }
  const hash = contentHash(JSON.stringify({ header, rows }));
  return { header, header_row: headerRow, rows, hash };
}

export type SnapDiff = {
  row_key: string; column: string | null;
  old_value: string; new_value: string;
  change_type: "Added" | "Modified" | "Removed";
};

// One diff, two consumers: the watch engine records these as WorkbookChanges, and the history
// viewer shows the same diff between any two stored versions. Shared so they can never disagree.
export function diffSnapshots(prevRows: SnapRow[], currRows: SnapRow[]): SnapDiff[] {
  const prevMap = new Map<string, SnapRow>(prevRows.map((r) => [r.key, r]));
  const currMap = new Map<string, SnapRow>(currRows.map((r) => [r.key, r]));
  const out: SnapDiff[] = [];
  for (const [key, curr] of currMap) {
    const old = prevMap.get(key);
    if (!old) {
      out.push({ row_key: key, column: null, old_value: "", new_value: summarizeRow(curr), change_type: "Added" });
      continue;
    }
    const columns = new Set([...Object.keys(old.cells), ...Object.keys(curr.cells)]);
    for (const col of columns) {
      const before = old.cells[col] ?? "";
      const after = curr.cells[col] ?? "";
      if (before !== after) out.push({ row_key: key, column: col, old_value: before, new_value: after, change_type: "Modified" });
    }
  }
  for (const [key, old] of prevMap) {
    if (!currMap.has(key)) out.push({ row_key: key, column: null, old_value: summarizeRow(old), new_value: "", change_type: "Removed" });
  }
  return out;
}

export type WatchResult = { status: "OK" | "Failed"; tabs: number; changes: number; error?: string };

// Fetch → per-tab snapshot → diff against the previous snapshot → persist changes.
// First run of a tab stores the baseline silently (no "everything added" flood).
export async function runWatch(sourceId: string): Promise<WatchResult> {
  const src = await SyncSource.findById(sourceId);
  if (!src) throw new HttpError(404, "Sync source not found");
  if (src.mode !== "watch") throw new HttpError(400, "Source is not in watch mode");
  const keyColumns: string[] = src.key_columns ?? [];

  let wb: XLSX.WorkBook;
  try {
    wb = await fetchWorkbook(src.source_url);
  } catch (e) {
    src.last_status = "Failed";
    src.last_error = e instanceof Error ? e.message : String(e);
    src.last_synced_at = new Date();
    await src.save();
    return { status: "Failed", tabs: 0, changes: 0, error: src.last_error ?? undefined };
  }

  // Tabs are read from the workbook itself every run (never a stored list), so the watch
  // follows the client's sheet as it grows or shrinks. A tab appearing or disappearing is
  // itself news the client never tells us — raise it, don't just absorb it silently.
  // The very first run of a source is the baseline, so it must not announce every tab.
  const isFirstRun = (await WorkbookSnapshot.countDocuments({ sync_source: src._id })) === 0;
  const seenTabs = new Set(wb.SheetNames);

  let totalChanges = 0;
  const changedTabs = new Set<string>(); // tabs that got a new snapshot — tab mappings re-run for these
  for (const tab of wb.SheetNames) {
    const snap = snapshotTab(wb.Sheets[tab], keyColumns);
    const prev = await WorkbookSnapshot.findOne({ sync_source: src._id, tab }).sort({ taken_at: -1 }).lean<any>();

    if (prev && prev.hash === snap.hash) continue; // unchanged tab — keep the old snapshot
    changedTabs.add(tab);

    if (!prev && !isFirstRun) {
      // A tab that did not exist last time. Announce the tab once and baseline its rows —
      // listing every row as "Added" would bury the actual news under a flood.
      totalChanges += await recordChange(
        src._id, tab, `Tab: ${tab}`, null, "",
        `New tab "${tab}" appeared — ${snap.rows.length} rows, ${snap.header.filter(Boolean).length} columns. Row-level changes are tracked from now on.`,
        "Added",
      );
    }

    if (prev) {
      for (const d of diffSnapshots(prev.rows as SnapRow[], snap.rows)) {
        totalChanges += await recordChange(src._id, tab, d.row_key, d.column, d.old_value, d.new_value, d.change_type);
      }
    }

    await WorkbookSnapshot.create({ sync_source: src._id, tab, ...snap, taken_at: new Date() });
    // Retention: a snapshot is only taken when the tab's content actually changed, so this is
    // version-history depth, not poll count. Umesh wants Excel-style history — Defaults-tunable.
    const keep = (await getDefaults()).snapshot_retention_per_tab ?? 100;
    const stale = await WorkbookSnapshot.find({ sync_source: src._id, tab })
      .sort({ taken_at: -1 }).skip(keep).select("_id").lean<any[]>();
    if (stale.length) await WorkbookSnapshot.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
  }

  // Tabs we have snapshots for that are no longer in the workbook — the client deleted or
  // renamed one. Announce it, then forget the tab so the alert does not re-fire every tick
  // (and so the same name reappearing later reads correctly as a new tab).
  const knownTabs: string[] = await WorkbookSnapshot.distinct("tab", { sync_source: src._id });
  for (const tab of knownTabs) {
    if (seenTabs.has(tab)) continue;
    const last = await WorkbookSnapshot.findOne({ sync_source: src._id, tab }).sort({ taken_at: -1 }).lean<any>();
    totalChanges += await recordChange(
      src._id, tab, `Tab: ${tab}`, null,
      `Tab "${tab}" existed with ${last?.rows?.length ?? 0} rows`,
      `Tab "${tab}" is gone from the workbook — deleted or renamed. Its tracking history stops here.`,
      "Removed",
    );
    await WorkbookSnapshot.deleteMany({ sync_source: src._id, tab });
  }

  // Approved tab mappings ingest on the same fetch: new rows become entities, changed rows
  // become Sync-Inbox review items. Runs only for tabs whose content moved this cycle.
  await runTabMappings(src, wb, changedTabs);

  src.last_status = "OK";
  src.last_error = undefined;
  src.last_synced_at = new Date();
  await src.save();

  // Tell people the moment something changes. Until now the only alert fired after a change
  // had been ignored for 48 hours, which is exactly the silence the client's habit of
  // editing the sheet unannounced already creates.
  if (totalChanges > 0) await notifyWatchChanges(src._id, src.name);

  return { status: "OK", tabs: wb.SheetNames.length, changes: totalChanges };
}

// Reviewers get one summary; each centre whose own row moved gets its own alert, so a SPOC
// hears about their location without being handed the whole workbook.
async function notifyWatchChanges(sourceId: unknown, sourceName: string): Promise<void> {
  const fresh = await WorkbookChange.find({ sync_source: sourceId, status: "New" })
    .sort({ createdAt: -1 }).limit(200).lean<any[]>();
  if (!fresh.length) return;

  const byTab = new Map<string, number>();
  for (const c of fresh) byTab.set(c.tab, (byTab.get(c.tab) ?? 0) + 1);
  const tabSummary = [...byTab.entries()].map(([t, n]) => `${t} (${n})`).join(", ");

  await Notification.create({
    type: "workbook_change_new", severity: "warning",
    message: `${fresh.length} change(s) detected in "${sourceName}" — ${tabSummary}. Review before acting.`,
    entity: "SyncSource", entity_id: sourceId, link: "/sheet-watch",
    role_target: ["Admin", "Operations"],
  });

  // Map changed rows to known centres by name or external id. The row key starts with the
  // institution name, so an exact-name or TC-ID match is enough; unmatched rows simply stay
  // in the reviewers' summary above.
  const names = [...new Set(fresh.map((c) => String(c.row_key).replace(/ \(#\d+\)$/, "").split(" · ")[0].trim()).filter(Boolean))];
  if (!names.length) return;
  const locs = await Location.find({ $or: [{ name: { $in: names } }, { external_id: { $in: names } }] })
    .select("_id name external_id").lean<any[]>();
  if (!locs.length) return;

  const byLoc = new Map<string, { name: string; count: number }>();
  for (const c of fresh) {
    const head = String(c.row_key).replace(/ \(#\d+\)$/, "").split(" · ")[0].trim();
    const loc = locs.find((l) => l.name === head || l.external_id === head);
    if (!loc) continue;
    const cur = byLoc.get(String(loc._id)) ?? { name: loc.name, count: 0 };
    cur.count++;
    byLoc.set(String(loc._id), cur);
  }
  for (const [locId, info] of byLoc) {
    await Notification.create({
      type: "workbook_change_location", severity: "warning",
      message: `The client's sheet changed ${info.count} value(s) for your centre ${info.name}. Open Sheet Watch to see what moved.`,
      entity: "Location", entity_id: locId, link: "/sheet-watch",
      location: locId, role_target: ["Admin", "Operations", "Location"],
    });
  }
}

function summarizeRow(row: SnapRow): string {
  const parts = Object.entries(row.cells).filter(([, v]) => v !== "").slice(0, 6)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(", ").slice(0, 500);
}

// Skip when an identical unreviewed change already exists — the poller re-runs every
// interval and a standing difference must raise once, not once per tick.
async function recordChange(
  sourceId: unknown, tab: string, rowKey: string, column: string | null,
  oldValue: string, newValue: string, type: "Added" | "Removed" | "Modified",
): Promise<number> {
  const dup = await WorkbookChange.findOne({
    sync_source: sourceId, tab, row_key: rowKey, column, new_value: newValue,
    change_type: type, status: { $in: ["New", "Seen"] },
  }).select("_id").lean();
  if (dup) return 0;
  await WorkbookChange.create({
    sync_source: sourceId, tab, row_key: rowKey, column,
    old_value: oldValue, new_value: newValue, change_type: type,
  });
  return 1;
}

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { fetchWorkbook, normalizeSheetUrl } from "@/lib/workbook";

// Probe a sheet link before saving it as a sync source (2026-08-12).
//
// A sync source that cannot be fetched fails silently in a background poller — the source looks
// configured, and nothing ever appears. So the link is proved here, in front of the person who
// pasted it, and the tabs and columns it found come back so they can see it is the right sheet.
// POST { source_url } → { ok, normalized_url, tabs: [{ name, rows, columns }] }
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");

  const { source_url } = await req.json();
  const raw = String(source_url ?? "").trim();
  if (!raw) throw new HttpError(400, "Paste the sheet link first.");
  if (!/^https?:\/\//i.test(raw)) throw new HttpError(400, "That does not look like a link — it should start with https://");

  const normalized = normalizeSheetUrl(raw);
  let wb;
  try {
    wb = await fetchWorkbook(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      normalized_url: normalized,
      error: msg,
      // The fix is nearly always a sharing setting, and it differs per host.
      hint: /google/i.test(normalized)
        ? "In Google Sheets: Share → General access → “Anyone with the link” → Viewer. File → Share → Publish to web also works."
        : /onedrive|1drv|sharepoint/i.test(normalized)
          ? "In OneDrive: Share → “Anyone with the link” → can view. A link restricted to named people cannot be read by the server."
          : "The server must be able to open this link without signing in. Check the sharing setting, and that the server has outbound internet access.",
    }, { status: 200 }); // a failed probe is a valid answer, not a server error
  }

  const tabs = wb.SheetNames.map((name) => {
    const rows = (wb.Sheets[name]["!ref"]
      ? XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, defval: "", raw: false })
      : []) as string[][];
    // The header is rarely row 1 — this workbook keeps a totals row above it — so the widest of
    // the first few rows is the best guess at the column names to show back.
    const head = rows.slice(0, 5).reduce((best: string[], r: string[]) =>
      r.filter((c) => String(c).trim()).length > best.filter((c) => String(c).trim()).length ? r : best, [] as string[]);
    return {
      name,
      rows: Math.max(0, rows.length - 1),
      columns: head.map((c) => String(c).trim()).filter(Boolean),
    };
  });

  return NextResponse.json({
    ok: true,
    normalized_url: normalized,
    changed: normalized !== raw,
    tabs,
  });
});

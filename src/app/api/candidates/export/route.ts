import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { enrichCandidateRows } from "@/lib/rules";
import { resolveExportCols } from "@/lib/candidate-columns";
import { Candidate } from "@/models";
import type { SessionUser } from "@/auth";

// R8 (QA-2845): "Download Excel" on the Candidates page - exactly the columns the table shows.
//
// AUTH AND SCOPE ARE export-sidh's, deliberately and line for line (that door is the audited one):
// candidates.manage, the Rule 38 location filter, archived rows never leave, and an explicit ?location
// is asserted against the caller's scope. This is a candidate-PII file, so every one of those is load
// bearing - a Location user scoped to centre X must never receive centre Y's people in it.
//
// WHICH COLUMNS: `cols` is validated against the whitelist in lib/candidate-columns.ts, the SAME list
// the screen's table is built from. An unknown or forbidden key (aadhaar_no, apaar_id, anything not on
// the list) is a 400 that names it - never silently dropped.
//
// WHICH ROWS: the table filters and searches in the browser, so the page sends the ids of the rows it is
// SHOWING (`ids`). Those ids are a request, not an authority: the query still ANDs the scope filter and
// archived_at:null, so an id from another centre simply matches nothing. With no `ids` it is every
// non-archived candidate in scope (optionally one `location`).
//
// GET carries a short list (links, scripts); POST carries the same fields as JSON for a full table,
// since a 2,000-id query string does not fit a URL. Both run `buildExport`.
const MAX_ROWS = 5000;
// Not Types.ObjectId.isValid: that accepts ANY 12-character string as an id.
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);

type ExportInput = { cols: unknown; ids?: unknown; location?: unknown };

async function buildExport(user: SessionUser, input: ExportInput): Promise<NextResponse> {
  await requirePerm(user, "candidates.manage");

  const check = resolveExportCols(input.cols);
  if (!check.ok) throw new HttpError(400, check.error);

  const filter: Record<string, unknown> = { ...locationFilter(user) };
  // Same as export-sidh: an archived candidate never leaves in a file.
  filter.archived_at = null;
  const loc = typeof input.location === "string" ? input.location.trim() : "";
  if (loc) {
    if (!isId(loc)) throw new HttpError(400, "That location is not valid.");
    assertLocationInScope(user, loc);
    // A scoped user's own filter is { $in: scope }; a validated, in-scope location narrows it.
    filter.location = loc;
  }

  let order: string[] | null = null;
  if (input.ids !== undefined && input.ids !== null) {
    if (!Array.isArray(input.ids)) throw new HttpError(400, "ids must be a list of candidate ids.");
    if (input.ids.length > MAX_ROWS) throw new HttpError(400, `Too many rows to download at once (${input.ids.length}); narrow the table first - the limit is ${MAX_ROWS}.`);
    const bad = input.ids.find((i) => !isId(i));
    if (bad !== undefined) throw new HttpError(400, "ids must be candidate ids.");
    order = input.ids as string[];
    filter._id = { $in: order };
  }

  const found = await Candidate.find(filter)
    .sort({ createdAt: -1 }).limit(MAX_ROWS)
    .populate("location", "name code")
    .populate("program", "name code")
    .lean<any[]>();
  let rows = await enrichCandidateRows(found);
  if (order) {
    // Keep the screen's order: the file reads the way the table did.
    const pos = new Map(order.map((id, i) => [String(id), i]));
    rows = rows.sort((a, b) => (pos.get(String(a._id)) ?? 0) - (pos.get(String(b._id)) ?? 0));
  }

  const header = check.cols.map((c) => c.label);
  const aoa: string[][] = [header, ...rows.map((r) => check.cols.map((c) => c.value(r)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "candidates");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="candidates.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const list = (k: string) => (sp.get(k) ? sp.get(k)!.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  return buildExport(user, { cols: list("cols"), ids: list("ids"), location: sp.get("location") ?? undefined });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  let body: any;
  try { body = await req.json(); } catch { throw new HttpError(400, "Send the columns as JSON."); }
  if (!body || typeof body !== "object") throw new HttpError(400, "Send the columns as JSON.");
  return buildExport(user, { cols: body.cols, ids: body.ids, location: body.location });
});

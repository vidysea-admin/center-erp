import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { WorkbookSnapshot } from "@/models";
import { diffSnapshots } from "@/lib/workbook";

// The Excel-style version history Umesh asked for (2026-08-13): "log by log, before kya tha,
// after kya tha — rollback kar paayein." A snapshot is stored every time a tab's content
// actually changes, so this is the sheet's change history, browsable and exportable.
//
//   GET ?                         → tabs with version counts
//   GET ?tab=X                    → version list for a tab (id, taken_at, rows, columns)
//   GET ?tab=X&from=ID&to=ID      → cell-level diff between two versions (same engine as Watch)
//   GET ?snap=ID&format=csv       → download a version as CSV — the practical rollback: we
//                                   cannot write into the client's Google/OneDrive file, but an
//                                   exported version can be pasted back or kept as evidence.
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources"); // same right as the rest of source administration
  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;

  const snapId = sp.get("snap");
  if (snapId) {
    const snap = await WorkbookSnapshot.findOne({ _id: snapId, sync_source: id }).lean<any>();
    if (!snap) throw new HttpError(404, "Version not found");
    if (sp.get("format") === "csv") {
      const header: string[] = (snap.header ?? []).filter(Boolean);
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = [header.map(esc).join(",")];
      for (const row of snap.rows ?? []) lines.push(header.map((h: string) => esc(row.cells?.[h] ?? "")).join(","));
      return new NextResponse(lines.join("\r\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${String(snap.tab).replace(/[^\w.-]+/g, "_")}-${new Date(snap.taken_at).toISOString().slice(0, 16).replace(":", "")}.csv"`,
        },
      });
    }
    return NextResponse.json({ item: { _id: snap._id, tab: snap.tab, taken_at: snap.taken_at, header: snap.header, rows: snap.rows } });
  }

  const tab = sp.get("tab");
  if (!tab) {
    const tabs = await WorkbookSnapshot.aggregate([
      { $match: { sync_source: Types.ObjectId.createFromHexString(id) } },
      { $group: { _id: "$tab", versions: { $sum: 1 }, latest: { $max: "$taken_at" } } },
      { $sort: { _id: 1 } },
    ]);
    return NextResponse.json({ tabs: tabs.map((t) => ({ tab: t._id, versions: t.versions, latest: t.latest })) });
  }

  const from = sp.get("from"), to = sp.get("to");
  if (from && to) {
    const [a, b] = await Promise.all([
      WorkbookSnapshot.findOne({ _id: from, sync_source: id, tab }).lean<any>(),
      WorkbookSnapshot.findOne({ _id: to, sync_source: id, tab }).lean<any>(),
    ]);
    if (!a || !b) throw new HttpError(404, "One of the versions was not found");
    // Older → newer, whichever order was clicked: a diff read backwards misreports every change.
    const [prev, curr] = new Date(a.taken_at) <= new Date(b.taken_at) ? [a, b] : [b, a];
    return NextResponse.json({
      from: { _id: prev._id, taken_at: prev.taken_at },
      to: { _id: curr._id, taken_at: curr.taken_at },
      changes: diffSnapshots(prev.rows ?? [], curr.rows ?? []),
    });
  }

  const versions = await WorkbookSnapshot.find({ sync_source: id, tab })
    .sort({ taken_at: -1 }).select("taken_at header rows").lean<any[]>();
  return NextResponse.json({
    items: versions.map((v) => ({
      _id: v._id, taken_at: v.taken_at,
      rows: v.rows?.length ?? 0, columns: (v.header ?? []).filter(Boolean).length,
    })),
  });
});

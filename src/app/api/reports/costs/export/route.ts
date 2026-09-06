import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { COST_LABELS, costRollup, type CostFilters } from "@/lib/rules";

// QA-1830 — the finance dashboard as an .xlsx, carrying THE SAME NUMBERS as the screen because it
// calls the same `costRollup`. An export that recomputes is an export that eventually disagrees,
// and then nobody can tell which of the two is the report.
//
// The same finance door as the screen. This one matters more than it looks: the money-leak probe in
// `scripts/e2e-roles.mjs` walks endpoints and greps their JSON, so it CANNOT see inside a binary
// xlsx — an export that skipped the gate would be the one leak the probe is structurally unable to
// find. The gate is therefore asserted directly in the suite for this route (QA-1830).
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "view");

  const p = req.nextUrl.searchParams;
  const filters: CostFilters = {};
  for (const k of ["from", "to", "location", "batch", "trainer", "program", "category"] as const) {
    const v = p.get(k);
    if (v) filters[k] = v;
  }
  const data = await costRollup(locationFilter(user), filters);
  const L = COST_LABELS;
  const money = (n: number | null) => (n === null ? "—" : n);

  const wb = XLSX.utils.book_new();

  // Budget vs actual, head then subhead. Two levels in one flat sheet, because Excel has no
  // two-row header worth trusting — a subhead row names its head so a filter still works.
  const headSheet: Record<string, string | number>[] = [];
  for (const h of data.by_head) {
    headSheet.push({
      Head: h.head, Subhead: "— all —", Code: h.code ?? "", Type: h.head_type ?? "",
      [L.actual]: h.amount, [L.entries]: h.entries, [L.pct_of_total]: h.pct_of_total,
      [L.budget]: money(h.budget), [L.variance]: money(h.variance), [L.pct_used]: money(h.pct_used),
      "Budget taken from": h.budget_basis,
    });
    for (const s of h.subheads) {
      headSheet.push({
        Head: h.head, Subhead: s.subhead, Code: s.code ?? "", Type: h.head_type ?? "",
        [L.actual]: s.amount, [L.entries]: s.entries, [L.pct_of_total]: "",
        [L.budget]: money(s.budget), [L.variance]: "", [L.pct_used]: "", "Budget taken from": "",
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(headSheet), "by head");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.by_location.map((r) => ({ Location: r.label, [L.actual]: r.amount, [L.entries]: r.entries, [L.pct_of_total]: r.pct_of_total })),
  ), "by location");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.by_job_role.map((r) => ({ "Job role": r.label, [L.actual]: r.amount, [L.entries]: r.entries, [L.pct_of_total]: r.pct_of_total })),
  ), "by job role");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.by_month.map((r) => ({ Month: r.label, [L.actual]: r.amount, [L.entries]: r.entries })),
  ), "monthly");

  // The cross-tab's columns come from the live master, so a head added this morning is a column in
  // this file this afternoon with no deployment (developer note #1).
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.cross_tab.rows.map((r) => ({
      Batch: r.batch, Location: r.location, "Job role": r.job_role,
      ...Object.fromEntries(data.cross_tab.heads.map((h) => [h.head, r.cells[h.key] ?? 0])),
      "Grand Total": r.total,
    })),
  ), "batch x head");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.unit_economics.map((r) => ({
      Batch: r.batch, Location: r.location, "Job role": r.job_role,
      [L.actual]: r.amount, [L.enrolled]: r.enrolled ?? "—", [L.certified]: r.certified ?? "—",
      [L.cost_per_enrolled]: money(r.cost_per_enrolled), [L.cost_per_certified]: money(r.cost_per_certified),
    })),
  ), "unit economics");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    data.register.map((r) => ({
      Date: r.entry_date ? String(r.entry_date).slice(0, 10) : "",
      Head: r.head, Subhead: r.subhead, Type: r.head_type ?? "",
      Amount: r.amount, Location: r.location, Batch: r.batch, "Job role": r.job_role,
      Trainer: r.trainer, Note: r.note, "Entered by": r.entered_by,
    })),
  ), "cost entry register");

  // What was counted, and what was NOT. A number without its origin starts an argument the moment it
  // leaves the screen, and this file is exactly what leaves the screen.
  const f = data.filters_applied;
  const applied = Object.keys(f).length
    ? Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" · ")
    : "no filters — every cost entry in your scope";
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Item: "Filters applied", Detail: applied },
    { Item: "Grand total", Detail: `${data.totals.actual} across ${data.totals.entries} entries` },
    { Item: "Untagged costs", Detail: `Entries with no batch or no centre are counted under "${COST_LABELS.unassigned}" — they are never dropped, so every sheet in this file sums to the grand total above.` },
    { Item: L.certified, Detail: "A Pass minus the dropped-but-passed — the same billable_passed the invoice bills on, so cost per certified and revenue share one denominator." },
    { Item: "Ratios", Detail: 'A batch with nobody enrolled shows "—" for cost per trainee, never 0 and never an error.' },
    { Item: "Counted at", Detail: `${data.measured_at} (UTC). A snapshot of that moment, not a live feed.` },
  ]), "where the numbers come from");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="finance-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

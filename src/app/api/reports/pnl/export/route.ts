import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { pnlRollup, PNL_LABELS, type PnlFilters } from "@/lib/rules";

// QA-1831 — the P&L as a workbook, from the SAME `pnlRollup` the screen reads. Nothing is
// recomputed here; this file only lays the payload out in sheets.
//
// The gate below is asserted DIRECTLY in scripts/e2e-roles.mjs, not left to the generic money-leak
// probe. That probe walks endpoints and greps their JSON, so it cannot see inside a binary .xlsx —
// an export that skipped the gate would be the one leak it is structurally unable to find. Same
// reasoning, verbatim, as the costs export beside it.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "view");

  const p = req.nextUrl.searchParams;
  const filters: PnlFilters = {};
  for (const k of ["from", "to", "location", "program", "scheme", "batch"] as const) {
    const v = p.get(k);
    if (v) filters[k] = v;
  }
  const data = await pnlRollup(locationFilter(user), filters);
  const L = PNL_LABELS;
  // A masked/absent figure is written as an em dash, never as 0 — the same rule the screen follows.
  // A 0 in a spreadsheet cell is an assertion, and this one would be false.
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v);
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.register.map((r) => ({
    Batch: r.batch, Centre: r.location, "Job role": r.job_role, Scheme: r.scheme,
    [L.billable]: n(r.billable), [L.rate]: n(r.rate),
    [L.accrued]: n(r.accrued), "How it was worked out": r.accrual_basis,
    [L.invoiced]: n(r.invoiced), [L.received]: n(r.received), [L.shortfall]: n(r.shortfall),
    [L.cost]: r.cost, [L.margin]: n(r.margin),
    "Invoice status": r.invoice_status, [L.stage]: r.stage ?? "—",
  }))), "batch P&L");

  for (const [sheet, rowsIn, keyName] of [
    ["by centre", data.by_location, "Centre"],
    ["by job role", data.by_job_role, "Job role"],
    ["by scheme", data.by_scheme, "Scheme"],
  ] as [string, any[], string][]) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsIn.map((r) => ({
      [keyName]: r.label, Batches: r.batches,
      [L.accrued]: r.accrued, [L.invoiced]: r.invoiced, [L.received]: r.received,
      [L.cost]: r.cost, [L.margin]: n(r.margin),
      // QA-1959: a withheld margin goes through n() like every other nullable in this file, and
      // carries its reason with it. Writing r.margin raw put a BLANK where the screen shows a
      // withholding, so the workbook and the screen disagreed about the same number.
      "Why the margin is withheld": r.margin_note ?? "",
      "Batches that could not be valued": r.accrued_unknown,
    }))), sheet);
  }

  for (const [sheet, key] of [
    ["earned but not invoiced", "not_invoiced"],
    ["short received", "shortfall"],
    ["no rate on the scheme", "unknown_rate"],
    ["job role names no scheme", "no_scheme"],
    ["scheme not in the master", "scheme_missing"],
  ] as [string, keyof typeof data.detail][]) {
    const d = data.detail[key];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.rows.map((r: any) => ({
      Batch: r.batch, Centre: r.location, "Job role": r.job_role, Scheme: r.scheme,
      [L.billable]: n(r.billable), [L.accrued]: n(r.accrued),
      [L.invoiced]: n(r.invoiced), [L.received]: n(r.received), [L.shortfall]: n(r.shortfall),
      Why: r.accrual_basis, [L.stage]: r.stage ?? "—",
    }))), sheet);
  }

  // What was counted, and what was NOT. A number without its origin starts an argument the moment it
  // leaves the screen, and this file is exactly what leaves the screen.
  const f = data.filters_applied;
  const applied = Object.keys(f).length
    ? Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" · ")
    : "no filters — every batch in your scope";
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Item: "Filters applied", Detail: applied },
    { Item: "What a date filter selects", Detail: data.window_note },
    { Item: L.accrued, Detail: `Certified (billable) head-count × the scheme's rate per certified candidate. Total ${data.totals.accrued} across ${data.totals.batches} batch(es).` },
    { Item: L.billable, Detail: "A Pass minus the dropped-but-passed — the same billable_passed the cost report divides by, so cost and revenue share one denominator." },
    ...(data.totals.accrued_note ? [{ Item: "Batches with no value", Detail: data.totals.accrued_note }] : []),
    ...(data.totals.cost_note ? [{ Item: "Cost not tagged to a batch", Detail: `${data.totals.cost_unattributed}. ${data.totals.cost_note}` }] : []),
    // QA-1961: when the figure does not apply, the WORKBOOK has to say so too. It previously
    // carried neither the number nor the reason, so a reader of the file could not tell a
    // withheld figure from an absent one.
    ...(data.totals.cost_unattributed_note
      ? [{
          Item: data.totals.cost_unattributed_scoped === false
            ? "Cost not tagged to a batch (NOT scoped to the dates)"
            : "Cost not tagged to a batch (—)",
          Detail: (data.totals.cost_unattributed_scoped === false && data.totals.cost_unattributed !== null
            ? `${data.totals.cost_unattributed}. `
            : "") + String(data.totals.cost_unattributed_note),
        }]
      : []),
    { Item: "Earned but not invoiced", Detail: `${data.totals.not_invoiced} batch(es). Work that has been done and never billed for.` },
    { Item: L.shortfall, Detail: `${data.totals.shortfall}. Invoiced minus received, where less came in than was billed — a part payment or a deduction at source. An invoice can read "Paid" and still be short.` },
    { Item: L.margin, Detail: "Revenue EARNED minus cost — not revenue invoiced. A batch that earned and was never billed shows as unprofitable, because it is." },
    { Item: L.margin + " (—)", Detail: "A dash means the margin is WITHHELD, not zero: at least one batch in that group could not be valued, so its cost is counted and its revenue is not, and a subtraction would be understated by exactly that much. The reason is in the 'Why the margin is withheld' column beside it." },
    { Item: "Batches that could not be valued", Detail: "Split by CAUSE across the sheets above, because the causes have different owners: 'job role names no scheme' is the job role master, 'scheme not in the master' is what a rename leaves behind, and 'no rate on the scheme' is the scheme master." },
    { Item: "Counted at", Detail: `${data.measured_at} (UTC). A snapshot of that moment, not a live feed.` },
  ]), "where the numbers come from");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="pnl-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

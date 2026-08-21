import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { centreVerdict, reportRollup } from "@/lib/rules";

// QA-441: the report as an .xlsx, carrying THE SAME NUMBERS as the screen. It reads the same
// `reportRollup` the screen reads — an export that recomputes is an export that eventually
// disagrees, and then nobody can tell which of the two is the report.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const { rows, roles, total, sources } = await reportRollup(locationFilter(user));

  // One flat sheet: Excel has no two-row header worth trusting, so each job role's five figures
  // become five named columns. The names carry the job role so a filter in Excel still works.
  const flat = rows.map((r) => {
    const out: Record<string, string | number> = { "Batch Location": r.location.name, Status: centreVerdict(r.total) };
    for (const role of roles) {
      const c = r.cells[role];
      out[`${role} — Target`] = c?.target ?? 0;
      out[`${role} — Approved`] = c?.approved ?? 0;
      // QA-527: the split is PER JOB ROLE here, unlike the screen. The screen keeps five columns
      // per role because it has a width to live within; a spreadsheet does not, and this file is
      // exactly where Karunn sir pivots — 17:00, "solar panel installation ke liye ACROSS ALL
      // LOCATIONS target itna tha… approve kitne hain, not approved kitne hain."
      out[`${role} — Not approved`] = c?.not_approved ?? 0;
      out[`${role} — No verdict`] = c?.unknown ?? 0;
      out[`${role} — Mobilised`] = c?.mobilised ?? 0;
      out[`${role} — In training`] = c?.in_training ?? 0;
      out[`${role} — Passed`] = c?.certified ?? 0;
    }
    out["Grand Total — Target"] = r.total.target;
    out["Grand Total — Approved"] = r.total.approved;
    out["Grand Total — Not approved"] = r.total.not_approved;
    out["Grand Total — No verdict"] = r.total.unknown;
    out["Grand Total — Mobilised"] = r.total.mobilised;
    out["Grand Total — In training"] = r.total.in_training;
    out["Grand Total — Passed"] = r.total.certified;
    // criterion 3: a row that cannot be true says so here too, not only on screen.
    out["Check"] = r.breaks.length ? r.breaks.join(" · ") : "";
    return out;
  });
  const totalRow: Record<string, string | number> = { "Batch Location": "ALL CENTRES", Status: "" };
  for (const role of roles) {
    const sum = rows.reduce((a, r) => {
      const c = r.cells[role];
      return {
        target: a.target + (c?.target ?? 0), approved: a.approved + (c?.approved ?? 0),
        not_approved: a.not_approved + (c?.not_approved ?? 0), unknown: a.unknown + (c?.unknown ?? 0),
        mobilised: a.mobilised + (c?.mobilised ?? 0), in_training: a.in_training + (c?.in_training ?? 0),
        certified: a.certified + (c?.certified ?? 0),
      };
    }, { target: 0, approved: 0, not_approved: 0, unknown: 0, mobilised: 0, in_training: 0, certified: 0 });
    totalRow[`${role} — Target`] = sum.target;
    totalRow[`${role} — Approved`] = sum.approved;
    totalRow[`${role} — Not approved`] = sum.not_approved;
    totalRow[`${role} — No verdict`] = sum.unknown;
    totalRow[`${role} — Mobilised`] = sum.mobilised;
    totalRow[`${role} — In training`] = sum.in_training;
    totalRow[`${role} — Passed`] = sum.certified;
  }
  totalRow["Grand Total — Target"] = total.target;
  totalRow["Grand Total — Approved"] = total.approved;
  totalRow["Grand Total — Not approved"] = total.not_approved;
  totalRow["Grand Total — No verdict"] = total.unknown;
  totalRow["Grand Total — Mobilised"] = total.mobilised;
  totalRow["Grand Total — In training"] = total.in_training;
  totalRow["Grand Total — Passed"] = total.certified;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat.concat([totalRow])), "report");
  // REQ-367 travels with the file. A number without its origin starts an argument the moment it
  // leaves the screen, and this file is exactly what leaves the screen.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Column: "Target", "Where it comes from": sources.target },
    { Column: "Approved", "Where it comes from": sources.approved },
    { Column: "Not approved", "Where it comes from": sources.not_approved },
    { Column: "No verdict", "Where it comes from": sources.unknown },
    { Column: "Mobilised", "Where it comes from": sources.mobilised },
    { Column: "In training", "Where it comes from": sources.in_training },
    { Column: "Passed", "Where it comes from": sources.certified },
    { Column: "Please note", "Where it comes from": sources.caveat },
  ]), "where the numbers come from");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="report-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { assertBatchInScope, planArtifact, planExportRows } from "@/lib/rules";

// QA-152 part 2 (-82): "Excel/sheet download ya share" — the plan as an .xlsx, the same rows
// the page shows (export-sidh pattern). Scope is the gate.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const art = await planArtifact(id);
  const rows = planExportRows(art);
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "#": "", Milestone: "(no plan yet)", "Due date": "", Status: "", "Done on": "", Owner: "", Notes: "" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "plan");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="plan-${art.batch.code}.xlsx"`,
    },
  });
});

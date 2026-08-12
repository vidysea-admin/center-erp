import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, assertLocationInScope } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";

// Export candidates in the SIDH assisted-registration CRM's sheet contract (the D:\crm
// tool: full_name · mobile · aadhaar_or_vid · qp_code · scheme_id · district). The
// aadhaar column is left blank on purpose — the ERP does not store Aadhaar numbers; the
// calling agent fills it during the OTP call.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // 2026-08-12 audit (auth S3-7): this walks out with up to 2000 rows of name + mobile +
  // district as a spreadsheet, gated by nothing but a session — so a read-only Trainer could
  // take the lot. Every other candidate surface answers to candidates.manage; so does this.
  await requirePerm(user, "candidates.manage");
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { ...locationFilter(user) };
  const loc = sp.get("location");
  if (loc) { assertLocationInScope(user, loc); filter.location = loc; }
  if (sp.get("program")) filter.program = sp.get("program");
  // Default: pool candidates not yet SIDH-registered — the ones the CRM run is for.
  filter.sidh_status = { $ne: "Registered" };
  if (sp.get("all") === "1") delete filter.sidh_status;

  const items = await Candidate.find(filter)
    .sort({ createdAt: -1 }).limit(2000)
    .populate("location", "name city state")
    .populate("program", "name code")
    .lean<any[]>();

  const rows = items.map((c) => ({
    full_name: c.name,
    mobile: c.phone,
    aadhaar_or_vid: "",                       // filled by the calling agent, never stored here
    qp_code: c.program?.code ?? "",
    scheme_id: "",                            // per-course; operator confirms in the CRM console
    district: c.location?.city ?? "",
    // extra columns are kept and ignored by the CRM's pattern matcher
    erp_location: c.location?.name ?? "",
    erp_program: c.program?.name ?? "",
    erp_sidh_status: c.sidh_status ?? "Not Registered",
  }));

  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ full_name: "", mobile: "", aadhaar_or_vid: "", qp_code: "", scheme_id: "", district: "" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "candidates");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sidh-crm-export.xlsx"`,
    },
  });
});

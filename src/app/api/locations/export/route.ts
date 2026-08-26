import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Location, LocationTarget } from "@/models";
import { tcVerdict, trainerTiesFor } from "@/lib/rules";
import { maskLocationSecrets } from "@/app/api/locations/route";

// QA-1286 (client call #3, 2026-08-25): "yahan apne ko download ke bhi option aane hain taaki hum
// dekh paayein ki yahan se download karke mere ko ye chaar paanch saat field ... jo bhi cheez dikh
// rahe hai ye sab important hai." The Locations grid was the one major table in the product with
// no export — built on this screen's own sheet-mirroring purpose, so the whole point is being able
// to hold it against the client's own workbook offline.
//
// SECURITY, stated because it decides the shape of this file before anything else: TC Password is
// a live government-portal credential and this grid carries it (QA-088, QA-289/-251). The LIST
// route already answers "should it be on screen unasked" with an unconditional NO, Admin included
// — an export is strictly worse than a screen (it leaves the building, sits in a Downloads folder,
// travels in email). So this reuses `maskLocationSecrets` from the list route rather than
// re-querying Location directly — the masking is imported, not re-derived, so the two cannot drift.
//
// Grain matches the screen: one row per centre x job-role, same as the sheet's own merged cells
// (ARCHITECTURE.md, locations/page.tsx's own note). A centre with no job-role target still gets
// one row, exactly as the grid renders one.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // Same gate as the screen and the list API — an export is not a lesser door than the page it
  // came from.
  await requirePerm(user, "locations.manage");

  const items = await Location.find({ ...locationFilter(user, "_id") })
    .select(["code", "external_id", "institution_id", "name", "city", "state", "address", "approval_status",
      "operational_status", "spoc_name", "spoc_phone", "principal_name", "principal_phone", "district",
      "tc_id", "tc_password", "tc_status", "operating_partner", "cluster_head_name", "cluster_head_phone", "active"].join(" "))
    .sort({ name: 1 })
    .lean<any[]>();

  // `false` unconditionally, same as the list route (-251/QA-289) — never on screen unasked, and
  // an export is the least-asked-for place a credential could ride out through.
  const masked = maskLocationSecrets(items, false);

  const locIds = items.map((l: any) => l._id);
  const [targets, trainerRows] = await Promise.all([
    LocationTarget.find({ location: { $in: locIds } })
      .select("location program tc_status tc_id approved_target trainers_required nominations_received_reported nominated_nsdc_reported trainers_certified_reported")
      .populate("program", "name code scheme")
      .lean<any[]>(),
    trainerTiesFor(locIds),
  ]);
  const byLoc = new Map<string, any[]>();
  for (const t of targets) {
    const k = String(t.location);
    const ours = trainerRows.get(`${k}|${String(t.program?._id)}`);
    byLoc.set(k, [...(byLoc.get(k) ?? []), {
      program: t.program?.name ?? null, scheme: t.program?.scheme ?? null,
      tc_verdict: tcVerdict(t.tc_status), tc_id: t.tc_id ?? null, tc_status: t.tc_status ?? null,
      approved_target: t.approved_target ?? null, trainers_required: t.trainers_required ?? null,
      nominations_received_reported: t.nominations_received_reported ?? null,
      nominated_nsdc_reported: t.nominated_nsdc_reported ?? null,
      trainers_certified_reported: t.trainers_certified_reported ?? null,
      trainers_nominated: ours?.nominated ?? 0, trainers_certified: ours?.certified ?? 0,
      trainers_nsdc: ours?.nsdc ?? 0,
    }]);
  }

  // Flattened, one row per centre x job-role — the same columns the grid renders, minus TC
  // Password (masked above) and hidden columns (Code/City/Approval/Operational stay hidden on the
  // grid by the operator's own choice — see locations/page.tsx — so this export follows the
  // grid's DEFAULT visible set rather than its full field list).
  const rows = masked.flatMap((l: any) => {
    const jrs = byLoc.get(String(l._id)) ?? [null];
    return jrs.map((jr: any) => ({
      "SPOC Name": l.spoc_name ?? "", "Cluster Head Contact": l.cluster_head_phone ?? "",
      "State": l.state ?? "", "District": l.district ?? l.city ?? "", "Institution Name": l.name,
      "Operating Partner": l.operating_partner ?? "",
      "Ongoing Scheme": jr?.scheme ?? "", "Job Role": jr?.program ?? "",
      "Total Target": jr?.approved_target ?? "", "TC ID": jr?.tc_id ?? "",
      "TC Status": jr?.tc_status ?? "",
      "Trainer Required": jr?.trainers_required ?? "",
      "Nomination Received (sheet)": jr?.nominations_received_reported ?? "",
      "Nomination Received (ours)": jr ? (jr.trainers_nominated ?? 0) : "",
      "Nominated to NSDC (sheet)": jr?.nominated_nsdc_reported ?? "",
      "Nominated to NSDC (ours)": jr ? (jr.trainers_nsdc ?? 0) : "",
      "Trainer Certified (sheet)": jr?.trainers_certified_reported ?? "",
      "Trainers (ours, live)": jr ? (jr.trainers_certified ?? 0) : "",
      "Certified Δ (sheet − ours)": jr && jr.trainers_certified_reported != null
        ? (jr.trainers_certified_reported ?? 0) - (jr.trainers_certified ?? 0) : "",
    }));
  });

  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "Institution Name": "(no centres in scope)" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "locations");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="locations-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

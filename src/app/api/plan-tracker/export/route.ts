import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { planTrackerRows, trainerForLogin } from "@/lib/rules";

// QA-526 (-174): the planning table as an .xlsx. The report got one in -170 because Manish sir
// asked; nobody asked for this one, and that is the reason to build it — Karunn sir keeps this
// table in a SPREADSHEET today, so a version he cannot download is a version he reads once and
// then goes back to Excel for.
//
// It reads the same `planTrackerRows` the screen reads. An export that recomputes is an export
// that eventually disagrees, and then nobody can say which one is the plan.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();

  // The same scope the screen uses, including the Trainer arm. Duplicating the rule would be a
  // second answer to "which batches are mine", which is how two screens start disagreeing.
  const scope: Record<string, unknown> = { ...locationFilter(user) };
  if (user.role === "Trainer") {
    const me = await trainerForLogin(user);
    if (me) {
      const loc = locationFilter(user);
      scope.$or = Object.keys(loc).length ? [loc, { trainer: me._id }] : [{ trainer: me._id }];
      delete scope.location;
    }
  }

  const rows = await planTrackerRows(scope);
  const d = (v: unknown) => (v == null ? "" : v === "Not needed" ? "Not needed" : String(v).slice(0, 10));
  // His column order, his headings. A download that renames his columns is a download he has to
  // translate before he can use it.
  //
  // QA-607: these headings and the SCREEN's headings must be the same words. They were not - the
  // download said "TOT starts" while the screen said "Starts", and "Available & ready for TOT"
  // while the screen said "Ready for TOT". One column with two names depending on which surface
  // you looked at is precisely the defect QA-565 closed on the report; it was alive here too.
  // Anything below that has no screen column (Scheme, TR ID, NSDC remarks, Mobilised count) is an
  // extra the download carries on purpose, not a renaming.
  const flat = rows.map((r: any) => ({
    "SL#": r.sl,
    "Location": r.location?.name ?? "",
    "Job Role": r.job_role ?? "",
    "Scheme": r.scheme ?? "",
    "Batch": r.batch?.code ?? "",
    "Trainer Name": r.trainer?.name ?? "",
    "TR ID": r.trainer?.tr_id ?? "",
    "Trainer profile verified on SIDH": d(r.sidh_profile_verified_on),
    "Trainer eligibility check": d(r.eligibility_checked_on),
    "Trainer available & ready for TOT": d(r.ready_for_tot),
    "Profile submitted to SSC/NSDC": d(r.nsdc_submitted_on),
    "SSC/NSDC approved the profile": d(r.nsdc_result_on),
    "NSDC remarks": r.nsdc_remarks ?? "",
    "TOT fee paid to SSC/NSDC": d(r.paid_on),
    "TOT start date": d(r.tot_start),
    "TOT end date": d(r.tot_done_on),
    "TOT result & certificate expected": d(r.tot_result_expected_on),
    "Trainer mapped on SIDH portal": d(r.trainer_mapped_sidh),
    "Mobilisation done for this batch": r.mobilization?.status ?? "",
    "Mobilised count": r.mobilization?.count ?? 0,
    "Registration & enrolment done on SIDH": d(r.enrollment_done),
    "Expected batch start date": d(r.planned_start),
    "Expected batch end date": d(r.planned_end),
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    flat.length ? flat : [{ "SL#": "", Location: "(no live batches in your view)" }],
  ), "planning");
  // The one thing a reader of this file could get wrong on their own, said in the file.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Note: "Every trainer column is read from the trainer record, not from the batch. A trainer running two batches shows the SAME dates on both rows because it is the same trainer, not two copies." },
    { Note: "\"Not needed\" means the trainer is already certified, so that step does not apply to this batch. It is not a blank waiting to be filled." },
    { Note: "Mobilised count is counted from the batch roster each time this file is made. It is not stored anywhere." },
  ]), "how to read this");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="batch-planning-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

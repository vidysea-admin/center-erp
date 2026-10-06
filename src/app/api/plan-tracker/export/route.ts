import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { planTrackerRows, planTrackerSummary, trainerForLogin } from "@/lib/rules";

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
  // QA-684 (-203), found by the new value-comparison pin the moment it existed: this took the first
  // ten characters of String(v), which is an ISO prefix for a string but "Mon Aug 17" for a Date -
  // and planTrackerRows hands back real Date objects, because nothing JSON-serialises them on this
  // path the way the API response does. So the SCREEN read 17 Aug 2026 and the DOWNLOADED FILE read
  // "Mon Aug 17", with no year, in a column the client sorts and filters on. Four pins had checked
  // that this file's HEADINGS matched the screen's and not one had looked underneath them.
  const d = (v: unknown) => {
    if (v == null) return "";
    if (v === "Not needed") return "Not needed";
    if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  };
  // His column order, his headings. A download that renames his columns is a download he has to
  // translate before he can use it.
  //
  // QA-640: these headings and the SCREEN's headings must be the same words. They were not - the
  // download said "TOT starts" while the screen said "Starts", and "Available & ready for TOT"
  // while the screen said "Ready for TOT". One column with two names depending on which surface
  // you looked at is precisely the defect QA-565 closed on the report; it was alive here too.
  // Anything below that has no screen column (Scheme, TR ID, NSDC remarks) is an
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
    // mtg-b1 (R3): Target / Mobilised / Gap are screen columns now, so they carry the screen's words.
    // "Mobilised" is the column that used to be called "Mobilised count" here; same number, the one
    // planTrackerRows already derives from the roster. Target and Gap come from the same rows too.
    "Target": r.target ?? 0,
    "Mobilised": r.mobilised ?? 0,
    "Gap": r.gap ?? 0,
    // QA-765: the screen can OPEN this cell, so the file has to carry the same days or the two
    // answer his question differently - and the export is where a disagreement is found last.
    "Mobilised by day": (r.mobilization?.days ?? [])
      .map((x: any) => (x.date ? x.date : "joining date not recorded") + " +" + x.joined).join(" · "),
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
    { Note: "Mobilised is counted from the batch roster each time this file is made. It is not stored anywhere." },
    { Note: "\"Mobilised by day\" is the same roster, split by the day each candidate joined (IST). Its increments add up to Mobilised - they are one query, not two." },
    { Note: "Target is the batch's planned seats. Gap is Target minus Mobilised, never below zero: a batch with more people than seats has no gap, and it does not cancel another batch's shortfall in the totals." },
  ]), "how to read this");
  // mtg-b1 (R3): the same summary the Planning tab shows above its table, from the same function.
  // It covers the batches that tab lists (Planning and Ready); the sheet above also carries the ones that have started.
  const sm = planTrackerSummary(rows);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Measure: "Batches (Planning and Ready)", "All planned": sm.total.batches, "Starting this week (IST)": sm.this_week.batches },
    { Measure: "Target", "All planned": sm.total.target, "Starting this week (IST)": sm.this_week.target },
    { Measure: "Mobilised", "All planned": sm.total.mobilised, "Starting this week (IST)": sm.this_week.mobilised },
    { Measure: "Gap", "All planned": sm.total.gap, "Starting this week (IST)": sm.this_week.gap },
  ]), "summary");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="batch-planning-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
});

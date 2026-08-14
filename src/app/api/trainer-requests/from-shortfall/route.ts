import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, locationFilter, assertLocationInScope } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Notification, TrainerRequest } from "@/models";
import { mappingReadinessBulk, addDays } from "@/lib/rules";
import { mailUsersByRole } from "@/lib/mailer";

// F-A9 (Manish): the readiness screen already knows exactly which centre × job role has
// no trainer — turn that shortfall into TrainerRequests in one click instead of retyping
// each one. Deliberately conservative: only rows whose trainer pipeline is EMPTY (no
// certified, none in the pipeline), never a halted or unapproved centre (F-B5), and
// never a second Open request for the same centre × job role. Everything not created is
// returned with its reason — report, never guess.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const body = await req.json().catch(() => ({}));

  const filter: Record<string, unknown> = { ...locationFilter(user) }; // Rule 38
  if (body.location) {
    assertLocationInScope(user, body.location);
    filter.location = body.location;
  }

  const rows = await mappingReadinessBulk(filter);
  const created: any[] = [];
  const skipped: any[] = [];
  const requiredBy = addDays(new Date(), 30); // realistic hiring lead; editable on the request

  for (const r of rows) {
    const name = { location: r.location?.name, program: r.program?.name };
    const certified = r.trainers?.certified ?? 0;
    const inPipeline = r.trainers?.in_pipeline ?? 0;
    if (certified >= 1 || inPipeline > 0) continue; // no shortfall, or hiring already underway — not even "skipped"
    if (["On Hold", "Stopped", "Closed"].includes(String(r.location?.operational_status))) {
      skipped.push({ ...name, reason: `centre is ${r.location.operational_status} (F-B5: a halted centre does not hire)` });
      continue;
    }
    if (r.location?.approval_status !== "Approved") {
      skipped.push({ ...name, reason: "centre not approved" });
      continue;
    }
    const open = await TrainerRequest.findOne({ location: r.location._id, program: r.program._id, status: "Open" }).lean();
    if (open) { skipped.push({ ...name, reason: "an Open trainer request already exists" }); continue; }
    const doc = await TrainerRequest.create({
      location: r.location._id, program: r.program._id, required_by_date: requiredBy,
      status: "Open", raised_by: user.id, note: "Raised from readiness shortfall",
    });
    await Notification.create({
      type: "trainer_request_new", severity: "info",
      message: `New trainer request: ${name.program ?? "job role"} at ${name.location ?? "centre"} (from readiness shortfall)`,
      entity: "TrainerRequest", entity_id: doc._id, link: "/trainers?tab=Requests",
      location: r.location._id, role_target: ["Admin", "Operations"],
    });
    // QA-115: inbox mirror, same audience and scope as the bell.
    mailUsersByRole({
      roles: ["Admin", "Operations"], location: r.location._id,
      subject: `Trainer request: ${name.program ?? "job role"} at ${name.location ?? "centre"}`,
      title: "A new trainer request was raised",
      lines: [`${name.program ?? "Job role"} at ${name.location ?? "centre"} (from readiness shortfall).`],
      link: "/trainers?tab=Requests", entity: "TrainerRequest", entity_id: doc._id,
    }).catch(() => {});
    created.push({ ...name, id: doc._id });
  }

  return NextResponse.json({ created, skipped, summary: { created: created.length, skipped: skipped.length } }, { status: created.length ? 201 : 200 });
});

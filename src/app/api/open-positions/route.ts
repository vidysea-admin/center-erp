import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { LocationTarget, Trainer } from "@/models";
import { NOMINATED_STATES } from "@/lib/rules";

// Open Positions (CEO, 13/08 walkthrough): "ek tab — kahan-kahan trainer hire karne hain.
// Location se sort karun toh kaun se program, kitne chahiye, kitne balance; job role select
// karun toh har location pe kitne baki. KEVAL approved location + approved course. Do
// certify ho gaye toh wo position CLOSED." Everything here is DERIVED per request from
// LocationTarget (requirement) minus live Trainer counts — never stored, so a trainer
// moving to Certified closes the position on the very next load.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // Only per-row-approved targets (tc_status is the government's verdict on that
  // centre×job-role), scoped by the caller's centres (Rule 38).
  const targets = await LocationTarget.find({ tc_status: "Approved", ...locationFilter(user) })
    .populate("location", "name code approval_status")
    .populate("program", "name code scheme")
    .lean<any[]>();
  // …AND only approved locations ("approved location WITH approved course, keval wahi").
  const rows = targets.filter((t) => t.location?.approval_status === "Approved" && t.program);

  const locIds = [...new Set(rows.map((t) => String(t.location._id)))];
  const counts = new Map<string, { nominated: number; certified: number }>();
  if (locIds.length) {
    const agg = await Trainer.aggregate([
      { $match: { nominated_for_location: { $in: rows.map((t) => t.location._id) }, active: true } },
      { $group: {
        _id: { l: "$nominated_for_location", p: "$nominated_for_program" },
        nominated: { $sum: { $cond: [{ $in: ["$pipeline_status", NOMINATED_STATES] }, 1, 0] } },
        certified: { $sum: { $cond: [{ $eq: ["$pipeline_status", "Certified"] }, 1, 0] } },
      } },
    ]);
    for (const r of agg) counts.set(`${String(r._id.l)}|${String(r._id.p)}`, { nominated: r.nominated, certified: r.certified });
  }

  const items = rows.map((t) => {
    const c = counts.get(`${String(t.location._id)}|${String(t.program._id)}`) ?? { nominated: 0, certified: 0 };
    const required = t.trainers_required ?? null;
    // CEO: "do certify ho gaye toh wo location close ho gayi — mere ko wo trainer nahi
    // chahiye." No stated requirement = the position cannot close on its own.
    const balance = required != null ? Math.max(0, required - c.certified) : null;
    return {
      _id: t._id,
      location: { _id: t.location._id, name: t.location.name, code: t.location.code },
      program: { _id: t.program._id, name: t.program.name, code: t.program.code, scheme: t.program.scheme },
      required, nominated: c.nominated, certified: c.certified, balance,
      status: required != null && c.certified >= required ? "Closed" : "Open",
    };
  });
  return NextResponse.json({ items });
});

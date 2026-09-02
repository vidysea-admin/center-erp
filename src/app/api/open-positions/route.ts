import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { LocationTarget } from "@/models";
import { trainerTiesFor } from "@/lib/rules"; // QA-1262b: one predicate for "who is tied to this centre x job role"

// Open Positions (CEO, 13/08 walkthrough): "ek tab — kahan-kahan trainer hire karne hain.
// Location se sort karun toh kaun se program, kitne chahiye, kitne balance; job role select
// karun toh har location pe kitne baki. KEVAL approved location + approved course. Do
// certify ho gaye toh wo position CLOSED." Everything here is DERIVED per request from
// LocationTarget (requirement) minus live Trainer counts — never stored, so a trainer
// moving to Certified closes the position on the very next load.
//
// R-G (CEO 14/08 [07:56, 09:01, 09:12]): each position also maps the trainer PIPELINE —
// "fresh applications, then documentation complete, sent to NSDC, NSDC approved, certified
// … then we can see which position needs our focus" — with the actual trainers named so a
// count is clickable, plus ?approved=all to "show not approved also" (default stays
// approved-only, exactly as he asked).

// The CEO's five buckets, from the stored stage names (R-A). The NSDC round-trip
// (Rejected) sits with "Sent to NSDC" — it is still at the government's door — and the
// post-approval prep states (payment/TOT) sit with "NSDC Approved".
const STAGE_BUCKETS: Record<string, string> = {
  "Fresh Lead": "fresh",
  "Shortlisted": "shortlisted",
  "Documents Completed": "docs",
  "Sent to NSDC": "sent",
  "NSDC Rejected": "sent",
  "NSDC Approved": "approved",
  "TOT Payment Done": "approved",
  "TOT Scheduled": "approved",
  "TOT In Progress": "approved",
  "Certified": "certified",
};
const BUCKET_KEYS = ["fresh", "shortlisted", "docs", "sent", "approved", "certified"] as const;

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // QA-091 (checker round 5): the hiring board is a trainers.manage surface — without a
  // gate, a Trainer read other trainers BY NAME through stage_trainers and an Enrollment
  // login read the whole 21-centre hiring plan.
  await requirePerm(user, "trainers.manage");
  const showAll = req.nextUrl.searchParams.get("approved") === "all";
  // Default: only per-row-approved targets (tc_status is the government's verdict on that
  // centre×job-role) at approved locations, scoped by the caller's centres (Rule 38).
  const targets = await LocationTarget.find({ ...(showAll ? {} : { tc_status: "Approved" }), ...locationFilter(user) })
    .populate("location", "name code approval_status")
    .populate("program", "name code scheme")
    .lean<any[]>();
  const rows = targets.filter((t) => t.program && t.location && (showAll || t.location.approval_status === "Approved"));

  // QA-1262b (2026-08-25): this board ran its OWN `Trainer.aggregate` on `nominated_for_location`
  // alone, so it and the Locations grid answered "how many trainers does this centre have for this
  // job role" DIFFERENTLY the moment QA-1262 taught the grid to count the batch tie too. Two
  // aggregations for one question is the second copy ARCHITECTURE section 3 exists to name, and
  // leaving this one behind would have shipped the disagreement rather than the fix. It reads
  // `trainerTiesFor` now — the same function, the same trainer-level de-duplication (a trainer both
  // nominated here AND running a batch here counts once), and the same `NOMINATED_STATES`.
  const byPosition = new Map<string, { counts: Record<string, number>; names: Record<string, { _id: string; name: string; label: string; stage: string }[]> }>(); // QA-1753: label rides through
  if (rows.length) {
    const ties = await trainerTiesFor(
      [...new Set(rows.map((t) => t.location._id))],
      [...new Set(rows.map((t) => t.program._id))],
    );
    for (const [k, v] of ties) {
      const counts: Record<string, number> = {};
      const names: Record<string, { _id: string; name: string; label: string; stage: string }[]> = {};
      for (const t of v.trainers) {
        const bucket = STAGE_BUCKETS[t.stage || "Fresh Lead"];
        if (!bucket) continue; // Dropped never counts toward a position
        counts[bucket] = (counts[bucket] ?? 0) + 1;
        (names[bucket] ??= []).push(t);
      }
      byPosition.set(k, { counts, names });
    }
  }

  const items = rows.map((t) => {
    const pos = byPosition.get(`${String(t.location._id)}|${String(t.program._id)}`) ?? { counts: {}, names: {} };
    const certified = pos.counts.certified ?? 0;
    // "Nominated" keeps its meaning from the preparation board: documents done onward.
    const nominated = (pos.counts.docs ?? 0) + (pos.counts.sent ?? 0) + (pos.counts.approved ?? 0) + certified;
    const required = t.trainers_required ?? null;
    // CEO: "do certify ho gaye toh wo location close ho gayi — mere ko wo trainer nahi
    // chahiye." No stated requirement = the position cannot close on its own.
    const balance = required != null ? Math.max(0, required - certified) : null;
    const approved = t.tc_status === "Approved" && t.location.approval_status === "Approved";
    return {
      _id: t._id,
      location: { _id: t.location._id, name: t.location.name, code: t.location.code },
      program: { _id: t.program._id, name: t.program.name, code: t.program.code, scheme: t.program.scheme },
      required, nominated, certified, balance,
      stages: Object.fromEntries(BUCKET_KEYS.map((k) => [k, pos.counts[k] ?? 0])),
      stage_trainers: pos.names,
      approved,
      approved_reason: approved ? null
        : t.location.approval_status !== "Approved" ? `centre ${t.location.approval_status ?? "Pending"}`
        : `TC status ${t.tc_status ?? "Pending"}`,
      status: required != null && certified >= required ? "Closed" : "Open",
    };
  });
  return NextResponse.json({ items });
});

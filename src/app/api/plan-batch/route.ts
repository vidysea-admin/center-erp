import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { earliestPossibleStart, planBatchBackward } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { Batch, Trainer } from "@/models";

// Standalone backward-plan calculator (2026-08-11): "मैं जब चाहूं… एक batch planning निकाल
// के किसी को भी share कर सकूं" — pick a start date, get the checklist, before any batch
// exists. GET ?start=YYYY-MM-DD
//
// -164 (REQ-186 / QA-461): it now also takes ?location= and ?program=, because "ये प्लानिंग
// लोकेशन वाइज़" — planning is a centre's question, not a global one. With a centre named it
// answers TWO things instead of one:
//   • the plan is that centre's plan — if the trainer already running that programme there is
//     certified, the TOT rows are not in it (QA-460);
//   • it reports the EARLIEST date that centre could actually start, with the reason, so a date
//     that cannot be met is never proposed in the first place.
// Without them the behaviour is byte-for-byte what it was: the calculator is used before a batch
// or a centre exists, and there the full plan is the honest answer.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  await requireUser();
  const q = req.nextUrl.searchParams;
  const start = q.get("start");
  const location = q.get("location");
  const program = q.get("program");
  if (!start || isNaN(new Date(start).getTime())) throw new HttpError(400, "start (YYYY-MM-DD) is required");
  const defaults = await getDefaults();

  // The centre's trainer for this programme: whoever is already teaching it there. This is the
  // trainer whose TOT state the plan depends on, and reading it from the live batches means the
  // planner never needs a trainer picker of its own.
  let trainer: any = null;
  if (location) {
    const b = await Batch.findOne({ location, ...(program ? { program } : {}), trainer: { $ne: null } })
      .sort({ planned_start: -1 })
      .select("trainer").lean<any>();
    if (b?.trainer) trainer = await Trainer.findById(b.trainer).select("name pipeline_status tot_done_on").lean<any>();
  }

  const milestones = planBatchBackward(new Date(start), defaults, { trainer });
  const earliest = location ? await earliestPossibleStart(location, { trainerId: trainer?._id }) : null;

  return NextResponse.json({
    start,
    milestones,
    // Named rather than merged into the milestone list: a milestone is a deadline the plan
    // creates, and this is a constraint the world imposes. Fusing them is how a screen ends up
    // showing a due date nobody owes.
    scoped_to: location ? { location, program: program ?? null, trainer: trainer ? { name: trainer.name, pipeline_status: trainer.pipeline_status ?? null, tot_done_on: trainer.tot_done_on ?? null } : null } : null,
    tot_skipped: !!trainer && (trainer.pipeline_status === "Certified" || !!trainer.tot_done_on),
    earliest_possible_start: earliest ? { date: earliest.date, basis: earliest.basis } : null,
    starts_too_soon: earliest ? new Date(start) < earliest.date : null,
  });
});

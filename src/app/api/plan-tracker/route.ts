import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
import { planTrackerRows, trainerForLogin } from "@/lib/rules";

// QA-399 — Karunn sir's Back-dated Planning table, the second of the two things he said the whole
// job needs. A thin door: every column's source and every rule about which grain it comes from
// lives in `planTrackerRows`, so this view can never quietly disagree with the batch it describes.
export const GET = apiHandler(async (_req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();

  // Rule 38, the same filter every other screen uses — plus the one arm the batches list already
  // has: a Trainer login sees the batches they teach whatever their location scope says. Copying
  // that shape rather than inventing a second answer to "which batches are mine".
  const scope: Record<string, unknown> = { ...locationFilter(user) };
  if (user.role === "Trainer") {
    const me = await trainerForLogin(user);
    if (me) {
      const loc = locationFilter(user);
      scope.$or = Object.keys(loc).length ? [loc, { trainer: me._id }] : [{ trainer: me._id }];
      delete scope.location;
    }
  }
  return NextResponse.json({ rows: await planTrackerRows(scope) });
});

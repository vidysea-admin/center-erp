import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, HttpError } from "@/lib/authz";
import { kpiRollup } from "@/lib/rules";

// QA-1832 — the CEO's own first question, and the one thing he said was missing from everything
// that had been built for him: *"मेरे कितने बच्चे ट्रेन हो गए, कितने ट्रेनिंग में हैं, कितने बैचेस और चालू होने
// वाले हैं"*, with blockers in his four categories, each carrying an owner.
//
// NO FINANCE GATE, deliberately. This report carries no money — headcounts, batch counts and the
// names of what is blocking a centre. The CEO's rule narrows COST visibility to three people; it
// would be a misreading of it to hide from a centre principal how many of their own students are
// in training. `locationFilter` still applies, so a scoped user sees their own centres and no more,
// exactly as every other report here behaves.
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const authz = locationFilter(user) as Record<string, any>;
  const scope: Record<string, unknown> = { ...authz };

  // A `?location=` NARROWS, it never widens. The first version of this line wrote
  // `scope.location = one` straight over the authorisation filter, so a scoped SPOC could name any
  // centre's id and read that centre's blockers — the authz clause was on the same key and the
  // query parameter simply replaced it. My own scope assertion passed because it never sent the
  // parameter, which is the shape this whole session has kept finding: the test walked the path
  // nobody attacks.
  const one = req.nextUrl.searchParams.get("location");
  if (one) {
    const allowed: string[] | null = Array.isArray(authz.location?.$in)
      ? authz.location.$in.map(String)
      : null;
    // `allowed === null` means the user is unscoped (Admin/Operations) and may ask for any centre.
    if (allowed && !allowed.includes(String(one))) {
      throw new HttpError(403, "That centre is not in your scope.");
    }
    scope.location = one;
  }
  return NextResponse.json(await kpiRollup(scope));
});

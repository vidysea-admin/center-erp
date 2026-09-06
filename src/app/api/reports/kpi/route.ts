import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter } from "@/lib/authz";
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
  const scope = { ...locationFilter(user) } as Record<string, unknown>;
  const one = req.nextUrl.searchParams.get("location");
  if (one) scope.location = one;
  return NextResponse.json(await kpiRollup(scope));
});

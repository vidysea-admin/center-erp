import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { __resetSmsDailyCapForTest } from "@/lib/rate-limit";

// TEST-ONLY endpoint (qa-2809 wall fix, -321). The SMS daily cap is a SINGLE global in-process
// bucket by design, so a per-phone reset cannot clear it. In the full wall e2e-roles trips that cap
// (the -110 toll-fraud pin) and runs BEFORE e2e-govt in the SAME server process, so qa-2809's OTP
// pins would inherit an already-blown budget and 429 with "SMS sending is paused for today". This
// clears only that one global counter.
//
// It is impossible to reach in production, gated TWO independent ways:
//   (1) it 404s unless MONGODB_DB is the center_erp_ci test database (production is center_erp) —
//       the SAME guard every other `_test_*` affordance in this app uses (approvals, costs,
//       batches). The check runs FIRST, before any auth, so in production the route does not exist;
//   (2) it still requires an authenticated Admin session, exactly like /api/test-email.
// It clears a rate-limit counter and nothing else — no data is created, exposed or deleted.
export const POST = apiHandler(async () => {
  if (!/^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")) {
    throw new HttpError(404, "Not found");
  }
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  __resetSmsDailyCapForTest();
  return NextResponse.json({ ok: true });
});

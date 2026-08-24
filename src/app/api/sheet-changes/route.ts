import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { hasPermission, requirePerm, requireView } from "@/lib/permissions";
import { FollowUpAction, LocationTarget, Program, SheetChange } from "@/models";
import { canRevert, classifyChange, targetRowField } from "@/lib/sync";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "sheet.approve"); // QA-025 P3: seeing the queue = view; apply/ignore keep edit
  const status = req.nextUrl.searchParams.get("status") || "Open";
  // The sidebar badge only needs the number — fetching every row to read .length was wasteful.
  if (req.nextUrl.searchParams.get("count") === "1") {
    return NextResponse.json({ count: await SheetChange.countDocuments(status === "all" ? {} : { status }) });
  }
  // QA-1016 (S3, checker on qa-234 cycle 2): this route is deliberately UNBOUNDED, and the reason
  // is recorded here rather than left to be rediscovered. It is a work-to-zero review queue: the
  // person reading it is the person whose job is to empty it, and a silent `limit` would hide rows
  // from exactly them — the failure QA-666 already cost us once, when 74 rows sat unactionable and
  // invisible. The screen has no pagination to reveal what a cap dropped, so a cap here would not
  // be a performance decision, it would be a correctness one.
  //
  // Measured cost (checker, A/B at ~55 rows): 52 ms -> 78 ms median, the delta being the per-row
  // follow-up count plus the memoised target-row lookup below. Both are O(rows) with a small
  // constant. If this queue is ever routinely in the hundreds, the fix is to aggregate the counts
  // in one pipeline rather than to truncate the list — a bound is the one thing it must not get.
  const items = await SheetChange.find(status === "all" ? {} : { status })
    .sort({ detected_at: -1 })
    .populate("location", "name code")
    .populate("actor", "name")
    .lean<any[]>();
  // 2026-08-13: tc_password became mappable, so a change row can now carry a live portal
  // credential. Sheet Watch already masks the same column; the reviewer inbox must not be the
  // door that stays open. Only a holder of locations.manage sees the values.
  const canSeeSecrets = await hasPermission(user, "locations.manage");

  // QA-988 (checker on qa-234 cycle 1): `targetRowField` only proves the field NAME parses. The
  // apply door additionally requires the LocationTarget row to already exist for tc_status / tc_id
  // (409 — "a status cannot create the row it describes"; approved_target may upsert, so it is
  // exempt). Without this fact the drawer put a ★ on a press that answers 409. Memoised per
  // request and asked ONLY for the rows that need it, so a queue of plain field changes costs
  // nothing extra.
  const programByCode = new Map<string, any>();
  const targetExistsCache = new Map<string, boolean>();
  async function targetRowExists(locationId: unknown, field: string): Promise<boolean | undefined> {
    const rf = targetRowField(field);
    if (!rf || !locationId || rf.base === "approved_target") return undefined;
    const key = `${String(locationId)}|${rf.code}`;
    if (targetExistsCache.has(key)) return targetExistsCache.get(key);
    if (!programByCode.has(rf.code)) {
      programByCode.set(rf.code, await Program.findOne({ code: rf.code }).select("_id").lean<any>());
    }
    const prog = programByCode.get(rf.code);
    // No such programme is a different refusal the door makes on its own; do not answer "missing
    // row" for it, because that would be a confident wrong sentence rather than an absent one.
    if (!prog) return undefined;
    const exists = !!(await LocationTarget.exists({ location: locationId, program: prog._id }));
    targetExistsCache.set(key, exists);
    return exists;
  }

  const withFups = await Promise.all(items.map(async (c) => {
    const masked = {
      ...c,
      ...(canSeeSecrets || c.field_name !== "tc_password"
        ? {}
        : { old_value: c.old_value ? "••••••" : "", new_value: c.new_value ? "••••••" : "" }),
    };
    // QA-986 (S1): Rule 7's count is a fact the predicate needs, not just a badge on the row —
    // "No action" on a change with pending follow-ups orphans them and erases what was applied.
    const pending = await FollowUpAction.countDocuments({ source_change: c._id, status: "Pending" });
    const facts = {
      ...masked,
      pending_followups: pending,
      target_row_exists: await targetRowExists(c.location?._id ?? c.location, String(c.field_name ?? "")),
    };
    return {
      ...masked,
      // QA-946: what this row's reviewer may actually DO, decided by the same predicate the apply
      // door refuses through (lib/sync.ts). The drawer used to render one hardcoded list of seven
      // for every row while the door accepted at most one of the top two, so a reviewer's only way
      // to learn a row's kind was to pick wrong and read the 400.
      //
      // Classified from the MASKED row, not the raw one. No `why` quotes a value today, but the
      // verdicts do read new_value (blank means "applying this ERASES the field"), and computing
      // them from the raw row would put a live portal credential one careless edit away from
      // travelling past the mask written two lines above it.
      actions: classifyChange(facts),
      pending_followups: pending,
      // QA-989: whether the ↩ Revert button should exist at all, answered by the SAME function the
      // revert door refuses through. The page used to decide this itself with a looser rule, so
      // every applied tc_status:/tc_id: row showed a button that 400s after the confirm.
      revert: canRevert(masked),
    };
  }));
  return NextResponse.json({ items: withFups });
});

import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, readJson, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { WeeklyTarget } from "@/models";
import { audit } from "@/lib/audit";
import { assertDigestDay, istWeekOf } from "@/lib/rules";

// Karunn sir, review 2026-11-02: "against the target, plus or minus - the week's target and the cumulative
// target, both. Manish ji has the targets." The weekly targets the daily digest compares against. Entered on
// Admin, Targets (typed, or pasted straight from Manish ji's Excel - both, Umesh 2026-11-02). Organisation-wide
// (no centre), keyed by the week's MONDAY (Mon-Sun IST, Umesh). Same right as Defaults: defaults.manage.
const TARGET_FIELDS =["trainers_trained", "candidates_in_training", "candidates_certified"] as const;
const MAX_ROWS = 260;        // five years of weeks: a paste larger than that is a wrong paste
const MAX_VALUE = 100_000;   // no weekly target in this programme is near this; a bigger number is a typo

const keyOf = (d: Date) => new Date(d).toISOString().slice(0, 10);

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "defaults.manage");
  const rows = await WeeklyTarget.find({}).sort({ week_start: 1 }).lean<any[]>();
  return NextResponse.json({ items: rows.map((r) => ({ week_start: keyOf(r.week_start), ...Object.fromEntries(TARGET_FIELDS.map((f) => [f, r[f] ?? null])) })) });
});

// PUT { rows: [{ week_start: "YYYY-MM-DD" (a Monday), trainers_trained, candidates_in_training, candidates_certified }] }
// Upserts every listed week; a week whose three figures are all blank is removed. Weeks not listed are left as
// they are, so pasting next month's weeks never erases this month's. The whole list is validated before
// anything is written: one bad row refuses the save and names the row, so a paste never lands half-way.
export const PUT = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "defaults.manage");
  requireEdit(user);
  const body = await readJson(req);
  if (!Array.isArray(body?.rows)) throw new HttpError(400, "Send the targets as a list of weeks.");
  if (body.rows.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} weeks can be saved at once; this list has ${body.rows.length}.`);
  const seen = new Set<string>();
  const clean = body.rows.map((r: any, i: number) => {
    const at = `Row ${i + 1}`;
    let week: string;
    try { week = assertDigestDay(r?.week_start); } catch { throw new HttpError(400, `${at}: the week must be a real date, written YYYY-MM-DD.`); }
    const monday = istWeekOf(week).from;
    if (monday !== week) throw new HttpError(400, `${at}: ${week} is not a Monday. A target week runs Monday to Sunday; that week starts on ${monday}.`);
    if (seen.has(week)) throw new HttpError(400, `${at}: the week of ${week} is listed twice.`);
    seen.add(week);
    const vals: Record<string, number | null> = {};
    for (const f of TARGET_FIELDS) {
      const raw = r?.[f];
      if (raw === null || raw === undefined || String(raw).trim() === "") { vals[f] = null; continue; }
      const n = Number(String(raw).replace(/,/g, "").trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_VALUE) throw new HttpError(400, `${at} (week of ${week}): "${String(raw).slice(0, 20)}" is not a whole number from 0 to ${MAX_VALUE.toLocaleString("en-IN")}.`);
      vals[f] = n;
    }
    return { week, vals };
  });

  let saved = 0, removed = 0;
  for (const { week, vals } of clean) {
    const week_start = new Date(`${week}T00:00:00.000Z`);   // a business date: UTC midnight of the IST date
    const before = await WeeklyTarget.findOne({ week_start }).lean<any>();
    if (TARGET_FIELDS.every((f) => vals[f] === null)) {
      if (before) { await WeeklyTarget.deleteOne({ _id: before._id }); await audit({ entity: "WeeklyTarget", entityId: before._id, newValue: `removed week ${week}`, actor: user.id }); removed++; }
      continue;
    }
    const doc = await WeeklyTarget.findOneAndUpdate({ week_start }, { $set: { ...vals, updated_by: user.id } }, { upsert: true, new: true });
    for (const f of TARGET_FIELDS) {
      if ((before?.[f] ?? null) !== vals[f]) await audit({ entity: "WeeklyTarget", entityId: doc._id, field: `${week} ${f}`, oldValue: before?.[f] ?? null, newValue: vals[f], actor: user.id });
    }
    saved++;
  }
  return NextResponse.json({ saved, removed });
});

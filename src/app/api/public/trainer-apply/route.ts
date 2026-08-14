import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { Notification, Program, PublicToken, Trainer } from "@/models";
import { audit } from "@/lib/audit";

// Public trainer application (CEO 13/08: "Add Trainer ke fields as a form uske paas chala
// jaye, wo khud bhar de — mere logon ka kaam kam ho jaye; fresh bhi bhej sake"). Two ways in:
//   - WITH ?token= : the link Divya sends from Quick-invite — completes the pre-created
//     Trainer profile (prefilled), single-use.
//   - WITHOUT token: a fresh self-application — creates a Trainer at "Fresh Lead".
// A trainer NEVER sets pay, TR ID, or pipeline stage from here; staff move the pipeline.
// No login is created — the Trainer doc is a pipeline record, not an account (accounts are
// admin-created per the role matrix).

const EARLY_STAGES = ["Fresh Lead", "Shortlisted"];

// What the applicant may write about themselves — nothing else crosses this boundary.
function applicantFields(body: Record<string, unknown>) {
  const S = (v: unknown) => String(v ?? "").trim();
  const N = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 60 ? n : undefined; };
  const skills = S(body.skills).split(/[,;/]+/).map((x) => x.trim()).filter(Boolean);
  return {
    name: S(body.name), phone: S(body.phone).replace(/\D/g, "").slice(-10), email: S(body.email) || undefined,
    qualification: S(body.qualification) || undefined,
    industry_experience_years: N(body.industry_experience_years),
    teaching_experience_years: N(body.teaching_experience_years),
    skills, home_location_other: S(body.home_location_other) || undefined,
    pipeline_note: S(body.note) ? `Applicant note: ${S(body.note).slice(0, 500)}` : undefined,
  };
}

// GET ?token= → prefill for the tokenized form (name/phone/email Divya already typed).
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const token = req.nextUrl.searchParams.get("token");
  const programs = await Program.find({ active: true }).select("name code scheme").lean<any[]>();
  if (!token) return NextResponse.json({ prefill: null, programs });
  const t = await PublicToken.findOne({ token, purpose: "trainer_apply", active: true }).lean<any>();
  if (!t?.trainer) throw new HttpError(404, "This link is not valid or has already been used.");
  const tr = await Trainer.findById(t.trainer).select("name phone email qualification skills home_location_other").lean<any>();
  if (!tr) throw new HttpError(404, "This link is not valid or has already been used.");
  return NextResponse.json({ prefill: { name: tr.name, phone: tr.phone, email: tr.email ?? "", qualification: tr.qualification ?? "", skills: (tr.skills ?? []).join(", "), home_location_other: tr.home_location_other ?? "" }, programs });
});

// POST → complete (token) or create (fresh) the application.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  await rateLimit(`trainer-apply:${clientKey(req)}`, 5, 60 * 60 * 1000); // 5/hour/IP
  const body = await req.json();
  // Honeypot: bots fill every field; humans never see this one. Fake success, no write.
  if (String(body.website ?? "").trim()) return NextResponse.json({ ok: true }, { status: 201 });
  const f = applicantFields(body);
  if (!f.name || f.phone.length !== 10) throw new HttpError(400, "Name and a 10-digit phone are required.");
  if (!f.skills.length) throw new HttpError(400, "Tell us at least one skill / job role you can teach.");

  if (body.token) {
    const t = await PublicToken.findOne({ token: String(body.token), purpose: "trainer_apply", active: true });
    if (!t?.trainer) throw new HttpError(404, "This link is not valid or has already been used.");
    const tr = await Trainer.findById(t.trainer);
    if (!tr) throw new HttpError(404, "This link is not valid or has already been used.");
    // Once staff have moved the pipeline past the early stages, the form must not rewrite
    // a profile that NSDC paperwork may already be based on.
    if (!EARLY_STAGES.includes(tr.pipeline_status)) {
      throw new HttpError(409, "This profile has already progressed — please contact the office for changes.");
    }
    // QA-040 (2026-08-14): Object.assign onto the mongoose document saved NOTHING — the
    // audit row and the burned link both landed while the profile kept its placeholder
    // skills (live evidence: trainer 6a7e…ec7c, updatedAt === createdAt). doc.set() is the
    // supported write path; undefined values are stripped so a field the applicant left
    // blank never erases what Divya pre-typed.
    tr.set(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
    await tr.save();
    t.active = false; // single-use: the completed form burns the link
    await t.save();
    await audit({ entity: "Trainer", entityId: tr._id, field: "self_application", newValue: "profile completed via trainer-apply link", actor: null });
    // QA-041: the applicant is promised a callback — tell the people who make it.
    await Notification.create({
      type: "trainer_application", severity: "info",
      message: `Trainer application completed: ${tr.name} (${(tr.skills ?? []).join(", ") || "no skills listed"}) — review the CV.`,
      entity: "Trainer", entity_id: tr._id, link: "/trainers", role_target: ["Admin", "Operations"],
    });
    return NextResponse.json({ ok: true, mode: "completed" }, { status: 200 });
  }

  // Fresh application — lands at the top of the pipeline for CV review.
  const existing = await Trainer.findOne({ phone: f.phone }).select("_id").lean<any>();
  if (existing) {
    // Anti-enumeration: same shape as success; staff see the earlier record either way.
    return NextResponse.json({ ok: true, mode: "received" }, { status: 201 });
  }
  const tr = await Trainer.create({ ...f, pipeline_status: "Fresh Lead", status: "Available", source: "Self Application" });
  await audit({ entity: "Trainer", entityId: tr._id, field: "self_application", newValue: "fresh application via /p/trainer-apply", actor: null });
  await Notification.create({
    type: "trainer_application", severity: "info",
    message: `New trainer application: ${tr.name} (${(tr.skills ?? []).join(", ")}) — review the CV.`,
    entity: "Trainer", entity_id: tr._id, link: "/trainers", role_target: ["Admin", "Operations"],
  });
  return NextResponse.json({ ok: true, mode: "received" }, { status: 201 });
});

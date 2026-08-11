import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { Candidate, EDUCATION_LEVEL, Program, PublicToken } from "@/models";
import { findDuplicateCandidates } from "@/lib/duplicates";
import { audit } from "@/lib/audit";

// Public candidate self-registration (2026-08-11: "मैंने आपको एक link भेज दिया, उस link पे
// आप अपनी detail भर दो"). No session — the per-location token in the URL is the credential.
// Guard rails: token must be active, honeypot field must be empty, per-IP rate limit.

const hits = new Map<string, { count: number; windowStart: number }>();
function rateLimit(ip: string, max = 10, windowMs = 10 * 60_000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.windowStart > windowMs) { hits.set(ip, { count: 1, windowStart: now }); return; }
  h.count++;
  if (h.count > max) throw new HttpError(429, "Too many submissions — please try again later.");
}

async function loadToken(token: string) {
  const t = await PublicToken.findOne({ token, purpose: "register", active: true })
    .populate("location", "name city state operational_status")
    .populate("program", "name code")
    .lean<any>();
  if (!t) throw new HttpError(404, "This link is not valid or has been switched off.");
  return t;
}

// GET → what the form needs to render (location name, program choice)
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  const programs = t.program
    ? [t.program]
    : await Program.find({ active: true }).select("name code").lean<any[]>();
  return NextResponse.json({
    location: { name: t.location?.name, city: t.location?.city, state: t.location?.state },
    programs,
    education_levels: EDUCATION_LEVEL,
  });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  rateLimit(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local");
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot — bots fill every field

  const name = String(body.name ?? "").trim();
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  if (!name || phone.length < 10) throw new HttpError(400, "Name and a 10-digit phone number are required.");
  const program = body.program && !t.program ? body.program : (t.program?._id ?? body.program);
  if (!program) throw new HttpError(400, "Please choose a program.");

  const doc = await Candidate.create({
    name,
    phone,
    gender: body.gender || undefined,
    dob: body.dob ? new Date(body.dob) : undefined,
    education: EDUCATION_LEVEL.includes(body.education) ? body.education : undefined,
    last_training_date: body.last_training_date ? new Date(body.last_training_date) : undefined,
    location: t.location._id,
    program,
    source: "Self Registration",
    lifecycle_status: "Unassigned",
  });
  await audit({ entity: "Candidate", entityId: doc._id, field: "create", newValue: `self-registered via public link (${t.location?.name})`, actorType: "EXTERNAL_SYNC" });
  // Advisory duplicate note for the team, never surfaced to the candidate.
  const dups = await findDuplicateCandidates({ phone, name, dob: doc.dob }, String(doc._id)).catch(() => []);
  if (dups.length) {
    await audit({ entity: "Candidate", entityId: doc._id, field: "duplicate_check", newValue: `${dups.length} possible duplicate(s) at intake`, actorType: "SYSTEM" });
  }
  return NextResponse.json({ ok: true, message: "Thank you! Your details are registered — the team will contact you." }, { status: 201 });
});

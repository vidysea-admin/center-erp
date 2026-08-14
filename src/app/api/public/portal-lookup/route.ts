import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { BatchMember, Candidate, PublicToken } from "@/models";
import { clientKey, rateLimit } from "@/lib/rate-limit";

// 2026-08-13 (Umesh: "candidate ke liye bhi ek hoga — ye requirement hai"): the /p/me entry
// point. A candidate types the mobile number they registered with and lands on their own
// "My Training" page (the per-member attendance capability link).
//
// Trust model: the WhatsApp/SMS distribution of these links already treats possession of the
// registered phone as the credential. Typing a number does NOT prove possession, so where a
// date of birth is on file it is demanded as the second factor; where the imported row carries
// none (most sheet rows), the phone number alone opens the page — same information the link in
// that phone's WhatsApp already shows, and every failure is the SAME generic message so the
// endpoint neither confirms nor denies that a number is known. Rate-limited per IP.

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  rateLimit(`portal-lookup:${clientKey(req)}`, 10, 60_000);

  const body = await req.json().catch(() => ({}));
  const phone = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
  const dob = String(body.dob ?? "").trim(); // yyyy-mm-dd from the date input
  // QA-057: the refusal stays GENERIC on purpose (anti-enumeration — it never confirms a
  // number is known), but it now names the second field, because with 504 of 590 candidates
  // carrying a DOB the old wording read as "wrong number" to the majority.
  const fail = () => new HttpError(404, "These details did not match. Check the mobile number — and if you have a date of birth on record, enter that too. Your centre coordinator can also send you your link.");

  if (phone.length !== 10) throw fail();
  const cand = await Candidate.findOne({ phone: { $regex: phone + "$" } }).select("name dob sidh_status lifecycle_status").lean<any>();
  if (!cand) throw fail();
  if (cand.dob) {
    // QA-056 (S1, checker): DOBs imported at IST midnight are stored as the PREVIOUS day
    // 18:30 UTC, and a UTC .toISOString() comparison locked every such student out — their
    // real birthday 404'd, the day before it worked. Both sides now canonicalize to the
    // IST calendar date (+05:30) before comparing, which also leaves clean UTC-midnight
    // dates (API-created rows) matching exactly as before.
    const istDateKey = (d: string | Date) => {
      const x = new Date(d);
      x.setMinutes(x.getMinutes() + 330);
      return x.toISOString().slice(0, 10);
    };
    if (!dob || istDateKey(dob) !== istDateKey(cand.dob)) throw fail();
  }

  // At most one active membership (partial-unique index on {candidate, left_on: null}).
  const member = await BatchMember.findOne({ candidate: cand._id, left_on: null }).select("_id batch").lean<any>();
  if (!member) {
    // Real candidate, no batch yet — say where they stand instead of a dead end.
    return NextResponse.json({
      enrolled: false,
      name: String(cand.name ?? "").split(" ")[0],
      sidh_status: cand.sidh_status ?? "Not Registered",
      lifecycle_status: cand.lifecycle_status ?? "Unassigned",
    });
  }

  const existing = await PublicToken.findOne({ purpose: "attendance", batch_member: member._id, active: true }).lean<any>();
  const token = existing?.token ?? (await PublicToken.create({
    purpose: "attendance", batch: member.batch, batch_member: member._id,
    token: crypto.randomBytes(16).toString("hex"), active: true,
  })).token;

  return NextResponse.json({ enrolled: true, url: `/p/attendance/${token}` });
});

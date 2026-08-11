import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { Location, Notification, User } from "@/models";
import { audit } from "@/lib/audit";

// Public self-signup (2026-08-11, CEO): single login for everyone — trainers, SPOCs, staff
// sign up, choose a role, and the account sits PENDING until an Admin approves it. Nothing
// is accessible before approval. Admin is deliberately not offered.
const SIGNUP_ROLES = ["Trainer", "Location", "Enrollment", "Operations"] as const;

const hits = new Map<string, { count: number; windowStart: number }>();
function rateLimit(ip: string, max = 5, windowMs = 15 * 60_000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.windowStart > windowMs) { hits.set(ip, { count: 1, windowStart: now }); return; }
  h.count++;
  if (h.count > max) throw new HttpError(429, "Too many signups — please try again later.");
}

// GET → what the form needs (role choices + locations for SPOC/Trainer preference)
export const GET = apiHandler(async () => {
  await dbConnect();
  const locations = await Location.find({ }).select("name city").sort({ name: 1 }).limit(300).lean<any[]>();
  return NextResponse.json({ roles: SIGNUP_ROLES, locations });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  rateLimit(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local");
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  const password = String(body.password ?? "");
  const role = String(body.role ?? "");
  if (!name || !email.includes("@") || password.length < 8) {
    throw new HttpError(400, "Name, a valid email and a password of at least 8 characters are required.");
  }
  if (!SIGNUP_ROLES.includes(role as any)) throw new HttpError(400, "Choose a valid role.");

  const existing = await User.findOne({ email }).select("_id").lean();
  if (existing) throw new HttpError(409, "An account with this email already exists — try logging in.");

  const doc = await User.create({
    name, email, phone,
    password_hash: await bcrypt.hash(password, 10),
    role: role as any,               // effective role; rights stay locked until approval
    requested_role: role as any,
    approval_status: "Pending",
    active: false,                    // approval flips this on
    can_edit: false,
    location_scope: body.location ? [body.location] : [],
  });
  await audit({ entity: "User", entityId: doc._id, field: "signup", newValue: `${email} requested ${role}`, actorType: "EXTERNAL_SYNC" });
  await Notification.create({
    type: "signup_pending", severity: "info",
    message: `New signup awaiting approval: ${name} (${email}) as ${role}`,
    entity: "User", entity_id: doc._id, link: "/admin?tab=Users",
    role_target: ["Admin"],
  });
  return NextResponse.json({ ok: true, message: "Account created — an Admin will approve it shortly. You will be able to log in after approval." }, { status: 201 });
});

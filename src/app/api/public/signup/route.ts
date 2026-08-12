import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { Location, Notification, User } from "@/models";
import { audit } from "@/lib/audit";

// Public self-signup (2026-08-11, CEO): single login for everyone — trainers, SPOCs, staff
// sign up, choose a role, and the account sits PENDING until an Admin approves it. Nothing
// is accessible before approval. Admin is deliberately not offered.
const SIGNUP_ROLES = ["Trainer", "Location", "Enrollment", "Operations"] as const;

// GET → what the form needs (role choices + locations for SPOC/Trainer preference)
export const GET = apiHandler(async () => {
  await dbConnect();
  const locations = await Location.find({ }).select("name city").sort({ name: 1 }).limit(300).lean<any[]>();
  return NextResponse.json({ roles: SIGNUP_ROLES, locations });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  rateLimit(clientKey(req), 10, 15 * 60_000); // audit auth S2-14: right-most trusted hop
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
  // 2026-08-12 audit (auth S2-16): a distinct 409 on an existing address turned this into an
  // unauthenticated oracle for "does this person have an account here". The request is now
  // accepted either way and nothing is created for an address already in use — the honest
  // outcome for the real user is identical, because a genuine signup also just waits for an
  // Admin. An Admin sees only the one pending row, so this cannot be used to spam the queue.
  if (existing) return NextResponse.json({ ok: true, pending: true }, { status: 201 });

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

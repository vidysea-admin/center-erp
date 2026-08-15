import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { User } from "@/models";
import { audit } from "@/lib/audit";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";
import { renderMail, sendMail } from "@/lib/mailer";

export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "users.manage"); // QA-025 P3: reading the user list = view level
  const items = await User.find({}, "-password_hash").populate("location_scope", "name code").lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // togglable (2026-08-11)
  requireEdit(user); // Rule 39: a view-only holder of a granted right still may not write
  const body = await req.json();
  if (!body.name || !body.email || !body.password || !body.role) {
    throw new HttpError(400, "name, email, password, role are required");
  }
  // Security review 2026-08-11: users.manage is grantable — creating an Admin (or a user
  // with pre-granted special rights) stays an Admin-only act.
  // 2026-08-12 audit (S1): the guard named only "Admin", so a users.manage holder could mint
  // themselves an Operations account — unscoped, can_edit, and exempt from Rule 39 — which is
  // the same escalation by a different door. Any privileged shape is now Admin-only.
  const elevated = body.role === "Admin" || body.role === "Operations"
    || (body.extra_permissions?.length ?? 0) > 0
    || body.can_edit === true
    || (body.location_scope?.length ?? 0) === 0; // unscoped == sees every centre
  if (elevated && user.role !== "Admin") {
    throw new HttpError(403, "Only an Admin may create Admin/Operations accounts, unscoped accounts, or grant special rights.");
  }
  // QA-141 (Umesh): the login identity itself gets format-checked — a mistyped email here is
  // an account nobody can ever mail or reset.
  const eErr = emailError(body.email);
  if (eErr) throw new HttpError(400, eErr);
  if (body.phone) {
    const pErr = phoneError(body.phone, { optional: true });
    if (pErr) throw new HttpError(400, pErr);
    body.phone = canonicalPhone(body.phone)!;
  }
  const doc = await User.create({
    name: body.name, email: body.email, phone: body.phone,
    password_hash: await bcrypt.hash(body.password, 10),
    role: body.role,
    location_scope: body.location_scope ?? [],
    can_edit: body.can_edit ?? false,
    active: body.active ?? true,
    // 2026-08-14: self-signup is closed, so a known-but-not-yet-cleared person is entered
    // by the Admin as Pending and approved through the same queue as before.
    approval_status: body.approval_status,
    requested_role: body.requested_role,
  });
  await audit({ entity: "User", entityId: doc._id, newValue: "created " + body.email, actor: user.id });
  // QA-115: welcome mail — NEVER the password (that stays out-of-band with the admin).
  // A Pending-created account is told on APPROVAL instead, not here.
  if (doc.approval_status !== "Pending") {
    const { html, text } = renderMail({
      title: "Your Center ERP account is ready",
      lines: [`Hello ${doc.name},`, `An account (${doc.email}, role ${doc.role}) has been created for you on the Vidysea Center ERP.`, `${user.name} will share your password with you separately.`],
      cta: { label: "Sign in to the ERP", url: "https://www.vidysea.com/erp" },
    });
    sendMail({ to: doc.email, subject: "Your Center ERP account is ready", html, text, entity: "User", entity_id: doc._id }).catch(() => {});
  }
  const { password_hash: _ph, ...safe } = doc.toObject();
  return NextResponse.json({ item: safe }, { status: 201 });
});

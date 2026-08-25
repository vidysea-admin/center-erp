import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { Trainer, User } from "@/models";
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
    // QA-1211: these two were MISSING from this list, and the way they were missing is the
    // interesting part - the escalation guard eighteen lines up READS `body.extra_permissions` to
    // decide whether the request needs Admin, and then `User.create` threw the value away. The
    // field was checked for danger and then discarded. So an Admin ticking "Special rights" while
    // CREATING a user got 201, a user holding nothing, and no hint that anything had been dropped -
    // while the SAME drawer, on edit, stored them correctly (`users/[id]/route.ts:70` loops over a
    // list containing both). A control that reports success and does nothing is the dead-input class
    // this project has paid for under QA-712, QA-723 and QA-754; this is the same shape with a 201
    // instead of a 403.
    extra_permissions: body.extra_permissions ?? [],
    revoked_permissions: body.revoked_permissions ?? [],
    // 2026-08-14: self-signup is closed, so a known-but-not-yet-cleared person is entered
    // by the Admin as Pending and approved through the same queue as before.
    approval_status: body.approval_status,
    requested_role: body.requested_role,
  });
  await audit({ entity: "User", entityId: doc._id, newValue: "created " + body.email, actor: user.id });
  // QA-149: an Add-User login with role Trainer and a trainer's email IS that trainer's login —
  // link it now so "My batches" works from the first sign-in (the other direction, Add Trainer
  // → Create login, lives on the trainer page).
  if (doc.role === "Trainer") {
    const em = String(doc.email).trim().toLowerCase();
    await Trainer.updateOne(
      { email: new RegExp(`^${em.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), $or: [{ user: null }, { user: { $exists: false } }] },
      { $set: { user: doc._id } },
    );
  }
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

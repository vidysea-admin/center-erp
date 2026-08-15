import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, Trainer, User } from "@/models";
import { assertTrainerDocInScope, trainerScopeTies } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { emailError } from "@/lib/validate";
import { renderMail, sendMail } from "@/lib/mailer";

// QA-148 (Manish, 15/08): "Add Trainer se trainer add kiya, bypass se Certified, batch
// assign — ab is trainer se login kaise karun?" There was NO bridge: Add Trainer makes a
// person, Add User makes a login, nothing joined them, and the trainer's batch list opened
// on an empty "My batches". This verb is the bridge, ONE click on the trainer's page:
//   - a User (role Trainer, can_edit — a trainer login exists to enter daily logs) with the
//     trainer's email, Approved, location_scope = every centre the trainer is tied to
//     (nomination / home / capable) PLUS the centres of the batches assigned to them;
//   - Trainer.user linked (so is_mine works from the first login);
//   - the password: caller-supplied, else a random temporary one RETURNED ONCE in the
//     response for the admin to hand over — never mailed (QA-115 rule); the welcome mail
//     says the admin will share it.
// Body: { password?: string }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "users.manage"); // creating a login IS user management
  requireEdit(user);
  const { id } = await ctx.params;
  const tr = await Trainer.findById(id).lean<any>();
  if (!tr) throw new HttpError(404, "Trainer not found");
  assertTrainerDocInScope(user, tr);
  if (tr.user) {
    const existing = await User.findById(tr.user).select("email").lean<any>();
    throw new HttpError(409, `This trainer already has a login${existing?.email ? ` (${existing.email})` : ""}.`);
  }
  const email = String(tr.email ?? "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "The trainer has no email — add one on the profile first; the email is the login.");
  const eErr = emailError(email);
  if (eErr) throw new HttpError(400, eErr);
  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "") || crypto.randomBytes(6).toString("base64url") + "!1";
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");

  // Scope: every centre this trainer is tied to + every centre they are assigned to teach at.
  const batchLocs = await Batch.find({ trainer: tr._id }).distinct("location");
  const scope = [...new Set([...trainerScopeTies(tr), ...batchLocs.map(String)])];

  // An existing login with the same email (made by hand via Add User) is LINKED, not duplicated.
  let doc = await User.findOne({ email }).lean<any>();
  let created = false;
  if (doc) {
    if (doc.role !== "Trainer") throw new HttpError(409, `A ${doc.role} account already uses ${email} — a trainer login must be its own account.`);
    const merged = [...new Set([...(doc.location_scope ?? []).map(String), ...scope])];
    await User.updateOne({ _id: doc._id }, { $set: { location_scope: merged, can_edit: true, active: true, approval_status: "Approved" } });
  } else {
    doc = await User.create({
      name: tr.name, email, phone: tr.phone,
      password_hash: await bcrypt.hash(password, 10),
      role: "Trainer", location_scope: scope, can_edit: true, active: true, approval_status: "Approved",
      approved_by: user.id, approved_at: new Date(),
    });
    created = true;
  }
  await Trainer.updateOne({ _id: tr._id }, { $set: { user: doc._id } });
  await audit({ entity: "Trainer", entityId: tr._id, field: "login", newValue: created ? `login created ${email}` : `login linked ${email}`, actor: user.id });
  if (created) {
    const { html, text } = renderMail({
      title: "Your Center ERP trainer login is ready",
      lines: [`Hello ${tr.name},`, `A trainer login (${email}) has been created for you on the Vidysea Center ERP.`, `${user.name} will share your password with you separately.`],
      cta: { label: "Sign in to the ERP", url: "https://www.vidysea.com/erp" },
    });
    sendMail({ to: email, subject: "Your Center ERP trainer login is ready", html, text, entity: "User", entity_id: doc._id }).catch(() => {});
  }
  return NextResponse.json({
    item: { user_id: doc._id, email, role: "Trainer", location_scope: scope, linked: true, created },
    // Returned ONCE, only when we minted it — the admin hands it over out-of-band.
    ...(created && !body.password ? { temporary_password: password } : {}),
  }, { status: created ? 201 : 200 });
});

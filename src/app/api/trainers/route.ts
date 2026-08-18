import { collectionRoutes } from "@/lib/crud";
import { Batch, Location, Trainer } from "@/models";
import { renderMail, sendMail } from "@/lib/mailer";
import { hasPermission } from "@/lib/permissions";
import { ACTIVE_BATCH_STATUSES, assertLocationOperational } from "@/lib/rules";
import { HttpError, isScoped } from "@/lib/authz";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";

// 2026-08-12, found by testing a real Trainer login: the directory is not location-scoped,
// so every signed-in user could read all 19 trainers INCLUDING day_rate, compensation and
// incentive notes. Pay is not directory data. Anyone without the trainers.manage right now
// gets the roster without the money fields.
// 2026-08-12: extended to the hiring journey too — NSDC remarks, qualification, experience
// and payment references are personnel data, not directory data.
// nominated_for_location/_program deliberately stay VISIBLE. They are not personnel data — they
// are the assignment fact "this trainer is cleared for this centre and this job role", which is
// what makes their TR ID usable on a batch. Masking them broke the trainer dropdown for anyone
// without trainers.manage, which is most of the people who actually create batches.
// One list, imported by the item route rather than copied into it — the two had already drifted
// apart once, and a mask that is right in one place and wrong in the other is worse than no mask.
const SENSITIVE_FIELDS = ["day_rate", "compensation_type", "compensation_fixed", "source", "qualification", "industry_experience_years", "teaching_experience_years", "nsdc_remarks", "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note", "incentive_note"];

export function maskTrainerSecrets(items: any[], canManage: boolean) {
  if (canManage) return items;
  return items.map((t) => {
    const safe = { ...t };
    for (const f of SENSITIVE_FIELDS) delete safe[f];
    return safe;
  });
}

export const { GET, POST } = collectionRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  // 2026-08-13 (Umesh, testing the view-only principal): masking pay was not enough — a
  // scoped user saw the ENTIRE trainer directory. A trainer belongs to a centre through
  // nomination, capability or home; scoped users see only trainers tied to their centres.
  scopeFilter: (user) => {
    const ids = (user.location_scope ?? []).map(String);
    return {
      $or: [
        { nominated_for_location: { $in: ids } },
        { capable_locations: { $in: ids } },
        { home_location: { $in: ids } },
      ],
    };
  },
  async mapItems(items, user) {
    // QA-031/045 (checker): "Assigned 6" was derived from pipeline_status Certified while
    // assigned_batches sat empty on all 71 — two different facts presented as one. The
    // truth is the batch links themselves: a trainer is assigned when a live batch points
    // at them. Attached per row so the UI stops guessing.
    const ids = items.map((t: any) => t._id);
    const live = ids.length
      ? await Batch.find({ trainer: { $in: ids }, status: { $in: ACTIVE_BATCH_STATUSES } })
        .select("code status trainer").lean<any[]>()
      : [];
    const byTrainer = new Map<string, any[]>();
    for (const b of live) {
      const k = String(b.trainer);
      if (!byTrainer.has(k)) byTrainer.set(k, []);
      byTrainer.get(k)!.push({ _id: b._id, code: b.code, status: b.status });
    }
    const withBatches = items.map((t: any) => ({ ...t, live_batches: byTrainer.get(String(t._id)) ?? [] }));
    return maskTrainerSecrets(withBatches, await hasPermission(user, "trainers.manage"));
  },
  fields: ["name", "phone", "email", "skills", "home_location", "home_location_other", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active", "pipeline_status", "tr_id", "capable_locations", "programs_applied", "compensation_type", "compensation_fixed", "govt_candidate_id",
    // 2026-08-12 hiring pipeline (Manish's RPL walkthrough)
    "nominated_for_location", "nominated_for_program", "source", "qualification",
    "industry_experience_years", "teaching_experience_years", "nsdc_remarks",
    "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note"],
  searchFields: ["name", "phone", "email", "tr_id"],
  // QA-095/091/061 (checker round 5, "the sixth time in this pattern"): the CEO closed the
  // Trainer's doors in the MENU; the server now closes them too. A Trainer never reads the
  // trainer directory ("I shouldn't be able to see other trainers"), and Enrollment's brief
  // is candidates, not the hiring surface.
  readRoles: ["Admin", "Operations", "Location"],
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // F-B5 (Manish): a halted centre must stop hiring — no nominating trainers for it.
  async beforeCreate(body, user) {
    // QA-141 (Umesh): manual entry is strict — normalize the phone to the bare 10 digits
    // (one person, one row under the unique index) and refuse junk outright.
    const pErr = phoneError(body.phone);
    if (pErr) throw new HttpError(400, pErr);
    body.phone = canonicalPhone(body.phone)!;
    const eErr = emailError(body.email, { optional: true });
    if (eErr) throw new HttpError(400, eErr);
    if (body.nominated_for_location) await assertLocationOperational(body.nominated_for_location, "Nominating a trainer for this centre");
    // QA-125: a scoped creator must tie the new trainer to their own centre — otherwise
    // they either write into a foreign centre or create someone their own list will
    // never show them (and, before this fix, could then still edit by id).
    if (isScoped(user)) {
      const allowed = user.location_scope.map(String);
      const ties = [body.nominated_for_location, body.home_location, ...((body.capable_locations as unknown[]) ?? [])]
        .filter(Boolean).map(String);
      if (!ties.length || !ties.every((t) => allowed.includes(t))) {
        throw new HttpError(403, "Tie the trainer to your own centre — nomination, home or capable location must be one of yours.");
      }
    }
  },
  // -119 (M4-16, Manish 17/08 [03:07] "trainer ke case me bhi waise hi saara cheez… aur uski mail
  // jayegi, sab kuch hoga jaise candidate ke liye tha"). The candidate welcome mail shipped in -109;
  // this is its trainer twin — a separate screen with a separate mailer, which is exactly why the
  // sheet treats it as separate work. Same discipline as the candidate path: fire-and-forget, so
  // creating a trainer can never fail on mail, and a trainer with no email is not an error — sendMail
  // records "skipped: no valid recipient address" in MailLog, so "did it go?" stays answerable per
  // trainer. No SMS arm here: that would need its own approved DLT template, and inventing one would
  // be a send that cannot happen.
  async afterWrite(doc, user) {
    const centre = doc.home_location
      ? await Location.findById(doc.home_location).select("name").lean<any>().catch(() => null)
      : null;
    const where = centre?.name ?? doc.home_location_other ?? "our centres";
    const { html, text } = renderMail({
      title: "You have been added as a trainer",
      lines: [
        `Hello ${doc.name},`,
        `You have been added as a trainer for ${where}. The team will be in touch about batches, documents and next steps.`,
        `Added by ${user.name}. If anything above is wrong, reply to this email and we will correct it.`,
      ],
    });
    // -121 (QA-260, checker on live -119): this used to `return` when there was no email, so nothing
    // was logged — while the -119 note claimed MailLog would record the skip. The claim was the right
    // behaviour and the code was wrong, so the code moved: sendMail is called either way and records
    // "skipped: no valid recipient address" itself (mailer.ts:101/108 — the QA-250 fix, which stores a
    // "(no address on record)" placeholder because MailLog.to is required and an empty one used to
    // throw inside a swallowed catch). "Did it go?" is now answerable for EVERY trainer, including the
    // ones it could never have gone to.
    sendMail({ to: doc.email ?? "", subject: "You have been added as a trainer", html, text, entity: "Trainer", entity_id: doc._id }).catch(() => {});
  },
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
  ],
});

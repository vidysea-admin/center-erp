// check-approval-decision-mail - approval-decision-mail (Umesh, 2026-10-19), criteria C1..C5.
//
//   C1  an APPROVED decision mails the requester once: a MailLog row, entity "ApprovalDecision"
//   C2  a REJECTED decision mails the requester once, naming Rejected, and the mail carries the reason
//   C3  nobody but the requester is mailed; the per-account switch gives a skipped row; a mail problem
//       never fails the decision
//   C4  the "approval needed" mail goes to every approver EXCEPT whoever raised the request
//       (by user id, falling back to email, case-insensitive)
//   C5  nobody decides their own request (already enforced in decideApproval - pinned here)
//
// WHY THIS IS A FUNCTION-LEVEL CHECK AND NOT AN HTTP SUITE. Both routes that decide an approval end in
// the same two lib functions, and the mail door records every attempt in MailLog (in a test environment
// every attempt is a "skipped" row, so a row IS the captured mail). Calling the real lib against a
// real database therefore exercises the same code the route does, without a built server. The MailLog
// stores a subject and never a body, so the WORDS of the mail (who decided, the reason) are asserted on
// buildDecisionMail, the function the send is built from.
//
// DATABASE. Own fixture, stamp-derived ids, torn down at the end. Refuses anything but a center_erp_ci*
// database, because it writes users, approval rows and mail log rows.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require_ = createRequire(import.meta.url);

const db = (process.env.MONGODB_DB ?? "").trim();
if (!/^center_erp_ci(?:_|$)/.test(db)) {
  console.error(`check-approval-decision-mail: refusing to run against "${db || "(unset)"}" - it writes fixtures and needs a center_erp_ci* database.`);
  process.exit(1);
}

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra))); }
};

const jitiMod = require_(path.join(root, "node_modules/jiti"));
const createJiti = jitiMod.createJiti ?? jitiMod;
const jiti = createJiti(path.join(root, "scripts/check-approval-decision-mail.mjs"), {
  alias: { "@": path.join(root, "src") }, interopDefault: true,
});
const { dbConnect } = jiti(path.join(root, "src/lib/db.ts"));
const M = jiti(path.join(root, "src/models/index.ts"));
const A = jiti(path.join(root, "src/lib/approvals.ts"));
const { User, ApprovalRule, ApprovalRequest, MailLog, Notification } = M;
const { requireApproval, decideApproval, finalizeApprovalDecision, buildDecisionMail } = A;
const mongoose = require_(path.join(root, "node_modules/mongoose"));
const oid = () => new mongoose.Types.ObjectId();

ok("[instrument] the real lib loaded and exports the functions under test",
  [requireApproval, decideApproval, finalizeApprovalDecision, buildDecisionMail].every((f) => typeof f === "function"),
  { buildDecisionMail: typeof buildDecisionMail });
if (typeof buildDecisionMail !== "function") {
  console.log(`\ncheck-approval-decision-mail: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

await dbConnect();
const stamp = Date.now().toString(36);
const mk = async (tag, extra = {}) => {
  const email = `zzadm.${tag}.${stamp}@vidysea-test.local`;
  const doc = await User.create({ name: `ZZADM ${tag} ${stamp}`, email, password_hash: "x", role: "Admin", can_edit: true, ...extra });
  return { doc, session: { id: String(doc._id), name: doc.name, email, role: "Admin", location_scope: [], can_edit: true }, email };
};
const R = await mk("req");            // the requester
const A1 = await mk("appr1");         // approver one
const A2 = await mk("appr2");         // approver two
const Rquiet = await mk("quiet", { mail_enabled: false }); // a requester whose account mail switch is off

const prior = await ApprovalRule.findOne({ action: "location.edit" }).lean();
const setRule = (users) => ApprovalRule.updateOne({ action: "location.edit" },
  { $set: { enabled: true, approver_role: "Admin", approver_users: users } }, { upsert: true });

const rowsFor = (entity, id) => MailLog.find({ entity, entity_id: id }).lean();
// The send is fire-and-forget, so wait for the rows to settle: until the count has been stable for 700ms
// (and at least `min` rows exist, or the cap is reached).
async function settle(entity, id, min = 0, capMs = 6000) {
  const t0 = Date.now(); let last = -1, since = Date.now();
  for (;;) {
    const n = await MailLog.countDocuments({ entity, entity_id: id });
    if (n !== last) { last = n; since = Date.now(); }
    if (n >= min && Date.now() - since > 700) break;
    if (Date.now() - t0 > capMs) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return rowsFor(entity, id);
}
const raise = async (user, summary = "Location edit for centre ZZADM", extra = {}) => {
  const out = await requireApproval("location.edit", user, { entity: "Location", entity_id: oid(), summary, payload: { x: 1 }, ...extra });
  return out.request;
};
const emails = (rows) => rows.map((r) => String(r.to).toLowerCase()).sort();

try {
  // ---------------------------------------------------------------- C4
  await setRule([]); // role audience: every Admin
  const reqRole = await raise(R.session);
  const rowsRole = await settle("ApprovalRequest", reqRole._id, 2);
  ok("C4 [precondition] the role audience was mailed (both other approvers have a row)",
    emails(rowsRole).includes(A1.email) && emails(rowsRole).includes(A2.email), emails(rowsRole));
  ok("C4 the requester gets NO approval-needed mail on the role path", !emails(rowsRole).includes(R.email), emails(rowsRole));

  await setRule([A1.session.id, R.session.id]); // named list that includes the requester
  const reqNamed = await raise(R.session);
  const rowsNamed = await settle("ApprovalRequest", reqNamed._id, 1);
  ok("C4 [precondition] a named approver was mailed", emails(rowsNamed).includes(A1.email), emails(rowsNamed));
  ok("C4 the requester is not mailed when they are on the named list, and a non-listed Admin is still not", 
    !emails(rowsNamed).includes(R.email) && !emails(rowsNamed).includes(A2.email), emails(rowsNamed));

  await setRule([]);
  // Fallback by EMAIL: the session carries a different id than the audience row, same address in other case.
  const ghost = { ...R.session, id: String(oid()), email: R.email.toUpperCase() };
  const reqGhost = await raise(ghost);
  const rowsGhost = await settle("ApprovalRequest", reqGhost._id, 2);
  ok("C4 [precondition] approvers mailed on the email-fallback run", emails(rowsGhost).includes(A1.email), emails(rowsGhost));
  ok("C4 matched by email (case-insensitive) when the id does not match", !emails(rowsGhost).includes(R.email), emails(rowsGhost));

  // ---------------------------------------------------------------- C1
  await setRule([A1.session.id]);
  const reqA = await raise(R.session, "Location edit for centre ZZADM-APPROVE");
  const claimedA = await decideApproval(String(reqA._id), A1.session, "Approved", "looks fine");
  await finalizeApprovalDecision(claimedA, A1.session, "Approved");
  const rowsA = await settle("ApprovalDecision", reqA._id, 1);
  ok("C1 approve -> exactly one ApprovalDecision row", rowsA.length === 1, rowsA.length);
  ok("C1 ...addressed to the requester", emails(rowsA)[0] === R.email, emails(rowsA));
  ok("C1 ...whose subject names Approved and not Rejected", /approved/i.test(rowsA[0]?.subject ?? "") && !/rejected/i.test(rowsA[0]?.subject ?? ""), rowsA[0]?.subject);
  ok("C1 ...and carries the request's own summary line", (rowsA[0]?.subject ?? "").includes("ZZADM-APPROVE"), rowsA[0]?.subject);
  ok("C1 the decision itself is recorded Approved", (await ApprovalRequest.findById(reqA._id).lean())?.status === "Approved");

  // ---------------------------------------------------------------- C2
  const reqB = await raise(R.session, "Location edit for centre ZZADM-REJECT");
  const claimedB = await decideApproval(String(reqB._id), A1.session, "Rejected", "Wrong centre chosen");
  await finalizeApprovalDecision(claimedB, A1.session, "Rejected");
  const rowsB = await settle("ApprovalDecision", reqB._id, 1);
  ok("C2 reject -> exactly one ApprovalDecision row, to the requester", rowsB.length === 1 && emails(rowsB)[0] === R.email, emails(rowsB));
  ok("C2 ...whose subject names Rejected and not Approved", /rejected/i.test(rowsB[0]?.subject ?? "") && !/approved/i.test(rowsB[0]?.subject ?? ""), rowsB[0]?.subject);
  const built = buildDecisionMail(await ApprovalRequest.findById(reqB._id).lean(), A1.session, "Rejected");
  ok("C2 the mail body says who rejected it", built.lines.some((l) => l.includes(A1.session.name) && /rejected/i.test(l)), built.lines);
  ok("C2 the mail body carries the reason", built.lines.some((l) => l.includes("Wrong centre chosen")), built.lines);
  ok("C2 a figure typed into the reason is not mailed out", !buildDecisionMail({ summary: "s", decision_note: "pay 128500 instead" }, A1.session, "Rejected").lines.join(" ").includes("128500"),
    buildDecisionMail({ summary: "s", decision_note: "pay 128500 instead" }, A1.session, "Rejected").lines);
  ok("C2 an approval with no comment adds no empty Reason line", !buildDecisionMail({ summary: "s" }, A1.session, "Approved").lines.some((l) => /reason|comment/i.test(l)));

  // ---------------------------------------------------------------- C3
  const everyone = [...rowsA, ...rowsB].map((r) => String(r.to).toLowerCase());
  ok("C3 nobody but the requester was mailed about either decision (not the decider, not other approvers)",
    everyone.length === 2 && everyone.every((e) => e === R.email), everyone);

  const reqQ = await raise(Rquiet.session, "Location edit for centre ZZADM-QUIET");
  const claimedQ = await decideApproval(String(reqQ._id), A1.session, "Approved");
  let threw = null;
  try { await finalizeApprovalDecision(claimedQ, A1.session, "Approved"); } catch (e) { threw = e; }
  const rowsQ = await settle("ApprovalDecision", reqQ._id, 1);
  ok("C3 account mail switch OFF -> the decision still succeeds", threw === null && (await ApprovalRequest.findById(reqQ._id).lean())?.status === "Approved", String(threw));
  ok("C3 ...and leaves ONE skipped row naming the account switch", rowsQ.length === 1 && rowsQ[0].status === "skipped" && /mail off for this account/.test(rowsQ[0].reason ?? ""), rowsQ);

  // A requester that no longer exists: there is nobody to mail, and the decision must still stand.
  const reqGone = await raise({ ...R.session, id: String(oid()), email: `zzadm.gone.${stamp}@vidysea-test.local` }, "Location edit for centre ZZADM-GONE");
  const claimedGone = await decideApproval(String(reqGone._id), A1.session, "Rejected", "no");
  let threw2 = null;
  try { await finalizeApprovalDecision(claimedGone, A1.session, "Rejected"); } catch (e) { threw2 = e; }
  ok("C3 a mail that cannot be addressed never fails the decision", threw2 === null && (await ApprovalRequest.findById(reqGone._id).lean())?.status === "Rejected", String(threw2));

  // ---------------------------------------------------------------- C5
  // The rule must NOT already exclude the requester (a named list would refuse them for a different
  // reason): with the role as the audience, the ONLY thing standing between R and the decision is the
  // self-decision guard itself.
  await setRule([]);
  const reqSelf = await raise(R.session, "Location edit for centre ZZADM-SELF");
  let refused = null;
  try { await decideApproval(String(reqSelf._id), R.session, "Approved"); } catch (e) { refused = e; }
  ok("C5 the requester deciding their own request is refused with a 403", refused?.status === 403 && /own request/i.test(refused?.message ?? ""), { status: refused?.status, message: refused?.message });
  const after = await ApprovalRequest.findById(reqSelf._id).lean();
  ok("C5 ...and nothing was written: still Pending, no decider recorded, no decision mail", after?.status === "Pending" && !after?.decided_by
    && (await settle("ApprovalDecision", reqSelf._id, 0, 1200)).length === 0, { status: after?.status, decided_by: after?.decided_by });
} finally {
  const ids = [R, A1, A2, Rquiet].map((u) => u.doc._id);
  const reqs = await ApprovalRequest.find({ summary: /ZZADM/ }).select("_id").lean();
  const reqIds = reqs.map((r) => r._id);
  await MailLog.deleteMany({ entity: { $in: ["ApprovalRequest", "ApprovalDecision"] }, entity_id: { $in: reqIds } });
  await Notification.deleteMany({ entity: "ApprovalRequest", entity_id: { $in: reqIds } });
  await ApprovalRequest.deleteMany({ _id: { $in: reqIds } });
  await User.deleteMany({ _id: { $in: ids } });
  if (prior) await ApprovalRule.updateOne({ action: "location.edit" }, { $set: { enabled: prior.enabled, approver_role: prior.approver_role, approver_users: prior.approver_users ?? [] } });
  else await ApprovalRule.deleteOne({ action: "location.edit" });
  const left = await User.countDocuments({ _id: { $in: ids } }) + await ApprovalRequest.countDocuments({ _id: { $in: reqIds } });
  ok("[teardown] every fixture row was removed and the removal was read back", left === 0, left);
  await mongoose.disconnect();
}
console.log(`\ncheck-approval-decision-mail: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

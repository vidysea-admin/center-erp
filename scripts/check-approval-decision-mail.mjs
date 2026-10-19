// check-approval-decision-mail - approval-decision-mail (Umesh, 2026-10-19), criteria C1..C5.
//
//   C1  an APPROVED decision mails the requester once: a MailLog row, entity "ApprovalDecision"
//   C2  a REJECTED decision mails the requester once, naming Rejected, and the mail carries the reason
//   C3  nobody but the requester is mailed; the per-account switch gives a skipped row; a mail problem
//       never fails the decision
//   C4  the "approval needed" mail goes to every approver EXCEPT whoever raised the request
//       (by user id, falling back to email, case-insensitive)
//   C5  nobody decides their own request (already enforced in decideApproval - pinned here)
//   C6  (r2) the decision note is mailed only to a requester who holds finance.view - the same rule the
//       in-app list applies (api/approvals ?mine=1 deletes decision_note for everyone else)
//   C7  (r2) digest-only mode does NOT hold back the decision mail (the daily digest never lists decisions)
//   S1  (subject-amount, Umesh 2026-10-19) the "approval needed" mail shows the amount in subject and body
//       ONLY to a recipient holding finance.view - decided per recipient, on all three audience paths
//       (role, named list, finance-grant holders); everyone else gets the masked text; the bell stays masked
//   S2  the decision mail does the same for the requester, and a bare buildDecisionMail call fails closed
//   S4  the MAIL LOG never stores an amount, for any recipient: it is readable by any Admin (who does not hold
//       finance.view), so a holder's row carries the masked base subject while the delivered mail is raw
//   S3  nothing else moves: a recipient without finance.view still sees no amount and no typed figure
//       (QA-2447), and the mail body carries the same split as the subject
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
const { User, ApprovalRule, ApprovalRequest, MailLog, Notification, Defaults } = M;
const { mailUsers, mailFor, renderMail } = jiti(path.join(root, "src/lib/mailer.ts"));
const { requireApproval, decideApproval, finalizeApprovalDecision, buildDecisionMail, decisionMailFor, approvalNeededMail, approvalNeededRecipientMail } = A;
const mongoose = require_(path.join(root, "node_modules/mongoose"));
const oid = () => new mongoose.Types.ObjectId();

ok("[instrument] the real lib loaded and exports the functions under test",
  [requireApproval, decideApproval, finalizeApprovalDecision, buildDecisionMail, decisionMailFor, approvalNeededMail, approvalNeededRecipientMail].every((f) => typeof f === "function"),
  { buildDecisionMail: typeof buildDecisionMail, decisionMailFor: typeof decisionMailFor, approvalNeededMail: typeof approvalNeededMail });
if (typeof buildDecisionMail !== "function" || typeof decisionMailFor !== "function" || typeof approvalNeededMail !== "function" || typeof approvalNeededRecipientMail !== "function") {
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
// C6: Admin does NOT carry finance.view (NO_ADMIN_BYPASS), so R above is a requester without it; Rfin holds it by grant.
const Rfin = await mk("fin", { extra_permissions: ["finance.view"] });
// subject-amount: a finance APPROVER (view + approve:edit) - the audience of a cost-head approval is whoever
// financeApprovers() returns, and this account is one by grant.
const AG = await mk("grant", { extra_permissions: ["finance.view", "finance.approve:edit"] });

const priorDefaults = await Defaults.findOne({ _singleton: "defaults" }).lean();
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
const hasRow = (rows, email) => rows.some((r) => String(r.to).toLowerCase() === email);

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
  // subject-amount (C2): the default of the 4th argument is now false (fail closed), so the pins that read the
  // reason out of a bare call pass `true` explicitly - this is the intended behaviour change, not a loosened pin.
  const built = buildDecisionMail(await ApprovalRequest.findById(reqB._id).lean(), A1.session, "Rejected", true);
  ok("C2 the mail body says who rejected it", built.lines.some((l) => l.includes(A1.session.name) && /rejected/i.test(l)), built.lines);
  ok("C2 the mail body carries the reason", built.lines.some((l) => l.includes("Wrong centre chosen")), built.lines);
  ok("C2 [precondition] with the note shown, the reason line IS in the mail (so the next pin can fail)",
    buildDecisionMail({ summary: "s", decision_note: "pay 128500 instead" }, A1.session, "Rejected", true).lines.some((l) => /^Reason: /.test(l)));
  ok("C2 a figure typed into the reason is not mailed out", !buildDecisionMail({ summary: "s", decision_note: "pay 128500 instead" }, A1.session, "Rejected", true).lines.join(" ").includes("128500"),
    buildDecisionMail({ summary: "s", decision_note: "pay 128500 instead" }, A1.session, "Rejected", true).lines);
  ok("C2 an approval with no comment adds no empty Reason line", !buildDecisionMail({ summary: "s" }, A1.session, "Approved", true).lines.some((l) => /reason|comment/i.test(l)));

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

  // ---------------------------------------------------------------- C6
  const NOTE_LINE = /Wrong centre chosen|Reason:|Comment:/;
  const reqNF = await ApprovalRequest.findById(reqB._id).lean(); // raised by R (no finance.view), rejected with a typed reason
  ok("C6 [precondition] the stored request carries the typed reason", reqNF?.decision_note === "Wrong centre chosen", reqNF?.decision_note);
  const mailNF = await decisionMailFor(reqNF, A1.session, "Rejected");
  ok("C6 a requester WITHOUT finance.view gets no decision-note text in the mail", !mailNF.lines.some((l) => NOTE_LINE.test(l)), mailNF.lines);
  ok("C6 ...still hears who rejected it and is pointed to the approver for the reason",
    mailNF.lines.some((l) => l.includes(A1.session.name) && /rejected/i.test(l)) && mailNF.lines.some((l) => l.includes("Open the app or ask the approver for the reason")), mailNF.lines);
  ok("C6 ...and the subject (which names the summary only) carries no note either", !/Wrong centre chosen/.test(mailNF.subject), mailNF.subject);
  const reqNFa = await ApprovalRequest.findById(reqA._id).lean(); // raised by R, approved with "looks fine"
  const mailNFa = await decisionMailFor(reqNFa, A1.session, "Approved");
  ok("C6 the same holds for an approval comment", reqNFa?.decision_note === "looks fine" && !mailNFa.lines.some((l) => /looks fine|Comment:/.test(l)), mailNFa.lines);

  await setRule([A1.session.id]);
  const reqF = await raise(Rfin.session, "Location edit for centre ZZADM-FIN");
  const claimedF = await decideApproval(String(reqF._id), A1.session, "Rejected", "Wrong centre chosen for pay 128500");
  await finalizeApprovalDecision(claimedF, A1.session, "Rejected");
  const reqFdoc = await ApprovalRequest.findById(reqF._id).lean();
  const mailF = await decisionMailFor(reqFdoc, A1.session, "Rejected");
  ok("C6 a requester WITH finance.view keeps the reason line", mailF.lines.some((l) => /^Reason: .*Wrong centre chosen/.test(l)), mailF.lines);
  ok("C6 ...with figures still removed from it", !mailF.lines.join(" ").includes("128500"), mailF.lines);
  ok("C6 ...and gets no 'ask the approver' line", !mailF.lines.some((l) => /ask the approver/i.test(l)), mailF.lines);
  ok("C6 a request whose requester no longer exists is treated as WITHOUT finance.view (no note)",
    !(await decisionMailFor({ ...reqNF, initiator: oid() }, A1.session, "Rejected")).lines.some((l) => NOTE_LINE.test(l)));

  // ---------------------------------------------------------------- S1..S3 (subject-amount)
  // TWO SEAMS, and they must not be confused. What a recipient is SENT is read where the send is built
  // (mailFor with the real callback, the builders). What the MAIL LOG stores is read from MailLog, and it
  // must be MASKED for everybody: MailLog is readable by any Admin (GET /api/test-email) and an Admin does
  // not hold finance.view. A pin that read the holder's raw subject back from MailLog would assert the leak.
  const RAW = (tag) => `Cost entry ₹128500 for ZZADM-${tag} - advance 424242 paid`;
  const subj = (rows, email) => rows.find((r) => String(r.to).toLowerCase() === email)?.subject ?? null;
  const HOLDER_SEES = (t) => typeof t === "string" && t.includes("₹128500") && t.includes("424242");
  const MASKED = (t) => typeof t === "string" && t.includes("₹—") && !t.includes("128500") && !t.includes("424242");
  const NO_FIGURE = (t) => typeof t === "string" && !/₹\s?\d/.test(t) && !t.includes("128500") && !t.includes("424242");
  const recip = (u) => ({ _id: u.doc._id, role: "Admin", email: u.email, name: u.doc.name });

  // the pure builder first: it is what every send is made from
  const bHold = approvalNeededMail(RAW("PURE"), { amount: 128500 }, "Requester", true);
  const bNone = approvalNeededMail(RAW("PURE"), { amount: 128500 }, "Requester", false);
  const bBare = approvalNeededMail(RAW("PURE"), { amount: 128500 }, "Requester");
  ok("S1 builder: a finance.view recipient gets the amount and the typed figure in subject AND first body line",
    HOLDER_SEES(bHold.subject) && HOLDER_SEES(bHold.lines[0]), bHold);
  ok("S1 builder: a recipient without it gets the masked text in subject AND body (S3)",
    MASKED(bNone.subject) && MASKED(bNone.lines[0]), bNone);
  ok("S2 builder: a bare call (no flag) is masked - fail closed", MASKED(bBare.subject) && MASKED(bBare.lines[0]), bBare);

  // the mail door: the BODY and SUBJECT of what is sent follow the per-recipient split, and the LOGGED subject
  // does not (MailLog stores a subject only, so the body is asserted on the function the send is built from)
  {
    const door = { title: "t", subject: "S masked ₹—", lines: ["masked ₹—"],
      perRecipient: async (u) => (u.role === "Holder" ? { subject: "S raw ₹128500", lines: ["raw ₹128500"] } : undefined) };
    const base = renderMail({ title: door.title, lines: door.lines });
    const mH = await mailFor(door, { role: "Holder" }, base, undefined);
    const mN = await mailFor(door, { role: "Other" }, base, undefined);
    const mT = await mailFor({ ...door, perRecipient: async () => { throw new Error("lookup failed"); } }, { role: "Holder" }, base, undefined);
    ok("S1 mail door: the callback's body reaches the holder (text and html), with its own subject",
      mH.subject === "S raw ₹128500" && mH.text.includes("128500") && mH.html.includes("128500"), mH);
    ok("S1 mail door: a recipient the callback declines gets exactly the base text, subject and body (S3)",
      mN.subject === door.subject && mN.text === base.text && mN.html === base.html && !mN.text.includes("128500"), mN);
    ok("S2 mail door: a callback that throws leaves the recipient on the base (masked) text - fail closed",
      mT.subject === door.subject && mT.text === base.text && !mT.text.includes("128500"), mT);
    ok("S4 mail door: for a PERSONALISED send the logged subject is the masked base, not the delivered raw one",
      mH.subject !== mH.log_subject && mH.log_subject === door.subject && !mH.log_subject.includes("128500"), { subject: mH.subject, log_subject: mH.log_subject });
    ok("S4 mail door: a personalised send with NO explicit logSubject still logs the masked base (fail closed)",
      !("logSubject" in door) && mH.log_subject === door.subject);
  }

  // the REAL callback requireApproval hands the mailer: holder -> raw subject and body, everyone else -> undefined
  {
    const pr = approvalNeededRecipientMail(RAW("CB"), { amount: 128500 }, "Requester");
    const forHolder = await pr(recip(Rfin));
    const forAdmin = await pr(recip(A1));
    const forGhost = await pr({ role: "Admin", email: "nobody@vidysea-test.local" });
    ok("S1 callback: a finance.view holder is handed the raw subject and first line", HOLDER_SEES(forHolder?.subject) && HOLDER_SEES(forHolder?.lines?.[0]), forHolder);
    ok("S1 callback: an Admin without finance.view is declined (stays on the masked base) (S3)", forAdmin === undefined, forAdmin);
    ok("S1 callback: a recipient with no id is declined - fail closed", forGhost === undefined, forGhost);
    const door2 = { title: "t", subject: bNone.subject, lines: bNone.lines, perRecipient: pr };
    const base2 = renderMail({ title: door2.title, lines: door2.lines });
    const delivered = await mailFor(door2, recip(Rfin), base2, undefined);
    ok("S1 delivered to the holder: raw subject and body; the log subject is masked",
      HOLDER_SEES(delivered.subject) && HOLDER_SEES(delivered.text) && NO_FIGURE(delivered.log_subject), { subject: delivered.subject, log_subject: delivered.log_subject });
  }

  // call-site wiring (the mail door cannot be intercepted from here): every mail send in requireApproval hands
  // the callback over, and the decision mail hands the masked log subject over
  {
    const fsx = await import("node:fs");
    const src = fsx.readFileSync(path.join(root, "src/lib/approvals.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function requireApproval("), src.indexOf("export async function decideApproval"));
    const sends = (body.match(/mailUsers(?:ByRole)?\(\{/g) ?? []).length;
    const wired = (body.match(/^\s+perRecipient,$/gm) ?? []).length;
    ok("S1 wiring [precondition] requireApproval has mail sends", sends === 3, sends);
    ok("S1 wiring: every mail send in requireApproval passes the per-recipient callback", wired === sends, { sends, wired });
    ok("S4 wiring: the decision mail is sent with the masked log subject", /logSubject:\s*m\.log_subject/.test(src));
  }

  // role audience: every Admin; the holder is Rfin, the others (A1, A2) hold no finance.view
  await setRule([]);
  const reqS1 = await raise(R.session, RAW("S1ROLE"), { payload: { amount: 128500 } });
  const rowsS1 = await settle("ApprovalRequest", reqS1._id, 3);
  ok("S1 role path [precondition] all three approvers have a row", [Rfin, A1, A2].every((u) => hasRow(rowsS1, u.email)), emails(rowsS1));
  ok("S4 role path: MailLog holds the MASKED subject for the finance.view holder too", MASKED(subj(rowsS1, Rfin.email)), subj(rowsS1, Rfin.email));
  ok("S1 role path: an Admin WITHOUT finance.view gets the masked subject (S3)", MASKED(subj(rowsS1, A1.email)) && MASKED(subj(rowsS1, A2.email)), [subj(rowsS1, A1.email), subj(rowsS1, A2.email)]);
  ok("S4 role path: no MailLog row for this request carries a rupee figure or the typed figure, for any recipient", rowsS1.every((r) => NO_FIGURE(r.subject)), rowsS1.map((r) => r.subject));
  const bellS1 = await Notification.find({ entity: "ApprovalRequest", entity_id: reqS1._id }).lean();
  ok("S1 the bell notification stays masked for everyone", bellS1.length >= 1 && bellS1.every((n) => MASKED(n.message)), bellS1.map((n) => n.message));

  // named-list audience
  await setRule([A1.session.id, Rfin.session.id]);
  const reqS1n = await raise(R.session, RAW("S1NAMED"), { payload: { amount: 128500 } });
  const rowsS1n = await settle("ApprovalRequest", reqS1n._id, 2);
  ok("S4 named path: MailLog is masked for the holder and the non-holder alike",
    MASKED(subj(rowsS1n, Rfin.email)) && MASKED(subj(rowsS1n, A1.email)) && rowsS1n.every((r) => NO_FIGURE(r.subject)), rowsS1n.map((r) => r.subject));

  // finance-grant audience (a cost head): the holders are the audience by definition
  await setRule([]);
  const reqS1g = await requireApproval("costcategory.create", R.session, {
    entity: "CostCategory", entity_id: oid(), summary: `New cost head "ZZADM-S1GRANT 424242" added by ${R.session.name} - not approved yet`,
    payload: { kind: "head-approval", name: "ZZADM-S1GRANT 424242" }, fallbackApproverRole: "Admin", decidedByGrant: true,
  });
  const rowsS1g = await settle("ApprovalRequest", reqS1g.request._id, 1);
  ok("S4 grant path: the finance approver is mailed, and the MailLog row is masked", hasRow(rowsS1g, AG.email) && !(subj(rowsS1g, AG.email) ?? "").includes("424242"), subj(rowsS1g, AG.email));
  ok("S1 grant path: a non-holder is not in that audience at all (S3)", !hasRow(rowsS1g, A1.email) && !hasRow(rowsS1g, A2.email), emails(rowsS1g));
  const bellS1g = await Notification.find({ entity: "ApprovalRequest", entity_id: reqS1g.request._id }).lean();
  ok("S1 grant path: the bell stays masked", bellS1g.length >= 1 && bellS1g.every((n) => !n.message.includes("424242")), bellS1g.map((n) => n.message));

  // decision mail, through the send path (MailLog subject) for a holder and a non-holder requester
  await setRule([A1.session.id]);
  const reqS2h = await raise(Rfin.session, RAW("S2HOLD"), { payload: { amount: 128500 } });
  const reqS2n = await raise(R.session, RAW("S2NONE"), { payload: { amount: 128500 } });
  for (const [rq, dec] of [[reqS2h, "Approved"], [reqS2n, "Rejected"]]) {
    const cl = await decideApproval(String(rq._id), A1.session, dec, "ok");
    await finalizeApprovalDecision(cl, A1.session, dec);
  }
  const rowsS2h = await settle("ApprovalDecision", reqS2h._id, 1);
  const rowsS2n = await settle("ApprovalDecision", reqS2n._id, 1);
  ok("S4 decision mail: MailLog holds the MASKED subject for a requester WITH finance.view", MASKED(rowsS2h[0]?.subject) && NO_FIGURE(rowsS2h[0]?.subject), rowsS2h[0]?.subject);
  ok("S2 decision mail: a requester WITHOUT it gets the masked subject (S3)", MASKED(rowsS2n[0]?.subject), rowsS2n[0]?.subject);
  const dmH = await decisionMailFor(await ApprovalRequest.findById(reqS2h._id).lean(), A1.session, "Approved");
  const dmN = await decisionMailFor(await ApprovalRequest.findById(reqS2n._id).lean(), A1.session, "Rejected");
  ok("S2 decision mail, delivered to the holder: raw subject and raw first line", HOLDER_SEES(dmH.subject) && HOLDER_SEES(dmH.lines[0]), dmH);
  ok("S4 decision mail: the holder's logged subject is the masked one, and differs from the delivered one", MASKED(dmH.log_subject) && dmH.log_subject !== dmH.subject, dmH.log_subject);
  ok("S2 decision mail body: first line is masked for the non-holder (S3)", MASKED(dmN.lines[0]) && MASKED(dmN.subject) && MASKED(dmN.log_subject), dmN);
  const bareDM = buildDecisionMail({ summary: RAW("BARE"), payload: { amount: 128500 } }, A1.session, "Approved");
  ok("S2 a bare buildDecisionMail call is masked in subject, first line and log subject - fail closed", MASKED(bareDM.subject) && MASKED(bareDM.lines[0]) && MASKED(bareDM.log_subject), bareDM);
  ok("S2 an unknown requester gets the masked summary too", MASKED((await decisionMailFor({ summary: RAW("GONE"), payload: { amount: 128500 }, initiator: oid() }, A1.session, "Approved")).subject));

  // ---------------------------------------------------------------- C7
  await Defaults.updateOne({ _singleton: "defaults" }, { $set: { digest_only_approval_mails: true } }, { upsert: true });
  await setRule([A1.session.id]);
  // Precondition: the switch really is ON in this run - a per-event mail is folded by the mail door.
  const probeId = oid();
  await mailUsers({ perEvent: true, userIds: [R.session.id], subject: "zzadm probe", title: "t", lines: ["x"], entity: "ZZADMProbe", entity_id: probeId });
  const probeRows = await settle("ZZADMProbe", probeId, 1);
  ok("C7 [precondition] digest-only is ON: a per-event mail IS folded into the digest by the mail door",
    probeRows.length === 1 && /digest-only/.test(probeRows[0]?.reason ?? ""), probeRows.map((r) => r.reason));
  const reqD = await raise(R.session, "Location edit for centre ZZADM-DIGEST");
  const claimedD = await decideApproval(String(reqD._id), A1.session, "Approved", "ok");
  await finalizeApprovalDecision(claimedD, A1.session, "Approved");
  const rowsD = await settle("ApprovalDecision", reqD._id, 1);
  ok("C7 digest-only ON -> the requester still gets exactly one decision mail row", rowsD.length === 1 && emails(rowsD)[0] === R.email, rowsD);
  // A test environment cannot send, so 'sent' is unreachable here; what is provable is WHICH door stopped it:
  // the test-environment door at sendMail, not the digest-only fold that sits before it.
  ok("C7 ...and it was NOT held back by digest-only (its skip reason is the test-environment door's)",
    !/digest-only/.test(rowsD[0]?.reason ?? "") && /test environment/.test(rowsD[0]?.reason ?? ""), rowsD[0]?.reason);
  // email_enabled-off cannot be driven: sendMail checks the test-database shape BEFORE it reads email_enabled,
  // so in any center_erp_ci* run the reason is always the test-environment one. The account switch (C3) can.
} finally {
  if (priorDefaults) await Defaults.updateOne({ _singleton: "defaults" }, { $set: { digest_only_approval_mails: priorDefaults.digest_only_approval_mails === true } });
  else await Defaults.deleteOne({ _singleton: "defaults" });
  const ids = [R, A1, A2, Rquiet, Rfin, AG].map((u) => u.doc._id);
  const reqs = await ApprovalRequest.find({ summary: /ZZADM/ }).select("_id").lean();
  const reqIds = reqs.map((r) => r._id);
  await MailLog.deleteMany({ entity: { $in: ["ApprovalRequest", "ApprovalDecision"] }, entity_id: { $in: reqIds } });
  await MailLog.deleteMany({ entity: "ZZADMProbe" });
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

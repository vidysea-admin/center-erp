// mtg-b3 (Umesh, inbox 2026-10-07; QA-2898 / QA-2899) - the person who entered a cost entry can edit or
// delete it themselves.
//
//   Payment Pending: the creator edits / deletes their own entry.
//   Approved, and the amount or the head (or batch / centre) changes: it goes back for approval through
//     the EXISTING cost.post queue - the row is untouched until an approver says yes.
//   Paid: locked for the creator. Finance and Admin-with-the-grant keep their current rights.
//   Every edit and delete writes an audit row. The delete is SOFT and recoverable.
//   An approved entry's edit / delete needs an in-app confirmation; the server enforces it regardless.
//   An edit is never an easier door than a post: QA-1977 (no auto-post under a Pending head) and the
//   pre-approved cap apply to it.
//
// WHY THESE ARMS ARE SHAPED THIS WAY. Every one is behavioural and derives its ids and its names from
// the run stamp: the "approved by" name in the dialog is the second approver who actually pressed
// Approve, the rows are counted in the raw collection, and the numbers are taken from the live ledger
// before and after. Each arm names the single guard it falsifies; the mutants in the evidence folder
// each break one guard and must turn that arm red:
//   own        - the creator path exists (isCostCreator + the costs.manage door)
//   creator    - only entered_by may use it (a different user is refused, in scope or not)
//   paid       - Paid is locked for the creator
//   confirm    - an approved entry's edit / delete is refused without confirm_approved
//   material   - amount / head / batch / centre on an approved entry goes to a person, not into the row
//   bypass     - the QA-1977 Pending-head rule and the cap are evaluated on an edit
//   fallback   - an approved entry reaches a person even when nobody switched the cost.post rule on
//   fence      - an approval of an edit refuses when the row changed after the edit was requested
//   soft       - a delete archives (recoverable) and the row leaves every total
//   scope      - an edit cannot move an entry onto a centre the creator cannot reach
//   pending    - one edit at a time; a delete is refused while an edit waits
//   finance    - finance's own PATCH / hard DELETE are unchanged
import { requireLocalBase, requireSafeDb } from "./db-guard.mjs";
import { MongoClient, ObjectId } from "mongodb";
import * as XLSX from "xlsx";

const BASE = requireLocalBase("e2e-cost-own-edit-delete", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "   " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }), redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean)
    .map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}
async function req(cookie, method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}
async function reqBuffer(cookie, p) {
  const res = await fetch(BASE + p, { headers: { cookie } });
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
}

const DB_NAME = requireSafeDb("e2e-cost-own-edit-delete");
if (!/^center_erp_ci(?:_|$)/.test(DB_NAME)) throw new Error("Own-cost raw fixtures require an isolated center_erp_ci database.");
const client = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(DB_NAME);
const rawCosts = db.collection("costentries");
const rawApprovals = db.collection("approvalrequests");
const rawAudits = db.collection("auditlogs");

const PW = "CiOnly@123";
const stamp = Date.now().toString(36);
const TAG = `b3-${stamp}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const admin = await login("admin@vidysea.com", ADMIN_PASSWORD);
ok("[precondition] the default admin signs in", !!admin);

const mkUser = async (name, email, role, grants, scope = []) => {
  const made = await req(admin, "POST", "/api/users", { name, email, password: PW, role, can_edit: true, location_scope: scope });
  if (made.data?.item?._id && grants.length) await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: grants });
  return { made, id: made.data?.item?._id, email, cookie: await login(email, PW), name };
};
const locs = (await req(admin, "GET", "/api/locations?limit=2000")).data?.items ?? [];
const ownLoc = locs.find((l) => l.code === "JPR03");
const foreignLoc = locs.find((l) => l.code === "KOT02");
ok("[precondition] an own and a foreign location exist", !!ownLoc && !!foreignLoc);

const approverName = `Approver Bee ${stamp}`;
const approverB = await mkUser(approverName, `zz.b3.bee.${stamp}@vidysea-test.local`, "Admin", ["finance.view", "finance.approve"]);
const creator = await mkUser(`Creator Cee ${stamp}`, `zz.b3.cee.${stamp}@vidysea-test.local`, "Operations", ["costs.manage"], [ownLoc?._id]);
const other = await mkUser(`Other Dee ${stamp}`, `zz.b3.dee.${stamp}@vidysea-test.local`, "Operations", ["costs.manage"], [ownLoc?._id]);
const viewer = await mkUser(`Viewer Eee ${stamp}`, `zz.b3.eee.${stamp}@vidysea-test.local`, "Operations", ["costs.manage", "finance.view"], [ownLoc?._id]);
const ungranted = await mkUser(`Ungranted ${stamp}`, `zz.b3.none.${stamp}@vidysea-test.local`, "Admin", []);
ok("[precondition] the approver, a creator, another user, a finance-view creator and an ungranted admin sign in",
  [approverB, creator, other, viewer, ungranted].every((u) => !!u.id && !!u.cookie),
  JSON.stringify([approverB, creator, other, viewer, ungranted].map((u) => u.made.status)));

const cats = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
const plain = cats.find((c) => !c.pre_approved && !/^(other|misc)/i.test(String(c.name)) && !c.parent);
const plain2 = cats.filter((c) => !c.pre_approved && !/^(other|misc)/i.test(String(c.name)) && c._id !== plain?._id)[0];
const capRes = await req(admin, "POST", "/api/master-lists/cost-categories", {
  name: `ZZ B3 Capped ${stamp}`, pre_approved: true, pre_approved_amount: 5000, pre_approved_basis: "Rs 5000 a time, agreed in the meeting",
});
const capId = capRes.data?.item?._id;
const pendRes = await req(admin, "POST", "/api/master-lists/cost-categories", {
  name: `ZZ B3 NotSignedOff ${stamp}`, pre_approved: true, pre_approved_amount: 5000, pre_approved_basis: "never signed off",
});
const pendId = pendRes.data?.item?._id;
const formulaRes = await req(admin, "POST", "/api/master-lists/cost-categories", {
  name: `ZZ B3 PerPass ${stamp}`, pre_approved: true, pre_approved_unit: "Per billable passed",
  pre_approved_amount: 50, pre_approved_min_billable: 1, pre_approved_basis: "Rs 50 per billable passed",
});
const formulaId = formulaRes.data?.item?._id;
ok("[precondition] two plain heads, a capped head, a never-signed-off capped head and a formula head exist",
  !!plain && !!plain2 && !!capId && !!pendId && !!formulaId, JSON.stringify({ cap: capRes.status, pend: pendRes.status, formula: formulaRes.status }));
const signOff = async (headId) => {
  const hr = await rawApprovals.findOne({ action: "costcategory.create", entity_id: new ObjectId(String(headId)), status: "Pending" });
  return hr ? (await req(approverB.cookie, "POST", `/api/approvals/${hr._id}`, { decision: "Approved", note: "fixture: sign off" })).status : 0;
};
ok("[precondition] the capped head was signed off by the second approver; the other one was NOT", (await signOff(capId)) === 200);

const rule = (enabled) => req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled, approver_role: "Admin" });
const entry = (note, extra = {}) => ({ entry_date: "2026-09-07", location: ownLoc._id, category: plain._id, amount: 321, note: `${TAG}-${note}`, ...extra });
const raw = (id) => rawCosts.findOne({ _id: new ObjectId(String(id)) });
const waitingEdit = (id) => rawApprovals.findOne({ action: "cost.post", entity_id: new ObjectId(String(id)), "payload.kind": "cost-edit", status: { $in: ["Pending", "Applying"] } });
const sentence = (name, day) => `This entry is already approved by ${name}${day ? ` on ${day}` : ""}.`;
const istDay = (d) => new Date(d).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

// A direct (never-approved) entry by `who`: cost.post is OFF when it is made.
async function mkDirect(who, note, extra = {}) {
  await rule(false);
  const r = await req(who.cookie, "POST", "/api/costs", entry(note, extra));
  return r.data?.item?._id ? String(r.data.item._id) : null;
}
// An APPROVED entry by `who`: parked under the rule, then approved by the second approver.
async function mkApproved(who, note, extra = {}) {
  await rule(true);
  const parked = await req(who.cookie, "POST", "/api/costs", entry(note, extra));
  const reqId = parked.data?.item?._id;
  if (!reqId) return null;
  const decided = await req(approverB.cookie, "POST", `/api/approvals/${reqId}`, { decision: "Approved", note: "fixture: approve" });
  const posted = reqId ? await rawCosts.findOne({ approval_request: new ObjectId(String(reqId)) }) : null;
  return decided.status === 200 && posted ? String(posted._id) : null;
}
const decide = (reqId, decision, extra = {}) => req(approverB.cookie, "POST", `/api/approvals/${reqId}`, { decision, note: `b3 ${decision}`, ...extra });
const audits = (id, field) => rawAudits.find({ entity: "CostEntry", entity_id: new ObjectId(String(id)), ...(field ? { field } : {}) }).toArray();
const register = async (cookie) => ((await req(cookie, "GET", "/api/reports/costs")).data?.register ?? []);

// ======================================================= own + creator: the basic edit and its refusals
{
  const id = await mkDirect(creator, "own-edit");
  ok("[precondition] the creator posted a direct entry (entered_by = the creator)", !!id && String((await raw(id))?.entered_by) === String(creator.id));

  const edit = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { note: `${TAG}-own-edit-2`, amount: "555", vendor_payee: "Vendor Own" });
  const after = await raw(id);
  ok("own: the creator edits their own Payment Pending entry (200)", edit.status === 200, `${edit.status} ${JSON.stringify(edit.data).slice(0, 160)}`);
  ok("own: the row carries the new amount, note and payee (raw)", after?.amount === 555 && after?.note === `${TAG}-own-edit-2` && after?.vendor_payee === "Vendor Own",
    JSON.stringify({ a: after?.amount, n: after?.note }));
  ok("own: the entry is still the creator's and still Payment Pending", String(after?.entered_by) === String(creator.id) && after?.payment_status === "Payment Pending");

  await req(approverB.cookie, "GET", "/api/costs"); // flushes pending audit events
  const edited = await audits(id, "edited");
  ok("audit: an edit writes an audit row naming the creator and what changed",
    edited.length === 1 && String(edited[0].actor) === String(creator.id) && JSON.stringify(edited[0].new_value).includes("555"),
    JSON.stringify(edited.map((a) => [a.actor, a.new_value])));

  const noop = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { note: after.note, amount: 555 });
  ok("own: an edit that changes nothing is a no-op (200, no audit row added)", noop.status === 200 && noop.data?.unchanged === true && (await audits(id, "edited")).length === 1);

  const blank = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { note: "   " });
  ok("own: a blank description is refused (400) and the row is unchanged", blank.status === 400 && (await raw(id))?.note === after.note, `${blank.status}`);
  const zero = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 0 });
  ok("own: a zero amount is refused (400)", zero.status === 400 && (await raw(id))?.amount === 555);
  const badMode = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { payment_mode: "Barter" });
  ok("own: an unknown payment mode is refused (400)", badMode.status === 400);

  // ---- creator: nobody else
  const otherPatch = await req(other.cookie, "PATCH", `/api/costs/${id}`, { amount: 1 });
  const otherDel = await req(other.cookie, "DELETE", `/api/costs/${id}`, { reason: "not mine" });
  const nogrant = await req(ungranted.cookie, "PATCH", `/api/costs/${id}`, { amount: 1 });
  const unchanged = await raw(id);
  ok("creator: another user (same centre, same right) is refused on PATCH (403)", otherPatch.status === 403, `${otherPatch.status} ${JSON.stringify(otherPatch.data)}`);
  ok("creator: ...and on DELETE (403)", otherDel.status === 403, `${otherDel.status}`);
  ok("creator: an admin without the finance right is refused too (403)", nogrant.status === 403, `${nogrant.status}`);
  ok("creator: the row is untouched and not archived", unchanged?.amount === 555 && !unchanged?.archived_at && !unchanged?.deletion_state);
  const markPaid = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { mark_paid: true, payment_ref: "R1", vendor_payee: "V", payment_mode: "Cash" });
  ok("creator: recording a payment is not the creator's (403) and the row is not Paid", markPaid.status === 403 && (await raw(id))?.payment_status === "Payment Pending", `${markPaid.status}`);
  const missing = await req(creator.cookie, "PATCH", `/api/costs/${new ObjectId()}`, { amount: 3 });
  ok("creator: an unknown id is 404", missing.status === 404, `${missing.status}`);

  // ---- the listing the creator sees: their own rows only
  const mineList = await req(creator.cookie, "GET", "/api/costs?mine=1");
  const otherId = await mkDirect(other, "other-row");
  const mineAgain = await req(creator.cookie, "GET", "/api/costs?mine=1");
  const asOther = await req(creator.cookie, "GET", `/api/costs?mine=1&entered_by=${other.id}`);
  const mineIds = (mineAgain.data?.items ?? []).map((r) => String(r._id));
  ok("own: ?mine=1 lists the creator's entry, flagged is_mine", mineList.status === 200 && (mineList.data?.items ?? []).some((r) => String(r._id) === id && r.is_mine === true), `${mineList.status}`);
  ok("creator: ?mine=1 never lists another user's entry, whatever else is sent", !mineIds.includes(otherId) && !(asOther.data?.items ?? []).some((r) => String(r._id) === otherId));
  const ledgerAsCreator = await req(creator.cookie, "GET", "/api/costs");
  ok("creator: the full ledger stays closed to a creator without finance.view (403)", ledgerAsCreator.status === 403, `${ledgerAsCreator.status}`);
  const ledgerAsViewer = await req(viewer.cookie, "GET", `/api/costs?batch=`);
  ok("creator: a finance.view reader sees the book with is_mine true ONLY on their own rows",
    ledgerAsViewer.status === 200 && (ledgerAsViewer.data?.items ?? []).every((r) => r.is_mine === false), `${ledgerAsViewer.status}`);
  const regCreatorRows = await register(creator.cookie);
  ok("creator: the finance register is closed to a creator without finance.view (no rows)", regCreatorRows.length === 0);
  const regViewer = await register(viewer.cookie);
  ok("creator: the register carries is_mine and never the enterer's id", regViewer.length > 0 && regViewer.every((r) => r.is_mine === false && !("entered_by_id" in r)));
}

// ======================================================= paid: locked for the creator, not for finance
{
  const id = await mkDirect(creator, "paid");
  const paid = await req(approverB.cookie, "PATCH", `/api/costs/${id}`, { mark_paid: true, payment_ref: `REF-${stamp}`, vendor_payee: "Vendor P", payment_mode: "Cash" });
  ok("[precondition] finance marked the entry paid", paid.status === 200 && (await raw(id))?.payment_status === "Paid", `${paid.status} ${JSON.stringify(paid.data).slice(0, 120)}`);
  const e = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 9 });
  const d = await req(creator.cookie, "DELETE", `/api/costs/${id}`, { reason: "paid" });
  const after = await raw(id);
  ok("paid: the creator cannot edit a Paid entry (409)", e.status === 409 && /paid/i.test(e.data?.error ?? ""), `${e.status} ${e.data?.error}`);
  ok("paid: ...cannot delete it (409)", d.status === 409, `${d.status}`);
  ok("paid: the row is untouched and visible", after?.amount === 321 && !after?.archived_at);
  const list = await req(creator.cookie, "GET", "/api/costs?mine=1");
  ok("paid: the listing says so (is_mine true, payment_status Paid)", (list.data?.items ?? []).some((r) => String(r._id) === id && r.payment_status === "Paid" && r.is_mine === true));
  const fin = await req(approverB.cookie, "PATCH", `/api/costs/${id}`, { note: `${TAG}-paid-finance-edit` });
  ok("finance: finance still edits a Paid entry, as before (200)", fin.status === 200 && (await raw(id))?.note === `${TAG}-paid-finance-edit`, `${fin.status}`);
}

// ======================================================= soft: delete archives, leaves every total, restores
{
  const id = await mkDirect(creator, "soft");
  const keep = await mkDirect(creator, "soft-keep");
  const before = await register(approverB.cookie);
  const beforeTotal = before.reduce((s, r) => s + r.amount, 0);
  const digestBefore = await req(approverB.cookie, "GET", "/api/reports/daily?date=2026-09-07");
  const del = await req(creator.cookie, "DELETE", `/api/costs/${id}`, { reason: "entered twice" });
  const row = await raw(id);
  ok("soft: the creator deletes their own unapproved entry (200, restorable)", del.status === 200 && del.data?.restorable === true, `${del.status} ${JSON.stringify(del.data)}`);
  ok("soft: the row is ARCHIVED (archived_at, archived_by, reason), not removed, and is not the hard-delete tombstone",
    !!row?.archived_at && String(row?.archived_by) === String(creator.id) && row?.archive_reason === "entered twice" && !row?.deletion_state, JSON.stringify(row));
  const regAfter = await register(approverB.cookie);
  const digestArchived = await req(approverB.cookie, "GET", "/api/reports/daily?date=2026-09-07");
  ok("soft: the shared daily digest loses exactly the archived liability",
    digestBefore.status === 200 && digestArchived.status === 200
      && digestArchived.data?.costs?.today?.amount === digestBefore.data?.costs?.today?.amount - 321,
    `${digestBefore.status}/${digestArchived.status}`);
  ok("soft: it is gone from the finance register and the total fell by exactly its amount",
    !regAfter.some((r) => r.id === id) && regAfter.reduce((s, r) => s + r.amount, 0) === beforeTotal - 321 && regAfter.some((r) => r.id === keep),
    `${beforeTotal} -> ${regAfter.reduce((s, r) => s + r.amount, 0)}`);
  const ledger = await req(approverB.cookie, "GET", "/api/costs");
  ok("soft: it is gone from the ledger listing", !(ledger.data?.items ?? []).some((r) => String(r._id) === id));
  const mine = await req(creator.cookie, "GET", "/api/costs?mine=1");
  ok("soft: ...and from the creator's own listing", !(mine.data?.items ?? []).some((r) => String(r._id) === id));
  const exp = await reqBuffer(approverB.cookie, "/api/reports/costs/export");
  const wb = XLSX.read(exp.data, { type: "buffer" });
  const exported = JSON.stringify(wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n])));
  ok("soft: ...and from the Excel export (the archived note is not in any sheet; the kept one is)",
    exp.status === 200 && !exported.includes(`${TAG}-soft"`) && exported.includes(`${TAG}-soft-keep`) && !exported.includes("entered_by_id"), `${exp.status}`);
  const again = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 5 });
  ok("soft: an archived entry cannot receive a new edit or delete (409)", again.status === 409 && (await req(creator.cookie, "DELETE", `/api/costs/${id}`, { reason: "x" })).status === 409, `${again.status}`);
  const deletedList = await req(creator.cookie, "GET", "/api/costs?mine=1&deleted=1");
  ok("soft: the deleted listing shows it (and only archived rows)",
    (deletedList.data?.items ?? []).some((r) => String(r._id) === id) && (deletedList.data?.items ?? []).every((r) => !!r.archived_at), `${deletedList.status}`);
  const otherRestore = await req(other.cookie, "POST", `/api/costs/${id}/restore`);
  ok("soft: another user cannot restore it (403)", otherRestore.status === 403 && !!(await raw(id))?.archived_at, `${otherRestore.status}`);
  const restoreLive = await req(creator.cookie, "POST", `/api/costs/${keep}/restore`);
  ok("soft: restoring a row that was never deleted is 404", restoreLive.status === 404, `${restoreLive.status}`);
  const restored = await req(creator.cookie, "POST", `/api/costs/${id}/restore`);
  const back = await raw(id);
  ok("soft: the creator restores it (200); the row is whole again", restored.status === 200 && !back?.archived_at && !back?.archived_by && !back?.archive_reason && back?.amount === 321, `${restored.status}`);
  const regBack = await register(approverB.cookie);
  ok("soft: ...and it is back in the register and the total", regBack.some((r) => r.id === id) && regBack.reduce((s, r) => s + r.amount, 0) === beforeTotal);
  const digestRestored = await req(approverB.cookie, "GET", "/api/reports/daily?date=2026-09-07");
  ok("soft: restoring brings the same amount back into the shared daily digest",
    digestRestored.status === 200 && digestRestored.data?.costs?.today?.amount === digestBefore.data?.costs?.today?.amount, `${digestRestored.status}`);
  await req(approverB.cookie, "GET", "/api/costs");
  const aDel = await audits(id, "deleted (recoverable)");
  const aRes = await audits(id, "restored");
  ok("audit: the delete and the restore each wrote an audit row naming the creator",
    aDel.length === 1 && aRes.length === 1 && String(aDel[0].actor) === String(creator.id) && String(aRes[0].actor) === String(creator.id), `${aDel.length}/${aRes.length}`);
  // a finance reader may restore a creator's deleted row too
  await req(creator.cookie, "DELETE", `/api/costs/${id}`, { reason: "again" });
  const finRestore = await req(approverB.cookie, "POST", `/api/costs/${id}/restore`);
  ok("soft: finance can restore a creator's deleted entry (200)", finRestore.status === 200 && !(await raw(id))?.archived_at, `${finRestore.status}`);
}

// ======================================================= confirm + material: an APPROVED entry
{
  const id = await mkApproved(creator, "approved");
  ok("[precondition] an approved entry exists, entered by the creator, approved by the second approver", !!id && String((await raw(id))?.entered_by) === String(creator.id));
  const listed = (await req(creator.cookie, "GET", "/api/costs?mine=1")).data?.items?.find((r) => String(r._id) === id);
  ok("[precondition] the listing says who approved it and when", listed?.approved_by === approverName && !!listed?.approved_on, JSON.stringify([listed?.approved_by, listed?.approved_on]));
  const day = istDay(listed.approved_on);

  // ---- confirm: refused without the flag, and the sentence is the one Umesh asked for
  const noConfirm = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 400 });
  ok("confirm: changing an approved entry without confirm_approved is refused (409) with the approver's name, the date and the question",
    noConfirm.status === 409 && (noConfirm.data?.error ?? "").includes(sentence(approverName, day))
      && (noConfirm.data?.error ?? "").includes("Changing it sends it back for approval. Are you really sure?"), `${noConfirm.status} ${noConfirm.data?.error}`);
  ok("confirm: ...and nothing was written (no request, row unchanged)", (await raw(id))?.amount === 321 && !(await waitingEdit(id)));
  const delNoConfirm = await req(creator.cookie, "DELETE", `/api/costs/${id}`, { reason: "x" });
  ok("confirm: deleting an approved entry without confirm_approved is refused (409), naming the approver; the row is not archived",
    delNoConfirm.status === 409 && (delNoConfirm.data?.error ?? "").includes(sentence(approverName, day)) && !(await raw(id))?.archived_at, `${delNoConfirm.status} ${delNoConfirm.data?.error}`);

  // ---- material: confirmed amount change goes back for approval; the row does not move
  const sent = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 400, note: `${TAG}-approved-new-note`, confirm_approved: true });
  const wait = await waitingEdit(id);
  ok("material: a confirmed amount change on an approved entry is QUEUED (202), not applied", sent.status === 202 && sent.data?.queued === true, `${sent.status} ${JSON.stringify(sent.data).slice(0, 160)}`);
  ok("material: the row is UNCHANGED until an approver decides (amount, note, approval link)",
    (await raw(id))?.amount === 321 && (await raw(id))?.note === `${TAG}-approved` && !!wait && String(wait.initiator) === String(creator.id), JSON.stringify(wait?.payload));
  ok("material: it is the existing cost.post queue, addressed to a person, carrying kind cost-edit", wait?.action === "cost.post" && wait?.payload?.kind === "cost-edit" && wait?.status === "Pending");
  const listedWaiting = (await req(creator.cookie, "GET", "/api/costs?mine=1")).data?.items?.find((r) => String(r._id) === id);
  ok("material: the listing flags edit_pending", listedWaiting?.edit_pending === true);
  // ---- pending: one at a time
  const second = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 410, confirm_approved: true });
  const delWhile = await req(creator.cookie, "DELETE", `/api/costs/${id}`, { confirm_approved: true });
  ok("pending: a second edit while one waits is refused (409)", second.status === 409 && (await rawApprovals.countDocuments({ action: "cost.post", entity_id: new ObjectId(id), "payload.kind": "cost-edit" })) === 1, `${second.status}`);
  ok("pending: a delete while an edit waits is refused (409) and the row is not archived", delWhile.status === 409 && !(await raw(id))?.archived_at, `${delWhile.status}`);
  const selfApprove = await req(creator.cookie, "POST", `/api/approvals/${wait._id}`, { decision: "Approved" });
  ok("material: the creator cannot approve their own change", selfApprove.status >= 400 && (await raw(id))?.amount === 321, `${selfApprove.status}`);

  // ---- approve it: the same row, the new numbers, the approver is the one who pressed Approve now
  const approverC = await mkUser(`Approver Cee2 ${stamp}`, `zz.b3.cee2.${stamp}@vidysea-test.local`, "Admin", ["finance.view", "finance.approve"]);
  const yes = await req(approverC.cookie, "POST", `/api/approvals/${wait._id}`, { decision: "Approved", note: "b3 approve edit" });
  const applied = await raw(id);
  ok("material: approving the edit applies it to the SAME row (200): amount, note and approval link",
    yes.status === 200 && applied?.amount === 400 && applied?.note === `${TAG}-approved-new-note` && String(applied?.approval_request) === String(wait._id), `${yes.status} ${JSON.stringify(yes.data).slice(0, 160)}`);
  ok("material: ...no second row was created", (await rawCosts.countDocuments({ note: `${TAG}-approved-new-note` })) === 1);
  const afterList = (await req(approverB.cookie, "GET", "/api/costs")).data?.items?.find((r) => String(r._id) === id);
  ok("material: 'approved by' is now the person who approved the CHANGE, and the entry is still the creator's",
    afterList?.approved_by === approverC.name && String(applied?.entered_by) === String(creator.id), JSON.stringify([afterList?.approved_by]));
  ok("material: the creator may change it again once decided", (await waitingEdit(id)) === null);
  await req(approverB.cookie, "GET", "/api/costs");
  const viaApproval = (await audits(id, "edited")).filter((a) => JSON.stringify(a.new_value).includes(String(wait._id)));
  ok("audit: the applied change wrote an audit row naming the approver and the request", viaApproval.length === 1 && String(viaApproval[0].actor) === String(approverC.id), `${viaApproval.length}`);

  // ---- partial approval: the sanctioned amount lands, the asked-for amount is kept
  const part = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 900, confirm_approved: true });
  const partReq = await waitingEdit(id);
  const partYes = await req(approverB.cookie, "POST", `/api/approvals/${partReq?._id}`, { decision: "Approved", approved_amount: 650, note: "partial" });
  const partRow = await raw(id);
  ok("material: a partial approval of an edit lands the sanctioned amount and keeps what was asked", part.status === 202 && partYes.status === 200 && partRow?.amount === 650 && partRow?.requested_amount === 900,
    `${part.status} ${partYes.status} ${JSON.stringify([partRow?.amount, partRow?.requested_amount])}`);

  // ---- rejected: nothing changes and the lock is gone
  const rej = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 777, confirm_approved: true });
  const rejReq = await waitingEdit(id);
  const rejNo = await decide(rejReq?._id, "Rejected");
  ok("material: a rejected edit leaves the row exactly as it was and frees the creator to try again",
    rej.status === 202 && rejNo.status === 200 && (await raw(id))?.amount === 650 && (await waitingEdit(id)) === null, `${rej.status} ${rejNo.status}`);

  // ---- a head change is material too
  const headChange = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { category: plain2._id, confirm_approved: true });
  const headReq = await waitingEdit(id);
  ok("material: changing the HEAD of an approved entry is queued too (202); the row keeps its head", headChange.status === 202 && String((await raw(id))?.category) === String(plain._id), `${headChange.status}`);
  const headYes = await decide(headReq?._id, "Approved");
  ok("material: ...and approving it moves the entry to the new head", headYes.status === 200 && String((await raw(id))?.category) === String(plain2._id), `${headYes.status}`);

  // ---- note-only: stays approved, but still asks
  const lightNo = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { vendor_payee: "Vendor Light" });
  ok("confirm: a change that does not touch money also asks first (409), with the 'stays approved' wording",
    lightNo.status === 409 && (lightNo.data?.error ?? "").includes("stays approved"), `${lightNo.status} ${lightNo.data?.error}`);
  const link = String((await raw(id))?.approval_request);
  const light = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { vendor_payee: "Vendor Light", confirm_approved: true });
  const lightRow = await raw(id);
  ok("material: a confirmed non-money change (payee) applies at once (200), is NOT re-queued, and stays approved by the same approver",
    light.status === 200 && lightRow?.vendor_payee === "Vendor Light" && String(lightRow?.approval_request) === link && !(await waitingEdit(id)), `${light.status}`);

  // ---- fence: finance changed the row after the edit was requested
  const fenceId = await mkApproved(creator, "fence");
  await req(creator.cookie, "PATCH", `/api/costs/${fenceId}`, { amount: 888, confirm_approved: true });
  const fenceReq = await waitingEdit(fenceId);
  const blockedFinance = await req(approverB.cookie, "PATCH", `/api/costs/${fenceId}`, { note: `${TAG}-fence-finance-touched` });
  ok("fence: finance cannot overwrite a pending creator proposal (409), and its original note remains",
    blockedFinance.status === 409 && (await raw(fenceId))?.note === `${TAG}-fence`, `${blockedFinance.status}`);
  // A raw fixture simulates an external/legacy writer that did not observe the ownership fence.
  // Replay must independently reject the stale revision even if that writer bypassed the API.
  await rawCosts.updateOne({ _id: new ObjectId(fenceId) }, { $set: { note: `${TAG}-fence-finance-touched`, updatedAt: new Date(Date.now() + 1000) } });
  const fenceYes = await decide(fenceReq?._id, "Approved");
  const fenceRow = await raw(fenceId);
  ok("fence: approving an edit after the row changed underneath it is refused (409) and nothing is overwritten",
    fenceYes.status === 409 && fenceRow?.amount === 321 && fenceRow?.note === `${TAG}-fence-finance-touched`, `${fenceYes.status} ${JSON.stringify(fenceYes.data).slice(0, 140)}`);
  ok("fence: ...and the request is still open so it can be rejected", (await rawApprovals.findOne({ _id: fenceReq._id }))?.status === "Pending");
  await decide(fenceReq._id, "Rejected");

  // ---- soft delete of an approved entry, confirmed
  const delId = await mkApproved(creator, "approved-delete");
  const delOk = await req(creator.cookie, "DELETE", `/api/costs/${delId}`, { confirm_approved: true, reason: "wrong centre" });
  const delRow = await raw(delId);
  ok("soft: a confirmed delete of an approved entry archives it (200); the approval link is kept so a restore is whole",
    delOk.status === 200 && !!delRow?.archived_at && !!delRow?.approval_request, `${delOk.status}`);
  const delRestore = await req(creator.cookie, "POST", `/api/costs/${delId}/restore`);
  const delBack = (await req(creator.cookie, "GET", "/api/costs?mine=1")).data?.items?.find((r) => String(r._id) === delId);
  ok("soft: restored, it is still approved by the same person", delRestore.status === 200 && delBack?.approved_by === approverName, `${delRestore.status}`);
}

// ======================================================= bypass: an edit is never an easier door than a post
{
  const id = await mkDirect(creator, "bypass");
  await rule(true);
  const toPending = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { category: pendId, amount: 100 });
  const pendingRow = await raw(id);
  ok("bypass: moving a direct entry under a head nobody has signed off does NOT auto-apply: it is queued (202), the row keeps its head (QA-1977)",
    toPending.status === 202 && String(pendingRow?.category) === String(plain._id) && pendingRow?.amount === 321 && pendingRow?.pre_approved_applied !== true, `${toPending.status} ${JSON.stringify(toPending.data).slice(0, 160)}`);
  const q = await waitingEdit(id);
  await decide(q._id, "Rejected");

  const withinCap = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { category: capId, amount: 3000 });
  const capRow = await raw(id);
  ok("bypass: within a signed-off cap the move applies at once (200) as pre-approved, with its basis", withinCap.status === 200 && capRow?.amount === 3000 && capRow?.pre_approved_applied === true && /5000/.test(capRow?.pre_approved_basis ?? ""),
    `${withinCap.status} ${JSON.stringify([capRow?.amount, capRow?.pre_approved_applied, capRow?.pre_approved_basis])}`);
  const inCapChange = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 3100, confirm_approved: true });
  ok("bypass: an already pre-approved entry needs a PERSON even when its new amount remains below the cap",
    inCapChange.status === 202 && (await raw(id))?.amount === 3000 && !!(await waitingEdit(id)), `${inCapChange.status}`);
  await decide((await waitingEdit(id))._id, "Rejected");
  const aboveCap = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 9000, confirm_approved: true });
  ok("bypass: above the cap it is QUEUED (202), not applied", aboveCap.status === 202 && (await raw(id))?.amount === 3000, `${aboveCap.status}`);
  const q2 = await waitingEdit(id);
  await decide(q2._id, "Rejected");
  const formula = await req(creator.cookie, "PATCH", `/api/costs/${id}`, { category: formulaId, amount: 100, confirm_approved: true });
  ok("bypass: onto a per-billable-passed head it is queued (202): an edit cannot take the reservation a post takes", formula.status === 202 && (await raw(id))?.amount === 3000, `${formula.status}`);
  const q3 = await waitingEdit(id);
  await decide(q3._id, "Rejected");

  const appId = await mkApproved(creator, "bypass-approved");
  const personToCap = await req(creator.cookie, "PATCH", `/api/costs/${appId}`, { category: capId, amount: 100, confirm_approved: true });
  ok("bypass: an entry a PERSON approved goes back to a person even under a cap it would pass (202)", personToCap.status === 202 && String((await raw(appId))?.category) === String(plain._id), `${personToCap.status}`);
  const q4 = await waitingEdit(appId);
  await decide(q4._id, "Rejected");

  // fallback: nobody switched the cost.post rule on
  await rule(false);
  const offHeadId = await mkDirect(creator, "pending-head-off");
  const offHead = await req(creator.cookie, "PATCH", `/api/costs/${offHeadId}`, { category: pendId, amount: 100 });
  const offHeadRequest = await waitingEdit(offHeadId);
  ok("fallback: a Pending head with cost.post OFF still parks the edit and leaves the liability untouched",
    offHead.status === 202 && !!offHeadRequest && (await raw(offHeadId))?.amount === 321
      && String((await raw(offHeadId))?.category) === String(plain._id), `${offHead.status}`);
  const prematurelyApproved = await decide(offHeadRequest?._id, "Approved");
  ok("fallback: a cost-edit approval cannot release an unapproved head (409), with no cost write",
    prematurelyApproved.status === 409 && (await raw(offHeadId))?.amount === 321
      && (await waitingEdit(offHeadId))?.status === "Pending", `${prematurelyApproved.status}`);
  await decide(offHeadRequest?._id, "Rejected");
  const noRule = await req(creator.cookie, "PATCH", `/api/costs/${appId}`, { amount: 345, confirm_approved: true });
  ok("fallback: with the cost.post rule OFF, an approved entry's change still reaches a person (202), addressed to the Admin role",
    noRule.status === 202 && (await raw(appId))?.amount === 321 && (await waitingEdit(appId))?.approver_role === "Admin", `${noRule.status} ${JSON.stringify(noRule.data).slice(0, 140)}`);
  await decide((await waitingEdit(appId))._id, "Rejected");
  const direct2 = await mkDirect(creator, "bypass-rule-off");
  const offDirect = await req(creator.cookie, "PATCH", `/api/costs/${direct2}`, { amount: 222 });
  ok("fallback: a never-approved entry with the rule OFF changes at once, exactly as a new post would (200)", offDirect.status === 200 && (await raw(direct2))?.amount === 222, `${offDirect.status}`);
}

// ======================================================= scope
{
  // Operations is a central, unscoped role. A Location persona exercises Rule 38 without
  // pretending that assigning location_scope changes the meaning of an Operations account.
  const scopedCreator = await mkUser(`Scoped Creator ${stamp}`, `zz.b3.scoped.${stamp}@vidysea-test.local`, "Location", ["costs.manage"], [ownLoc._id]);
  ok("[precondition] an explicitly Location-scoped creator signs in", !!scopedCreator.id && !!scopedCreator.cookie, `${scopedCreator.made.status}`);
  const id = await mkDirect(scopedCreator, "scope");
  const toForeign = await req(scopedCreator.cookie, "PATCH", `/api/costs/${id}`, { location: foreignLoc._id });
  ok("scope: an edit cannot move the entry onto a centre outside the creator's scope (403); the row keeps its centre",
    toForeign.status === 403 && String((await raw(id))?.location) === String(ownLoc._id), `${toForeign.status} ${JSON.stringify(toForeign.data)}`);
  // an entry of the creator's that sits at a foreign centre (written raw): not writable by a scoped user
  const foreignId = new ObjectId();
  await rawCosts.insertOne({
    _id: foreignId, entry_date: new Date("2026-09-07"), location: new ObjectId(foreignLoc._id), category: new ObjectId(plain._id), amount: 77,
    requested_amount: 77, payment_status: "Payment Pending", note: `${TAG}-foreign`, entered_by: new ObjectId(scopedCreator.id), reservation_state: "Applied",
    createdAt: new Date(), updatedAt: new Date(),
  });
  const foreignEdit = await req(scopedCreator.cookie, "PATCH", `/api/costs/${foreignId}`, { amount: 78 });
  const foreignDel = await req(scopedCreator.cookie, "DELETE", `/api/costs/${foreignId}`, { reason: "x" });
  ok("scope: the creator's own entry at a foreign centre is out of scope for edit and delete (403)", foreignEdit.status === 403 && foreignDel.status === 403 && (await raw(foreignId))?.amount === 77, `${foreignEdit.status}/${foreignDel.status}`);
  const mineForeign = await req(scopedCreator.cookie, "GET", "/api/costs?mine=1");
  ok("scope: ?mine=1 stays inside the creator's location scope", !(mineForeign.data?.items ?? []).some((r) => String(r._id) === String(foreignId)));
  const noBatchLoc = await req(scopedCreator.cookie, "PATCH", `/api/costs/${id}`, { location: "", batch: "" });
  ok("scope: removing every anchor (centre, batch, trainer) is refused by Rule 37 (400)", noBatchLoc.status === 400 && String((await raw(id))?.location) === String(ownLoc._id), `${noBatchLoc.status}`);
  await rawCosts.deleteOne({ _id: foreignId });
}

// ======================================================= finance: unchanged
{
  const id = await mkDirect(creator, "finance");
  const finEdit = await req(approverB.cookie, "PATCH", `/api/costs/${id}`, { amount: 600 });
  ok("finance: a finance.approve holder still edits anybody's entry (200)", finEdit.status === 200 && (await raw(id))?.amount === 600, `${finEdit.status}`);
  const noReason = await req(approverB.cookie, "DELETE", `/api/costs/${id}`);
  ok("finance: the hard delete still demands a reason (400)", noReason.status === 400 && !!(await raw(id)), `${noReason.status}`);
  const hard = await req(approverB.cookie, "DELETE", `/api/costs/${id}`, { reason: "b3 finance hard delete" });
  const gone = await raw(id);
  ok("finance: the hard delete is still a HARD delete (the row is gone, or only its audit tombstone remains), never an archive", hard.status === 200 && (!gone || (gone.deletion_state && !gone.archived_at)), `${hard.status} ${JSON.stringify(gone)?.slice(0, 120)}`);
}

// ======================================================= retry, unknown status and concurrent ownership
{
  const unknownId = await mkDirect(creator, "unknown-payment");
  await rawCosts.updateOne({ _id: new ObjectId(unknownId) }, { $unset: { payment_status: "" } });
  const unknownEdit = await req(creator.cookie, "PATCH", `/api/costs/${unknownId}`, { amount: 432 });
  const unknownDelete = await req(creator.cookie, "DELETE", `/api/costs/${unknownId}`, {});
  ok("unknown: missing payment status permits neither creator edit nor delete and changes no liability",
    unknownEdit.status === 409 && unknownDelete.status === 409 && (await raw(unknownId))?.amount === 321
      && !(await raw(unknownId))?.archived_at, `${unknownEdit.status}/${unknownDelete.status}`);
  await rawCosts.updateOne({ _id: new ObjectId(unknownId) }, { $set: { archived_at: new Date() } });
  const unknownRestore = await req(creator.cookie, "POST", `/api/costs/${unknownId}/restore`);
  ok("unknown: creator restore also refuses an unrecorded payment status and keeps the row archived",
    unknownRestore.status === 409 && !!(await raw(unknownId))?.archived_at, `${unknownRestore.status}`);

  const deleteRetryId = await mkDirect(creator, "retry-delete");
  const deleteRetryBody = { reason: "entered twice", base_updated_at: (await raw(deleteRetryId)).updatedAt.toISOString() };
  const deleteRetryHeaders = { "Idempotency-Key": `${TAG}-delete-retry` };
  const deletedFirst = await req(creator.cookie, "DELETE", `/api/costs/${deleteRetryId}`, deleteRetryBody, deleteRetryHeaders);
  const deletedAgain = await req(creator.cookie, "DELETE", `/api/costs/${deleteRetryId}`, deleteRetryBody, deleteRetryHeaders);
  ok("retry: a repeated creator delete returns its first receipt and adds no second archive audit",
    deletedFirst.status === 200 && deletedAgain.status === 200 && JSON.stringify(deletedFirst.data) === JSON.stringify(deletedAgain.data)
      && (await audits(deleteRetryId, "deleted (recoverable)")).length === 1, `${deletedFirst.status}/${deletedAgain.status}`);

  const directId = await mkDirect(creator, "retry-direct");
  const directBase = await raw(directId);
  const directBody = { amount: 432, base_updated_at: directBase.updatedAt.toISOString() };
  const directHeaders = { "Idempotency-Key": `${TAG}-direct-retry` };
  const directFirst = await req(creator.cookie, "PATCH", `/api/costs/${directId}`, directBody, directHeaders);
  const directAgain = await req(creator.cookie, "PATCH", `/api/costs/${directId}`, directBody, directHeaders);
  const directClash = await req(creator.cookie, "PATCH", `/api/costs/${directId}`, { ...directBody, amount: 433 }, directHeaders);
  ok("retry: a lost direct-edit response returns the first result and only one edit audit",
    directFirst.status === 200 && directAgain.status === 200
      && JSON.stringify(directFirst.data) === JSON.stringify(directAgain.data)
      && (await audits(directId, "edited")).length === 1, `${directFirst.status}/${directAgain.status}`);
  ok("retry: reusing an edit key for a different payload is refused and does not overwrite the first edit",
    directClash.status === 409 && (await raw(directId))?.amount === 432, `${directClash.status}`);
  const paidDirect = await req(approverB.cookie, "PATCH", `/api/costs/${directId}`, {
    mark_paid: true, payment_ref: `${TAG}-retry-paid`, vendor_payee: "Retry vendor", payment_mode: "Cash",
  });
  const afterPaymentRetry = await req(creator.cookie, "PATCH", `/api/costs/${directId}`, directBody, directHeaders);
  ok("retry: the same accepted edit key remains a receipt after payment, while the Paid row stays locked",
    paidDirect.status === 200 && afterPaymentRetry.status === 200 && (await raw(directId))?.payment_status === "Paid"
      && afterPaymentRetry.data?.item?.amount === 432, `${paidDirect.status}/${afterPaymentRetry.status}`);

  const queueId = await mkApproved(creator, "retry-queued");
  const queuedBase = await raw(queueId);
  const queuedBody = { amount: 456, confirm_approved: true, base_updated_at: queuedBase.updatedAt.toISOString() };
  const queuedHeaders = { "Idempotency-Key": `${TAG}-queue-retry` };
  const repeated = await Promise.all([1, 2].map(() => req(creator.cookie, "PATCH",
    `/api/costs/${queueId}?_test_pause_before_own_commit_ms=250`, queuedBody, queuedHeaders)));
  const queuedRequest = await waitingEdit(queueId);
  ok("retry: concurrent identical edits return the SAME request, with one approval row and unchanged cost",
    repeated.every((r) => r.status === 202) && repeated[0].data?.item?._id === repeated[1].data?.item?._id
      && (await rawApprovals.countDocuments({ entity_id: new ObjectId(queueId), "payload.kind": "cost-edit" })) === 1
      && (await raw(queueId))?.amount === 321, JSON.stringify(repeated.map((r) => [r.status, r.data?.error])));
  const payWhileQueued = await req(approverB.cookie, "PATCH", `/api/costs/${queueId}`, {
    mark_paid: true, payment_ref: "HELD", vendor_payee: "Held vendor", payment_mode: "Cash",
  });
  ok("owner: a queued creator edit prevents finance payment until the decision",
    payWhileQueued.status === 409 && (await raw(queueId))?.payment_status === "Payment Pending", `${payWhileQueued.status}`);
  const rejected = await decide(queuedRequest?._id, "Rejected");
  const cleared = await raw(queueId);
  ok("owner: rejection clears request ownership and its durable proposal without changing the amount",
    rejected.status === 200 && !cleared?.cost_edit_request && !cleared?.cost_edit_proposal && cleared?.amount === 321, `${rejected.status}`);
  const queueRetryAfterReject = await req(creator.cookie, "PATCH", `/api/costs/${queueId}`, queuedBody, queuedHeaders);
  ok("retry: a retry after rejection returns the original request instead of making a second one",
    queueRetryAfterReject.status === 202 && String(queueRetryAfterReject.data?.item?._id) === String(queuedRequest?._id)
      && (await rawApprovals.countDocuments({ entity_id: new ObjectId(queueId), "payload.kind": "cost-edit" })) === 1, `${queueRetryAfterReject.status}`);

  const raceId = await mkApproved(creator, "edit-edit-race");
  const raceBase = await raw(raceId);
  const rivals = await Promise.all([551, 552].map((amount) => req(creator.cookie, "PATCH",
    `/api/costs/${raceId}?_test_pause_before_own_commit_ms=250`,
    { amount, confirm_approved: true, base_updated_at: raceBase.updatedAt.toISOString() }, { "Idempotency-Key": `${TAG}-rival-${amount}` })));
  const rivalRequest = await waitingEdit(raceId);
  ok("owner: concurrent different proposals admit exactly one and leave the original cost unchanged",
    rivals.filter((r) => r.status === 202).length === 1 && rivals.filter((r) => r.status === 409).length === 1
      && (await rawApprovals.countDocuments({ entity_id: new ObjectId(raceId), "payload.kind": "cost-edit" })) === 1
      && (await raw(raceId))?.amount === 321, JSON.stringify(rivals.map((r) => r.status)));
  const applied = await decide(rivalRequest?._id, "Approved");
  const replay = await decide(rivalRequest?._id, "Approved");
  const winner = await raw(raceId);
  ok("owner: approval applies exactly the owner's payload once; duplicate approval adds no row or edit audit",
    applied.status === 200 && [200, 409].includes(replay.status) && winner?.amount === rivalRequest?.payload?.amount
      && !winner?.cost_edit_request && !winner?.cost_edit_proposal
      && (await audits(raceId, "edited")).length === 1, `${applied.status}/${replay.status}`);

  const deleteRaceId = await mkApproved(creator, "edit-delete-race");
  const deleteRaceBase = await raw(deleteRaceId);
  const editVsDelete = await Promise.all([
    req(creator.cookie, "PATCH", `/api/costs/${deleteRaceId}?_test_pause_before_own_commit_ms=250`,
      { amount: 654, confirm_approved: true, base_updated_at: deleteRaceBase.updatedAt.toISOString() }),
    req(creator.cookie, "DELETE", `/api/costs/${deleteRaceId}`, { confirm_approved: true, base_updated_at: deleteRaceBase.updatedAt.toISOString() }),
  ]);
  const deletedRace = await raw(deleteRaceId);
  const deletionRequest = await waitingEdit(deleteRaceId);
  ok("owner: edit versus delete cannot leave both an archive and a pending proposal",
    editVsDelete.filter((r) => r.status >= 200 && r.status < 300).length === 1
      && !!deletedRace?.archived_at !== !!deletionRequest && !(deletedRace?.archived_at && deletedRace?.cost_edit_request),
    JSON.stringify(editVsDelete.map((r) => r.status)));
  if (deletionRequest) await decide(deletionRequest._id, "Rejected");

  const paymentRaceId = await mkApproved(creator, "edit-payment-race");
  const paymentBase = await raw(paymentRaceId);
  const editVsPayment = await Promise.all([
    req(creator.cookie, "PATCH", `/api/costs/${paymentRaceId}?_test_pause_before_own_commit_ms=250`,
      { amount: 765, confirm_approved: true, base_updated_at: paymentBase.updatedAt.toISOString() }),
    req(approverB.cookie, "PATCH", `/api/costs/${paymentRaceId}`, {
      mark_paid: true, payment_ref: `${TAG}-race`, vendor_payee: "Race vendor", payment_mode: "Cash",
    }),
  ]);
  const paidRace = await raw(paymentRaceId);
  const paymentRequest = await waitingEdit(paymentRaceId);
  ok("owner: edit versus payment commits exactly one; a Paid row never carries a pending creator edit",
    editVsPayment.filter((r) => r.status >= 200 && r.status < 300).length === 1
      && !(paidRace?.payment_status === "Paid" && (paidRace?.cost_edit_request || paymentRequest)),
    JSON.stringify(editVsPayment.map((r) => r.status)));
  if (paymentRequest) await decide(paymentRequest._id, "Rejected");
}

// Formula soft deletion preserves the existing cap commitment. Only an approved material
// replacement releases it; a pending or rejected proposal cannot alter the ledger/reservation.
{
  const formulaOwnId = await mkDirect(creator, "formula-owner");
  await signOff(formulaId);
  await rawCosts.updateOne({ _id: new ObjectId(formulaOwnId) }, { $set: {
    category: new ObjectId(formulaId), pre_approved_applied: true, pre_approved_unit: "Per billable passed",
    pre_approved_basis: "fixture commitment", reservation_kind: "Formula", reservation_state: "Applied",
  } });
  const formulaOriginal = await raw(formulaOwnId);
  const archived = await req(creator.cookie, "DELETE", `/api/costs/${formulaOwnId}`, { confirm_approved: true });
  const held = await raw(formulaOwnId);
  ok("formula: soft delete hides the liability but retains the amount and complete Formula commitment",
    archived.status === 200 && !!held?.archived_at && held?.amount === 321 && held?.pre_approved_applied === true
      && held?.pre_approved_unit === "Per billable passed" && held?.reservation_state === "Applied", `${archived.status}`);
  const restored = await req(creator.cookie, "POST", `/api/costs/${formulaOwnId}/restore`);
  const restoredRow = await raw(formulaOwnId);
  ok("formula: restore returns exactly the same commitment, without a second cost or reservation",
    restored.status === 200 && !restoredRow?.archived_at && restoredRow?.pre_approved_applied === true
      && restoredRow?.reservation_kind === formulaOriginal.reservation_kind
      && (await rawCosts.countDocuments({ _id: new ObjectId(formulaOwnId) })) === 1, `${restored.status}`);
  const formulaEdit = await req(creator.cookie, "PATCH", `/api/costs/${formulaOwnId}`, { amount: 444, confirm_approved: true });
  const formulaRequest = await waitingEdit(formulaOwnId);
  ok("formula: material edit reaches a human and preserves the old commitment until approval",
    formulaEdit.status === 202 && (await raw(formulaOwnId))?.amount === 321
      && (await raw(formulaOwnId))?.pre_approved_applied === true, `${formulaEdit.status}`);
  const rejected = await decide(formulaRequest?._id, "Rejected");
  ok("formula: rejection retains the old amount and automated reservation",
    rejected.status === 200 && (await raw(formulaOwnId))?.amount === 321
      && (await raw(formulaOwnId))?.reservation_kind === "Formula" && (await raw(formulaOwnId))?.pre_approved_applied === true, `${rejected.status}`);
  const replacement = await req(creator.cookie, "PATCH", `/api/costs/${formulaOwnId}`, { amount: 445, confirm_approved: true });
  const replacementRequest = await waitingEdit(formulaOwnId);
  const sanctioned = await decide(replacementRequest?._id, "Approved");
  const replaced = await raw(formulaOwnId);
  ok("formula: human approval atomically replaces the liability and releases the old automated reservation",
    replacement.status === 202 && sanctioned.status === 200 && replaced?.amount === 445
      && replaced?.pre_approved_applied === false && !replaced?.reservation_kind
      && String(replaced?.approval_request) === String(replacementRequest?._id), `${replacement.status}/${sanctioned.status}`);
}

// ======================================================= takeover regressions: destination ownership and input guards
{
  const rawBatches = db.collection("batches");
  const rawCategories = db.collection("costcategories");
  // Raw snapshots include internal receipts, proposal ownership and audit outboxes, not just amounts.
  const snapshot = async (costIds, batchIds = []) => {
    const costOids = costIds.map((id) => new ObjectId(String(id)));
    const batchOids = batchIds.map((id) => new ObjectId(String(id)));
    const costs = await rawCosts.find({ _id: { $in: costOids } }).sort({ _id: 1 }).toArray();
    const refs = costs.flatMap((row) => [row.approval_request, row.cost_edit_request]).filter(Boolean);
    const [batches, requests, auditRows, costCount, requestCount, auditCount, notificationCount, mailCount] = await Promise.all([
      rawBatches.find({ _id: { $in: batchOids } }).sort({ _id: 1 }).toArray(),
      rawApprovals.find({ $or: [{ _id: { $in: refs } }, { entity_id: { $in: costOids } },
        { "payload.cost_entry": { $in: costIds.map(String) } }] }).sort({ _id: 1 }).toArray(),
      rawAudits.find({ entity_id: { $in: [...costOids, ...batchOids, ...refs] } }).sort({ _id: 1 }).toArray(),
      rawCosts.countDocuments({}), rawApprovals.countDocuments({}), rawAudits.countDocuments({}),
      db.collection("notifications").countDocuments({}), db.collection("maillogs").countDocuments({}),
    ]);
    return JSON.stringify({ costs, batches, requests, auditRows, costCount, requestCount, auditCount, notificationCount, mailCount });
  };
  const template = await rawBatches.findOne({ program: { $type: "objectId" } });
  ok("takeover [precondition]: a program exists for isolated empty batch fixtures", !!template?.program);
  const makeBatch = async (suffix) => {
    const id = new ObjectId();
    // Explicit synthetic Planning batch: no member, cost or approval is invented under it.
    await rawBatches.insertOne({ _id: id, code: `ZZ-B3-${suffix}-${stamp}`, status: "Planning",
      location: new ObjectId(ownLoc._id), program: template.program, target_size: 1,
      planned_start: new Date("2026-09-01"), planned_end: new Date("2026-09-30"),
      createdAt: new Date(), updatedAt: new Date() });
    return id;
  };
  if (template?.program) {
    // QA-2908: remove only the exact fixture request and its receipt after a real queued edit.
    // The remaining proposal is the authentic durable claim that a crash-before-request leaves;
    // the destination is then removed using the raw isolated fixture database, never production.
    const recoveryCreator = await mkUser(`Recovery scoped ${stamp}`, `zz.b3.recovery.${stamp}@vidysea-test.local`,
      "Location", ["costs.manage"], [String(ownLoc._id)]);
    ok("QA-2908 [precondition]: a scoped editable creator exists", !!recoveryCreator.id && !!recoveryCreator.cookie);
    for (const [audience, actor, expectedStatus] of [["scoped", recoveryCreator, 404], ["global", creator, 409]]) {
      for (const missingState of ["missing", "Deleting"]) {
        const refusalStatus = missingState === "Deleting" ? 409 : expectedStatus;
        const source = await makeBatch(`RECOVERY-SOURCE-${audience}-${missingState}`);
        const destination = await makeBatch(`RECOVERY-DEST-${audience}-${missingState}`);
        const costId = await mkApproved(actor, `recovery-${audience}-${missingState}`, { batch: String(source) });
        const baseCost = costId ? await raw(costId) : null;
        const body = { batch: String(destination), confirm_approved: true, base_updated_at: baseCost?.updatedAt.toISOString() };
        const headers = { "Idempotency-Key": `${TAG}-recovery-${audience}-${missingState}` };
        const queued = costId ? await req(actor.cookie, "PATCH", `/api/costs/${costId}`, body, headers) : { status: 0 };
        const saved = costId ? await raw(costId) : null;
        const requestId = saved?.cost_edit_request;
        const proposal = saved?.cost_edit_proposal;
        ok(`QA-2908 ${audience}/${missingState} [precondition]: real queue persisted a coherent matching actor/cost/key/hash/destination claim`,
          queued.status === 202 && !!requestId && String(proposal?.context?.requestId) === String(requestId)
            && String(proposal.context.entity_id) === costId && proposal.context.payload.cost_entry === costId
            && proposal.context.payload._edit_mutation_key === proposal.mutation_key
            && proposal.context.payload._edit_input_hash === proposal.input_hash
            && proposal.context.batch === String(destination) && proposal.context.payload.batch === String(destination));
        if (!requestId || !proposal) continue;
        await rawApprovals.deleteOne({ _id: requestId });
        await rawCosts.updateOne({ _id: new ObjectId(costId) }, { $pull: { own_mutations: { key: proposal.mutation_key } } });
        if (missingState === "missing") await rawBatches.deleteOne({ _id: destination });
        else await rawBatches.updateOne({ _id: destination }, { $set: { deletion_state: "Deleting" } });
        const before = await snapshot([costId], [source, destination]);
        const expected = JSON.parse(before);
        ok(`QA-2908 ${audience}/${missingState} crash boundary [precondition]: no exact request or matching receipt remains, while the same coherent proposal owns the unchanged source`,
          !await rawApprovals.findOne({ _id: requestId })
            && !(expected.costs[0].own_mutations ?? []).some((receipt) => receipt.key === proposal.mutation_key)
            && String(expected.costs[0].cost_edit_request) === String(requestId)
            && JSON.stringify(expected.costs[0].cost_edit_proposal) === JSON.stringify(proposal)
            && expected.costs[0].amount === baseCost.amount && new Date(expected.costs[0].updatedAt).getTime() === baseCost.updatedAt.getTime()
            && (missingState === "missing" ? expected.batches.every((batch) => String(batch._id) !== String(destination))
              : expected.batches.some((batch) => String(batch._id) === String(destination) && batch.deletion_state === "Deleting")));
        delete expected.costs[0].cost_edit_request;
        delete expected.costs[0].cost_edit_proposal;
        const retried = await req(actor.cookie, "PATCH", `/api/costs/${costId}`, body, headers);
        ok(`QA-2908 ${audience}/${missingState}: retry refuses ${refusalStatus} and clears only the two exact owner claim fields; liability/revision/reservation/receipts/outbox and all effects stay unchanged`,
          retried.status === refusalStatus && await snapshot([costId], [source, destination]) === JSON.stringify(expected),
          `${retried.status} ${retried.data?.error ?? ""}`);
      }
    }

    // Negative ownership oracles use the same saved authentic proposal, then corrupt ONE link.
    // A foreign existing batch remains a 403; an ambiguous claim may never be silently collected.
    const negativeSource = await makeBatch("RECOVERY-NEG-SOURCE");
    const negativeDestination = await makeBatch("RECOVERY-NEG-DEST");
    const negativeId = await mkApproved(recoveryCreator, "recovery-negative", { batch: String(negativeSource) });
    const negativeBase = negativeId ? await raw(negativeId) : null;
    const negativeBody = { batch: String(negativeDestination), confirm_approved: true, base_updated_at: negativeBase?.updatedAt.toISOString() };
    const negativeHeaders = { "Idempotency-Key": `${TAG}-recovery-negative` };
    const negativeQueued = negativeId ? await req(recoveryCreator.cookie, "PATCH", `/api/costs/${negativeId}`, negativeBody, negativeHeaders) : { status: 0 };
    const negativeClaim = negativeId ? await raw(negativeId) : null;
    ok("QA-2908 negative controls [precondition]: an actual proposal and exact queue identity exist", negativeQueued.status === 202 && !!negativeClaim?.cost_edit_request);
    if (negativeClaim?.cost_edit_request) {
      const requestId = negativeClaim.cost_edit_request, proposal = negativeClaim.cost_edit_proposal;
      const originalRequest = await rawApprovals.findOne({ _id: requestId });
      await rawCosts.updateOne({ _id: new ObjectId(negativeId) }, { $pull: { own_mutations: { key: proposal.mutation_key } } });
      await rawApprovals.deleteOne({ _id: requestId });
      await rawBatches.updateOne({ _id: negativeDestination }, { $set: { location: new ObjectId(foreignLoc._id) } });
      const foreignBefore = await snapshot([negativeId], [negativeSource, negativeDestination]);
      const foreign = await req(recoveryCreator.cookie, "PATCH", `/api/costs/${negativeId}`, negativeBody, negativeHeaders);
      ok("QA-2908 foreign existing destination: exactly 403 and no claim, liability, request, audit, notification or receipt effects",
        foreign.status === 403 && await snapshot([negativeId], [negativeSource, negativeDestination]) === foreignBefore, `${foreign.status}`);
      await rawBatches.deleteOne({ _id: negativeDestination });
      for (const [link, fields] of [
        ["owner request", { cost_edit_request: new ObjectId() }],
        ["mutation key", { "cost_edit_proposal.mutation_key": `${proposal.mutation_key}-other` }],
        ["input hash", { "cost_edit_proposal.input_hash": "different-hash" }],
        ["context request", { "cost_edit_proposal.context.requestId": new ObjectId() }],
        ["context cost", { "cost_edit_proposal.context.payload.cost_entry": String(new ObjectId()) }],
        ["context destination", { "cost_edit_proposal.context.batch": String(negativeSource) }],
      ]) {
        await rawCosts.updateOne({ _id: new ObjectId(negativeId) }, { $set: { cost_edit_request: requestId, cost_edit_proposal: proposal } });
        await rawCosts.updateOne({ _id: new ObjectId(negativeId) }, { $set: fields });
        const before = await snapshot([negativeId], [negativeSource, negativeDestination]);
        const denied = await req(recoveryCreator.cookie, "PATCH", `/api/costs/${negativeId}`, negativeBody, negativeHeaders);
        ok(`QA-2908 mismatched ${link}: refuses without collecting an ambiguous claim or changing any side effect`,
          [403, 404, 409].includes(denied.status) && await snapshot([negativeId], [negativeSource, negativeDestination]) === before, `${denied.status}`);
      }
      // An exact ID existing under another actor is not a matching retry and must block cleanup.
      await rawCosts.updateOne({ _id: new ObjectId(negativeId) }, { $set: { cost_edit_request: requestId, cost_edit_proposal: proposal } });
      await rawApprovals.insertOne({ ...originalRequest, initiator: new ObjectId(other.id) });
      const requestBefore = await snapshot([negativeId], [negativeSource, negativeDestination]);
      const existing = await req(recoveryCreator.cookie, "PATCH", `/api/costs/${negativeId}`, negativeBody, negativeHeaders);
      ok("QA-2908 exact request exists for another actor: refuses and preserves ownership, request and all effects",
        [403, 404, 409].includes(existing.status) && await snapshot([negativeId], [negativeSource, negativeDestination]) === requestBefore, `${existing.status}`);
      await rawApprovals.deleteOne({ _id: requestId });
      await rawCosts.updateOne({ _id: new ObjectId(negativeId) }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
    }
    await req(admin, "PATCH", `/api/users/${recoveryCreator.id}`, { active: false });

    // QA-2909: the actual approver records a PARTIAL sanction. Removing only the queued receipt
    // exposes the decided-prior path; two simultaneous retries then race for exactly one receipt.
    const moneyId = await mkApproved(creator, "edit-replay-money");
    const moneyBase = moneyId ? await raw(moneyId) : null;
    const moneyBody = { amount: 846123, note: `${TAG}-requested with vendor advance 919191`, confirm_approved: true,
      base_updated_at: moneyBase?.updatedAt.toISOString() };
    const moneyHeaders = { "Idempotency-Key": `${TAG}-edit-replay-money` };
    const first = moneyId ? await req(creator.cookie, "PATCH", `/api/costs/${moneyId}`, moneyBody, moneyHeaders) : { status: 0 };
    const moneyRequest = moneyId ? await waitingEdit(moneyId) : null;
    const moneyDecision = moneyRequest ? await decide(moneyRequest._id, "Approved", { approved_amount: 423061, note: "Sanction 423061; vendor budget 818181" }) : { status: 0 };
    const decided = moneyRequest ? await rawApprovals.findOne({ _id: moneyRequest._id }) : null;
    ok("QA-2909 [precondition]: actual partial decision retains requested 846123, sanctioned 423061 and money in decision/payload prose",
      first.status === 202 && moneyDecision.status === 200 && decided?.payload?.amount === 846123 && decided.approved_amount === 423061
        && decided.decision_note.includes("818181") && decided.payload.note.includes("919191") && (await raw(moneyId))?.amount === 423061);
    if (decided) {
      const mutationKey = decided.payload._edit_mutation_key;
      await rawCosts.updateOne({ _id: new ObjectId(moneyId) }, { $pull: { own_mutations: { key: mutationKey } } });
      const countBefore = await rawApprovals.countDocuments({ entity_id: new ObjectId(moneyId), "payload.kind": "cost-edit" });
      const costBefore = await raw(moneyId);
      const simultaneous = await Promise.all([1, 2].map(() => req(creator.cookie, "PATCH", `/api/costs/${moneyId}`, moneyBody, moneyHeaders)));
      for (const [index, response] of simultaneous.entries()) {
        ok(`QA-2909 decided prior/concurrent receipt ${index + 1}: 202 same request and original requested amount, without sanctioned amount, decision prose or nested payload money text`,
          response.status === 202 && String(response.data?.item?._id) === String(decided._id) && response.data?.queued === true
            && response.data.item.payload?.amount === 846123 && !Object.hasOwn(response.data.item, "approved_amount")
            && !Object.hasOwn(response.data.item, "decision_note") && !/423061|818181|919191/.test(JSON.stringify(response.data)));
      }
      const after = await raw(moneyId);
      ok("QA-2909 decided prior/concurrent receipts: one receipt, one edit request and one edit audit; sanctioned liability and revision are unchanged",
        after?.own_mutations?.filter((receipt) => receipt.key === mutationKey).length === 1
          && await rawApprovals.countDocuments({ entity_id: new ObjectId(moneyId), "payload.kind": "cost-edit" }) === countBefore
          && (await audits(moneyId, "edit sent for approval")).length === 1 && after.amount === costBefore.amount
          && String(after.updatedAt) === String(costBefore.updatedAt) && !after.cost_edit_request && !after.cost_edit_proposal);
      const cachedBefore = await snapshot([moneyId]);
      const cached = await req(creator.cookie, "PATCH", `/api/costs/${moneyId}`, moneyBody, moneyHeaders);
      ok("QA-2909 cached receipt: current nonfinance replay remains masked and makes no writes",
        cached.status === 202 && String(cached.data?.item?._id) === String(decided._id) && cached.data.item.payload?.amount === 846123
          && !Object.hasOwn(cached.data.item, "approved_amount") && !Object.hasOwn(cached.data.item, "decision_note")
          && !/423061|818181|919191/.test(JSON.stringify(cached.data)) && await snapshot([moneyId]) === cachedBefore);
      const granted = await req(admin, "PATCH", `/api/users/${creator.id}`, { extra_permissions: ["costs.manage", "finance.view"] });
      const financeBefore = await snapshot([moneyId]);
      const finance = await req(creator.cookie, "PATCH", `/api/costs/${moneyId}`, moneyBody, moneyHeaders);
      ok("QA-2909 cached receipt current finance control: grant reveals exact original decision facts on same 202 request without effects",
        granted.status === 200 && finance.status === 202 && String(finance.data?.item?._id) === String(decided._id)
          && finance.data.item.payload?.amount === 846123 && finance.data.item.approved_amount === 423061
          && finance.data.item.decision_note === decided.decision_note && finance.data.item.payload.note === decided.payload.note
          && await snapshot([moneyId]) === financeBefore);
      const revoked = await req(admin, "PATCH", `/api/users/${creator.id}`, { extra_permissions: ["costs.manage"], revoked_permissions: ["finance.view"] });
      const revokedBefore = await snapshot([moneyId]);
      const revokedRetry = await req(creator.cookie, "PATCH", `/api/costs/${moneyId}`, moneyBody, moneyHeaders);
      ok("QA-2909 cached receipt current finance revoked: original amount only, no sanctioned/decision/payload money disclosure and no effects",
        revoked.status === 200 && revokedRetry.status === 202 && String(revokedRetry.data?.item?._id) === String(decided._id)
          && revokedRetry.data.item.payload?.amount === 846123 && !Object.hasOwn(revokedRetry.data.item, "approved_amount")
          && !Object.hasOwn(revokedRetry.data.item, "decision_note") && !/423061|818181|919191/.test(JSON.stringify(revokedRetry.data))
          && await snapshot([moneyId]) === revokedBefore);
      await req(admin, "PATCH", `/api/users/${creator.id}`, { extra_permissions: ["costs.manage"], revoked_permissions: [] });
    }
    const fromBatch = await makeBatch("FROM");
    const toBatch = await makeBatch("TO");
    const id = await mkApproved(creator, "destination-owner", { batch: String(fromBatch) });
    ok("takeover [precondition]: the source liability exists before its real batch-change proposal", !!id);
    if (id) {
      const queued = await req(creator.cookie, "PATCH", `/api/costs/${id}`,
        { batch: String(toBatch), confirm_approved: true });
      const proposed = await waitingEdit(id);
      const held = await raw(id);
      ok("destination [precondition]: actual A-to-B edit is queued and durably owns the unchanged source cost",
        queued.status === 202 && !!proposed && String(held?.batch) === String(fromBatch)
          && String(held?.cost_edit_request) === String(proposed?._id)
          && proposed?.payload?.batch === String(toBatch) && String(proposed?.batch) === String(toBatch), `${queued.status}`);
      if (proposed) {
        for (const status of ["Pending", "Applying"]) {
          // Applying is the existing request's synthetic in-flight decision state, not a new request.
          await rawApprovals.updateOne({ _id: proposed._id }, { $set: { status } });
          const before = await snapshot([id], [fromBatch, toBatch]);
          const removed = await req(admin, "DELETE", `/api/batches/${toBatch}`, { reason: `${TAG}-held-${status}-destination` });
          ok(`destination: ${status} edit refuses destination batch deletion (409), with both batches, cost, request, lock and audit byte-unchanged`,
            removed.status === 409 && (await snapshot([id], [fromBatch, toBatch])) === before,
            `${removed.status} ${removed.data?.error ?? ""}`);
        }
        await rawApprovals.updateOne({ _id: proposed._id }, { $set: { status: "Pending" } });
        const rejected = await decide(proposed._id, "Rejected");
        ok("destination: rejected batch change clears its ownership for later reconciliation", rejected.status === 200 && !(await raw(id))?.cost_edit_request);
      }

      const emptyDestination = await makeBatch("CLAIM-EMPTY");
      const claimId = new ObjectId();
      // Explicit crash fixture between the cost ownership CAS and creation of the approval row.
      await rawCosts.updateOne({ _id: new ObjectId(id) }, { $set: {
        cost_edit_request: claimId,
        cost_edit_proposal: { mutation_key: `${TAG}-crash-before-queue`, input_hash: "synthetic-crash-fixture",
          context: { batch: String(emptyDestination), payload: { kind: "cost-edit", cost_entry: id, batch: String(emptyDestination) } } },
      } });
      ok("destination [precondition]: durable claim targets an empty batch before any request row exists",
        !(await rawApprovals.findOne({ _id: claimId })) && await rawCosts.countDocuments({ batch: emptyDestination }) === 0);
      const beforeClaimDelete = await snapshot([id], [emptyDestination]);
      const emptyDelete = await req(admin, "DELETE", `/api/batches/${emptyDestination}`, { reason: `${TAG}-claim-before-queue` });
      ok("destination: claim-before-queue protects an EMPTY destination (409), with cost ownership, batch and all effects unchanged",
        emptyDelete.status === 409 && (await snapshot([id], [emptyDestination])) === beforeClaimDelete,
        `${emptyDelete.status} ${emptyDelete.data?.error ?? ""}`);
      await rawCosts.updateOne({ _id: new ObjectId(id) }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });

      // The existing deletion-fence hook lets the claim arrive after deletion has been claimed.
      const fencedDestination = await makeBatch("CLAIM-LATE");
      const localCost = await mkDirect(creator, "destination-history", { batch: String(fencedDestination) });
      const batchBefore = JSON.stringify(await rawBatches.findOne({ _id: fencedDestination }));
      const localBefore = JSON.stringify(await raw(localCost));
      const auditBefore = await rawAudits.countDocuments({});
      const deletePromise = req(admin, "DELETE", `/api/batches/${fencedDestination}?_test_pause_after_deletion_fence_ms=5000`,
        { reason: `${TAG}-late-claim` });
      let fenceSeen = null;
      for (let attempt = 0; attempt < 150 && !fenceSeen; attempt++) {
        fenceSeen = await rawBatches.findOne({ _id: fencedDestination, deletion_state: "Deleting" });
        if (!fenceSeen) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ok("destination [instrument precondition]: recorded-work deletion reached its durable fence before the external claim",
        !!localCost && !!fenceSeen);
      let lateCostBefore = "";
      if (fenceSeen) {
        await rawCosts.updateOne({ _id: new ObjectId(id) }, { $set: {
          cost_edit_request: claimId,
          cost_edit_proposal: { mutation_key: `${TAG}-late-crash`, input_hash: "synthetic-late-claim",
            context: { batch: String(fencedDestination), payload: { kind: "cost-edit", cost_entry: id, batch: String(fencedDestination) } } },
        } });
        lateCostBefore = JSON.stringify(await raw(id));
      }
      const lateDelete = await deletePromise;
      ok("destination: a post-fence external claim refuses deletion (409), rolls back its own batch marker and preserves both costs, claim and audit",
        !!fenceSeen && lateDelete.status === 409
          && JSON.stringify(await rawBatches.findOne({ _id: fencedDestination })) === batchBefore
          && JSON.stringify(await raw(localCost)) === localBefore && JSON.stringify(await raw(id)) === lateCostBefore
          && !(await rawApprovals.findOne({ _id: claimId })) && await rawAudits.countDocuments({}) === auditBefore,
        `${lateDelete.status} ${lateDelete.data?.error ?? ""}`);
      await rawCosts.updateOne({ _id: new ObjectId(id) }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
    }
  }

  // Synthetic legacy rows under unapproved taxonomy exercise the merged material edit, including
  // omission of category. Description-only correction remains possible for a Pending legacy row.
  for (const status of ["Pending", "Rejected"]) {
    for (const blockedAt of ["selected", "parent"]) {
      const parentId = new ObjectId(), categoryId = new ObjectId();
      if (blockedAt === "parent") await rawCategories.insertOne({ _id: parentId, name: `ZZ ${TAG}-${status}-parent`, active: true, approval_status: status });
      await rawCategories.insertOne({ _id: categoryId, name: `ZZ ${TAG}-${status}-${blockedAt}-category`, active: true,
        approval_status: blockedAt === "selected" ? status : "Approved", ...(blockedAt === "parent" ? { parent: parentId } : {}) });
      const id = await mkDirect(creator, `legacy-${status}-${blockedAt}`);
      ok(`taxonomy [precondition]: legacy ${status} ${blockedAt} cost fixture exists`, !!id);
      if (!id) continue;
      await rawCosts.updateOne({ _id: new ObjectId(id) }, { $set: { category: categoryId } });
      for (const patch of [{ amount: 876 }, { location: foreignLoc._id }]) {
        const before = await snapshot([id]);
        const changed = await req(approverB.cookie, "PATCH", `/api/costs/${id}`, patch);
        ok(`taxonomy: finance material ${Object.keys(patch)[0]} edit under ${status} ${blockedAt} is refused (409) even when category is omitted; entry and all effects unchanged`,
          changed.status === 409 && (await snapshot([id])) === before, `${changed.status} ${changed.data?.error ?? ""}`);
      }
      if (status === "Pending") {
        const corrected = await req(approverB.cookie, "PATCH", `/api/costs/${id}`, { note: `${TAG}-legacy-description-${blockedAt}` });
        ok(`taxonomy: a Pending legacy ${blockedAt} still permits descriptive correction (200) without moving money or head`,
          corrected.status === 200 && (await raw(id))?.amount === 321 && String((await raw(id))?.category) === String(categoryId), `${corrected.status}`);
      }
    }
  }

  const malformedId = await mkApproved(creator, "malformed-fields");
  ok("text [precondition]: approved liability exists for malformed creator material-edit attempts", !!malformedId);
  if (malformedId) {
    for (const field of ["note", "vendor_payee", "voucher_no", "payment_mode"]) {
      for (const [kind, value] of [["object", { text: "Cash" }], ["array", ["Cash"]], ["number", 123]]) {
        const before = await snapshot([malformedId]);
        const changed = await req(creator.cookie, "PATCH", `/api/costs/${malformedId}`,
          { amount: 765, confirm_approved: true, [field]: value }, { "Idempotency-Key": `${TAG}-bad-${field}-${kind}` });
        ok(`text: creator ${field} ${kind} is refused (400) before any ledger, approval, audit, receipt, ownership or outbox change`,
          changed.status === 400 && (await snapshot([malformedId])) === before, `${changed.status} ${changed.data?.error ?? ""}`);
      }
    }
  }

  for (const [field, value] of [["note", { text: "bad" }], ["vendor_payee", ["bad"]], ["voucher_no", 123], ["payment_mode", ["Cash"]]]) {
    const id = await mkApproved(creator, `stored-malformed-${field}`);
    const queued = id ? await req(creator.cookie, "PATCH", `/api/costs/${id}`, { amount: 654, confirm_approved: true }) : { status: 0 };
    const proposed = id ? await waitingEdit(id) : null;
    ok(`text [precondition]: actual queued ${field} proposal exists before explicit stored-payload corruption`, queued.status === 202 && !!proposed);
    if (!proposed) continue;
    // Explicit legacy/corrupt stored request fixture: API submission remains strictly typed.
    await rawApprovals.updateOne({ _id: proposed._id }, { $set: { [`payload.${field}`]: value } });
    const costBefore = JSON.stringify(await raw(id));
    const costCountBefore = await rawCosts.countDocuments({});
    const auditBefore = await rawAudits.countDocuments({});
    const approved = await decide(proposed._id, "Approved");
    const requestAfter = await rawApprovals.findOne({ _id: proposed._id });
    ok(`text: stored malformed ${field} approval is refused (400), rolls request back to Pending, and leaves liability, ownership, receipts, outbox and audit unchanged`,
      approved.status === 400 && requestAfter?.status === "Pending"
        && JSON.stringify(requestAfter?.payload?.[field]) === JSON.stringify(value)
        && JSON.stringify(await raw(id)) === costBefore && await rawCosts.countDocuments({}) === costCountBefore
        && await rawAudits.countDocuments({}) === auditBefore, `${approved.status} ${approved.data?.error ?? ""}`);
    const rejected = await decide(proposed._id, "Rejected");
    ok(`text: malformed ${field} request remains rejectable and releases its ownership`, rejected.status === 200 && !(await raw(id))?.cost_edit_request);
  }
}

// ======================================================= browser: the dialog is for approved entries only
let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
} catch (e) {
  ok("[precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200));
}
if (browser) {
  // Keep the browser fixture below DataTable's 25-row page boundary. API cases above still
  // exercise the original Operations creator; this fresh Operations persona has the same rights.
  const uiCreator = await mkUser(`UI Creator ${stamp}`, `zz.b3.ui.${stamp}@vidysea-test.local`, "Operations", ["costs.manage"], [ownLoc._id]);
  ok("[precondition] the UI creator has the same cost-entry rights and signs in", !!uiCreator.id && !!uiCreator.cookie, `${uiCreator.made.status}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  let nativeDialogs = 0;
  page.on("dialog", (d) => { nativeDialogs++; d.dismiss().catch(() => {}); });
  const arm = async (name, fn) => {
    try { await fn(); } catch (e) { ok(`${name} [arm ran to its end]`, false, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 240)); }
  };
  const approvedUi = await mkApproved(uiCreator, "ui-approved");
  // Deleted entries do not render Note; this distinct amount identifies exactly this row.
  const directUi = await mkDirect(uiCreator, "ui-direct", { amount: 642 });
  ok("[precondition] the approved and direct UI entries exist and belong to the UI creator",
    !!approvedUi && !!directUi && String((await raw(approvedUi))?.entered_by) === String(uiCreator.id)
      && String((await raw(directUi))?.entered_by) === String(uiCreator.id));
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().fill(uiCreator.email);
  await page.locator('input[type="password"]').first().fill(PW);
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
  await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
  ok("[precondition] the creator is logged in in the browser", !/login/i.test(page.url()), page.url());
  await page.goto(BASE + "/costs", { waitUntil: "domcontentloaded" });
  // Section renders h3 -> header div -> enclosing card. My submissions appears before
  // Entries you entered and repeats approved notes, so a global tr.first() is the wrong row.
  const cardOf = (title) => page.getByRole("heading", { name: title, exact: true, level: 3 }).locator("..").locator("..");
  const rowOf = (note) => cardOf("Entries you entered").locator("tr", { hasText: `${TAG}-${note}` }).first();
  const modal = page.getByTestId("confirm-modal");

  await arm("ui: the own-entries table lists the creator's rows with Edit and Delete", async () => {
    await rowOf("ui-approved").waitFor();
    ok("ui: an own unpaid row offers Edit and Delete", (await rowOf("ui-approved").getByRole("button", { name: "Delete" }).count()) === 1 && (await rowOf("ui-approved").getByRole("button", { name: "Edit" }).count()) === 1);
  });

  await arm("ui: delete of an approved entry shows the dialog with the approver, the date and the question", async () => {
    await rowOf("ui-approved").getByRole("button", { name: "Delete" }).click();
    await modal.waitFor();
    const text = (await modal.innerText()).replace(/\s+/g, " ");
    const listed = (await req(uiCreator.cookie, "GET", "/api/costs?mine=1")).data?.items?.find((r) => String(r._id) === approvedUi);
    ok("ui: the dialog says who approved it and when, and asks 'Are you really sure?'", text.includes(sentence(approverName, istDay(listed.approved_on))) && text.includes("Are you really sure?"), text);
    ok("ui: it is an in-app dialog, not window.confirm", nativeDialogs === 0, `native dialogs: ${nativeDialogs}`);
    await modal.getByRole("button", { name: "Cancel" }).click();
    await modal.waitFor({ state: "detached" });
    ok("ui: Cancel leaves the entry exactly as it was (not archived)", !(await raw(approvedUi))?.archived_at);
  });

  await arm("ui: confirming deletes an approved entry (soft)", async () => {
    await rowOf("ui-approved").getByRole("button", { name: "Delete" }).click();
    await modal.waitFor();
    await modal.getByRole("button", { name: "Yes, delete it" }).click();
    await modal.waitFor({ state: "detached" });
    await page.waitForFunction(async () => true);
    const until = Date.now() + 15000;
    while (Date.now() < until && !(await raw(approvedUi))?.archived_at) await page.waitForTimeout(200);
    ok("ui: after confirming, the approved entry is archived", !!(await raw(approvedUi))?.archived_at);
  });

  await arm("ui: an unapproved entry deletes WITHOUT a dialog, and can be restored from the deleted list", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await rowOf("ui-direct").waitFor();
    await rowOf("ui-direct").getByRole("button", { name: "Delete" }).click();
    const until = Date.now() + 15000;
    while (Date.now() < until && !(await raw(directUi))?.archived_at) await page.waitForTimeout(200);
    ok("ui: no dialog appeared for the unapproved entry, and it is archived", (await modal.count()) === 0 && !!(await raw(directUi))?.archived_at && nativeDialogs === 0);
    await page.getByText("Deleted entries - restorable").waitFor();
    const deletedRow = cardOf("Deleted entries - restorable").locator("tr").filter({ has: page.getByRole("cell", { name: "₹642", exact: true }) });
    // Database acknowledgement precedes the client refresh; prove the row after it renders.
    await deletedRow.waitFor();
    ok("[precondition] the deleted list identifies exactly the direct UI entry", await deletedRow.count() === 1 && (await raw(directUi))?.amount === 642);
    const restoreBtn = deletedRow.getByRole("button", { name: "Restore", exact: true });
    await restoreBtn.waitFor();
    await restoreBtn.click();
    const until2 = Date.now() + 15000;
    while (Date.now() < until2 && (await raw(directUi))?.archived_at) await page.waitForTimeout(200);
    ok("ui: Restore brings it back", !(await raw(directUi))?.archived_at);
  });

  await arm("ui: editing an approved entry's amount asks first, then sends it back for approval", async () => {
    const id = await mkApproved(uiCreator, "ui-edit");
    await page.reload({ waitUntil: "domcontentloaded" });
    await rowOf("ui-edit").waitFor();
    await rowOf("ui-edit").getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Amount (₹)").or(page.locator('input[type="number"]').first()).first().fill("456");
    await page.getByRole("button", { name: "Save" }).click();
    await modal.waitFor();
    const text = (await modal.innerText()).replace(/\s+/g, " ");
    ok("ui: the edit dialog carries the approver and 'sends it back for approval'", text.includes(`approved by ${approverName}`) && text.includes("Changing it sends it back for approval. Are you really sure?"), text);
    ok("ui: nothing was sent before the person confirmed", (await raw(id))?.amount === 321 && !(await waitingEdit(id)));
    await modal.getByRole("button", { name: "Yes, send it back for approval" }).click();
    await modal.waitFor({ state: "detached" });
    const until = Date.now() + 15000;
    while (Date.now() < until && !(await waitingEdit(id))) await page.waitForTimeout(200);
    ok("ui: after confirming, the change is waiting for approval and the row is unchanged", !!(await waitingEdit(id)) && (await raw(id))?.amount === 321);
    await page.getByText("Sent back to the Admin for approval").waitFor().catch(() => {});
  });

  await arm("ui: an unapproved entry's edit saves with no dialog", async () => {
    const id = await mkDirect(uiCreator, "ui-edit-direct");
    await page.reload({ waitUntil: "domcontentloaded" });
    await rowOf("ui-edit-direct").waitFor();
    await rowOf("ui-edit-direct").getByRole("button", { name: "Edit" }).click();
    await page.locator('input[type="number"]').first().fill("654");
    await page.getByRole("button", { name: "Save" }).click();
    const until = Date.now() + 15000;
    while (Date.now() < until && (await raw(id))?.amount !== 654) await page.waitForTimeout(200);
    ok("ui: saved (amount 654) and no dialog was shown", (await raw(id))?.amount === 654 && (await modal.count()) === 0 && nativeDialogs === 0);
  });

  await browser.close();
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

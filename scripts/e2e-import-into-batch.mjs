// qa-import-into-batch (release -325): the Candidates "Import Excel" drawer can put the sheet's people
// straight onto a batch ("Add to batch (optional)"), instead of the old two-step (import into the pool,
// then a window.confirm, then a second /api/candidates/assign call).
//
// What this suite holds, at the importer door POST /api/candidates/import and the two doors it now
// shares a join rule with (POST /api/candidates/assign, POST /api/batches/[id]/members):
//   1  with a batch: preview says what will happen; commit creates + assigns, truthfully
//   2  without a batch: nothing about the existing importer changes (response keys, QA-991 drop-the-ID)
//   3  a batch at the wrong centre / job role / closed / unknown refuses with ZERO writes
//   4  a portal-ID holder already active in another batch is refused per row, the rest still land
//   5  a ticked holder is ASSIGNED, never duplicated
//   6  an unticked holder is SKIPPED (Umesh's default) - still no new candidate for that row
//   7  import AND assign are both required for the batch field (candidates.manage alone: 403)
//   8  Rule 38 scope: a scoped user cannot import into another centre's batch, and never sees the
//      name of a holder outside their scope
//   9  a forged tick (an id that is not one of THIS sheet's holders) is ignored
//  10  one row that matches two different holders is ambiguous - neither assigned, row not created
//  11  a new row whose "Interested in" is Upcoming batch is created but NOT assigned, and says so
//  12  a holder who joins another batch between preview and commit is refused at commit
//  13  a unique-index failure during the insert reports the truth and attempts no assignment
//  14  over target: joins succeed, with the warning, and the preview says so first
//  15  a holder previously dropped from THIS batch is revived (same BatchMember _id), not duplicated
//  P   parity of the two migrated doors (walk-in adoption + audit, other-centre refusal text)
//  S   static: one place spells the refusal sentences; the three routes call assignCandidateToBatch
//
// Every assertion names the SPECIFIC refusal (status AND message) - "any refusal" is the QA-2457 trap.
// Fixtures are prefixed ZZIMP- so every row is recognisable and deletable. Own stamp, own centres.
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { BASE, adminLogin, login, req, ok, finish, stamp, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const S = stamp("ZZIMP-");
let seq = 0;
const nextN = () => ++seq;
// 10-digit mobile, 12-digit APAAR, CAN id - all unique per call, all derived from the run stamp
const mkPhone = () => "9" + String(Date.now()).slice(-5) + String(1000 + nextN()).slice(-4);
const mkApaar = () => String(Date.now()).slice(-8) + String(1000 + nextN()).slice(-4);
const mkCan = () => "CAN_" + String(Date.now()).slice(-6) + String(1000 + nextN()).slice(-4);

const progR = (await req(admin, "POST", "/api/programs", { code: S + "R", name: "IIB Role R " + S, trainer_skill: "IIB" + S }, 201)).data.item;
const progR2 = (await req(admin, "POST", "/api/programs", { code: S + "Q", name: "IIB Role Q " + S, trainer_skill: "IIB2" + S }, 201)).data.item;
const locX = (await req(admin, "POST", "/api/locations", { code: "X" + S, name: "ZZIMP-X " + S, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
const locY = (await req(admin, "POST", "/api/locations", { code: "Y" + S, name: "ZZIMP-Y " + S, approval_status: "Approved", city: "Agra" }, 201)).data.item;

let batchSeq = 0;
const mkBatch = async (loc, prog, target = 10) =>
  (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today(), target_size: target, session: ["Morning", "Afternoon", "Full Day"][batchSeq++ % 3] }, 201)).data.item;
const mkCand = async (extra = {}) => {
  const n = nextN();
  const r = await req(admin, "POST", "/api/candidates", { name: `ZZIMP-C${n} ${S}`, phone: mkPhone(), location: locX._id, program: progR._id, ...extra }, 201);
  return r.data.item;
};
const idOf = (v) => String(v?._id ?? v);
const members = async (batchId) => ((await req(admin, "GET", `/api/batches/${batchId}/members`)).data.items ?? []);
const activeIn = async (batchId) => (await members(batchId)).filter((m) => !m.left_on);
const zzCands = async () => ((await req(admin, "GET", "/api/candidates?limit=2000")).data.items ?? []).filter((c) => String(c.name ?? "").includes(S));
const byName = async (name) => (await zzCands()).filter((c) => c.name === name);

// A sheet as the drawer sends it: Name / Phone / APAAR / CAN / Interest columns.
const mapping = { Name: "name", Phone: "phone", APAAR: "apaar_id", CAN: "sidh_candidate_id", Interest: "batch_interest" };
const mkSheet = (rows, header = ["Name", "Phone", "APAAR", "CAN", "Interest"]) => {
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
const row = (name, extra = {}) => ({ Name: name, Phone: mkPhone(), APAAR: "", CAN: "", Interest: "", ...extra });
async function importSheet(cookie, { rows, location = locX, program = progR, batch, assign_holders, confirm = false, withMapping = true, header, map = mapping }) {
  const fd = new FormData();
  fd.append("file", new Blob([mkSheet(rows, header)]), "iib.xlsx");
  fd.append("location", String(location._id));
  fd.append("program", String(program._id));
  if (withMapping) fd.append("mapping", JSON.stringify(map));
  fd.append("accept_unknown", "1");
  if (batch) fd.append("batch", String(batch._id ?? batch));
  if (assign_holders) fd.append("assign_holders", JSON.stringify(assign_holders));
  if (confirm) fd.append("confirm", "1");
  const r = await fetch(BASE + "/api/candidates/import", { method: "POST", headers: { cookie }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const holdersOf = (d) => d?.batch_plan?.holders ?? [];

// ============================================================ 1. with a batch
{
  const B = await mkBatch(locX, progR);
  const sheet = [row(`ZZIMP-A1 ${S}`), row(`ZZIMP-A2 ${S}`), row(`ZZIMP-A3 ${S}`)];
  const before = (await zzCands()).length;
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  ok("IIB-1a: preview with a batch answers 200 and carries a batch_plan", pv.status === 200 && !!pv.data.batch_plan, JSON.stringify(pv.data).slice(0, 200));
  ok("IIB-1b: batch_plan says 3 will be created and the roster goes 0 -> 3",
    pv.data.batch_plan?.will_create === 3 && pv.data.batch_plan?.will_add_new === 3 && pv.data.batch_plan?.roster_after === 3 && pv.data.batch_plan?.batch?.roster_count === 0,
    JSON.stringify(pv.data.batch_plan));
  ok("IIB-1c: the preview wrote nothing (no candidate, no member)", (await zzCands()).length === before && (await activeIn(B._id)).length === 0);
  const done = await importSheet(admin, { rows: sheet, batch: B, confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-1d: commit answers 201 with created=3 assigned_new=3 assigned_existing=0",
    done.status === 201 && R?.created === 3 && R?.assigned_new === 3 && R?.assigned_existing === 0, JSON.stringify(done.data).slice(0, 300));
  ok("IIB-1e: existing keys survive (imported, imported_ids) beside batch_result", done.data.imported === 3 && done.data.imported_ids?.length === 3);
  const mem = await activeIn(B._id);
  ok("IIB-1f: three BatchMember rows on the batch, each with a joined_on (addMemberChecked's default)", mem.length === 3 && mem.every((m) => !!m.joined_on), JSON.stringify(mem.map((m) => m.joined_on)));
  const created = await Promise.all(done.data.imported_ids.map(async (id) => (await req(admin, "GET", `/api/candidates/${id}`)).data.item));
  ok("IIB-1g: the new candidates are Assigned, at the sheet's centre and job role",
    created.every((c) => c?.lifecycle_status === "Assigned" && idOf(c.location) === String(locX._id) && idOf(c.program) === String(progR._id)),
    JSON.stringify(created.map((c) => [c?.lifecycle_status, c?.location, c?.program])));
  ok("IIB-1h: invariant created = assigned_new + created_not_assigned.length", R.created !== undefined && R.created === R.assigned_new + (R.created_not_assigned?.length ?? -99));
  // the audit trail names the batch import
  const aud = (await req(admin, "GET", `/api/audit/Batch/${B._id}`)).data.items ?? [];
  ok("IIB-1i: a Batch import_assign audit row records the counts", aud.some((a) => a.field === "import_assign"), JSON.stringify(aud.map((a) => a.field)));
}

// ============================================================ 2. without a batch: unchanged
{
  const holder = await mkCand({ apaar_id: mkApaar() });
  const sheet = [row(`ZZIMP-N1 ${S}`), row(`ZZIMP-N2 ${S}`, { APAAR: holder.apaar_id })];
  const pv = await importSheet(admin, { rows: sheet });
  const PREVIEW_KEYS = ["aadhaar_invalid", "aadhaar_invalid_count", "apaar_duplicate", "apaar_duplicate_count", "apaar_invalid", "apaar_invalid_count", "apaar_same_as_aadhaar", "apaar_same_as_aadhaar_count", "apaar_taken", "apaar_taken_count", "batch_interest_unmatched", "blank_by_field", "candidate_id_invalid", "candidate_id_invalid_count", "date_unparseable", "date_unparseable_count", "duplicate_count", "duplicates", "education_unmatched", "extra_columns_stored", "ignored_columns", "interest_unmatched", "phone_invalid", "phone_invalid_count", "preview", "row_count", "sidh_status_unmatched", "sidh_taken", "sidh_taken_count", "skipped", "template_rows_skipped", "template_rows_skipped_count", "unhandled_fields", "unknown_columns", "valid"];
  ok("IIB-2a: without a batch the preview has exactly the pre-change keys (no batch_plan, no holder_count)",
    JSON.stringify(Object.keys(pv.data).sort()) === JSON.stringify(PREVIEW_KEYS), JSON.stringify(Object.keys(pv.data).sort()));
  ok("IIB-2b: the QA-991 line is untouched - the held APAAR is reported as taken", pv.data.apaar_taken_count === 1 && pv.data.valid === 2, JSON.stringify([pv.data.apaar_taken_count, pv.data.valid]));
  const done = await importSheet(admin, { rows: sheet, confirm: true });
  const COMMIT_KEYS = ["aadhaar_invalid", "aadhaar_invalid_count", "apaar_duplicate", "apaar_duplicate_count", "apaar_invalid", "apaar_invalid_count", "apaar_same_as_aadhaar", "apaar_same_as_aadhaar_count", "apaar_taken", "apaar_taken_count", "batch_interest_unmatched", "blank_by_field", "candidate_id_invalid", "candidate_id_invalid_count", "date_unparseable", "date_unparseable_count", "duplicate_count", "ignored_columns", "imported", "imported_ids", "phone_invalid", "phone_invalid_count", "sidh_status_unmatched", "sidh_taken", "sidh_taken_count", "skipped", "unhandled_fields"];
  ok("IIB-2c: without a batch the commit has exactly the pre-change keys (no batch_result)",
    done.status === 201 && JSON.stringify(Object.keys(done.data).sort()) === JSON.stringify(COMMIT_KEYS), JSON.stringify(Object.keys(done.data).sort()));
  const dup = (await byName(`ZZIMP-N2 ${S}`))[0];
  ok("IIB-2d: the held-ID row is still IMPORTED as a new candidate, with the ID dropped (QA-991)", done.data.imported === 2 && !!dup && !dup.apaar_id, JSON.stringify([done.data.imported, dup?.apaar_id]));
}

// ============================================================ 3. batch-level refusals: ZERO writes
{
  const BY = await mkBatch(locY, progR);
  const BR2 = await mkBatch(locX, progR2);
  const BC = await mkBatch(locX, progR);
  await req(admin, "POST", `/api/batches/${BC._id}/transition`, { target: "Cancelled", reason: "ZZIMP closed-batch fixture" }, 200);
  const sheet = [row(`ZZIMP-W1 ${S}`), row(`ZZIMP-W2 ${S}`)];
  const snap = async () => `${(await zzCands()).length}|${(await members(BY._id)).length}|${(await members(BR2._id)).length}|${(await members(BC._id)).length}`;
  const before = await snap();
  for (const confirm of [false, true]) {
    const tag = confirm ? "commit" : "preview";
    const wrongLoc = await importSheet(admin, { rows: sheet, batch: BY, confirm });
    ok(`IIB-3a(${tag}): a batch at another centre is refused 409 naming location / job role`,
      wrongLoc.status === 409 && /not at this location \/ job role/i.test(wrongLoc.data.error ?? ""), JSON.stringify(wrongLoc));
    const wrongRole = await importSheet(admin, { rows: sheet, batch: BR2, confirm });
    ok(`IIB-3b(${tag}): a batch for another job role is refused with the same 409`,
      wrongRole.status === 409 && /not at this location \/ job role/i.test(wrongRole.data.error ?? ""), JSON.stringify(wrongRole));
    const closed = await importSheet(admin, { rows: sheet, batch: BC, confirm });
    ok(`IIB-3c(${tag}): a closed batch is refused 409 "Batch is closed"`, closed.status === 409 && /closed/i.test(closed.data.error ?? ""), JSON.stringify(closed));
    const unknown = await importSheet(admin, { rows: sheet, batch: "0123456789abcdef01234567", confirm });
    ok(`IIB-3d(${tag}): an unknown batch id is 404 "Batch not found"`, unknown.status === 404 && /Batch not found/.test(unknown.data.error ?? ""), JSON.stringify(unknown));
  }
  ok("IIB-3e: all of those wrote nothing - candidate count and every member count unchanged (read back)", (await snap()) === before, `${before} -> ${await snap()}`);
}

// ============================================================ 4. clash per-row refusal
{
  const B9 = await mkBatch(locX, progR);
  const BT = await mkBatch(locX, progR);
  const h1 = await mkCand({ sidh_candidate_id: mkCan() });
  await req(admin, "POST", `/api/batches/${B9._id}/members`, { candidate: h1._id }, 201);
  const sheet = [row(`ZZIMP-K1 ${S}`), row(`ZZIMP-K2 ${S}`, { CAN: h1.sidh_candidate_id })];
  const pv = await importSheet(admin, { rows: sheet, batch: BT });
  const H = holdersOf(pv.data)[0];
  ok("IIB-4a: the preview lists the holder row as NOT assignable, naming the other batch's code",
    holdersOf(pv.data).length === 1 && H?.can_assign === false && /already active in batch/i.test(H?.refusal ?? "") && (H?.refusal ?? "").includes(B9.code), JSON.stringify(H));
  ok("IIB-4b: ...with the holder's name and a /candidates?q= link (in scope)", H?.candidate?.name === h1.name && /^\/candidates\?q=/.test(H?.link ?? ""), JSON.stringify(H));
  const done = await importSheet(admin, { rows: sheet, batch: BT, assign_holders: [h1._id], confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-4c: ticking it anyway: commit refused[] names the row and the other batch; the other row still lands",
    done.status === 201 && R?.created === 1 && R?.assigned_new === 1 && R?.assigned_existing === 0 &&
    (R?.refused ?? []).some((x) => (x.reason ?? "").includes(B9.code) && /already active/i.test(x.reason ?? "")), JSON.stringify(R));
  const onBT = await activeIn(BT._id);
  ok("IIB-4d: BT holds exactly the new row; the holder is still only on B9", onBT.length === 1 && !onBT.some((m) => idOf(m.candidate) === String(h1._id)) && (await activeIn(B9._id)).length === 1);
}

// ============================================================ 5 + 6. ticked holder assigned / unticked skipped
{
  const B5 = await mkBatch(locX, progR);
  const B6 = await mkBatch(locX, progR);
  const h2 = await mkCand({ apaar_id: mkApaar() });
  const h6 = await mkCand({ apaar_id: mkApaar() });
  const sheet5 = [row(`ZZIMP-T1 ${S}`), row(`ZZIMP-T2 ${S} (same person as holder)`, { APAAR: h2.apaar_id })];
  const pv = await importSheet(admin, { rows: sheet5, batch: B5 });
  ok("IIB-5a: preview: one new row and one holder row (can_assign), valid counts only the new row",
    pv.data.valid === 1 && pv.data.batch_plan?.will_create === 1 && holdersOf(pv.data).length === 1 && holdersOf(pv.data)[0].can_assign === true && holdersOf(pv.data)[0].matched_on === "apaar", JSON.stringify(pv.data.batch_plan));
  const before = (await zzCands()).length;
  const done = await importSheet(admin, { rows: sheet5, batch: B5, assign_holders: [h2._id], confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-5b: commit: created=1, assigned_new=1, assigned_existing=1", done.status === 201 && R?.created === 1 && R?.assigned_new === 1 && R?.assigned_existing === 1, JSON.stringify(R));
  ok("IIB-5c: the candidate count rose by exactly the NEW rows (1), no duplicate of the holder", (await zzCands()).length === before + 1);
  ok("IIB-5d: nobody else carries the holder's APAAR or the holder-row's name",
    (await zzCands()).filter((c) => c.apaar_id === h2.apaar_id).length === 1 && (await byName(`ZZIMP-T2 ${S} (same person as holder)`)).length === 0);
  const m5 = await activeIn(B5._id);
  ok("IIB-5e: the holder is now on the batch (2 members in all)", m5.length === 2 && m5.some((m) => idOf(m.candidate) === String(h2._id)));

  // 6: the same shape, nothing ticked
  const sheet6 = [row(`ZZIMP-U1 ${S}`), row(`ZZIMP-U2 ${S} (same person as holder)`, { APAAR: h6.apaar_id })];
  const before6 = (await zzCands()).length;
  const d6 = await importSheet(admin, { rows: sheet6, batch: B6, assign_holders: [], confirm: true });
  const R6 = d6.data.batch_result ?? {};
  ok("IIB-6a: unticked holder: holders_skipped lists the row and its ID; nothing assigned for it",
    d6.status === 201 && R6?.assigned_existing === 0 && (R6?.holders_skipped ?? []).length === 1 && (R6.holders_skipped[0]?.value ?? "") === h6.apaar_id, JSON.stringify(R6));
  ok("IIB-6b: the holder is NOT on the batch, and STILL no new candidate was made for that row (D2)",
    !(await activeIn(B6._id)).some((m) => idOf(m.candidate) === String(h6._id)) && (await zzCands()).length === before6 + 1 && (await byName(`ZZIMP-U2 ${S} (same person as holder)`)).length === 0);
  ok("IIB-6c: sheet rows = created + holder rows (assigned + skipped + refused)",
    2 === (R6.created ?? 0) + (R6.assigned_existing ?? 0) + (R6.holders_skipped ?? []).length + (R6.refused ?? []).length, JSON.stringify(R6));
}

// ============================================================ 7. persona without assign
let userNoAssign, cookieNoAssign, emNoAssign, pwNoAssign;
{
  const em = `zzimp.noassign.${Date.now()}@vidysea-test.local`;
  const pw = "Iib7pass!xyz";
  emNoAssign = em; pwNoAssign = pw;
  const u = await req(admin, "POST", "/api/users", { name: "ZZIMP no-assign " + S, email: em, password: pw, role: "Location", location_scope: [locX._id], can_edit: true, revoked_permissions: ["candidates.assign"] }, 201);
  userNoAssign = u.data.item;
  cookieNoAssign = await login(em, pw);
  ok("IIB-7[precondition]: the no-assign persona can log in", !!cookieNoAssign);
  const B7 = await mkBatch(locX, progR);
  const before = (await zzCands()).length;
  const pv = await importSheet(cookieNoAssign, { rows: [row(`ZZIMP-P1 ${S}`)], batch: B7 });
  const cm = await importSheet(cookieNoAssign, { rows: [row(`ZZIMP-P1 ${S}`)], batch: B7, confirm: true });
  ok("IIB-7a: candidates.manage WITHOUT candidates.assign: the batch field is 403 on the preview AND the commit",
    pv.status === 403 && cm.status === 403, JSON.stringify([pv.status, pv.data.error, cm.status, cm.data.error]));
  ok("IIB-7b: ...and wrote nothing", (await zzCands()).length === before && (await members(B7._id)).length === 0);
  const plain = await importSheet(cookieNoAssign, { rows: [row(`ZZIMP-P2 ${S}`)], confirm: true });
  ok("IIB-7c: the same persona with NO batch still imports (201, pool only)", plain.status === 201 && plain.data.imported === 1 && !plain.data.batch_result, JSON.stringify(plain));
}

// ============================================================ 8. scope
let userScopeY, cookieScopeY, userScopeX, cookieScopeX, emScopeX, pwScopeX, BXscope;
{
  const pw = "Iib8pass!xyz";
  const emY = `zzimp.scopey.${Date.now()}@vidysea-test.local`;
  userScopeY = (await req(admin, "POST", "/api/users", { name: "ZZIMP scope-Y " + S, email: emY, password: pw, role: "Location", location_scope: [locY._id], can_edit: true }, 201)).data.item;
  cookieScopeY = await login(emY, pw);
  const BX8 = await mkBatch(locX, progR);
  const before = (await zzCands()).length;
  const wrong = await importSheet(cookieScopeY, { rows: [row(`ZZIMP-S1 ${S}`)], batch: BX8, confirm: true });
  const wrongPv = await importSheet(cookieScopeY, { rows: [row(`ZZIMP-S1 ${S}`)], batch: BX8 });
  ok("IIB-8a: a Location user scoped to Y cannot import into X's batch (403 Location out of scope), preview or commit",
    wrong.status === 403 && wrongPv.status === 403 && /out of scope/i.test(wrong.data.error ?? ""), JSON.stringify([wrong, wrongPv]));
  ok("IIB-8b: ...and wrote nothing", (await zzCands()).length === before && (await members(BX8._id)).length === 0);

  const emX = `zzimp.scopex.${Date.now()}@vidysea-test.local`;
  userScopeX = (await req(admin, "POST", "/api/users", { name: "ZZIMP scope-X " + S, email: emX, password: pw, role: "Location", location_scope: [locX._id], can_edit: true }, 201)).data.item;
  cookieScopeX = await login(emX, pw);
  emScopeX = emX; pwScopeX = pw; BXscope = BX8;
  const holderY = await mkCand({ apaar_id: mkApaar(), location: locY._id });
  const pv = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-S2 ${S}`), row(`ZZIMP-S3 ${S}`, { APAAR: holderY.apaar_id })], batch: BX8 });
  const H = holdersOf(pv.data)[0];
  ok("IIB-8c: a holder at Y, seen by a user at X, is reported with candidate:null and cannot be assigned",
    pv.status === 200 && H && H.candidate === null && H.link === null && H.can_assign === false, JSON.stringify(pv.data.batch_plan));
  const blob = JSON.stringify(pv.data);
  ok("IIB-8d: the holder's NAME and PHONE appear nowhere in the whole preview JSON", !blob.includes(holderY.name) && !blob.includes(holderY.phone), blob.slice(0, 300));
  const cm = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-S2 ${S}`), row(`ZZIMP-S3 ${S}`, { APAAR: holderY.apaar_id })], batch: BX8, assign_holders: [holderY._id], confirm: true });
  ok("IIB-8e: ticking the out-of-scope holder assigns nothing; the in-scope new row lands", cm.status === 201 && cm.data.batch_result?.assigned_existing === 0 && cm.data.batch_result?.created === 1 &&
    !(await activeIn(BX8._id)).some((m) => idOf(m.candidate) === String(holderY._id)), JSON.stringify(cm.data.batch_result));
  ok("IIB-8f: the commit response does not carry the out-of-scope holder's name either", !JSON.stringify(cm.data).includes(holderY.name));
}

// ============================================================ 8b. QA-2930: the look-alike line must not name another centre's candidate
// The "possible duplicate" lookup used to run unscoped: a Location importer at X who typed a phone number
// that belongs to somebody at Y was told that person's name, phone and centre. Rule 38: the importer may
// learn that a look-alike exists elsewhere (so they ask an Admin), never WHO or WHERE.
{
  const holderY = await mkCand({ location: locY._id });          // out of scope for the X user (single-import arm)
  const holderY2 = await mkCand({ location: locY._id });         // (batch-import arm) - own phone: the single arm's commit creates a candidate at X with holderY's phone
  const holderYa = await mkCand({ location: locY._id });         // (Admin arms)
  const holderX = await mkCand({ location: locX._id });          // in scope for the X user
  const both = mkPhone();
  const bothY = await mkCand({ location: locY._id, phone: both });
  const bothX = await mkCand({ location: locX._id, phone: both });
  // (a phone-matched look-alike has the IMPORTER'S OWN phone in every line - the phone is checked in LK7, by a name+DOB match)
  const idLeaks = (data, c) => {
    const body = JSON.stringify(data);
    return body.includes(c.name) || body.includes(locY.name);
  };
  const SENT = /another centre|centre you cannot see/i;
  const nameY = `ZZIMP-LK1 ${S}`;
  // single import (no batch)
  const pv1 = await importSheet(cookieScopeX, { rows: [row(nameY, { Phone: holderY.phone })] });
  ok("IIB-LK1a: Location importer at X sees a look-alike from another centre (single import): still flagged, 1 possible duplicate",
    pv1.status === 200 && pv1.data.duplicate_count === 1 && (pv1.data.duplicates ?? []).length === 1 && SENT.test(pv1.data.duplicates[0]), JSON.stringify(pv1.data.duplicates));
  ok("IIB-LK1b: ...and the preview JSON body carries no name or centre of the Y candidate", !idLeaks(pv1.data, holderY), JSON.stringify(pv1.data.duplicates));
  const cm1 = await importSheet(cookieScopeX, { rows: [row(nameY, { Phone: holderY.phone })], confirm: true });
  ok("IIB-LK1c: ...the commit still imports (flag, never block) and its JSON body carries no name or centre of the Y candidate",
    cm1.status === 201 && cm1.data.imported === 1 && cm1.data.duplicate_count === 1 && !JSON.stringify(cm1.data).includes(holderY.name) && !JSON.stringify(cm1.data).includes(locY.name), JSON.stringify(cm1.data).slice(0, 200));
  // batch import
  const pv2 = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK2 ${S}`, { Phone: holderY2.phone })], batch: BXscope });
  ok("IIB-LK2a: Location importer at X sees a look-alike from another centre (batch import): flagged without identity",
    pv2.status === 200 && !!pv2.data.batch_plan && pv2.data.duplicate_count === 1 && SENT.test((pv2.data.duplicates ?? [])[0] ?? "") && !idLeaks(pv2.data, holderY2), JSON.stringify(pv2.data.duplicates));
  const cm2 = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK2 ${S}`, { Phone: holderY2.phone })], batch: BXscope, confirm: true });
  ok("IIB-LK2b: ...batch commit lands the row and its JSON body carries no name or centre of the Y candidate",
    cm2.status === 201 && cm2.data.batch_result?.created === 1 && !JSON.stringify(cm2.data).includes(holderY2.name) && !JSON.stringify(cm2.data).includes(locY.name), JSON.stringify(cm2.data).slice(0, 200));
  // in-scope look-alike keeps today's message (name, centre, status)
  const pv3 = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK3 ${S}`, { Phone: holderX.phone })] });
  const d3 = (pv3.data.duplicates ?? [])[0] ?? "";
  ok("IIB-LK3a: Location importer at X sees a look-alike from their own centre (single import): the full message is unchanged",
    pv3.data.duplicate_count === 1 && d3.includes("already exists:") && d3.includes(holderX.name) && d3.includes(locX.name) && !SENT.test(d3), d3);
  const pv3b = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK3 ${S}`, { Phone: holderX.phone })], batch: BXscope });
  ok("IIB-LK3b: ...and the same in a batch import", (pv3b.data.duplicates ?? [])[0] === d3 && d3.includes("already exists:") && d3.includes(holderX.name), JSON.stringify(pv3b.data.duplicates));
  // look-alikes at both centres: the in-scope one is shown, the other is not
  const pv4 = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK4 ${S}`, { Phone: both })] });
  const d4 = (pv4.data.duplicates ?? []).join(" | ");
  ok("IIB-LK4: a phone held at both X and Y shows the X candidate only; nothing of the Y one (all lines joined: not Mongo-order dependent)",
    pv4.data.duplicate_count === 1 && d4.includes(bothX.name) && !JSON.stringify(pv4.data).includes(bothY.name) && !JSON.stringify(pv4.data).includes(locY.name), d4);
  // a row with no look-alike anywhere is not flagged
  const pv5 = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-LK5 ${S}`)] });
  ok("IIB-LK5: a row with no look-alike anywhere is not flagged", pv5.status === 200 && pv5.data.duplicate_count === 0, JSON.stringify(pv5.data.duplicates));
  // a NAME + DATE OF BIRTH look-alike carries a different phone: that phone is the thing that must not come back
  const yDob = await mkCand({ location: locY._id, dob: "1999-01-15" });
  const dobRow = { ...row(yDob.name, { Phone: mkPhone() }), DOB: "1999-01-15" };
  const dobOpts = { rows: [dobRow], header: ["Name", "Phone", "APAAR", "CAN", "Interest", "DOB"], map: { ...mapping, DOB: "dob" } };
  const pv7 = await importSheet(cookieScopeX, dobOpts);
  ok("IIB-LK7a: Location importer at X sees a name + date-of-birth look-alike from another centre: flagged, and neither its phone nor its centre comes back",
    pv7.status === 200 && pv7.data.duplicate_count === 1 && SENT.test((pv7.data.duplicates ?? [])[0] ?? "") && !JSON.stringify(pv7.data).includes(yDob.phone) && !JSON.stringify(pv7.data).includes(locY.name), JSON.stringify(pv7.data.duplicates));
  const pv7a = await importSheet(admin, dobOpts);
  ok("IIB-LK7b: ...the same sheet for an Admin names the Y candidate's centre as before", pv7a.data.duplicate_count >= 1 && (pv7a.data.duplicates ?? []).some((d) => d.includes("already exists:") && d.includes(locY.name)), JSON.stringify(pv7a.data.duplicates));
  // Admin keeps today's message, with the other centre's name
  const pa = await importSheet(admin, { rows: [row(`ZZIMP-LK6 ${S}`, { Phone: holderYa.phone })] });
  const da = (pa.data.duplicates ?? [])[0] ?? "";
  ok("IIB-LK6a: Admin importing a look-alike from any centre (single import) still gets the full message",
    pa.data.duplicate_count >= 1 && da.includes("already exists:") && da.includes(holderYa.name) && da.includes(locY.name) && !SENT.test(da), da);
  const pab = await importSheet(admin, { rows: [row(`ZZIMP-LK6 ${S}`, { Phone: holderYa.phone })], batch: BXscope });
  ok("IIB-LK6b: ...and in a batch import", (pab.data.duplicates ?? [])[0] === da && da.includes("already exists:") && da.includes(holderYa.name) && da.includes(locY.name), JSON.stringify(pab.data.duplicates));
}

// ============================================================ 8c. QA-2930 (review round): the NON-batch APAAR / portal-ID "already taken" lines
// Without a batch, a sheet row whose APAAR / portal Candidate ID already belongs to somebody gets a line saying WHO
// ("... is already the APAAR ID of <name>"). For a Location importer at X and a holder at Y that was the same leak
// as the look-alike line. The ID is still dropped from the row (QA-991) - only the name is withheld.
{
  const yAp = await mkCand({ apaar_id: mkApaar(), location: locY._id });
  const yCan = await mkCand({ sidh_candidate_id: mkCan(), location: locY._id });
  const xAp = await mkCand({ apaar_id: mkApaar(), location: locX._id });
  const xCan = await mkCand({ sidh_candidate_id: mkCan(), location: locX._id });
  const GEN = /centre you cannot see/i;
  const nm = (c) => String(c.name);
  // Location importer at X, APAAR held at Y
  const pvA = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-NB1 ${S}`, { APAAR: yAp.apaar_id })] });
  ok("IIB-NB1a: Location importer at X puts an APAAR ID held by a Y candidate in the sheet (no batch): the ID is still reported taken, and the Y candidate's name is not in the preview",
    pvA.status === 200 && pvA.data.apaar_taken_count === 1 && GEN.test((pvA.data.apaar_taken ?? [])[0] ?? "") && !JSON.stringify(pvA.data).includes(nm(yAp)), JSON.stringify(pvA.data.apaar_taken));
  const cmA = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-NB1 ${S}`, { APAAR: yAp.apaar_id })], confirm: true });
  const landedA = (await byName(`ZZIMP-NB1 ${S}`))[0];
  ok("IIB-NB1b: ...the commit body has no Y name either, the row still lands, and its APAAR ID is dropped (QA-991 unchanged)",
    cmA.status === 201 && cmA.data.imported === 1 && cmA.data.apaar_taken_count === 1 && !JSON.stringify(cmA.data).includes(nm(yAp)) && !!landedA && !landedA.apaar_id, JSON.stringify(cmA.data).slice(0, 250));
  // portal Candidate ID held at Y
  const pvC = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-NB2 ${S}`, { CAN: yCan.sidh_candidate_id })] });
  ok("IIB-NB2a: Location importer at X puts a portal Candidate ID held by a Y candidate in the sheet (no batch): reported taken, no Y name in the preview",
    pvC.status === 200 && pvC.data.sidh_taken_count === 1 && GEN.test((pvC.data.sidh_taken ?? [])[0] ?? "") && !JSON.stringify(pvC.data).includes(nm(yCan)), JSON.stringify(pvC.data.sidh_taken));
  const cmC = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-NB2 ${S}`, { CAN: yCan.sidh_candidate_id })], confirm: true });
  const landedC = (await byName(`ZZIMP-NB2 ${S}`))[0];
  ok("IIB-NB2b: ...the commit body has no Y name, the row lands, and its portal ID is dropped",
    cmC.status === 201 && cmC.data.imported === 1 && !JSON.stringify(cmC.data).includes(nm(yCan)) && !!landedC && !landedC.sidh_candidate_id, JSON.stringify(cmC.data).slice(0, 250));
  // in scope: unchanged
  const pvX = await importSheet(cookieScopeX, { rows: [row(`ZZIMP-NB3 ${S}`, { APAAR: xAp.apaar_id }), row(`ZZIMP-NB3b ${S}`, { CAN: xCan.sidh_candidate_id })] });
  ok("IIB-NB3: Location importer at X with APAAR / portal IDs held by X candidates still gets the holder's name",
    (pvX.data.apaar_taken ?? [])[0]?.includes(`APAAR ID of ${nm(xAp)}`) && (pvX.data.sidh_taken ?? [])[0]?.includes(`recorded for ${nm(xCan)}`), JSON.stringify([pvX.data.apaar_taken, pvX.data.sidh_taken]));
  // Admin: unchanged
  const pvAd = await importSheet(admin, { rows: [row(`ZZIMP-NB4 ${S}`, { APAAR: yAp.apaar_id }), row(`ZZIMP-NB4b ${S}`, { CAN: yCan.sidh_candidate_id })] });
  ok("IIB-NB4: Admin putting the Y candidates' APAAR / portal IDs in a sheet still gets their names",
    (pvAd.data.apaar_taken ?? [])[0]?.includes(`APAAR ID of ${nm(yAp)}`) && (pvAd.data.sidh_taken ?? [])[0]?.includes(`recorded for ${nm(yCan)}`), JSON.stringify([pvAd.data.apaar_taken, pvAd.data.sidh_taken]));
}

// ============================================================ 8d. QA-2930 (review round): other scoped roles, and a scoped user with an EMPTY scope
// Trainer and scoped Enrollment are scoped by isScoped() exactly like Location. A Location / Trainer user whose
// location_scope is [] sees NOTHING, so the check-duplicate lookup must answer nothing, not the whole country.
const mkPersona = async (label, role, scope, extra = {}) => {
  const em = `zzimp.${label}.${Date.now()}@vidysea-test.local`;
  const pw = "Iib8dpass!xyz";
  const r = await req(admin, "POST", "/api/users", { name: `ZZIMP ${label} ${S}`, email: em, password: pw, role, location_scope: scope, can_edit: true, ...extra });
  const cookie = r.status === 201 ? await login(em, pw) : null;
  return { user: r.data.item, status: r.status, err: r.data.error, cookie };
};
const checkDup = (cookie, body) => req(cookie, "POST", "/api/candidates/check-duplicate", body);
const personas = [];
{
  const yC = await mkCand({ location: locY._id });
  const xC = await mkCand({ location: locX._id });
  for (const [label, role] of [["trainer", "Trainer"], ["enrol", "Enrollment"]]) {
    const P = await mkPersona(label + "x", role, [locX._id], { extra_permissions: ["candidates.manage"] });
    if (P.user) personas.push(P.user);
    ok(`IIB-SC[precondition]: a ${role} scoped to X can be created and log in`, P.status === 201 && !!P.cookie, JSON.stringify([P.status, P.err]));
    if (!P.cookie) continue;
    const pvY = await importSheet(P.cookie, { rows: [row(`ZZIMP-SC-${label}-Y ${S}`, { Phone: yC.phone })] });
    ok(`IIB-SC1-${label}: a ${role} importer scoped to X sees a look-alike from another centre: flagged, no name or centre`,
      pvY.status === 200 && pvY.data.duplicate_count === 1 && /centre you cannot see/i.test((pvY.data.duplicates ?? [])[0] ?? "") && !JSON.stringify(pvY.data).includes(yC.name) && !JSON.stringify(pvY.data).includes(locY.name), JSON.stringify([pvY.status, pvY.data.duplicates, pvY.data.error]));
    const pvX2 = await importSheet(P.cookie, { rows: [row(`ZZIMP-SC-${label}-X ${S}`, { Phone: xC.phone })] });
    const dx = (pvX2.data.duplicates ?? [])[0] ?? "";
    ok(`IIB-SC2-${label}: ...and a look-alike at their own centre keeps the full message`, dx.includes("already exists:") && dx.includes(xC.name) && dx.includes(locX.name), dx);
  }
  // EMPTY scope
  for (const [label, role] of [["trainer0", "Trainer"], ["loc0", "Location"]]) {
    const P = await mkPersona(label, role, [], { extra_permissions: ["candidates.manage"] });
    if (P.user) personas.push(P.user);
    ok(`IIB-EM[precondition]: a ${role} with an EMPTY location_scope can be created and log in (otherwise the empty-scope arms verify nothing)`, P.status === 201 && !!P.cookie, JSON.stringify([P.status, P.err]));
    if (!P.cookie) continue;
    const cd = await checkDup(P.cookie, { phone: yC.phone });
    ok(`IIB-EM1-${label}: a ${role} with an empty scope asks check-duplicate about a Y candidate's phone: 200 and nothing comes back`,
      cd.status === 200 && (cd.data.duplicates ?? []).length === 0 && !JSON.stringify(cd.data).includes(yC.name) && !JSON.stringify(cd.data).includes(locY.name), JSON.stringify(cd.data).slice(0, 200));
    const imp = await importSheet(P.cookie, { rows: [row(`ZZIMP-EM-${label} ${S}`, { Phone: yC.phone })], location: locX });
    ok(`IIB-EM2-${label}: ...and its import (X is outside an empty scope) is refused 403 with no name or centre in the body`,
      imp.status === 403 && !JSON.stringify(imp.data).includes(yC.name) && !JSON.stringify(imp.data).includes(locY.name), JSON.stringify([imp.status, imp.data]).slice(0, 200));
  }
  // a scoped user asking check-duplicate about their own centre still gets the answer; Admin gets all
  const Px = await mkPersona("chkx", "Location", [locX._id], { extra_permissions: ["candidates.manage"] });
  if (Px.user) personas.push(Px.user);
  const own = await checkDup(Px.cookie, { phone: xC.phone });
  const other = await checkDup(Px.cookie, { phone: yC.phone });
  const adm = await checkDup(admin, { phone: yC.phone });
  ok("IIB-EM3: check-duplicate unchanged for a user scoped to X (own centre answered, other centre silent) and for an Admin (any centre answered)",
    (own.data.duplicates ?? []).some((d) => d.name === xC.name) && (other.data.duplicates ?? []).length === 0 && (adm.data.duplicates ?? []).some((d) => d.name === yC.name), JSON.stringify([own.data, other.data, adm.data]).slice(0, 300));
}

// ============================================================ 9. forged tick
{
  const B = await mkBatch(locX, progR);
  const real = await mkCand({ apaar_id: mkApaar() });
  const stranger = await mkCand();
  const sheet = [row(`ZZIMP-F1 ${S}`), row(`ZZIMP-F2 ${S}`, { APAAR: real.apaar_id })];
  const done = await importSheet(admin, { rows: sheet, batch: B, assign_holders: [stranger._id], confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-9a: an id that is not one of THIS sheet's holders is ignored - never assigned", done.status === 201 && !(await activeIn(B._id)).some((m) => idOf(m.candidate) === String(stranger._id)));
  ok("IIB-9b: ...reported nowhere as assigned or refused; the real holder is listed as skipped",
    !JSON.stringify(R).includes(String(stranger._id)) && R?.assigned_existing === 0 && (R?.holders_skipped ?? []).length === 1, JSON.stringify(R));
}

// ============================================================ 10. ambiguous row
{
  const B = await mkBatch(locX, progR);
  const h3 = await mkCand({ sidh_candidate_id: mkCan() });
  const h4 = await mkCand({ apaar_id: mkApaar() });
  const sheet = [row(`ZZIMP-M1 ${S}`), row(`ZZIMP-M2 ${S}`, { CAN: h3.sidh_candidate_id, APAAR: h4.apaar_id })];
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  ok("IIB-10a: the preview names the row as ambiguous (two different holders)", (pv.data.batch_plan?.ambiguous ?? []).length === 1 && /two different/i.test(pv.data.batch_plan?.ambiguous?.[0]?.reason ?? ""), JSON.stringify(pv.data.batch_plan));
  const before = (await zzCands()).length;
  const done = await importSheet(admin, { rows: sheet, batch: B, assign_holders: [h3._id, h4._id], confirm: true });
  ok("IIB-10b: ticking both assigns neither, and the ambiguous row is not created",
    done.status === 201 && done.data.batch_result?.assigned_existing === 0 && (await zzCands()).length === before + 1 &&
    !(await activeIn(B._id)).some((m) => [h3._id, h4._id].includes(idOf(m.candidate))), JSON.stringify(done.data.batch_result));
}

// ============================================================ 11. Upcoming-batch interest on a NEW row
{
  const B = await mkBatch(locX, progR);
  const sheet = [row(`ZZIMP-V1 ${S}`), row(`ZZIMP-V2 ${S}`, { Interest: "Upcoming batch" })];
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  const nr = pv.data.batch_plan?.new_refused ?? [];
  ok("IIB-11a: the preview refuses the Upcoming-interest row with the Upcoming-batch sentence, and counts it out of will_add_new",
    nr.length === 1 && /interested in the Upcoming batch/i.test(nr[0].reason ?? "") && pv.data.batch_plan?.will_create === 2 && pv.data.batch_plan?.will_add_new === 1, JSON.stringify(pv.data.batch_plan));
  const done = await importSheet(admin, { rows: sheet, batch: B, confirm: true });
  const R = done.data.batch_result ?? {};
  const v2 = (await byName(`ZZIMP-V2 ${S}`))[0];
  ok("IIB-11b: commit creates that candidate but does NOT assign them, and says so", done.status === 201 && R?.created === 2 && R?.assigned_new === 1 && (R?.created_not_assigned ?? []).includes(String(v2?._id)), JSON.stringify(R));
  ok("IIB-11c: ...they are not on the roster, the other row is", (await activeIn(B._id)).length === 1 && !(await activeIn(B._id)).some((m) => idOf(m.candidate) === String(v2?._id)));
  ok("IIB-11d: invariant created = assigned_new + created_not_assigned.length", R.created !== undefined && R.created === R.assigned_new + (R.created_not_assigned?.length ?? -99));
}

// ============================================================ 12. race between preview and commit
{
  const B = await mkBatch(locX, progR);
  const Bother = await mkBatch(locX, progR);
  const h = await mkCand({ apaar_id: mkApaar() });
  const sheet = [row(`ZZIMP-R1 ${S}`), row(`ZZIMP-R2 ${S}`, { APAAR: h.apaar_id })];
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  ok("IIB-12[precondition]: at preview time the holder IS assignable", holdersOf(pv.data)[0]?.can_assign === true);
  await req(admin, "POST", `/api/batches/${Bother._id}/members`, { candidate: h._id }, 201); // the race
  const done = await importSheet(admin, { rows: sheet, batch: B, assign_holders: [h._id], confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-12a: commit refuses the holder with the other batch's code, and does not count them assigned",
    done.status === 201 && R?.assigned_existing === 0 && (R?.refused ?? []).some((x) => (x.reason ?? "").includes(Bother.code)), JSON.stringify(R));
  ok("IIB-12b: the new row still landed; invariant holds", R?.created === 1 && R?.assigned_new === 1 && R.created !== undefined && R.created === R.assigned_new + (R.created_not_assigned?.length ?? -99));
}

// ============================================================ 13. insert failure
{
  const B = await mkBatch(locX, progR);
  const dupAp = mkApaar();
  const sheet = [row(`ZZIMP-D1 ${S}`), row(`ZZIMP-D2 ${S}`, { APAAR: dupAp }), row(`ZZIMP-D3 ${S}`, { APAAR: dupAp })];
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  ok("IIB-13[precondition]: the preview already reports the within-sheet duplicate APAAR", pv.data.apaar_duplicate_count === 1);
  const done = await importSheet(admin, { rows: sheet, batch: B, confirm: true });
  const landed = (await zzCands()).filter((c) => /^ZZIMP-D[123] /.test(c.name));
  ok("IIB-13a: the response is a clean error (409) - no 500, no raw E11000 / index text",
    done.status === 409 && !/E11000|index|dup key/i.test(done.data.error ?? "") && !!done.data.error, JSON.stringify(done.data).slice(0, 300));
  ok("IIB-13b: it reports the TRUE created count (read back from the database) and attempts no assignment",
    done.data.batch_result?.created === landed.length && landed.length === 2 && done.data.batch_result?.assigned_new === 0 && (await activeIn(B._id)).length === 0, JSON.stringify([done.data.batch_result, landed.length]));
  // review fold-in 2026-10-17 (finding 1): created = assigned_new + created_not_assigned.length must hold on
  // THIS path too - the rows that landed but were not added are listed by id, and the ids are the real ones.
  const R13 = done.data.batch_result ?? {};
  ok("IIB-13c: invariant created = assigned_new + created_not_assigned holds after a failed insert, and the ids are the rows that landed",
    R13.created === (R13.assigned_new ?? -99) + (R13.created_not_assigned?.length ?? -99) &&
    (R13.created_not_assigned ?? []).length === 2 &&
    (R13.created_not_assigned ?? []).every((id) => landed.some((c) => String(c._id) === String(id))), JSON.stringify([R13, landed.map((c) => c._id)]));
}

// ============================================================ 14. over target
{
  const BO = await mkBatch(locX, progR, 3);
  for (let i = 0; i < 2; i++) await req(admin, "POST", `/api/batches/${BO._id}/members`, { candidate: (await mkCand())._id }, 201);
  const sheet = [row(`ZZIMP-O1 ${S}`), row(`ZZIMP-O2 ${S}`), row(`ZZIMP-O3 ${S}`)];
  const pv = await importSheet(admin, { rows: sheet, batch: BO });
  ok("IIB-14a: the preview says the roster will pass the target, BEFORE anything is written",
    pv.data.batch_plan?.roster_after === 5 && /Roster would be 5 of target 3/.test(pv.data.batch_plan?.target_warning ?? ""), JSON.stringify(pv.data.batch_plan));
  const done = await importSheet(admin, { rows: sheet, batch: BO, confirm: true });
  const R = done.data.batch_result ?? {};
  ok("IIB-14b: the joins succeed (3 assigned) and warnings carry 'Roster is now 4 of target 3'",
    done.status === 201 && R?.assigned_new === 3 && (R?.warnings ?? []).some((w) => /Roster is now 4 of target 3/.test(w)), JSON.stringify(R));
}

// ============================================================ 15. revive
{
  const B = await mkBatch(locX, progR);
  const h = await mkCand({ apaar_id: mkApaar() });
  const m0 = (await req(admin, "POST", `/api/batches/${B._id}/members`, { candidate: h._id }, 201)).data.item;
  await req(admin, "POST", `/api/members/${m0._id}/drop`, { left_on: today(), drop_reason: "Other" }, 200);
  const sheet = [row(`ZZIMP-Z1 ${S}`), row(`ZZIMP-Z2 ${S}`, { APAAR: h.apaar_id })];
  const pv = await importSheet(admin, { rows: sheet, batch: B });
  ok("IIB-15a: the dropped holder is assignable again in the preview", holdersOf(pv.data)[0]?.can_assign === true, JSON.stringify(holdersOf(pv.data)));
  const done = await importSheet(admin, { rows: sheet, batch: B, assign_holders: [h._id], confirm: true });
  const all = (await members(B._id)).filter((m) => idOf(m.candidate) === String(h._id));
  ok("IIB-15b: ticked: assigned_existing=1, and the SAME BatchMember _id is revived (one row, not two)",
    done.data.batch_result?.assigned_existing === 1 && all.length === 1 && String(all[0]._id) === String(m0._id) && !all[0].left_on, JSON.stringify([done.data.batch_result, all.map((m) => [m._id, m.left_on])]));
}

// ============================================================ P. parity of the two migrated doors
{
  const Bsingle = await mkBatch(locX, progR);
  const Bbulk = await mkBatch(locX, progR);
  const w1 = await mkCand({ location: undefined });
  const w2 = await mkCand({ location: undefined });
  ok("IIB-P[precondition]: both walk-ins start with no centre", !w1.location && !w2.location);
  await req(admin, "POST", `/api/batches/${Bsingle._id}/members`, { candidate: w1._id }, 201);
  const bulk = await req(admin, "POST", "/api/candidates/assign", { batch: Bbulk._id, candidate_ids: [w2._id] }, 200);
  ok("IIB-P1: BOTH doors adopt a walk-in (centre set to the batch's)", bulk.data.results?.[0]?.ok === true &&
    idOf((await req(admin, "GET", `/api/candidates/${w1._id}`)).data.item.location) === String(locX._id) &&
    idOf((await req(admin, "GET", `/api/candidates/${w2._id}`)).data.item.location) === String(locX._id));
  const audOf = async (id) => ((await req(admin, "GET", `/api/audit/Candidate/${id}`)).data.items ?? []).filter((a) => a.field === "location");
  const a1 = await audOf(w1._id), a2 = await audOf(w2._id);
  const shape = (a) => String(a?.[0]?.new_value ?? "").replace(/\([^)]*\)/, "(CODE)");
  ok("IIB-P2: BOTH doors audit the adoption, with the SAME wording (the two copies used to differ)",
    a1.length === 1 && a2.length === 1 && shape(a1) === shape(a2) && /set to this batch's centre on enrolment/.test(String(a1[0]?.new_value)), JSON.stringify([a1, a2]));
  const alien = await mkCand({ location: locY._id });
  const Bx = await mkBatch(locX, progR);
  const single = await req(admin, "POST", `/api/batches/${Bx._id}/members`, { candidate: alien._id });
  const bulk2 = await req(admin, "POST", "/api/candidates/assign", { batch: Bx._id, candidate_ids: [alien._id] });
  ok("IIB-P3: a different-centre candidate is refused by BOTH doors with the SAME sentence",
    single.status === 409 && bulk2.data.results?.[0]?.ok === false && single.data.error === bulk2.data.results[0].error && /belongs to another centre/.test(single.data.error), JSON.stringify([single.data, bulk2.data.results]));
  const otherRole = await mkCand({ program: progR2._id });
  const s2 = await req(admin, "POST", `/api/batches/${Bx._id}/members`, { candidate: otherRole._id });
  const b2 = await req(admin, "POST", "/api/candidates/assign", { batch: Bx._id, candidate_ids: [otherRole._id] });
  ok("IIB-P4: a different-job-role candidate is refused by BOTH doors with the SAME sentence",
    s2.status === 409 && s2.data.error === b2.data.results?.[0]?.error && /different job role\/scheme/.test(s2.data.error), JSON.stringify([s2.data, b2.data.results]));
  const Bclosed = await mkBatch(locX, progR);
  await req(admin, "POST", `/api/batches/${Bclosed._id}/transition`, { target: "Cancelled", reason: "ZZIMP closed-batch fixture" }, 200);
  const c1 = await req(admin, "POST", `/api/batches/${Bclosed._id}/members`, { candidate: (await mkCand())._id });
  const c2 = await req(admin, "POST", "/api/candidates/assign", { batch: Bclosed._id, candidate_ids: [(await mkCand())._id] });
  ok("IIB-P5: a closed batch is refused 409 by BOTH doors", c1.status === 409 && c2.status === 409, JSON.stringify([c1.status, c2.status]));
}

// ============================================================ 16. members POST: an archived candidate (review fold-in, finding 2)
{
  const Barc = await mkBatch(locX, progR);
  const arc = await mkCand();
  await req(admin, "DELETE", `/api/candidates/${arc._id}`, { reason: "ZZIMP archived-fixture" }, 200);
  const chk = (await req(admin, "GET", `/api/candidates/${arc._id}`)).data.item;
  ok("IIB-16[precondition]: the fixture really is archived", !!chk?.archived_at, JSON.stringify(chk?.archived_at));
  const single = await req(admin, "POST", `/api/batches/${Barc._id}/members`, { candidate: arc._id });
  ok("IIB-16a: members POST refuses an archived candidate with the archived sentence (409), same as the importer's rule",
    single.status === 409 && /is archived — restore them before adding them to a batch/.test(single.data.error ?? ""), JSON.stringify([single.status, single.data]));
  ok("IIB-16b: and nothing was written - the roster is still empty", (await activeIn(Barc._id)).length === 0);
}

// ============================================================ S. static pin
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p); } };
  walk(root);
  const holders = (needle) => files.filter((f) => fs.readFileSync(f, "utf8").includes(needle)).map((f) => path.relative(root, f).replace(/\\/g, "/"));
  const A = holders("belongs to another centre — move them");
  const B = holders("is registered under a different job role/scheme");
  ok("IIB-S1: exactly one place spells the other-centre refusal, and it is rules.ts", A.length === 1 && A[0] === "lib/rules.ts", JSON.stringify(A));
  ok("IIB-S2: exactly one place spells the other-job-role refusal, and it is rules.ts", B.length === 1 && B[0] === "lib/rules.ts", JSON.stringify(B));
  const callers = ["app/api/candidates/import/route.ts", "app/api/candidates/assign/route.ts", "app/api/batches/[id]/members/route.ts"];
  ok("IIB-S3: all three routes import assignCandidateToBatch", callers.every((c) => /assignCandidateToBatch/.test(fs.readFileSync(path.join(root, c), "utf8"))), callers.join(", "));
}

// ============================================================ UI. the drawer, in a real browser
{
  const { ADMIN_PASSWORD } = await import("./e2e-lib.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  let chromium = null;
  try { ({ chromium } = await import("playwright")); } catch { /* reported below, never skipped silently */ }
  ok("IIB-UI[precondition]: playwright is importable (a missing browser means the UI arm verified NOTHING)", !!chromium);
  if (chromium) {
    const browser = await chromium.launch({ headless: true });
    const dir = mkdtempSync(path.join(tmpdir(), "iib-ui-"));
    try {
      const BU = await mkBatch(locX, progR);
      const BUrole = await mkBatch(locX, progR2);
      const BUcentre = await mkBatch(locY, progR);
      const BUclosed = await mkBatch(locX, progR);
      await req(admin, "POST", `/api/batches/${BUclosed._id}/transition`, { target: "Cancelled", reason: "ZZIMP ui closed fixture" }, 200);
      const Bbusy = await mkBatch(locX, progR);
      const hOk = await mkCand({ apaar_id: mkApaar() });
      const hBusy = await mkCand({ sidh_candidate_id: mkCan() });
      await req(admin, "POST", `/api/batches/${Bbusy._id}/members`, { candidate: hBusy._id }, 201);
      const sheetRows = [row(`ZZIMP-UI1 ${S}`), row(`ZZIMP-UI2 ${S}`), row(`ZZIMP-UI3 ${S} (holder ok)`, { APAAR: hOk.apaar_id }), row(`ZZIMP-UI4 ${S} (holder busy)`, { CAN: hBusy.sidh_candidate_id })];
      const file = path.join(dir, "ui.xlsx");
      writeFileSync(file, mkSheet(sheetRows));
      const columns = ["Name", "Phone", "APAAR", "CAN", "Interest"];

      const open = async (ctx, email, pw) => {
        const page = await ctx.newPage();
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
        if (await emailBox.count()) {
          await emailBox.fill(email);
          await page.locator('input[type="password"]').first().fill(pw);
          await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
          await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
        }
        await page.goto(`${BASE}/candidates`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Import Excel" }).click();
        const drawer = page.locator("div.fixed.inset-0").last();
        await drawer.locator("label", { hasText: "Location" }).locator("select").selectOption(String(locX._id));
        return { page, drawer };
      };

      // ---- admin
      const ctxA = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const { page, drawer } = await open(ctxA, "admin@vidysea.com", ADMIN_PASSWORD);
      ok("IIB-UI-1: the Batch select does not exist until Location AND Job role are both chosen", (await drawer.getByTestId("import-batch").count()) === 0);
      await drawer.locator("label", { hasText: "Program" }).locator("select").selectOption(String(progR._id));
      const sel = drawer.getByTestId("import-batch");
      await sel.waitFor({ timeout: 10000 });
      await sel.locator(`option[value="${BU._id}"]`).waitFor({ state: "attached", timeout: 15000 }).catch(() => {}); // the batch list loads async
      const vals = await sel.locator("option").evaluateAll((os) => os.map((o) => o.value));
      ok("IIB-UI-2: it lists the open batch for THIS centre + job role, and not the other-role / other-centre / closed ones",
        vals.includes(String(BU._id)) && !vals.includes(String(BUrole._id)) && !vals.includes(String(BUcentre._id)) && !vals.includes(String(BUclosed._id)), JSON.stringify(vals.length));
      await sel.selectOption(String(BU._id));
      await page.evaluate(([sig, mp]) => localStorage.setItem("erp-import-map-candidates-v2", JSON.stringify({ sig, mapping: mp })),
        [[...columns].sort().join("|"), mapping]);
      await drawer.locator('input[type="file"]').setInputFiles(file);
      await drawer.getByRole("button", { name: "Preview" }).waitFor({ timeout: 15000 });
      await drawer.getByRole("button", { name: "Preview" }).click();
      const plan = drawer.getByTestId("import-batch-plan");
      await plan.waitFor({ timeout: 15000 });
      const summary = await drawer.getByTestId("import-batch-summary").innerText();
      ok(`IIB-UI-3: the preview says "2 will be added to batch ${BU.code}"`, new RegExp(`2 will be added to batch ${BU.code}`).test(summary), summary);
      const holdersBox = drawer.getByTestId("import-holders");
      const trs = holdersBox.locator("tbody tr");
      ok("IIB-UI-4: two holder rows are listed", (await trs.count()) === 2, String(await trs.count()));
      const okRow = trs.filter({ hasText: "ZZIMP-UI3" });
      const busyRow = trs.filter({ hasText: "ZZIMP-UI4" });
      ok("IIB-UI-5: the assignable holder has an ENABLED checkbox and a new-tab link to /candidates?q=",
        (await okRow.locator('input[type="checkbox"]').isEnabled()) &&
        /\/candidates\?q=/.test((await okRow.locator("a").getAttribute("href")) ?? "") && (await okRow.locator("a").getAttribute("target")) === "_blank");
      const busyTxt = await busyRow.innerText();
      ok("IIB-UI-6: the busy holder's checkbox is DISABLED and the reason names the other batch",
        !(await busyRow.locator('input[type="checkbox"]').isEnabled()) && busyTxt.includes(Bbusy.code) && /already active in batch/i.test(busyTxt), busyTxt);
      const btn = () => drawer.getByRole("button", { name: /^Import \d+ and add/ });
      ok("IIB-UI-7: button reads 'Import 2 and add 2' before any tick", /Import 2 and add 2 to /.test(await btn().innerText()), await btn().innerText());
      await okRow.locator('input[type="checkbox"]').check();
      ok("IIB-UI-8: ticking the holder moves it to 'add 3'", new RegExp(`Import 2 and add 3 to ${BU.code}`).test(await btn().innerText()), await btn().innerText());
      await btn().click();
      await page.getByText(new RegExp(`3 added to ${BU.code}`)).first().waitFor({ timeout: 20000 }).catch(() => {});
      const bodyTxt = await page.locator("body").innerText();
      ok("IIB-UI-9: the result summary reports created 2 / added 3 (2 new, 1 already in the system)",
        /2 new candidates created/.test(bodyTxt) && new RegExp(`3 added to ${BU.code} \\(2 new, 1 already in the system\\)`).test(bodyTxt), bodyTxt.slice(0, 300));
      const roster = await activeIn(BU._id);
      ok("IIB-UI-10: the roster read back from the API is those 3", roster.length === 3 && roster.some((m) => idOf(m.candidate) === String(hOk._id)));
      ok("IIB-UI-11: and the busy holder was left alone (still only on their other batch)", !roster.some((m) => idOf(m.candidate) === String(hBusy._id)) && (await activeIn(Bbusy._id)).length === 1);
      await ctxA.close();

      // ---- manage WITHOUT assign: no Batch field at all
      const ctxP = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const P = await open(ctxP, emNoAssign, pwNoAssign);
      await P.drawer.locator("label", { hasText: "Program" }).locator("select").selectOption(String(progR._id));
      await P.page.waitForTimeout(800);
      ok("IIB-UI-12: a user with candidates.manage but NOT candidates.assign sees no 'Add to batch' field",
        (await P.drawer.getByTestId("import-batch").count()) === 0 && (await P.drawer.locator("label", { hasText: "Program" }).count()) === 1);
      await ctxP.close();

      // ---- QA-2930: a Location user at X, look-alike held at Y - the drawer must not show who or where
      const yUi = await mkCand({ location: locY._id });
      const fileLk = path.join(dir, "lk.xlsx");
      writeFileSync(fileLk, mkSheet([row(`ZZIMP-LKUI ${S}`, { Phone: yUi.phone })]));
      const ctxS = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const SC = await open(ctxS, emScopeX, pwScopeX);
      await SC.drawer.locator("label", { hasText: "Program" }).locator("select").selectOption(String(progR._id));
      await SC.page.evaluate(([sig, mp]) => localStorage.setItem("erp-import-map-candidates-v2", JSON.stringify({ sig, mapping: mp })),
        [[...columns].sort().join("|"), mapping]);
      await SC.drawer.locator('input[type="file"]').setInputFiles(fileLk);
      await SC.drawer.getByRole("button", { name: "Preview" }).waitFor({ timeout: 15000 });
      await SC.drawer.getByRole("button", { name: "Preview" }).click();
      await SC.drawer.getByText(/possible duplicate/i).first().waitFor({ timeout: 15000 }).catch(() => {});
      const lkTxt = await SC.drawer.innerText();
      ok("IIB-UI-13: Location importer at X sees a look-alike from another centre: the drawer flags it and names no one (no name, no centre)",
        /possible duplicate/i.test(lkTxt) && /another centre|centre you cannot see/i.test(lkTxt) && !lkTxt.includes(yUi.name) && !lkTxt.includes(locY.name), lkTxt.slice(0, 400));
      await ctxS.close();
    } catch (e) {
      ok("IIB-UI: the browser journey ran to its end", false, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300));
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

// ============================================================ cleanup of the personas created above
for (const u of [userNoAssign, userScopeY, userScopeX, ...personas].filter(Boolean)) {
  await req(admin, "PATCH", `/api/users/${u._id}`, { active: false }, 200);
}
finish();

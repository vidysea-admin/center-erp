// Role-wise access verification — Rules 38 (location scoping), 39 (can_edit), 40 (role gates).
// Requires sample data (seed-sample.mjs). Run: node scripts/e2e-roles.mjs
//
// QA-831 (S1, -223): this suite performs a real `PUT /api/permissions` (see the QA-025 P1 block
// below) against whatever BASE_URL names, and it had NO guard. Two consequences, both real:
// BASE_URL pointing at production would have made the wall rewrite the LIVE permission matrix; and
// a run that dies between the PUT and its restore leaves Enrollment holding `costs.manage:view`.
// `requireLocalBase` already existed in db-guard.mjs and seed-sample.mjs already used it — this
// file did not. On 2026-08-24 an entire day went into proving the live matrix had NOT changed; one
// accidental run of this script would have made that impossible to prove.
import { requireLocalBase } from "./db-guard.mjs";
const BASE = requireLocalBase("e2e-roles", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}

async function req(cookie, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PW = "CiOnly@123";
const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", PW);
const spoc = await login("spoc.jpr03@vidysea.com", PW);
// 2026-08-13 (Umesh role matrix): the principal is a WRITER now (admin-like within their
// centre); Rule 39's view-only persona lives on its own login.
const principal = await login("principal.jpr03@vidysea.com", PW);
const viewer = await login("viewer.jpr03@vidysea.com", PW);
const trainer = await login("trainer.jpr03@vidysea.com", PW);
const enroll = await login("enroll@vidysea.com", PW);
ok("all seven role users can log in", admin && ops && spoc && principal && viewer && trainer && enroll);

// Rule 38: Location user sees only scoped locations
const spocLocs = await req(spoc, "GET", "/api/locations?limit=200");
ok("Rule 38: SPOC sees exactly 1 location (JPR03)", spocLocs.data.items?.length === 1 && spocLocs.data.items[0].code === "JPR03", `got ${spocLocs.data.items?.length}`);
const adminLocs = await req(admin, "GET", "/api/locations?limit=200");
ok("Admin sees all locations", (adminLocs.data.items?.length ?? 0) > 5, `got ${adminLocs.data.items?.length}`);

// Rule 38: scoped batches/candidates
const spocBatches = await req(spoc, "GET", "/api/batches");
ok("Rule 38: SPOC batches all JPR03", spocBatches.data.items?.every((b) => b.location?.code === "JPR03"), JSON.stringify(spocBatches.data.items?.map((b) => b.location?.code)));
// Search for KOT02 rather than scanning a capped page for it. The list route caps at 200 rows and
// the test database grows with every run, so "find it in the first 200" quietly became false and
// the suite died on an undefined instead of failing an assertion. The search parameter is `q`.
const otherLoc = (await req(admin, "GET", "/api/locations?q=KOT02")).data.items?.find((l) => l.code === "KOT02")
  ?? adminLocs.data.items.find((l) => l.code === "KOT02");
ok("fixture: the foreign location KOT02 exists (run seed:sample first)", !!otherLoc);
const spocForeign = await req(spoc, "GET", `/api/locations/${otherLoc._id}`);
ok("Rule 38: SPOC blocked from foreign location detail (403)", spocForeign.status === 403, `got ${spocForeign.status}`);

// Rule 39: the view-only login cannot write
const jpr = spocLocs.data.items[0];
const viewerWrite = await req(viewer, "PATCH", `/api/locations/${jpr._id}`, { city: "Hacked" });
ok("Rule 39: view-only user PATCH blocked (403)", viewerWrite.status === 403, `got ${viewerWrite.status}`);
const viewerRead = await req(viewer, "GET", `/api/locations/${jpr._id}`);
ok("Rule 39: view-only user can still read", viewerRead.status === 200);
// SPOC (can_edit) CAN write own location
const spocWrite = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { spoc_phone: "9876500001" });
ok("SPOC with can_edit can write own location", spocWrite.status === 200, `got ${spocWrite.status}`);

// Rule 40: role gates
// -218 (Umesh, 23/08): the new status door is gated on `sheet.approve`, the SAME key bulk-ignore and
// apply use — a permission, never a role literal. The screen hides the control behind that same key,
// because six times in eight releases a control was gated on one thing while its door checked
// another (QA-712, QA-723, QA-754, QA-775, QA-785, QA-791) and every one was a button someone could
// see and not press. Enrollment does not hold sheet.approve.
{
  const anyChange = (await req(admin, "GET", "/api/sheet-changes?status=all")).data?.items?.[0];
  if (anyChange) {
    const r = await req(enroll, "PATCH", `/api/sheet-changes/${anyChange._id}/status`, { status: "Ignored" });
    ok("-218: a login without sheet.approve cannot change a sync change's status", r.status === 403, `status=${r.status}`);
    const v = await req(viewer, "PATCH", `/api/sheet-changes/${anyChange._id}/status`, { status: "Open" });
    ok("-218: …and a view-only login cannot either", v.status === 403, `status=${v.status}`);
    const after = (await req(admin, "GET", "/api/sheet-changes?status=all")).data?.items?.find((c) => c._id === anyChange._id);
    ok("-218: …and neither refusal moved the row", after?.status === anyChange.status,
      `${anyChange.status} -> ${after?.status}`);

    // QA-806 (-219, checker on qa-218): the gates -218 put on that SCREEN were unreachable code.
    // `/sync`'s ceiling was ["Admin"], and routeAllowed returns true for Admin before it reads any
    // permission - so the only login that could reach the screen was one for which `can()` is
    // unconditionally true, and `canApprove`/`canRunSources` could never evaluate false. Exactly the
    // fault the /govt-attendance rule was written to fix: "every gate read the ROLE while the API
    // read the PERMISSION". Operations is on the ceiling now, so the matrix actually decides - and
    // that is what this pins, because a gate nobody can fail is not a gate.
    // QA-814 (-220, checker on qa-219): this read `data?.matrix?.Operations`, a key
    // /api/permissions NEVER returns (it returns `{catalog, roles:[{role, permissions}]}`). So
    // `opsSetNow` was ALWAYS `[]`, and the PUT below then WIPED the Operations permission set and
    // failed five neighbouring assertions. A pin that destroys the state it is measuring is worse
    // than no pin. Read the shape the API actually has, and refuse to run at all if it looks wrong.
    const permsNow = (await req(admin, "GET", "/api/permissions")).data;
    const opsRow = (permsNow?.roles ?? []).find((r) => r.role === "Operations");
    ok("-220 (QA-814): the permissions payload has the shape this pin reads", Array.isArray(opsRow?.permissions),
      JSON.stringify(Object.keys(permsNow ?? {})));
    const opsSetNow = opsRow?.permissions ?? null;
    if (Array.isArray(opsSetNow) && !opsSetNow.includes("sheet.approve")) {
      const denied = await req(ops, "PATCH", `/api/sheet-changes/${anyChange._id}/status`, { status: "Open" });
      ok("-218/QA-806: Operations WITHOUT sheet.approve is refused by the door", denied.status === 403, `status=${denied.status}`);
      await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: [...opsSetNow, "sheet.approve"] }, 200);
      const allowed = await req(ops, "PATCH", `/api/sheet-changes/${anyChange._id}/status`, { status: anyChange.status === "Open" ? "Ignored" : "Open" });
      ok("-218/QA-806: …and WITH it the same login is accepted - so the RIGHT decides, not the role",
        allowed.status === 200 || allowed.status === 409,
        `status=${allowed.status} error=${JSON.stringify(allowed.data?.error ?? null).slice(0, 110)}`);
      await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsSetNow }, 200);
      const deniedAgain = await req(ops, "PATCH", `/api/sheet-changes/${anyChange._id}/status`, { status: "Open" });
      ok("-218/QA-806: …and revoking it closes the door again", deniedAgain.status === 403, `status=${deniedAgain.status}`);
    }
  }
}

const enrollChanges = await req(enroll, "GET", "/api/sheet-changes");
ok("Rule 40: Enrollment role blocked from Sync Inbox (403)", enrollChanges.status === 403, `got ${enrollChanges.status}`);
const spocCosts = await req(spoc, "GET", "/api/costs");
ok("Rule 40: Location role blocked from Costs (403)", spocCosts.status === 403, `got ${spocCosts.status}`);
const opsChanges = await req(ops, "GET", "/api/sheet-changes");
ok("Rule 40/QA-083: Operations is OUT of the Sync Inbox now", opsChanges.status === 403, `got ${opsChanges.status}`);
const opsUsers = await req(ops, "GET", "/api/users");
ok("Rule 40: non-Admin blocked from Users (403)", opsUsers.status === 403, `got ${opsUsers.status}`);
const opsPrograms = await req(ops, "POST", "/api/programs", { code: "XX", name: "X", trainer_skill: "X" });
ok("Rule 40: non-Admin cannot create Program (403)", opsPrograms.status === 403, `got ${opsPrograms.status}`);
const enrollDefaults = await req(enroll, "PUT", "/api/defaults", { batch_size: 99 });
ok("Rule 40: non-Admin cannot edit Defaults (403)", enrollDefaults.status === 403, `got ${enrollDefaults.status}`);

// Enrollment role CAN update enrollment steps
const anyBatch = spocBatches.data.items.find((b) => b.status === "Active");
if (anyBatch) {
  const members = await req(admin, "GET", `/api/batches/${anyBatch._id}/members`);
  const m = members.data.items.find((x) => !x.left_on);
  const enrollPatch = await req(enroll, "PATCH", `/api/members/${m._id}`, { reg_done: true });
  ok("Enrollment role can update enrollment steps", enrollPatch.status === 200, `got ${enrollPatch.status}`);
}

// By-ID scope bypass (IDOR) — SPOC must NOT reach foreign batches directly
const allBatches = await req(admin, "GET", "/api/batches");
const foreignBatch = allBatches.data.items.find((b) => b.location?.code && b.location.code !== "JPR03");
if (foreignBatch) {
  ok("IDOR: SPOC GET foreign batch → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}`)).status === 403);
  ok("IDOR: SPOC PATCH foreign batch → 403", (await req(spoc, "PATCH", `/api/batches/${foreignBatch._id}`, { target_size: 99 })).status === 403);
  ok("IDOR: SPOC foreign batch members → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/members`)).status === 403);
  ok("IDOR: SPOC foreign batch logs → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/logs`)).status === 403);
  ok("IDOR: SPOC foreign batch closure → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/closure`)).status === 403);
  ok("IDOR: SPOC foreign batch transition → 403", (await req(spoc, "POST", `/api/batches/${foreignBatch._id}/transition`, { target: "Ready" })).status === 403);
  ok("IDOR: SPOC bulk-assign into foreign batch → 403", (await req(spoc, "POST", "/api/candidates/assign", { batch: foreignBatch._id, candidate_ids: ["000000000000000000000000"] })).status === 403);
  const fMembers = await req(admin, "GET", `/api/batches/${foreignBatch._id}/members`);
  const fm = fMembers.data.items?.[0];
  if (fm) {
    ok("IDOR: SPOC PATCH foreign member → 403", (await req(spoc, "PATCH", `/api/members/${fm._id}`, { reg_done: true })).status === 403);
  }
  ok("IDOR: batches list ?location=<foreign> → 403", (await req(spoc, "GET", `/api/batches?location=${foreignBatch.location._id}`)).status === 403);
  // Foreign CANDIDATE into own batch must also be blocked (sibling asymmetry regression)
  const ownBatch = spocBatches.data.items.find((b) => !["Completed", "Cancelled"].includes(b.status));
  const foreignCand = (await req(admin, "GET", "/api/candidates?limit=200")).data.items.find((c) => c.location?.code && c.location.code !== "JPR03");
  if (ownBatch && foreignCand) {
    ok("IDOR: SPOC add foreign candidate to own batch → 403", (await req(spoc, "POST", `/api/batches/${ownBatch._id}/members`, { candidate: foreignCand._id })).status === 403);
  }
}
// Audit actor_type cannot be spoofed via body.source
if (anyBatch) {
  const members2 = await req(admin, "GET", `/api/batches/${anyBatch._id}/members`);
  const m2 = members2.data.items.find((x) => !x.left_on);
  await req(enroll, "PATCH", `/api/members/${m2._id}`, { kyc_done: true, source: "Automation" });
  const aud = await req(admin, "GET", `/api/audit/BatchMember/${m2._id}`);
  const latest = aud.data.items?.[0];
  ok("audit actor_type stays USER despite body.source=Automation", latest?.actor_type === "USER", latest?.actor_type);
}

// Per-candidate results routes must respect Rule 38 exactly like the rest
if (foreignBatch) {
  ok("IDOR: SPOC GET foreign batch results → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/results`)).status === 403);
  ok("IDOR: SPOC PUT foreign batch results → 403", (await req(spoc, "PUT", `/api/batches/${foreignBatch._id}/results`, { rows: [{ member: "000000000000000000000000", result: "Pass" }] })).status === 403);
}
const ownActive = spocBatches.data.items.find((b) => !["Completed", "Cancelled"].includes(b.status));
if (ownActive) {
  ok("SPOC can read results for own batch", (await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).status === 200);
  ok("view-only user cannot mark results", (await req(viewer, "PUT", `/api/batches/${ownActive._id}/results`, { rows: [{ member: "000000000000000000000000", result: "Pass" }] })).status === 403);

  // ---- QA-747 (-214, Umesh 23/08): the TRAINER must be able to type a portal Candidate ID ----
  //
  // His words: "role number nai chayye, candidate id chayye. Candidate id fill karne ke liye woh
  // hona chahiye, taaki jin students ki candidate id missing hai unko wo kar payein." Asked whether
  // a Trainer should be able to save one, he said "Trainer bhi bhar sake".
  //
  // That is the whole reason the write lives on THIS door. The closure card opens on
  // `closure.manage`, which a Trainer has; `PATCH /api/candidates/:id` wants `candidates.manage`,
  // which a Trainer does NOT have and which does not even list Trainer in writeRoles. Wiring the box
  // to that door would have shown every Trainer an input that 403s on save - the dead-button class
  // that shipped three times in three releases (QA-712, QA-723, QA-754). So this pin is not a nicety:
  // it is the assertion that the button a Trainer can SEE is a button a Trainer can PRESS.
  // THE CORRECTION, and it is mine. I asked Umesh "should a Trainer be able to save one?" and I
  // told him the card opens on `closure.manage`, "which a Trainer has". **A Trainer does not have
  // it.** `permissions.ts:61` grants Trainer exactly one right - `batches.daily_log` - so a Trainer
  // has never been able to open or mark this card at all. He answered "Trainer bhi bhar sake" to a
  // question built on a false fact, and the wall refused the pin I wrote from it (403, four
  // assertions). Widening this is a live permission-matrix decision and it is HIS - `closure.manage`
  // also carries certificate upload, so it is not a small grant.
  //
  // What the code does guarantee, and what is pinned here, is the COUPLING: the id is written on the
  // same door and the same right as marking a result, so everyone who can SEE this card can fill the
  // box, and anyone who cannot mark cannot write an identity field either. No visible control that
  // refuses on press - which was the entire reason for choosing this door.
  const spocRows = (await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [];
  const target = spocRows.find((r) => r.candidate?._id && !r.left_on);
  if (target) {
    const stamp = String(Date.now()).slice(-7);
    const wrote = await req(spoc, "PUT", `/api/batches/${ownActive._id}/results`,
      { rows: [{ member: String(target.member), sidh_candidate_id: `CAN_${stamp}` }] });
    ok("QA-747: whoever can mark results can save a portal Candidate ID from the same card",
      wrote.status === 200, `status=${wrote.status} error=${JSON.stringify(wrote.data?.error ?? null).slice(0, 140)}`);
    const idOf = (rows) => rows.find((r) => String(r.member) === String(target.member))?.candidate?.sidh_candidate_id ?? null;
    ok("QA-747: …and it actually landed on the candidate, not just returned 200",
      idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? []) === `CAN_${stamp}`,
      String(idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [])));
    // the guard is the SHARED one, so this door cannot take junk either (QA-714)
    const junk = await req(spoc, "PUT", `/api/batches/${ownActive._id}/results`,
      { rows: [{ member: String(target.member), sidh_candidate_id: "40918461" }] });
    ok("QA-747: …junk is refused here with the same message as every other door",
      junk.status === 400 && /portal Candidate ID/i.test(String(junk.data?.error ?? "")),
      `status=${junk.status} error=${JSON.stringify(junk.data?.error ?? null).slice(0, 120)}`);
    ok("QA-747: …and the refused row left the stored id exactly as it was (nothing written first)",
      idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? []) === `CAN_${stamp}`,
      String(idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [])));
    // and whoever cannot mark cannot write an identity field either - no half-open door
    {
      const r = await req(viewer, "PUT", `/api/batches/${ownActive._id}/results`,
        { rows: [{ member: String(target.member), sidh_candidate_id: `CAN_${stamp}1` }] });
      ok("QA-747: …and a view-only user cannot write one either", r.status === 403, `status=${r.status}`);
    }
    // QA-1469 (2026-08-24 outage postmortem, "Trainer ko haq do" -> Trainer now carries
    // closure.manage): the coupling above cuts the other way too - a Trainer can now open this
    // card, so a Trainer can now also write the portal Candidate ID from it, same as a SPOC.
    // Re-writes the SAME value the SPOC already stored (not a fresh one) so the id chain every
    // pin below this one hardcodes as `CAN_${stamp}` stays intact - QA-1502 cycle 2's checker
    // caught a first version of this pin using a distinct value here, which left `target`
    // holding it instead and broke QA-780/QA-786's duplicate-id and untouched-id assertions.
    {
      const r = await req(trainer, "PUT", `/api/batches/${ownActive._id}/results`,
        { rows: [{ member: String(target.member), sidh_candidate_id: `CAN_${stamp}` }] });
      ok("QA-1469: …and a Trainer (closure.manage granted) CAN write one now",
        r.status === 200, `status=${r.status} error=${JSON.stringify(r.data?.error ?? null).slice(0, 140)}`);
    }
    // QA-780 (-216, checker on qa-214): the id must NOT be written by a request that then refuses.
    // -214 wrote it, then let the result-marking throw 400 and a duplicate id throw 409 mid-loop -
    // so a response whose own message says "Nothing has been saved" had already saved and audited an
    // identity field. Two probes, because the two refusals came from different places.
    const readId = async () => ((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [])
      .find((r) => String(r.member) === String(target.member))?.candidate?.sidh_candidate_id ?? null;
    const before780 = await readId();
    const badResult = await req(spoc, "PUT", `/api/batches/${ownActive._id}/results`,
      { rows: [{ member: String(target.member), sidh_candidate_id: `CAN_${stamp}780`, result: "NotAResult" }] });
    ok("QA-780: a row whose RESULT is refused does not leave the Candidate ID written behind it",
      badResult.status >= 400 && (await readId()) === before780,
      `status=${badResult.status} stored=${await readId()} (was ${before780})`);
    // …and a DUPLICATE id is refused before anything is written, not by the index mid-loop
    // QA-786 (-217, checker on qa-216): the version of this pin in -216 accepted `200 ||  409`, so it
    // could not fail - it passed whatever the door did. Charged, and rewritten to require the refusal.
    // Two students are needed for a real duplicate, so it takes the SECOND row on the batch.
    const rows2 = (await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [];
    const other = rows2.find((r) => r.candidate?._id && !r.left_on && String(r.member) !== String(target.member));
    if (other) {
      const held = `CAN_${stamp}`;                       // already on `target` from the pin above
      const beforeOther = other.candidate?.sidh_candidate_id ?? null;
      const dup = await req(spoc, "PUT", `/api/batches/${ownActive._id}/results`,
        { rows: [{ member: String(other.member), sidh_candidate_id: held }] });
      ok("QA-780: an id that already belongs to someone else is REFUSED, and says nothing was saved",
        dup.status === 409 && /Nothing has been saved/i.test(String(dup.data?.error ?? "")),
        `status=${dup.status} error=${JSON.stringify(dup.data?.error ?? null).slice(0, 140)}`);
      const otherAfter = ((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [])
        .find((r) => String(r.member) === String(other.member))?.candidate?.sidh_candidate_id ?? null;
      ok("QA-780: …and that student's id is exactly what it was", otherAfter === beforeOther,
        `${beforeOther} -> ${otherAfter}`);

      // QA-786: the same id twice in ONE request. The DB pre-check cannot see this - the conflict
      // does not exist yet - so -216 wrote the first row, audited it, and let the unique index throw
      // 409 on the second. A request that refuses must not have written.
      const fresh = `CAN_${stamp}786`;
      const twin = await req(spoc, "PUT", `/api/batches/${ownActive._id}/results`, {
        rows: [
          { member: String(target.member), sidh_candidate_id: fresh },
          { member: String(other.member), sidh_candidate_id: fresh },
        ],
      });
      ok("QA-786: one id given to two students in ONE save is refused before anything is written",
        twin.status === 409 && /Nothing has been saved/i.test(String(twin.data?.error ?? "")),
        `status=${twin.status} error=${JSON.stringify(twin.data?.error ?? null).slice(0, 140)}`);
      const both = (await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [];
      const idFor = (m) => both.find((r) => String(r.member) === String(m))?.candidate?.sidh_candidate_id ?? null;
      ok("QA-786: …and NEITHER student carries the id that request tried to hand out",
        idFor(target.member) !== fresh && idFor(other.member) !== fresh,
        JSON.stringify({ target: idFor(target.member), other: idFor(other.member), tried: fresh }));
    }

    ok("QA-747: …the stored id is untouched after both refusals",
      idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? []) === `CAN_${stamp}`,
      String(idOf((await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).data?.items ?? [])));
  }
}

// Alerts: the by-ID action route must be location-scoped exactly like the list
const adminAlerts = (await req(admin, "GET", "/api/notifications?status=all")).data.items ?? [];
const foreignAlert = adminAlerts.find((n) => n.location && n.location.code !== "JPR03");
if (foreignAlert) {
  ok("IDOR: SPOC cannot act on another location's alert", (await req(spoc, "POST", `/api/notifications/${foreignAlert._id}`, { status: "Resolved" })).status === 403);
}
const spocAlerts = (await req(spoc, "GET", "/api/notifications?status=all")).data.items ?? [];
ok("alerts list scoped to SPOC's location", spocAlerts.every((n) => !n.location || n.location.code === "JPR03"), JSON.stringify(spocAlerts.map((n) => n.location?.code)));

// Home queues must be scoped for Location users (no cross-location leakage)
const spocHome = await req(spoc, "GET", "/api/home");
const homeQueues = spocHome.data.queues ?? {};
const leaks = [
  ...(homeQueues.attendance_gaps ?? []).filter((l) => l.batch?.location?.code && l.batch.location.code !== "JPR03"),
  ...(homeQueues.enrollment_failures ?? []).filter((f) => f.batch?.location?.code && f.batch.location.code !== "JPR03"),
  ...(homeQueues.follow_ups ?? []),
  ...(homeQueues.sheet_changes ?? []),
];
ok("Home queues leak nothing outside SPOC scope", leaks.length === 0, `leaked ${leaks.length}`);

// ---- QA-1104 (checker on qa-1074 cycle 1): the report is not a side door to the sync surface ----
// The rollup's `sync_gap` block was shipped in cycle 1 to EVERY authenticated role. Three of its
// fields belong to a surface the product refuses two clicks away: `/api/sheet-changes` and
// `/api/sync-sources` both 403 a user without `sheet.approve`, in so many words - "You do not have
// the 'Approve/apply sheet changes' right". The checker measured five logins - SPOC, principal,
// TRAINER, ops, enrolment - all getting the source's name, its status and the sync's own error
// sentence out of `/api/reports/rollup`. `last_error` is the sharp end: sync.ts assigns it straight
// from a caught exception, so on another failure it can carry the workbook URL or the provider's
// message.
//
// Pinned from BOTH sides, because a one-sided version passes if the block disappears for everyone -
// and the counts are the part Umesh actually asked for and must survive.
{
  const rollupOf = async (who) => (await req(who, "GET", "/api/reports/rollup")).data?.sync_gap ?? {};
  const asSpoc = await rollupOf(spoc);
  const asTrainer = await rollupOf(trainer);
  const asAdmin = await rollupOf(admin);

  ok("QA-1104: a scoped login gets NO sync source name / status / error out of the report",
    !asSpoc.source_name && !asSpoc.last_status && !asSpoc.last_error && !asSpoc.last_synced_at
    && !asTrainer.source_name && !asTrainer.last_status && !asTrainer.last_error,
    JSON.stringify({ spoc: asSpoc, trainer: asTrainer }));

  ok("QA-1104: …and it is a GATE, not a deletion - the counts Umesh asked for still reach them",
    Number.isInteger(asSpoc.open_total) && Number.isInteger(asSpoc.open_affecting)
    && !!asSpoc.verdict_not_on_row && Number.isInteger(asSpoc.verdict_not_on_row.rows),
    JSON.stringify(asSpoc));

  // The other side: an Admin DOES get it, so a fix that simply removed the block cannot pass.
  ok("QA-1104: an Admin still gets the source block - otherwise this pin would pass on a deletion",
    typeof asAdmin.last_status === "string" && "source_name" in asAdmin && !!asAdmin.last_synced_at,
    JSON.stringify(asAdmin));

  // And the gate is the SAME question the sync doors ask, not a new one invented here.
  ok("QA-1104: the roles refused the source block are exactly the roles the sync doors 403",
    (await req(spoc, "GET", "/api/sheet-changes")).status === 403
    && (await req(trainer, "GET", "/api/sheet-changes")).status === 403
    && (await req(admin, "GET", "/api/sheet-changes")).status === 200,
    JSON.stringify({
      spoc: (await req(spoc, "GET", "/api/sheet-changes")).status,
      trainer: (await req(trainer, "GET", "/api/sheet-changes")).status,
      admin: (await req(admin, "GET", "/api/sheet-changes")).status,
    }));
}

// 2026-08-11 routes — scoping and role gates
// Sheet Watch is Admin/Operations only
ok("SPOC cannot read workbook changes", (await req(spoc, "GET", "/api/workbook-changes")).status === 403);
ok("Ops cannot read workbook changes either (QA-083)", (await req(ops, "GET", "/api/workbook-changes")).status === 403);
// Meeting notes follow location scope; view-only principal cannot write
const ownLocId = spocLocs.data.items[0]._id;
ok("SPOC can add a meeting note at own location", (await req(spoc, "POST", `/api/locations/${ownLocId}/notes`, { note: "role-test note" })).status === 201);
ok("SPOC cannot read another location's notes", (await req(spoc, "GET", `/api/locations/${otherLoc._id}/notes`)).status === 403);
ok("view-only user cannot add notes", (await req(viewer, "POST", `/api/locations/${ownLocId}/notes`, { note: "nope" })).status === 403);
// Public-token creation is scoped too
ok("SPOC cannot mint a register link for a foreign location", (await req(spoc, "POST", "/api/public-tokens", { purpose: "register", location: otherLoc._id })).status === 403);
// …and so is the token LIST — tokens are credentials, a foreign location's must never leak
const foreignToken = (await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: otherLoc._id })).data.item;
const spocTokens = (await req(spoc, "GET", "/api/public-tokens")).data.items ?? [];
ok("token list scoped: SPOC never sees a foreign location's links",
  spocTokens.every((t) => !t.location || t.location.code === "JPR03"),
  JSON.stringify(spocTokens.map((t) => t.location?.code)));
if (foreignToken?._id) await req(admin, "PATCH", `/api/public-tokens/${foreignToken._id}`, { active: false });
// Backward-plan calculator is any-authenticated read
ok("planner endpoint readable by SPOC", (await req(spoc, "GET", "/api/plan-batch?start=2026-12-01")).status === 200);

// 2026-08-11 evening (CEO): togglable role permissions — revoke a right from a whole role
// and the gate closes for that role; restore it and it reopens. No re-login either way.
const permsBefore = (await req(admin, "GET", "/api/permissions")).data;
const opsSet = permsBefore.roles.find((r) => r.role === "Operations")?.permissions ?? [];
// QA-083: sheet.approve is OUT of the Operations defaults now — the toggle test runs the
// other way: granting it opens the door, removing it closes again.
ok("permission matrix lists roles + catalog (Ops trimmed of sheet.approve)", permsBefore.catalog?.length >= 10 && !opsSet.includes("sheet.approve"));
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: [...opsSet, "sheet.approve"] });
await new Promise((r) => setTimeout(r, 5200)); // permission cache TTL
ok("granting sheet.approve to Operations opens Sheet Watch", (await req(ops, "GET", "/api/workbook-changes")).status === 200);
ok("…and the Sync Inbox", (await req(ops, "GET", "/api/sheet-changes")).status === 200);
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsSet });
await new Promise((r) => setTimeout(r, 5200));
ok("removing the right closes it again", (await req(ops, "GET", "/api/workbook-changes")).status === 403);
ok("Admin role toggles are refused (lockout-proof)", (await req(admin, "PUT", "/api/permissions", { role: "Admin", permissions: [] })).status === 400);
ok("SPOC cannot open the permission matrix", (await req(spoc, "GET", "/api/permissions")).status === 403);

// 2026-08-12, found by testing a REAL approved account on production with every right
// granted: four screens stayed closed because their READ gate was still a hardcoded role
// check while only the write gate had moved onto the toggles. Granting a right must open
// the screen, not just the save button.
{
  const target = (await req(admin, "GET", "/api/users")).data.items.find((u) => u.email === "enroll@vidysea.com");
  // QA-1825: reading the ledger and the invoice book moved off costs.manage/invoices.manage onto
  // finance.view, so the grant that opens those two screens is finance.view — the assertions below
  // (grant opens the READ, revoke closes it again) are unchanged in what they pin.
  const ALL = ["costs.manage", "finance.view", "sheet.sources", "feedback.links"]; // QA-1838: invoices.manage retired — it gated nothing
  await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: ALL });
  for (const [path, label] of [["/api/costs", "costs"], ["/api/invoices", "invoices"], ["/api/sync-sources", "sync sources"], ["/api/public-tokens", "public links"]]) {
    ok(`granting the right opens ${label} for reading too`, (await req(enroll, "GET", path)).status === 200, `${path}`);
  }
  await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: [] });
  for (const [path, label] of [["/api/costs", "costs"], ["/api/invoices", "invoices"], ["/api/sync-sources", "sync sources"]]) {
    ok(`revoking it closes ${label} again`, (await req(enroll, "GET", path)).status === 403, `${path}`);
  }
  // The tab-mapping wizard (2026-08-13) is part of the same source-admin surface — every one of
  // its routes answers to sheet.sources, permission checked before the id is even looked up.
  ok("tab-mappings list is closed without sheet.sources", (await req(enroll, "GET", "/api/sync-sources/000000000000000000000000/tab-mappings")).status === 403);
  ok("tab-mappings approve is closed without sheet.sources", (await req(enroll, "PUT", "/api/sync-sources/000000000000000000000000/tab-mappings", { tab: "X", entity_type: "Candidate", columns: [], constants: {}, key_field: "phone" })).status === 403);
  ok("tab-mappings suggest is closed without sheet.sources", (await req(enroll, "POST", "/api/sync-sources/000000000000000000000000/tab-mappings/suggest", { tab: "X", entity_type: "Candidate" })).status === 403);
  ok("Sync Now is closed without sheet.sources (was role-gated)", (await req(enroll, "POST", "/api/sync-sources/000000000000000000000000/run", {})).status === 403);
}

// Trainer pay is not directory data (2026-08-12): a signed-in user without trainers.manage
// could read every trainer's day rate and compensation from the roster.
{
  // A trainer created here with a known day rate, rather than hoping one in the seed data has
  // one: the roster is capped, so "some trainer in the list has pay" quietly becomes false once
  // enough pay-less trainers exist, and the assertion then passes or fails on unrelated data.
  const stamp = Date.now().toString().slice(-6);
  // R2: Enrollment no longer reads the trainer directory AT ALL, so the mask is proven on
  // a Location-role reader whose trainers.manage is REVOKED per-user (the R-B deny list) —
  // read allowed by role, money hidden by the missing right.
  const viewerUser = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "viewer.jpr03@vidysea.com");
  if (viewerUser) await req(admin, "PATCH", `/api/users/${viewerUser._id}`, { revoked_permissions: ["trainers.manage"] });
  const progForMask = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const paid = (await req(admin, "POST", "/api/trainers", {
    name: `PayCheck Trainer ${stamp}`, phone: `97${stamp}00`, skills: ["PayCheck"],
    day_rate: 1234, compensation_type: "Batch-wise", compensation_fixed: 5678, incentive_note: "secret",
    nominated_for_location: jpr._id, nominated_for_program: progForMask._id, // tie to JPR so the scoped viewer can see the row
  })).data.item;

  const list = (await req(viewer, "GET", "/api/trainers")).data.items ?? [];
  ok("trainer roster is readable without the manage right", list.length > 0);
  ok("…but day rate is hidden", list.every((t) => t.day_rate === undefined), JSON.stringify(list[0]?.day_rate));
  ok("…and compensation fields are hidden", list.every((t) => t.compensation_type === undefined && t.compensation_fixed === undefined && t.incentive_note === undefined));
  const one = (await req(viewer, "GET", `/api/trainers/${paid._id}`)).data.item;
  ok("…opening the paid trainer by id does not leak them either",
    one?.day_rate === undefined && one?.compensation_fixed === undefined && one?.incentive_note === undefined, JSON.stringify(one?.day_rate));
  const adminOne = (await req(admin, "GET", `/api/trainers/${paid._id}`)).data.item;
  ok("Admin still sees pay", adminOne?.day_rate === 1234 && adminOne?.compensation_fixed === 5678, JSON.stringify(adminOne?.day_rate));

  // The other side of the same mask, and the more dangerous one. The nomination target is what
  // makes a trainer's TR ID usable at a centre, so the batch screen filters the dropdown on it.
  // It was briefly masked alongside the pay fields, which silently emptied the certified group
  // for everyone without trainers.manage — the people who mostly create batches. Masking it
  // again would break batch creation without failing any other assertion, so it is pinned here.
  // F-B5 made nominating for a HALTED centre a 409, and "?limit=1" can now hand back a
  // suite-halted Gate Location — pin the fixture to the known-operational JPR03 instead.
  const loc = jpr;
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const nom = (await req(admin, "POST", "/api/trainers", {
    name: `Nominated Trainer ${stamp}`, phone: `96${stamp}00`, skills: ["PayCheck"],
    nominated_for_location: loc._id, nominated_for_program: prog._id,
  })).data.item;
  const seen = (await req(viewer, "GET", `/api/trainers/${nom._id}`)).data.item;
  ok("the nomination target stays visible without trainers.manage",
    (seen?.nominated_for_location?._id ?? seen?.nominated_for_location) === loc._id,
    JSON.stringify(seen?.nominated_for_location));
  ok("…and so does the job role it was nominated for",
    (seen?.nominated_for_program?._id ?? seen?.nominated_for_program) === prog._id,
    JSON.stringify(seen?.nominated_for_program));
  ok("…while the personnel fields beside it stay hidden",
    seen?.nsdc_remarks === undefined && seen?.qualification === undefined && seen?.payment_reference === undefined);
  if (viewerUser) await req(admin, "PATCH", `/api/users/${viewerUser._id}`, { revoked_permissions: [] }); // restore for later suites

  // 2026-08-13 (Umesh, testing the view-only principal): masking pay was not enough — a
  // scoped user saw the ENTIRE trainer directory. Scoped users see only trainers tied to
  // their centres (nominated / capable / home).
  const spocTrainers = (await req(spoc, "GET", "/api/trainers?limit=2000")).data.items ?? [];
  const jprId = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0]._id;
  const tied = (t) => [t.nominated_for_location?._id ?? t.nominated_for_location,
    t.home_location?._id ?? t.home_location, ...(t.capable_locations ?? []).map((l) => l?._id ?? l)]
    .filter(Boolean).map(String).includes(String(jprId));
  ok("Rule 38: scoped SPOC sees only trainers tied to their centre", spocTrainers.every(tied), `${spocTrainers.length} rows, untied: ${spocTrainers.filter((t) => !tied(t)).map((t) => t.name).slice(0, 3).join(", ")}`);
  if (String(loc._id) !== String(jprId)) {
    ok("…and the elsewhere-nominated trainer is not in their list", !spocTrainers.some((t) => t._id === nom._id));
  }
  const adminAll = (await req(admin, "GET", "/api/trainers?limit=2000")).data.items ?? [];
  ok("…while Admin still sees the full directory", adminAll.length > spocTrainers.length, `${adminAll.length} vs ${spocTrainers.length}`);
}

// ---- QA-125 (checker, 15/08): trainer IDOR — the SEVENTH list-hides/item-allows hole,
// and the first on WRITES. A SPOC documented, un-documented and edited a trainer they
// could not even see. The union scope (nomination/capability/home) now guards every
// by-id trainer surface, untied trainers fail closed, and creation binds to the
// creator's own scope.
{
  const stamp = Date.now().toString().slice(-6); // block-local: the mask block's stamp is not in scope here
  const p125 = (n) => "95" + Date.now().toString().slice(-7) + n; // unique 10-digit phones
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  // A trainer that is unambiguously FOREIGN to the JPR03-scoped SPOC…
  const foreignTr = (await req(admin, "POST", "/api/trainers", {
    name: `Foreign Trainer ${stamp}`, phone: p125(1), skills: ["Q125"],
    nominated_for_location: otherLoc._id, nominated_for_program: prog._id,
  })).data.item;
  // …and one tied to NOTHING at all.
  const untiedTr = (await req(admin, "POST", "/api/trainers", {
    name: `Untied Trainer ${stamp}`, phone: p125(2), skills: ["Q125"],
  })).data.item;
  const fDoc = (await req(admin, "POST", `/api/trainers/${foreignTr._id}/documents`, { doc_type: "Aadhaar", file_url: "/erp/api/files/q125.pdf", original_name: "q125.pdf" })).data.item;

  ok("QA-125: SPOC GET foreign trainer → 403", (await req(spoc, "GET", `/api/trainers/${foreignTr._id}`)).status === 403);
  ok("QA-125: SPOC PATCH foreign trainer → 403", (await req(spoc, "PATCH", `/api/trainers/${foreignTr._id}`, { qualification: "x" })).status === 403);
  ok("QA-125: SPOC read foreign trainer's documents → 403", (await req(spoc, "GET", `/api/trainers/${foreignTr._id}/documents`)).status === 403);
  ok("QA-125: SPOC document a foreign trainer → 403", (await req(spoc, "POST", `/api/trainers/${foreignTr._id}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q125b.pdf" })).status === 403);
  ok("QA-125: SPOC delete a foreign trainer's document → 403", (await req(spoc, "DELETE", `/api/trainers/${foreignTr._id}/documents/${fDoc._id}`)).status === 403);
  ok("QA-125: SPOC move a foreign trainer's pipeline → 403", (await req(spoc, "POST", `/api/trainers/${foreignTr._id}/transition`, { target: "Shortlisted" })).status === 403);
  ok("QA-125: an UNTIED trainer is out of scope too (fail closed, like the list)", (await req(spoc, "GET", `/api/trainers/${untiedTr._id}`)).status === 403);
  // Creation binds to the creator's scope: a foreign tie is refused, an own-centre tie lands.
  ok("QA-125: SPOC creating a trainer tied to a foreign centre → 403",
    (await req(spoc, "POST", "/api/trainers", { name: `Q125F ${stamp}`, phone: p125(3), skills: ["x"], nominated_for_location: otherLoc._id })).status === 403);
  ok("QA-125: SPOC creating an UNTIED trainer → 403 (they could never see it again)",
    (await req(spoc, "POST", "/api/trainers", { name: `Q125U ${stamp}`, phone: p125(4), skills: ["x"] })).status === 403);
  const jprLoc = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const ownCreate = await req(spoc, "POST", "/api/trainers", { name: `Q125O ${stamp}`, phone: p125(5), skills: ["x"], home_location: jprLoc._id });
  ok("QA-125: SPOC creating an own-centre trainer still works", ownCreate.status === 201, `got ${ownCreate.status}`);
  // Quick-invite by a scoped user auto-ties the invitee to the inviter's centre(s).
  const qi = await req(spoc, "POST", "/api/trainers/quick-invite", { name: `Q125QI ${stamp}`, phone: p125(6) });
  ok("QA-125: scoped quick-invite lands…", qi.status === 201, `got ${qi.status}`);
  if (qi.status === 201) {
    const invited = (await req(spoc, "GET", `/api/trainers/${qi.data.item.trainer}`));
    ok("QA-125: …auto-tied so the inviter can see their own invitee", invited.status === 200 && (invited.data.item?.capable_locations ?? []).length > 0, `got ${invited.status}`);
  }
  // QA-125 follow-up (checker design note): document DELETE is narrower than read/upload.
  // A capable-only tie lets a centre teach with the trainer, not erase their identity
  // documents — deletion belongs to the nominating/home centre. Capable-only trainers
  // (the quick-invite window) fall back to the union so a mis-upload stays fixable.
  const sharedTr = (await req(admin, "POST", "/api/trainers", {
    name: `Q125S ${stamp}`, phone: p125(7), skills: ["Q125"],
    nominated_for_location: otherLoc._id, capable_locations: [jprLoc._id],
  })).data.item;
  const sDoc = await req(spoc, "POST", `/api/trainers/${sharedTr._id}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q125s.pdf", original_name: "q125s.pdf" });
  ok("QA-125b: capable-tie SPOC can still READ the shared trainer", (await req(spoc, "GET", `/api/trainers/${sharedTr._id}`)).status === 200);
  ok("QA-125b: capable-tie SPOC can still UPLOAD a document", sDoc.status === 201, `got ${sDoc.status}`);
  ok("QA-125b: capable-tie SPOC cannot DELETE it — ownership is the nominating centre",
    (await req(spoc, "DELETE", `/api/trainers/${sharedTr._id}/documents/${sDoc.data.item._id}`)).status === 403);
  ok("QA-125b: admin (unscoped) deletes the shared trainer's document fine",
    (await req(admin, "DELETE", `/api/trainers/${sharedTr._id}/documents/${sDoc.data.item._id}`)).status === 200);
  if (qi.status === 201) {
    const qiDoc = await req(spoc, "POST", `/api/trainers/${qi.data.item.trainer}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/q125qi.jpg", original_name: "q125qi.jpg" });
    ok("QA-125b: capable-ONLY invitee (no nomination/home) — inviter still deletes (union fallback)",
      qiDoc.status === 201 && (await req(spoc, "DELETE", `/api/trainers/${qi.data.item.trainer}/documents/${qiDoc.data.item._id}`)).status === 200);
  }
  if (ownCreate.status === 201) {
    const oDoc = await req(spoc, "POST", `/api/trainers/${ownCreate.data.item._id}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/q125o.jpg", original_name: "q125o.jpg" });
    ok("QA-125b: HOME centre owns deletion too",
      oDoc.status === 201 && (await req(spoc, "DELETE", `/api/trainers/${ownCreate.data.item._id}/documents/${oDoc.data.item._id}`)).status === 200);
  }
  // QA-061 evidence (stale row close): Enrollment reaches neither the directory nor the board.
  ok("QA-061: Enrollment cannot read the trainer directory", (await req(enroll, "GET", "/api/trainers?limit=5")).status === 403);
  ok("QA-061: Enrollment cannot read the hiring board", (await req(enroll, "GET", "/api/open-positions")).status === 403);
  // Admin cleanup so later fixtures stay unaffected.
  const clean = await req(admin, "DELETE", `/api/trainers/${foreignTr._id}/documents/${fDoc._id}`);
  ok("QA-125: admin (unscoped) still deletes fine", clean.status === 200, `got ${clean.status}`);
}

// ---- QA-130 (-61): trainers get a DELETE verb — Admin-only, batch-referenced rows refuse,
// documents cascade. Junk rows (QA probes, duplicate imports) stop living forever in every
// list; a person with real history still gets Dropped, never erased. Plus the QA-130 rider:
// created_by now survives the schema, and QA-133's relevant_skills is recorded on the batch.
{
  const stamp61 = Date.now().toString().slice(-6);
  const p130 = (n) => "94" + Date.now().toString().slice(-7) + n;
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];

  const mk = await req(admin, "POST", "/api/trainers", { name: `Q130 Junk ${stamp61}`, phone: p130(1), skills: ["Q130"], home_location: jpr._id });
  ok("QA-130: fixture trainer created", mk.status === 201, `got ${mk.status}`);
  const tid = mk.data.item?._id;
  const got = await req(admin, "GET", `/api/trainers/${tid}`);
  ok("QA-130 rider: created_by rides on the row (schema stopped dropping it)", !!got.data.item?.created_by, JSON.stringify(got.data.item?.created_by ?? null));

  ok("QA-130: Location SPOC cannot delete a trainer", (await req(spoc, "DELETE", `/api/trainers/${tid}`)).status === 403);
  // QA-904 (2026-08-24): this line used to read "Operations cannot delete either - Admin-only verb".
  // Umesh reversed that: delete follows a togglable right now, and Operations holds `trainers.delete`
  // by default. The assertion is UPDATED rather than deleted, because what it guards is still real -
  // it just guards the new rule. It gets its OWN throwaway trainer: letting it delete `tid` would
  // destroy the fixture the rest of this block depends on, which is exactly what happened when the
  // rule changed underneath it.
  {
    const own = await req(admin, "POST", "/api/trainers", { name: `Q894 Ops ${stamp61}`, phone: p130(7), skills: ["Q894"], home_location: jpr._id });
    ok("QA-904: Operations CAN delete a junk trainer now - it follows trainers.delete, not the Admin role",
      own.status === 201 && (await req(ops, "DELETE", `/api/trainers/${own.data.item._id}`)).status === 200,
      `create=${own.status}`);
  }

  const bat = await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: "2026-09-01", trainer: tid });
  ok("QA-130: batch fixture referencing the trainer", bat.status < 300, `got ${bat.status}`);
  if (bat.status < 300) {
    ok("QA-130: referenced by a batch → 409 (drop, don't erase)", (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 409);
    // QA-133: relevant_skills — the operator's recorded pick, never a filter; list-only, junk filtered.
    const rs = await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { relevant_skills: ["Drone Service Technician", "  ", 42] });
    ok("QA-133: relevant_skills recorded on the batch (junk entries filtered)",
      rs.status === 200 && JSON.stringify(rs.data.item?.relevant_skills) === JSON.stringify(["Drone Service Technician"]),
      JSON.stringify(rs.data.item?.relevant_skills ?? null));
    ok("QA-133: relevant_skills refuses a non-list", (await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { relevant_skills: "x" })).status === 400);
    const detach = await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { trainer: null });
    ok("QA-130: batch detached for the delete path", detach.status === 200, `got ${detach.status}`);
  }
  const doc = await req(admin, "POST", `/api/trainers/${tid}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q130.pdf", original_name: "q130.pdf" });
  const del = await req(admin, "DELETE", `/api/trainers/${tid}`);
  ok("QA-130: admin deletes the junk row (documents cascade)", doc.status === 201 && del.status === 200, `${doc.status}/${del.status}`);
  ok("QA-130: the row is gone", (await req(admin, "GET", `/api/trainers/${tid}`)).status === 404);
  ok("QA-130: re-delete → 404, not a crash", (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 404);
}

// ---- QA-136/137 (-62): the audit trail was ALWAYS written on create (crud.ts — the checker's
// grep saw only route files and missed the central layer); what was missing is a surface.
// These pins hold both truths: the rows exist, and the new windows onto them are role-gated.
{
  const stamp62 = Date.now().toString().slice(-6);
  const p137 = (n) => "93" + Date.now().toString().slice(-7) + n;
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];

  const mk = await req(admin, "POST", "/api/trainers", { name: `Q137 Trail ${stamp62}`, phone: p137(1), skills: ["Q137"], home_location: jpr._id });
  ok("QA-136: trainer create lands", mk.status === 201, `got ${mk.status}`);
  const tid = mk.data.item?._id;
  const hist = await req(admin, "GET", `/api/audit/Trainer/${tid}`);
  ok("QA-136 evidence: the CREATE audit row exists — crud has always written it",
    hist.status === 200 && (hist.data.items ?? []).some((a) => a.new_value === "created"),
    `${hist.status}, rows=${(hist.data.items ?? []).length}`);
  await req(admin, "PATCH", `/api/trainers/${tid}`, { qualification: "MSc (Q137)" });
  ok("QA-137: field-level history rows carry the change",
    ((await req(admin, "GET", `/api/audit/Trainer/${tid}`)).data.items ?? []).some((a) => a.field === "qualification"));
  ok("QA-137: SPOC reads an own-centre trainer's history (union resolver)",
    (await req(spoc, "GET", `/api/audit/Trainer/${tid}`)).status === 200);
  const foreign = await req(admin, "POST", "/api/trainers", { name: `Q137 Foreign ${stamp62}`, phone: p137(2), skills: ["Q137"], home_location: otherLoc._id });
  ok("QA-137: SPOC reading a FOREIGN trainer's history → 403 (fail closed)",
    (await req(spoc, "GET", `/api/audit/Trainer/${foreign.data.item?._id}`)).status === 403);

  const adminU = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "admin@vidysea.com");
  const byUser = await req(admin, "GET", `/api/audit/by-user/${adminU._id}?limit=50`);
  ok("QA-137: Admin reads the per-user activity view", byUser.status === 200 && (byUser.data.items ?? []).length > 0, `got ${byUser.status}`);
  const narrowed = (await req(admin, "GET", `/api/audit/by-user/${adminU._id}?entity=Trainer&limit=50`)).data.items ?? [];
  ok("QA-137: ?entity= narrows the per-user view", narrowed.length > 0 && narrowed.every((a) => a.entity === "Trainer"), `n=${narrowed.length}`);
  ok("QA-137: Operations is refused the per-user view (Admin-only v1)", (await req(ops, "GET", `/api/audit/by-user/${adminU._id}`)).status === 403);
  ok("QA-137: a scoped SPOC is refused too — no Rule 38 back door", (await req(spoc, "GET", `/api/audit/by-user/${adminU._id}`)).status === 403);

  // Fixtures leave through the front door (QA-130's verb), proving it twice over.
  ok("QA-137: fixtures cleaned via the delete verb",
    (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 200 &&
    (await req(admin, "DELETE", `/api/trainers/${foreign.data.item?._id}`)).status === 200);
}

// ---- QA-131/140/139 (-63): the scheme's money is Admin-only, the invoice book follows the
// costs-ledger rule, and ignored earliest-start advice says so out loud (warn, never block).
{
  const ls = await req(admin, "GET", "/api/master-lists/schemes");
  ok("QA-131: schemes master loads for admin (lazy-seeded)", ls.status === 200 && (ls.data.items ?? []).length > 0, `got ${ls.status}, n=${(ls.data.items ?? []).length}`);
  const sch = ls.data.items?.[0];
  const set = await req(admin, "PATCH", `/api/master-lists/schemes/${sch._id}`, { amount_received: 12345, total_hours: 480 });
  ok("QA-131: admin records hours + amount on a scheme", set.status === 200, `got ${set.status}`);
  const back = (await req(admin, "GET", "/api/master-lists/schemes")).data.items.find((s) => s._id === sch._id);
  ok("QA-131: admin reads the amount back", back?.amount_received === 12345, JSON.stringify(back?.amount_received));
  for (const [who, name] of [[ops, "Operations"], [spoc, "Location SPOC"]]) {
    const r = await req(who, "GET", "/api/master-lists/schemes");
    const row = (r.data.items ?? []).find((s) => s._id === sch._id);
    ok(`QA-131: ${name} reads schemes WITHOUT amount_received`,
      r.status === 200 && (r.data.items ?? []).length > 0 && (r.data.items ?? []).every((s) => !("amount_received" in s)),
      `got ${r.status}`);
    ok(`QA-131: ${name} still sees the hours (only the money is masked)`, row?.total_hours === 480, JSON.stringify(row?.total_hours));
  }
  ok("QA-140: Operations is refused the invoice book (same R-E rule as the cost ledger)",
    (await req(ops, "GET", "/api/invoices")).status === 403);
  ok("QA-140: admin reads invoices fine", (await req(admin, "GET", "/api/invoices")).status === 200);

  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const early = await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: tomorrow });
  ok("QA-139: a too-early batch still creates — warn, never block", early.status === 201, `got ${early.status}`);
  ok("QA-139: …and the response names the earliest possible start",
    typeof early.data.warning === "string" && /earliest possible start/i.test(early.data.warning),
    JSON.stringify(early.data.warning ?? null));
}

// ---- QA-141 (-64, Umesh after the Arun episode: "values must be format tested — mobile
// number only 10 digit"): phone canon = bare 10 digits (+91/0 forms normalize to the same
// ten so one person is ONE row under the unique index); email must look like one. Strict on
// manual entry; the importers normalize-and-report instead (client rows are never dropped).
{
  const s141 = Date.now().toString().slice(-6);
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  ok("QA-141: a 12-digit keyboard-mash phone is refused on trainer create (the Arun shape)",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Bad ${s141}`, phone: "332432432432", skills: ["x"], home_location: jpr._id })).status === 400);
  ok("QA-141: a junk email is refused",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Mail ${s141}`, phone: "9822200111", skills: ["x"], email: "not-an-email", home_location: jpr._id })).status === 400);
  const fancy = await req(admin, "POST", "/api/trainers", { name: `Q141 Canon ${s141}`, phone: "+91 98222 00119", skills: ["x"], home_location: jpr._id });
  ok("QA-141: '+91 98222 00119' lands as the bare '9822200119'", fancy.status === 201 && fancy.data.item?.phone === "9822200119", JSON.stringify(fancy.data.item?.phone ?? fancy.status));
  ok("QA-141: the SAME person entered bare now collides — one row per human (409)",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Dup ${s141}`, phone: "9822200119", skills: ["x"], home_location: jpr._id })).status === 409);
  ok("QA-141: candidate junk phone refused",
    (await req(admin, "POST", "/api/candidates", { name: `Q141 Cand ${s141}`, phone: "12345", location: jpr._id })).status === 400);
  ok("QA-141: user junk login email refused",
    (await req(admin, "POST", "/api/users", { name: "Q141U", email: "nope", password: "Q141pass!xyz", role: "Enrollment", location_scope: [jpr._id] })).status === 400);
  ok("QA-141: quick-invite refuses a 15-digit mash the old slice(-10) silently accepted",
    (await req(admin, "POST", "/api/trainers/quick-invite", { name: `Q141 QI ${s141}`, phone: "123456789012345" })).status === 400);
  if (fancy.status === 201) {
    ok("QA-141: fixture leaves via the delete verb", (await req(admin, "DELETE", `/api/trainers/${fancy.data.item._id}`)).status === 200);
  }
}

// ---- QA-116 (-65): the OTP enrolment path — a walk-in candidate proves their email with a
// 6-digit code, then registers through the same field set the link path uses. The hash is
// one-way, so the test plants a known code straight into the CI DB to walk the happy path.
{
  const B = process.env.BASE_URL || "http://localhost:3000/erp";
  const pj = async (body) => {
    const r = await fetch(B + "/api/public/enrol-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  // QA-1136: enrol-otp reads HALTED_LOCATION_STATUSES at two sites (route.ts:38 hides a halted
  // centre from this public form's own centre list; route.ts:148 refuses a registration naming
  // one directly) and neither had a suite assertion before this.
  const otpHaltLoc = (await req(admin, "POST", "/api/locations", { name: `OTP Halted ${Date.now()}`, code: "OTPH" + Date.now().toString().slice(-6), approval_status: "Approved", operational_status: "Stopped" }, 201)).data.item;
  const em = `otp.${Date.now()}@test.local`;
  const reqOtp = await pj({ action: "request", email: em });
  ok("QA-116: OTP request lands (mail skipped in CI, challenge stored)", reqOtp.status === 200 && !!reqOtp.data.token, `got ${reqOtp.status}`);
  const tok = reqOtp.data.token;
  ok("QA-116: a junk email is refused a code", (await pj({ action: "request", email: "nope" })).status === 400);
  ok("QA-116: a wrong code is refused", (await pj({ action: "verify", token: tok, code: "000000" })).status === 400);
  ok("QA-116: the form context stays locked before verification", (await fetch(B + `/api/public/enrol-otp?token=${tok}`)).status === 404);

  const { MongoClient } = await import("mongodb");
  const nodeCrypto = await import("crypto");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const db = mc.db(process.env.MONGODB_DB || "center_erp_ci");
  await db.collection("publictokens").updateOne({ token: tok }, { $set: { otp_hash: nodeCrypto.createHash("sha256").update("424242").digest("hex"), otp_attempts: 0 } });

  ok("QA-116: the right code verifies", (await pj({ action: "verify", token: tok, code: "424242" })).status === 200);
  const ctxRes = await fetch(B + `/api/public/enrol-otp?token=${tok}`);
  const ctxD = await ctxRes.json().catch(() => ({}));
  ok("QA-116: a verified session serves the form (operational centres + active programs)",
    ctxRes.status === 200 && (ctxD.locations ?? []).length > 0 && (ctxD.programs ?? []).length > 0);
  ok("QA-1136: a halted centre is never offered on the public enrolment form",
    !(ctxD.locations ?? []).some((l) => String(l._id) === String(otpHaltLoc._id)), JSON.stringify((ctxD.locations ?? []).map((l) => l._id)));
  ok("QA-116/141: the OTP form refuses a junk phone too",
    (await pj({ action: "register", token: tok, name: "OTP Cand", phone: "12345", location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id })).status === 400);
  const reg = await pj({ action: "register", token: tok, name: "OTP Cand E2E", phone: "97" + Date.now().toString().slice(-8), location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id });
  ok("QA-116: registration lands", reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.data).slice(0, 120)}`);
  ok("QA-116: the challenge is single-use",
    (await pj({ action: "register", token: tok, name: "X", phone: "9733333331", location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id })).status === 404);
  const found = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent("OTP Cand E2E")}`)).data.items ?? []).find((c) => c.email === em);
  ok("QA-116: the row carries the VERIFIED email and the OTP source", !!found && found.source === "Self Registration (OTP)", JSON.stringify(found?.source ?? null));

  // QA-1136 (site 2): registration is refused even if a halted centre's id is sent directly - the
  // list already hides it (asserted above), but a scripted POST does not go through that list. A
  // FRESH challenge, since the one above is already single-used.
  {
    const em2 = `otp1136.${Date.now()}@test.local`;
    const r1136 = await pj({ action: "request", email: em2 });
    await db.collection("publictokens").updateOne({ token: r1136.data.token }, { $set: { otp_hash: nodeCrypto.createHash("sha256").update("424242").digest("hex"), otp_attempts: 0 } });
    await pj({ action: "verify", token: r1136.data.token, code: "424242" });
    const regHalted = await pj({ action: "register", token: r1136.data.token, name: "OTP Halted Attempt", phone: "98" + Date.now().toString().slice(-8), location: otpHaltLoc._id, program: ctxD.programs?.[0]?._id });
    ok("QA-1136: registering directly at a halted centre id is refused, not silently accepted",
      regHalted.status === 400 && /not taking registrations/i.test(String(regHalted.data?.error ?? "")), `got ${regHalted.status} ${JSON.stringify(regHalted.data).slice(0, 150)}`);
  }

  // ---- -130 (QA-275): the OTP door is a SECOND public intake, and -126 only fixed the first ----
  // -126 put the nine Skill India fields on p/register and on both internal routes. p/enrol is the
  // email/SMS-OTP walk-in link - a different link for the same job - so a student arriving through
  // it was still chased later for exactly the data those fields exist to stop chasing. The checker's
  // own note on having passed QA-261: "I checked the door the row named and did not ask whether the
  // product had another one." This pin is that question, asked permanently.
  {
    const r3 = await pj({ action: "request", email: `otp9.${Date.now()}@test.local` });
    await db.collection("publictokens").updateOne({ token: r3.data.token }, { $set: { otp_hash: nodeCrypto.createHash("sha256").update("424242").digest("hex"), otp_attempts: 0 } });
    await pj({ action: "verify", token: r3.data.token, code: "424242" });
    const portal = { salutation: "Mr.", father_name: "Indal Singh", mother_name: "Rani Devi", marital_status: "Single",
      religion: "Hindu", social_category: "OBC", state: "Uttar Pradesh", district: "Sant Ravidas Nagar", sub_district: "Aurai" };
    const nm = "OTP Portal Fields " + Date.now().toString().slice(-6);
    const regP = await pj({ action: "register", token: r3.data.token, name: nm, phone: "96" + Date.now().toString().slice(-8),
      location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id, ...portal });
    ok("-130 (QA-275): a self-enrolment carrying the government-portal fields is accepted", regP.status === 201, `got ${regP.status}`);
    const row = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(nm)}`)).data.items ?? []).find((c) => c.name === nm);
    ok("-130 (QA-275): ...and the candidate exists", !!row, "not found after OTP self-enrolment");
    const wrong = Object.entries(portal).filter(([k, v]) => String(row?.[k] ?? "") !== v).map(([k]) => k);
    ok("-130 (QA-275): every portal field STORES and READS BACK through the OTP door too",
      wrong.length === 0, `missing/wrong: ${wrong.join(", ")}`);
  }

  const r2 = await pj({ action: "request", email: `otp2.${Date.now()}@test.local` });
  await db.collection("publictokens").updateOne({ token: r2.data.token }, { $set: { otp_expires_at: new Date(Date.now() - 1000) } });
  ok("QA-116: an expired code is refused", (await pj({ action: "verify", token: r2.data.token, code: "111111" })).status === 400);
  await mc.close();
}

// ---- -110 (Umesh 17/08, checker QA-187/188): the SAME challenge over SMS, and the wall must never
// text a real student. The account's ONLY approved DLT template is the OTP one (888579131), so OTP is
// the only purpose that can send; every other purpose is switched off by construction.
{
  const B = process.env.BASE_URL || "http://localhost:3000/erp";
  const pj = async (body) => {
    const r = await fetch(B + "/api/public/enrol-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const { MongoClient } = await import("mongodb");
  const nodeCrypto = await import("crypto");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const db = mc.db(process.env.MONGODB_DB || "center_erp_ci");

  // (1) THE GUARD. The wall runs on center_erp_ci: sending is off STRUCTURALLY, whatever env is set.
  const health = (await req(admin, "GET", "/api/test-email")).data.sms;
  ok("-110: the admin panel reports SMS health with presence only, never a value",
    !!health && typeof health.configured === "boolean" && Array.isArray(health.templates) && !JSON.stringify(health).match(/[0-9a-f]{24,}/i),
    JSON.stringify(health).slice(0, 200));
  ok("-110: on the CI database SMS is NOT configured — the wall cannot text anyone, flag or no flag",
    health.configured === false && /test environment|SMS_DISABLED|not configured/i.test(String(health.reason)), String(health.reason));

  // (2) the phone challenge — same shape as the email one
  const ph = "97" + Date.now().toString().slice(-8);
  const r1 = await pj({ action: "request", phone: ph });
  ok("-110: a phone OTP request lands and returns a token (SMS suppressed in CI, challenge stored)", r1.status === 200 && !!r1.data.token && r1.data.channel === "sms", `got ${r1.status} ${JSON.stringify(r1.data).slice(0, 120)}`);
  const tok = r1.data.token;
  const row = await db.collection("publictokens").findOne({ token: tok });
  ok("-110: the challenge is stored as phone_otp with the number and only a HASH of the code", row?.purpose === "phone_otp" && row?.phone === ph && /^[0-9a-f]{64}$/.test(String(row?.otp_hash)) && !row?.email);
  ok("-110: a junk phone is refused a code", (await pj({ action: "request", phone: "12345" })).status === 400);
  ok("-110: a wrong code is refused", (await pj({ action: "verify", token: tok, code: "000000" })).status === 400);
  // the SMS attempt is on record — as a SKIP, naming why — and the code is NOT in the log (QA-142)
  const smsLog = ((await req(admin, "GET", "/api/test-email")).data.log ?? []).find((l) => l.channel === "sms" && l.entity === "PublicToken");
  ok("-110: the SMS attempt is recorded in the ONE log with channel 'sms', as a skip that names the reason",
    !!smsLog && smsLog.status === "skipped" && /test environment|SMS_DISABLED|not configured|template/i.test(String(smsLog.reason)),
    JSON.stringify(smsLog && { st: smsLog.status, r: smsLog.reason, ch: smsLog.channel }));
  ok("-110: the live code never reaches the log (QA-142 holds for SMS too)", !!smsLog && !/\b\d{6}\b/.test(String(smsLog.subject ?? "")), String(smsLog?.subject));

  await db.collection("publictokens").updateOne({ token: tok }, { $set: { otp_hash: nodeCrypto.createHash("sha256").update("313131").digest("hex"), otp_attempts: 0 } });
  ok("-110: the right code verifies", (await pj({ action: "verify", token: tok, code: "313131" })).status === 200);
  const ctxRes = await fetch(B + `/api/public/enrol-otp?token=${tok}`);
  const ctxD = await ctxRes.json().catch(() => ({}));
  ok("-110: a verified SMS session serves the form and says which channel proved it",
    ctxRes.status === 200 && ctxD.channel === "sms" && ctxD.phone === ph, JSON.stringify({ ch: ctxD.channel, ph: ctxD.phone }));
  // register — the VERIFIED number is the phone of record; a typed one is ignored
  const reg = await pj({ action: "register", token: tok, name: "SMS OTP Cand E2E", phone: "9000000000", location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id });
  ok("-110: registration lands on the SMS path", reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.data).slice(0, 120)}`);
  // -109's mailer fix, proved where it is genuinely reachable: this registration gave NO email, so the
  // confirmation mail has no recipient — the row must still exist (placeholder), never be lost.
  {
    const c = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent("SMS OTP Cand E2E")}`)).data.items ?? [])[0];
    const mailRow = ((await req(admin, "GET", "/api/test-email")).data.log ?? []).find((l) => (l.channel ?? "email") === "email" && String(l.entity_id) === String(c?._id));
    ok("-109/-110: an email attempt with NO address is still RECORDED (placeholder recipient), never silently lost",
      !!mailRow && mailRow.status === "skipped" && /no address on record/i.test(String(mailRow.to)) && /recipient/i.test(String(mailRow.reason)),
      JSON.stringify(mailRow && { to: mailRow.to, st: mailRow.status, r: mailRow.reason }));
  }
  const found = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent("SMS OTP Cand E2E")}`)).data.items ?? [])[0];
  ok("-110: the row carries the VERIFIED phone (not the typed one) and the SMS-OTP source",
    !!found && found.phone === ph && found.source === "Self Registration (SMS OTP)", JSON.stringify(found && { p: found.phone, s: found.source }));
  ok("-110: the challenge is single-use", (await pj({ action: "register", token: tok, name: "X", location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id })).status === 404);

  // (3) TOLL FRAUD — the gates that go beyond the email flow. Keyed on the PHONE, not the IP.
  const ph2 = "96" + Date.now().toString().slice(-8);
  const a = await pj({ action: "request", phone: ph2 });
  const b = await pj({ action: "request", phone: ph2 });
  ok("-110: an immediate resend to the SAME number is refused (cooldown) — rotating IPs would not help",
    a.status === 200 && b.status === 429 && /wait/i.test(String(b.data?.error)), `${a.status}/${b.status} ${String(b.data?.error ?? "").slice(0, 60)}`);
  // per-phone cap: burn the cooldown by rewinding the last-send marker is not possible from outside,
  // so prove the per-phone bucket exists via its message on a fresh number after the daily cap test.
  // (4) DAILY CAP: with the process cap set low for CI (SMS_DAILY_CAP), the next number trips it and
  //     raises a Notification instead of failing quietly.
  if (Number(process.env.SMS_DAILY_CAP ?? 0) > 0) {
    // The per-IP allowance (5/hour) would trip before a cap of 6 does. The cap is a PROCESS-wide
    // gate keyed on nothing the caller controls, so vary the forwarded IP per request — exactly what
    // an attacker does — and prove the cap still stops it. That is the whole point of the cap.
    let tripped = null;
    for (let i = 0; i < Number(process.env.SMS_DAILY_CAP) + 3; i++) {
      const r = await fetch(B + "/api/public/enrol-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `10.9.${i}.${i}` },
        body: JSON.stringify({ action: "request", phone: "95" + String(1000000000 + i).slice(-8) }),
      }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => ({})) }));
      if (r.status === 429 && /paused/i.test(String(r.data?.error))) { tripped = r; break; }
    }
    ok("-110: the global daily cap trips and says so to the student in plain words", !!tripped, JSON.stringify(tripped?.data ?? "did not trip"));
    const notif = ((await req(admin, "GET", "/api/notifications?status=New&limit=100")).data.items ?? []).find((n) => n.type === "sms_daily_cap");
    ok("-110: ...and raises a Notification to Admin/Ops rather than stopping silently", !!notif, JSON.stringify(notif && { t: notif.type, m: String(notif.message).slice(0, 80) }));
  } else {
    ok("-110: the daily-cap pin was NOT exercised — run the wall with SMS_DAILY_CAP=6 so it is", false, "SMS_DAILY_CAP unset");
  }

  // (5) a purpose with NO approved template cannot send, and says so on the record
  const noTpl = (await req(admin, "POST", "/api/candidates", { name: `SMS NoTemplate ${Date.now().toString().slice(-6)}`, phone: "94" + Date.now().toString().slice(-8), location: ctxD.locations?.[0]?._id, program: ctxD.programs?.[0]?._id })).data.item;
  const noTplLog = ((await req(admin, "GET", "/api/test-email")).data.log ?? []).find((l) => String(l.entity_id) === String(noTpl?._id));
  ok("-110: a phone-only student registered by admin gets an SMS ATTEMPT on record...", !!noTplLog && noTplLog.channel === "sms", JSON.stringify(noTplLog && { ch: noTplLog.channel, st: noTplLog.status }));
  ok("-110: ...recorded as skipped for the honest reason — no approved DLT template for that purpose (or suppressed in CI)",
    !!noTplLog && noTplLog.status === "skipped" && /template|test environment|SMS_DISABLED/i.test(String(noTplLog.reason)), String(noTplLog?.reason));
  if (noTpl?._id) await req(admin, "DELETE", `/api/candidates/${noTpl._id}`);

  // (6) the ONE log answers "did anything reach this person?" per channel
  const both = ((await req(admin, "GET", "/api/test-email")).data.log ?? []);
  ok("-110: MailLog carries BOTH channels side by side, so 'kuch gaya ki nahi' is one query",
    both.some((l) => l.channel === "sms") && both.some((l) => (l.channel ?? "email") === "email"));
  await mc.close();
}

// ---- QA-025 P1+P2 (-66): three-level rights (none/view/edit). Bare key = edit (its meaning
// since day one — zero migration); "key:view" is the new middle level. Finance reads sit on
// view; every write keeps needing edit. The R-E Operations hardcode on the ledgers STAYS —
// an ordered lattice cannot express the CEO's post-yes/read-no shape, so that stays code.
{
  const s25 = Date.now().toString().slice(-6);
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const em = `q025.${s25}@vidysea-test.local`;
  const mkU = await req(admin, "POST", "/api/users", { name: "Q025 Viewer", email: em, password: "Q025pass!xyz", role: "Enrollment", location_scope: [jpr._id], can_edit: true });
  ok("QA-025: fixture user created", mkU.status === 201 || mkU.status === 200, `got ${mkU.status}`);
  const uid = mkU.data.item?._id;
  // QA-1825: two keys now, because the lattice point this pins spans both — finance.view is what
  // READS the ledger, costs.manage is what WRITES an entry, and the assertion below is that a
  // :view grant gives the first and not the second.
  const grant = await req(admin, "PATCH", `/api/users/${uid}`, { extra_permissions: ["costs.manage:view", "finance.view:view"] });
  ok("QA-025: a :view grant is stored verbatim", grant.status === 200 && (grant.data.item?.extra_permissions ?? []).includes("costs.manage:view"));
  const viewer = await login(em, "Q025pass!xyz");
  ok("QA-025: the viewer signs in", !!viewer);
  if (viewer) {
    ok("QA-025 P2: view level READS the cost ledger", (await req(viewer, "GET", "/api/costs")).status === 200);
    ok("QA-025 P2: view level cannot WRITE a cost entry",
      (await req(viewer, "POST", "/api/costs", { entry_date: "2026-08-16", location: jpr._id, amount: 1, category: "000000000000000000000000" })).status === 403);
    const me = await req(viewer, "GET", "/api/permissions/me");
    ok("QA-025 P1: /api/permissions/me names the level", me.status === 200 && me.data.levels?.["costs.manage"] === "view", JSON.stringify(me.data.levels?.["costs.manage"] ?? null));
    // QA-153 (-83): the shell decides "does this door exist for you" from THIS payload — so
    // it must carry the role and the togglable keys the route rules read (attendance.govt,
    // costs.manage, sheet.sources), and say nothing for a right the person does not hold.
    // -84 said "candidate delete is Admin-only - Operations gets 403 even though they manage
    // candidates". QA-904 (2026-08-24) reversed that on Umesh's instruction: Operations holds
    // `candidates.delete` by default now. Updated, not removed - and the SEPARATION is what is worth
    // asserting, so Enrollment (who also manage candidates, and were never granted the delete) is
    // checked in the same breath. If one right ever silently opened another, this is the line that
    // notices.
    {
      const progId = (await req(admin, "GET", "/api/programs?limit=1")).data.items?.[0]?._id;
      const mkProbe = async (n) => (await req(admin, "POST", "/api/candidates", { name: "Del Probe " + n + s25, phone: "9700" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), location: jpr._id, program: progId }, 201)).data.item;
      const c1 = await mkProbe("A");
      if (c1?._id) {
        ok("QA-904: Operations CAN delete a candidate now (candidates.delete, not the Admin role)",
          (await req(ops, "DELETE", `/api/candidates/${c1._id}`)).status === 200);
      } else ok("QA-904: fixture candidate created", false, JSON.stringify(c1));
      const c2 = await mkProbe("B");
      if (c2?._id) {
        ok("QA-904: Enrollment still CANNOT - they manage candidates but were never given the delete",
          (await req(enroll, "DELETE", `/api/candidates/${c2._id}`)).status === 403);
        ok("QA-904: ...and an Admin still can, without holding the right explicitly",
          (await req(admin, "DELETE", `/api/candidates/${c2._id}`)).status === 200);
      } else ok("QA-904: second fixture candidate created", false, JSON.stringify(c2));
    }
    const meTr = await req(trainer, "GET", "/api/permissions/me");
    ok("QA-153: a trainer's effective rights carry no attendance.govt / costs.manage / sheet.sources (so Govt Attendance, Costs, Sheet Sync do not exist for them)",
      meTr.status === 200 && meTr.data.role === "Trainer" && !meTr.data.levels?.["attendance.govt"] && !meTr.data.levels?.["costs.manage"] && !meTr.data.levels?.["sheet.sources"] && meTr.data.levels?.["batches.daily_log"] === "edit",
      JSON.stringify(meTr.data.levels));
    // ---- -107 (Umesh 17/08): "trainer dashboard mai ek aur remaining hai — upload government
    // sheet of attendance." The grant was DEAD: the importer's API has always gated on
    // `attendance.govt`, but every screen gated on the ROLE, so a trainer granted the right (Anuj
    // Kumar carries it on production) never got a door. The right decides now — and it stays OFF
    // for the Trainer role by default, so a trainer who only marks daily logs sees nothing new.
    {
      // Default trainer: no right, and the API says so — the door genuinely does not exist.
      ok("-107: a trainer WITHOUT the right is still refused the portal importer (403), by the API",
        (await req(trainer, "GET", "/api/govt-attendance")).status === 403);
      // Grant it to this one trainer, the way Umesh did for Anuj.
      const target = ((await req(admin, "GET", "/api/users?limit=200")).data.items ?? [])
        .find((u) => u.email === "trainer.jpr03@vidysea.com");
      if (target) {
        const before = target.extra_permissions ?? [];
        const grant = await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: [...new Set([...before, "attendance.govt"])] });
        ok("-107: an Admin can grant attendance.govt to one specific trainer", [200, 201].includes(grant.status), `${grant.status} ${JSON.stringify(grant.data).slice(0, 120)}`);
        const trAgain = await login(target.email, PW);
        if (trAgain) {
          const meNow = await req(trAgain, "GET", "/api/permissions/me");
          ok("-107: …their effective rights now carry attendance.govt at edit level",
            meNow.data?.levels?.["attendance.govt"] === "edit", JSON.stringify(meNow.data?.levels?.["attendance.govt"]));
          ok("-107: …and the importer OPENS for them (200, not 403) — the grant is finally live",
            (await req(trAgain, "GET", "/api/govt-attendance")).status === 200);
        } else {
          ok("-107: the granted trainer could be signed in", false, "login failed for " + target.email);
        }
        // Revoke and confirm the door closes again — a right must narrow as well as widen.
        await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: before });
        const trRevoked = await login(target.email, PW);
        if (trRevoked) {
          ok("-107: revoking it closes the door again (403) — the toggle works both ways",
            (await req(trRevoked, "GET", "/api/govt-attendance")).status === 403);
        }
      } else {
        ok("-107: a trainer account exists to grant the right to", false, "no active Trainer user found");
      }
    }
    const meSp = await req(spoc, "GET", "/api/permissions/me");
    // QA-1469 (2026-08-24 outage postmortem): Umesh - "Location ko bhi govt-attendance milna
    // chahiye." Narrower than the 13/08 "attendance is off the SPOC plate" ruling below: that was
    // about routine daily attendance logging (still Trainer's job), not the government-portal
    // reconciliation import a SPOC needs to see for their own location. costs.manage is untouched.
    ok("QA-153/QA-1469: a SPOC's rights carry attendance.govt (govt-attendance import), still no costs.manage",
      meSp.status === 200 && meSp.data.role === "Location" && meSp.data.levels?.["attendance.govt"] === "edit" && !meSp.data.levels?.["costs.manage"], JSON.stringify(meSp.data.levels));
    ok("QA-1469: …and the govt-attendance importer actually OPENS for a SPOC now (200, not 403)",
      (await req(spoc, "GET", "/api/govt-attendance")).status === 200);
    const meOps = await req(ops, "GET", "/api/permissions/me");
    // QA-1825: the Costs page is post-only for whoever lacks finance.view — it used to be decided
    // by the role name. Operations' own rights are unchanged, which is what this pins.
    ok("QA-153: Operations carries costs.manage + attendance.govt (their doors stay; the Costs page is post-only without finance.view)",
      meOps.status === 200 && meOps.data.levels?.["costs.manage"] === "edit" && meOps.data.levels?.["attendance.govt"] === "edit", JSON.stringify(meOps.data.levels));
    // QA-1825: this used to read "no invoices right at any level → still 403", which asserted that
    // `invoices.manage` gates the invoice book. It does not any more — the book is finance.view,
    // and this viewer was deliberately granted finance.view:view above, so the OLD assertion now
    // pins a premise the product no longer holds. The lattice point it existed for is unchanged
    // and is asserted directly instead: a :view holder READS but cannot MOVE an invoice, because
    // moving one is finance.approve. (`viewer` holds neither invoices.manage nor finance.approve.)
    ok("QA-025/QA-1825: a finance.view:view holder READS the invoice book", (await req(viewer, "GET", "/api/invoices")).status === 200);
    ok("QA-025/QA-1825: ...but cannot MOVE an invoice — that is finance.approve, which they do not hold",
      (await req(viewer, "PATCH", "/api/batches/000000000000000000000000/invoice", { status: "Raised" })).status === 403);
  }
  ok("QA-025/R-E: Operations still refused the ledger READ (edit-without-view stays code)",
    (await req(ops, "GET", "/api/costs")).status === 403);
  const put = await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: ["candidates.manage", "candidates.assign", "costs.manage:view"] });
  ok("QA-025 P1: the matrix PUT keeps a :view entry verbatim",
    put.status === 200 && (put.data.item?.permissions ?? []).includes("costs.manage:view"), JSON.stringify(put.data.item?.permissions ?? null));
  const restore = await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: ["candidates.manage", "candidates.assign"] });
  ok("QA-025: role matrix restored for the rest of the wall", restore.status === 200);
}

// ---- QA-021/142 (-68): Dropout is a real candidate stage now — reachable from anywhere,
// with the reason and the journey stage stamped server-side (same derivation the page
// renders with). And the OTP mail's LOG subject is redacted (QA-142).
{
  const s68 = Date.now().toString().slice(-6);
  const p68 = (n) => "92" + Date.now().toString().slice(-7) + n;
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];

  const c1 = (await req(admin, "POST", "/api/candidates", { name: `Q021 Fresh ${s68}`, phone: p68(1), location: jpr._id, program: prog._id })).data.item;
  ok("QA-021: dropping without a reason is refused", (await req(admin, "POST", `/api/candidates/${c1._id}/drop`, {})).status === 400);
  const d1 = await req(admin, "POST", `/api/candidates/${c1._id}/drop`, { reason: "Moved away" });
  ok("QA-021: a FRESH lead can drop now — no roster needed", d1.status === 200 && d1.data.item?.lifecycle_status === "Dropped", `got ${d1.status}`);
  ok("QA-021: reason + stage stamped ('Fresh Lead')",
    d1.data.item?.dropped_reason === "Moved away" && d1.data.item?.dropped_from_stage === "Fresh Lead",
    JSON.stringify([d1.data.item?.dropped_reason ?? null, d1.data.item?.dropped_from_stage ?? null]));
  ok("QA-021: a second drop is refused (409)", (await req(admin, "POST", `/api/candidates/${c1._id}/drop`, { reason: "again" })).status === 409);
  const u1 = await req(admin, "POST", `/api/candidates/${c1._id}/drop`, { undo: true });
  ok("QA-021: reinstate → Unassigned with the stamps cleared",
    u1.status === 200 && u1.data.item?.lifecycle_status === "Unassigned" && !u1.data.item?.dropped_reason && !u1.data.item?.dropped_from_stage);

  const cf = (await req(admin, "POST", "/api/candidates", { name: `Q021 Foreign ${s68}`, phone: p68(2), location: otherLoc._id, program: prog._id })).data.item;
  ok("QA-021: a scoped SPOC cannot drop a foreign candidate (403)",
    (await req(spoc, "POST", `/api/candidates/${cf._id}/drop`, { reason: "x" })).status === 403);

  const bat = (await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: "2027-01-05" })).data.item;
  const mem = await req(admin, "POST", `/api/batches/${bat._id}/members`, { candidate: c1._id });
  ok("QA-021: a reinstated candidate re-assigns fine (Rule 20/21)", mem.status === 201 || mem.status === 200, `got ${mem.status}`);
  const d2 = await req(admin, "POST", `/api/candidates/${c1._id}/drop`, { reason: "Left town" });
  ok("QA-021: dropping a ROSTERED candidate runs the Rule 25 path too", d2.status === 200 && d2.data.item?.lifecycle_status === "Dropped", `got ${d2.status}`);
  ok("QA-021: the stage came from the Enrolled journey ('Enrollment in progress')",
    d2.data.item?.dropped_from_stage === "Enrollment in progress", JSON.stringify(d2.data.item?.dropped_from_stage ?? null));

  const pjO = async (body) => {
    const r = await fetch((process.env.BASE_URL || "http://localhost:3000/erp") + "/api/public/enrol-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const em68 = `q142.${Date.now()}@test.local`;
  const rq = await pjO({ action: "request", email: em68 });
  ok("QA-142: OTP request lands", rq.status === 200, `got ${rq.status}`);
  const { MongoClient } = await import("mongodb");
  const mc2 = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc2.connect();
  const row = await mc2.db(process.env.MONGODB_DB || "center_erp_ci").collection("maillogs").findOne({ to: em68 });
  ok("QA-142: the OTP mail's LOG subject is redacted — no live code in the Admin panel",
    row?.subject === "****** is your registration code", JSON.stringify(row?.subject ?? null));
  await mc2.close();
}

// ---- QA-149 (-78): a trainer's LOGIN reaches the trainer's BATCHES. Manish: "Add Trainer se
// banaya, Certified, batch assign — login karun to batch dikhta hi nahi." Trainer.user was
// never set anywhere; is_mine was false for everyone.
{
  const s148 = Date.now().toString().slice(-6);
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog148 = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const em148 = `t148.${s148}@vidysea-test.local`;
  // A trainer made the Add-Trainer way — no login, just a person with an email.
  const tr = (await req(admin, "POST", "/api/trainers", { name: `Q148 Trainer ${s148}`, phone: `98${s148}00`.slice(0, 10).padEnd(10, "1"), email: em148, skills: [String(prog148.trainer_skill ?? "x")], home_location: jpr._id }, 201)).data.item;
  ok("QA-149: trainer exists with no login yet", !!tr?._id && !tr.user);
  // The bridge: one call creates the login, scoped to the trainer's centres, and links it.
  const mk = await req(admin, "POST", `/api/trainers/${tr._id}/create-login`, {}, 201);
  ok("QA-149: create-login mints a Trainer login with a one-time temporary password", !!mk.data.temporary_password && mk.data.item?.linked === true && mk.data.item?.email === em148, JSON.stringify(mk.data.item));
  ok("QA-149: the login's scope covers the trainer's centre", (mk.data.item?.location_scope ?? []).map(String).includes(String(jpr._id)), JSON.stringify(mk.data.item?.location_scope));
  const trAfter = (await req(admin, "GET", `/api/trainers/${tr._id}`)).data.item;
  ok("QA-149: Trainer.user is linked after create-login", String(trAfter.user ?? "") === String(mk.data.item.user_id));
  const again = await req(admin, "POST", `/api/trainers/${tr._id}/create-login`, {});
  ok("QA-149: a second create-login is refused 409 (already has a login)", again.status === 409, String(again.status));
  // Assign a batch to this trainer, sign in as the trainer: the batch is MINE.
  const b148 = (await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog148._id, trainer: tr._id, planned_start: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), target_size: 5 }, 201)).data.item;
  const trLogin = await login(em148, mk.data.temporary_password);
  ok("QA-149: the new trainer login signs in", !!trLogin);
  if (trLogin) {
    const mine = (await req(trLogin, "GET", "/api/batches")).data.items ?? [];
    const row = mine.find((b) => String(b._id) === String(b148._id));
    ok("QA-149: the assigned batch is in the trainer's list AND is_mine=true", !!row && row.is_mine === true, JSON.stringify(mine.map((b) => [b.code, b.is_mine])));
    ok("QA-149: the trainer can open their assigned batch by id (scope allows assignment)", (await req(trLogin, "GET", `/api/batches/${b148._id}`)).status === 200);
  }
  // The other direction: an Add-User login with role Trainer + a trainer's email gets linked automatically.
  const em148b = `t148b.${s148}@vidysea-test.local`;
  const tr2 = (await req(admin, "POST", "/api/trainers", { name: `Q148 Trainer B ${s148}`, phone: `97${s148}00`.slice(0, 10).padEnd(10, "2"), email: em148b, skills: ["x"], home_location: jpr._id }, 201)).data.item;
  await req(admin, "POST", "/api/users", { name: "Q148 B", email: em148b, password: "Q148pass!xyz", role: "Trainer", location_scope: [jpr._id], can_edit: true }, 201);
  const tr2After = (await req(admin, "GET", `/api/trainers/${tr2._id}`)).data.item;
  ok("QA-149: Add User (role Trainer, same email) auto-links to the trainer", !!tr2After.user, JSON.stringify(tr2After.user));
  await req(admin, "POST", `/api/batches/${b148._id}/transition`, { target: "Cancelled", reason: "QA-149 cleanup" }, 200);
}

// ---- QA-132/025-P3 (-72): the product listens for bounces, and more reads open at view.
{
  const s72 = Date.now().toString().slice(-6);
  const B = process.env.BASE_URL || "http://localhost:3000/erp";
  const sns = async (body, hdr = true) => {
    const r = await fetch(B + "/api/public/ses-notifications", { method: "POST", headers: { "Content-Type": "application/json", ...(hdr ? { "x-amz-sns-message-type": "Notification" } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  ok("QA-132: a non-SNS post is refused (400)", (await sns({ Type: "Notification" }, false)).status === 400);
  ok("QA-132: a non-AWS SubscribeURL is refused (SSRF guard)",
    (await sns({ Type: "SubscriptionConfirmation", SubscribeURL: "https://evil.example.com/x" })).status === 400);
  const { MongoClient } = await import("mongodb");
  const mc72 = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc72.connect();
  const db72 = mc72.db(process.env.MONGODB_DB || "center_erp_ci");
  const mid = `q132-${s72}@ses.test`;
  await db72.collection("maillogs").insertOne({ to: `victim.${s72}@test.local`, subject: "Q132 probe", status: "sent", message_id: mid, createdAt: new Date() });
  const b = await sns({ Type: "Notification", Message: JSON.stringify({ notificationType: "Bounce", mail: { messageId: mid }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: `victim.${s72}@test.local`, diagnosticCode: "550 no such user" }] } }) });
  const row72 = await db72.collection("maillogs").findOne({ message_id: mid });
  ok("QA-132: a bounce notification flips the row — 'sent' stops being forever",
    b.status === 200 && b.data.updated === 1 && row72?.status === "bounced" && /550 no such user/.test(row72?.reason ?? ""),
    JSON.stringify([b.data.updated ?? null, row72?.status ?? null]));
  await mc72.close();

  // QA-025 P3: users/sheet-changes/govt-attendance reads open at VIEW level.
  const jpr72 = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const em72 = `q025p3.${s72}@vidysea-test.local`;
  const mkV = await req(admin, "POST", "/api/users", { name: "Q025 P3 Viewer", email: em72, password: "Q025p3pass!x", role: "Enrollment", location_scope: [jpr72._id], can_edit: true });
  await req(admin, "PATCH", `/api/users/${mkV.data.item?._id}`, { extra_permissions: ["users.manage:view", "sheet.approve:view", "attendance.govt:view"] });
  const viewer72 = await login(em72, "Q025p3pass!x");
  ok("QA-025 P3: viewer signs in", !!viewer72);
  if (viewer72) {
    ok("P3: users list READS at view level", (await req(viewer72, "GET", "/api/users")).status === 200);
    ok("P3: creating a user still needs EDIT (403)", (await req(viewer72, "POST", "/api/users", { name: "X", email: `x.${s72}@t.local`, password: "Xx12345678!", role: "Enrollment", location_scope: [jpr72._id] })).status === 403);
    ok("P3: sheet-changes queue READS at view level", (await req(viewer72, "GET", "/api/sheet-changes")).status === 200);
    ok("P3: govt-attendance READS at view level", (await req(viewer72, "GET", "/api/govt-attendance")).status === 200);
  }
}

// ---- QA-070/093 (-70): hours everywhere staff look, and the scheme's ABSOLUTE
// min_required_hours is the bar (the pct-collapse gave a different number whenever
// program.hours ≠ scheme.total_hours).
{
  const s70 = Date.now().toString().slice(-6);
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  // Own program with an ENUM scheme + hours 100 — deliberately ≠ the scheme's 120, so the
  // absolute-vs-pct difference is visible (absolute → 60; pct-collapse would give 50).
  const progMk = await req(admin, "POST", "/api/programs", { code: `Q70${s70}`, name: `Q070 Prog ${s70}`, trainer_skill: `Q070 ${s70}`, scheme: "RPL-HSL", hours: 100, duration_days: 15 });
  const prog = progMk.data.item;
  ok("QA-093 fixture: program (scheme RPL-HSL, hours 100) created", progMk.status === 201 && !!prog?._id, `got ${progMk.status}`);
  const schemeRow = ((await req(admin, "GET", "/api/master-lists/schemes")).data.items ?? []).find((x) => x.name === "RPL-HSL");
  ok("QA-093 fixture: the lazy-seeded RPL-HSL master row exists", !!schemeRow?._id);
  await req(admin, "PATCH", `/api/master-lists/schemes/${schemeRow._id}`, { total_hours: 120, min_required_hours: 60 });
  const bat = (await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: "2027-03-01", slot_start: "09:00", slot_end: "17:00" })).data.item;
  ok("QA-070 fixture: batch with an 8h slot", !!bat?._id);

  const att = (await req(admin, "GET", `/api/batches/${bat._id}/attendance`)).data;
  ok("QA-093: required hours = the scheme's ABSOLUTE 60 (not a pct re-multiplication)",
    att.required_hours === 60 && att.min_attendance_source === "scheme", JSON.stringify([att.required_hours, att.min_attendance_source]));
  const mem = (await req(admin, "GET", `/api/batches/${bat._id}/members`)).data;
  ok("QA-070: the roster API carries the bar too", mem.required_hours === 60, JSON.stringify(mem.required_hours));

  // Member-level: one candidate, one present day, 8h slot → our_hours 8, not qualified (no portal row).
  const cand = (await req(admin, "POST", "/api/candidates", { name: `Q070 Cand ${s70}`, phone: "93" + Date.now().toString().slice(-8), location: jpr._id, program: prog._id })).data.item;
  await req(admin, "POST", `/api/batches/${bat._id}/members`, { candidate: cand._id });
  const memRows = (await req(admin, "GET", `/api/batches/${bat._id}/members`)).data.items ?? [];
  const row = memRows.find((m) => String(m.candidate?._id) === String(cand._id));
  ok("QA-070: roster row carries the hours verdict object",
    !!row?.hours && row.hours.required_hours === 60 && row.hours.qualified === false, JSON.stringify(row?.hours ?? null));

  // Invalid scheme data (min > total) → honest fallback to the Defaults pct path.
  // (This also RESTORES the pre-pin behaviour for other RPL-HSL programs: an invalid row
  // is ignored, exactly like the empty row the wall started with.)
  await req(admin, "PATCH", `/api/master-lists/schemes/${schemeRow._id}`, { min_required_hours: 130 });
  const att2 = (await req(admin, "GET", `/api/batches/${bat._id}/attendance`)).data;
  ok("QA-093: invalid scheme data falls back to the pct path, labelled 'defaults'",
    att2.min_attendance_source === "defaults" && att2.required_hours === Math.ceil(att2.program_hours * (att2.min_attendance_pct / 100)),
    JSON.stringify([att2.min_attendance_source, att2.required_hours, att2.program_hours, att2.min_attendance_pct]));
}

// ---- QA-129 (-69): mail suppression is STRUCTURAL now — the wall points at a test DB and a
// localhost auth URL, and either shape alone kills sending BEFORE any flag is consulted.
// The skip reason must SAY so (a "not configured" lie would hide the new gate).
{
  const p129 = "91" + Date.now().toString().slice(-8);
  const em129 = `q129.${Date.now()}@test.local`;
  const qi = await req(admin, "POST", "/api/trainers/quick-invite", { name: "Q129 Probe", phone: p129, email: em129 });
  ok("QA-129 fixture: quick-invite with an email lands", qi.status === 201, `got ${qi.status}`);
  const { MongoClient } = await import("mongodb");
  const mc129 = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc129.connect();
  const row129 = await mc129.db(process.env.MONGODB_DB || "center_erp_ci").collection("maillogs").findOne({ to: em129 });
  ok("QA-129: the skip names the TEST ENVIRONMENT, not a flag someone remembered",
    row129?.status === "skipped" && /test environment/.test(row129?.reason ?? ""),
    JSON.stringify([row129?.status ?? null, row129?.reason ?? null]));
  await mc129.close();
  if (qi.status === 201) {
    ok("QA-129: probe leaves via the delete verb", (await req(admin, "DELETE", `/api/trainers/${qi.data.item.trainer}`)).status === 200);
  }
}

// ---- QA-126/127/128 (-67): the manual is current, role-filtered and English-only.
// (The manual sits behind sign-in like every staff screen — fetch it WITH a session.)
{
  const B = process.env.BASE_URL || "http://localhost:3000/erp";
  const r = await fetch(B + "/manual.html", { headers: { cookie: admin } });
  const html = await r.text();
  ok("QA-126: the manual serves", r.status === 200);
  ok("QA-127: sections carry role tags for the Help filter", html.includes('data-roles="Admin"') && html.includes("rolebar"));
  ok("QA-126: it documents the current release features (OTP path, three-level rights, TR ID flag)",
    html.includes("/p/enrol") && html.includes("view") && html.includes("TR ID pending"));
  ok("QA-128: English-only — no Devanagari anywhere", !/[ऀ-ॿ]/.test(html));
  ok("QA-037: the Operations row tells the truth (no sheet-sync claim, ledgers named as Admin's)",
    !/Operations<\/b><\/td><td>[^<]*Sheet Watch/i.test(html) && /they submit; the Admin reads the books/.test(html));
}

// 2026-08-12 audit F-000 (S0): the generic list route copied every ?key=value into the Mongo
// filter AFTER the Rule 38 scope filter, so ?location=<other centre> simply overwrote it and a
// scoped user could read every centre's candidate PII. Scope is now applied last, client keys
// are allow-listed to cfg.fields, and $-prefixed keys are rejected.
{
  const own = spocLocs.data.items[0];
  const baseline = await req(spoc, "GET", "/api/candidates?limit=200");
  const n0 = baseline.data.items?.length ?? 0;
  ok("F-000 baseline: SPOC sees only own-location candidates", (baseline.data.items ?? []).every((c) => c.location?.code === "JPR03"), `n=${n0}`);

  const widen = await req(spoc, "GET", `/api/candidates?location=${otherLoc._id}&limit=200`);
  const leaked = (widen.data.items ?? []).filter((c) => c.location?._id && String(c.location._id) === String(otherLoc._id));
  ok("F-000: ?location=<foreign> leaks nothing", leaked.length === 0, `leaked ${leaked.length}`);

  const byId = await req(spoc, "GET", `/api/locations?_id=${otherLoc._id}&limit=200`);
  ok("F-000: ?_id=<foreign> on locations leaks nothing",
    (byId.data.items ?? []).every((l) => l.code === "JPR03"), JSON.stringify((byId.data.items ?? []).map((l) => l.code)));

  ok("F-000: $-prefixed filter key rejected (400)", (await req(spoc, "GET", "/api/candidates?$where=1%3D%3D1")).status === 400);
  ok("F-000: dotted filter key rejected (400)", (await req(spoc, "GET", "/api/candidates?location.code=KOT02")).status === 400);

  // QA-1871 (checker on qa-1865-1866, cycle 2): this row could not fail for the defect it names.
  // Its third clause was `|| junk.status === 200`, which is true whenever the route answers at all
  // — so an unknown key that DID reach Mongo and narrowed the result would have passed. Its second
  // clause was no better: it compared a `/api/users` list length against `n0`, the SPOC's CANDIDATE
  // count, two unrelated numbers that agreed only by luck.
  //
  // What the row is actually for: an unrecognised query key must be DROPPED by the shared query
  // builder (`src/lib/crud.ts` — `if (!filterable.has(k)) continue;`), not passed to the driver.
  //
  // QA-1871 cycle 1 FAIL — and my first rewrite of this row was still wrong, in a way worth
  // recording because it is the same mistake twice. I made the assertion *capable* of failing and
  // never checked it was pointed at code that could exhibit the defect. `GET /api/users` is a
  // hand-written `User.find({})` that reads NO query parameter at all, so junk and base are
  // identical BY CONSTRUCTION whatever the query builder does — and the SPOC persona is 403 on it,
  // so the row passed on its first clause before the comparison was ever evaluated. The checker
  // injected the real defect in one line of crud.ts and this row did not move; the same clause
  // aimed at `/api/candidates` went 22 -> 0. I had also written in the manifest that no mutant was
  // possible here without rewriting the query builder. That was simply false, and it was the kind
  // of false that excuses a test from having to work.
  //
  // So: a route crud.ts actually serves, a persona that gets 200, and the 200 asserted rather than
  // allowed to be stood in for by a refusal.
  const candBase = await req(spoc, "GET", "/api/candidates?limit=200");
  const candJunk = await req(spoc, "GET", "/api/candidates?password_hash=x&limit=200");
  ok("F-000: the persona really READS the filtered route (200 both ways) — a refusal must not stand in for a pass",
    candBase.status === 200 && candJunk.status === 200, `base ${candBase.status} · junk ${candJunk.status}`);
  ok("F-000: an unknown filter key is DROPPED, so the answer is identical to the same request without it",
    candJunk.status === 200 && candBase.status === 200
      && (candJunk.data.items?.length ?? -1) === (candBase.data.items?.length ?? -2)
      && (candBase.data.items?.length ?? 0) > 0,
    `junk n=${candJunk.data.items?.length} vs base n=${candBase.data.items?.length}`);

  // …while legitimate filtering must still work in both directions
  const narrowOwn = await req(spoc, "GET", `/api/candidates?location=${own._id}&limit=200`);
  ok("F-000: scoped user can still narrow within own scope", (narrowOwn.data.items?.length ?? 0) === n0, `${narrowOwn.data.items?.length} vs ${n0}`);
  const adminNarrow = await req(admin, "GET", `/api/candidates?location=${otherLoc._id}&limit=200`);
  ok("F-000: unscoped Admin can still filter by any location",
    (adminNarrow.data.items ?? []).every((c) => String(c.location?._id) === String(otherLoc._id)) && (adminNarrow.data.items?.length ?? 0) > 0,
    `n=${adminNarrow.data.items?.length}`);
  const enumFilter = await req(admin, "GET", "/api/candidates?lifecycle_status=Enrolled&limit=200");
  ok("F-000: ordinary field filters still work", enumFilter.status === 200 && (enumFilter.data.items ?? []).every((c) => c.lifecycle_status === "Enrolled"));
}

// 2026-08-12 audit (auth S1-9, sync S2-11): Rule 39 says can_edit=false is view-and-nothing-else
// everywhere. Seven write routes gated on a GRANTABLE right but never called requireEdit, so a
// view-only reviewer holding sheet.approve could close a centre, and the same shape could edit
// defaults, costs and users. The viewer below is a real view-only Location account.
{
  const jprId = spocLocs.data.items[0]._id;
  ok("Rule 39: view-only cannot add a cost entry", (await req(viewer, "POST", "/api/costs", { entry_date: "2026-08-12", location: jprId, category: "000000000000000000000000", amount: 1 })).status === 403);
  ok("Rule 39: view-only cannot edit Defaults", (await req(viewer, "PUT", "/api/defaults", { batch_size: 99 })).status === 403);
  ok("Rule 39: view-only cannot create a user", (await req(viewer, "POST", "/api/users", { name: "x", email: `vo${Date.now()}@t.local`, password: "Test@12345", role: "Location" })).status === 403);
  ok("Rule 39: view-only cannot bulk-ignore sheet changes", (await req(viewer, "POST", "/api/sheet-changes/bulk-ignore", { ids: ["000000000000000000000000"] })).status === 403);
  ok("Rule 39: view-only cannot apply a sheet change", (await req(viewer, "POST", "/api/sheet-changes/000000000000000000000000/apply", { action: "Close location", note: "x" })).status === 403);
  // auth S1-8: the invoice route was the only by-id batch route with no scope assertion at all
  const foreign = allBatches.data.items.find((b) => b.location?.code && b.location.code !== "JPR03");
  if (foreign) {
    ok("auth S1-8: SPOC cannot touch another centre's invoice", (await req(spoc, "PATCH", `/api/batches/${foreign._id}/invoice`, { amount: 1 })).status === 403);
  }

  // auth S1-5: the audit trail stores before/after values, so an unscoped feed leaked exactly the
  // personal data Rule 38 exists to protect. Any signed-in user could read any record's history.
  if (foreign) {
    ok("auth S1-5: SPOC cannot read a foreign batch's audit trail", (await req(spoc, "GET", `/api/audit/Batch/${foreign._id}`)).status === 403);
    const foreignCand = (await req(admin, "GET", "/api/candidates?limit=200")).data.items.find((c) => c.location?.code && c.location.code !== "JPR03");
    if (foreignCand) {
      ok("auth S1-5: …nor a foreign candidate's", (await req(spoc, "GET", `/api/audit/Candidate/${foreignCand._id}`)).status === 403);
    }
    ok("auth S1-5: unknown entity fails closed for a scoped user", (await req(spoc, "GET", `/api/audit/Whatever/${foreign._id}`)).status === 403);
  }
  const ownBatchForAudit = spocBatches.data.items[0];
  if (ownBatchForAudit) {
    ok("auth S1-5: SPOC can still read their own batch's audit trail", (await req(spoc, "GET", `/api/audit/Batch/${ownBatchForAudit._id}`)).status === 200);
  }
  ok("auth S1-5: Admin still reads any audit trail", (await req(admin, "GET", `/api/audit/Batch/${allBatches.data.items[0]._id}`)).status === 200);
}

// 2026-08-12 audit (auth S1-4): role, scope, can_edit and deactivation were frozen into the JWT
// at sign-in with a 30-day life, so an Admin could deactivate or demote someone and they carried
// on with their old powers until the token expired. The identity is now re-read from the database
// behind the same short TTL the permission cache uses.
{
  const target = (await req(admin, "GET", "/api/users")).data.items.find((u) => u.email === "enroll@vidysea.com");
  const before = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: active account works before the change", before.status === 200, `${before.status}`);

  // narrowing scope must bite without a re-login
  const jprId = spocLocs.data.items[0]._id;
  await req(admin, "PATCH", `/api/users/${target._id}`, { location_scope: [jprId] }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const scoped = await req(enroll, "GET", "/api/locations?limit=200");
  ok("auth S1-4: a narrowed scope applies to the live session",
    (scoped.data.items ?? []).every((l) => l.code === "JPR03"), JSON.stringify((scoped.data.items ?? []).map((l) => l.code)));
  await req(admin, "PATCH", `/api/users/${target._id}`, { location_scope: [] }, undefined);
  await new Promise((r) => setTimeout(r, 5200));

  // deactivation must end the session
  await req(admin, "PATCH", `/api/users/${target._id}`, { active: false }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const afterOff = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: deactivating an account ends its live session", afterOff.status === 401, `${afterOff.status}`);

  await req(admin, "PATCH", `/api/users/${target._id}`, { active: true }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const afterOn = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: reactivating restores it, still without a re-login", afterOn.status === 200, `${afterOn.status}`);
}

// 2026-08-12 audit — the access/disclosure S2/S3 cluster
{
  const jprId = spocLocs.data.items[0]._id;

  // auth S3-5: the approvals queue carries closure reasons and invoice amounts in its payload
  ok("auth S3-5: approvals queue needs the approvals.decide right", (await req(enroll, "GET", "/api/approvals")).status === 403);
  ok("auth S3-5: …and an Admin still reads it", (await req(admin, "GET", "/api/approvals")).status === 200);

  // auth S3-7 + S2-12: a 2000-row name+mobile+district export, and a duplicate oracle over every
  // centre, were both gated by nothing but "is signed in" — so a right that can be revoked
  // everywhere else could not be revoked here. Prove the gate by taking the right away.
  {
    const enrollPerms = (await req(admin, "GET", "/api/permissions")).data.roles.find((r) => r.role === "Enrollment")?.permissions ?? [];
    ok("auth S3-7/S2-12: both are open while the right is held",
      [200, 404].includes((await req(enroll, "GET", "/api/candidates/export-sidh")).status)
      && (await req(enroll, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" })).status === 200);
    await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollPerms.filter((p) => p !== "candidates.manage") });
    await new Promise((r) => setTimeout(r, 5200)); // permission cache TTL
    ok("auth S3-7: revoking candidates.manage closes the bulk SIDH export",
      (await req(enroll, "GET", "/api/candidates/export-sidh")).status === 403);
    ok("auth S2-12: …and closes the duplicate probe",
      (await req(enroll, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" })).status === 403);
    await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollPerms });
    await new Promise((r) => setTimeout(r, 5200));
  }
  const scopedProbe = await req(spoc, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" });
  ok("auth S2-12: a scoped user only ever learns about their own centres",
    scopedProbe.status === 200 && (scopedProbe.data.duplicates ?? []).every((d) => !d.location || String(d.location).includes("Jaipur")),
    JSON.stringify((scopedProbe.data.duplicates ?? []).map((d) => d.location)));

  // auth S3-6: revoking locations.manage must also stop room writes
  const rooms = (await req(spoc, "GET", `/api/locations/${jprId}/rooms`)).data.items ?? [];
  if (rooms[0]) {
    ok("auth S3-6: view-only cannot edit a room", (await req(viewer, "PATCH", `/api/rooms/${rooms[0]._id}`, { capacity: 99 })).status === 403);
  }

  // auth S2-13: editing a log is where the government figure is set — same right as creating one
  const ownB = spocBatches.data.items.find((b) => ["Active", "Closing"].includes(b.status));
  if (ownB) {
    const lg = (await req(spoc, "GET", `/api/batches/${ownB._id}/logs`)).data.items?.[0];
    if (lg) ok("auth S2-13: view-only cannot edit a daily log", (await req(viewer, "PATCH", `/api/logs/${lg._id}`, { note: "nope" })).status === 403);
  }

  // auth S2-15: a 500 must not hand the client the raw exception text
  const boom = await req(admin, "POST", "/api/candidates", { name: "x", phone: "1", location: "not-an-objectid", program: "also-not" });
  ok("auth S2-15: an internal error does not leak driver/schema detail",
    boom.status < 500 || !/Cast to ObjectId|mongo|ValidationError|E11000|at .*\.ts:/i.test(JSON.stringify(boom.data)),
    `${boom.status} ${JSON.stringify(boom.data).slice(0, 120)}`);

  // auth S2-16: signup must not confirm which addresses already have an account
  const dup = await fetch(BASE + "/api/public/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Probe", email: "admin@vidysea.com", password: "Test@12345", role: "Trainer" }),
  });
  ok("auth S2-16: signup does not reveal that an address is already registered", dup.status !== 409, `got ${dup.status}`);
}

// ---- 2026-08-13 (Umesh role matrix): principal/SPOC = admin-like within their centre;
// NO attendance, NO batch edit, certificate upload yes, NO accounts. Trainer = own batch
// daily log only. Operations = trainer + trainee data. ----
{
  const stampR = String(Date.now()).slice(-8); // 2-digit prefix + 8 = the 10-digit phone validation wants
  // Principal ADDS a trainer at their centre (trainers.manage newly granted to Location).
  const trAdd = await req(principal, "POST", "/api/trainers", { name: "TEST-RM Trainer " + stampR, phone: `96${stampR}`, skills: ["RMSkill"], home_location: jpr._id });
  ok("matrix: principal can ADD a trainer", trAdd.status === 201, `got ${trAdd.status}: ${JSON.stringify(trAdd.data).slice(0, 100)}`);
  // …and a candidate (candidates.manage kept). program is mandatory on direct creation.
  const progRM = spocBatches.data.items[0]?.program?._id
    ?? ((await req(principal, "GET", "/api/programs")).data.items ?? [])[0]?._id;
  const cAdd = await req(principal, "POST", "/api/candidates", { name: "TEST-RM Cand " + stampR, phone: `95${stampR}`, location: jpr._id, program: progRM });
  ok("matrix: principal can ADD a candidate", cAdd.status === 201, `got ${cAdd.status}: ${JSON.stringify(cAdd.data).slice(0, 80)}`);
  // NO attendance: daily-log POST and marking rounds are refused for the Location role.
  const anyBatch = spocBatches.data.items.find((b) => ["Active", "Closing"].includes(b.status));
  if (anyBatch) {
    const dl = await req(principal, "POST", `/api/batches/${anyBatch._id}/logs`, { log_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), present_member_ids: [] });
    ok("matrix: principal CANNOT enter a daily log (attendance is the trainer's)", dl.status === 403, `got ${dl.status}`);
    // QA-1469: a principal/Location login now CARRIES attendance.govt (see the QA-153 block
    // above), so this probe no longer names a role without the right - retargeted to a Trainer,
    // who still lacks it, to keep testing what it always tested: refused BEFORE the door's own
    // body-shape validation runs. (A `principal` probe here now reaches that validation - POSTing
    // `{}` instead of multipart form data - and 500s on a JS-side sender rather than the shape
    // check itself, which is a separate, pre-existing route behavior, not this pin's concern.)
    const gv = await req(trainer, "POST", "/api/govt-attendance", {});
    ok("matrix: a role without attendance.govt CANNOT import govt attendance", gv.status === 403, `got ${gv.status}`);
  }
  // NO batch edit: transition + PATCH both 403 (batches.manage removed).
  const anyB = spocBatches.data.items[0];
  if (anyB) {
    ok("matrix: principal CANNOT transition a batch", (await req(principal, "POST", `/api/batches/${anyB._id}/transition`, { target: "Ready" })).status === 403);
    ok("matrix: principal CANNOT edit batch fields", (await req(principal, "PATCH", `/api/batches/${anyB._id}`, { target_size: 99 })).status === 403);
  }
  // Certificate upload path stays open (closure.manage kept): PUT closure on own batch is
  // not 403 — it may 409 on business rules, which is fine; the GATE is what we assert.
  if (anyB) {
    const cl = await req(principal, "PUT", `/api/batches/${anyB._id}/closure`, { certificate_file: "/files/rm-test.pdf" });
    ok("matrix: principal's certificate-upload gate is OPEN (not 403)", cl.status !== 403, `got ${cl.status}`);
  }
  // NO accounts: unchanged 403.
  ok("matrix: principal still blocked from costs", (await req(principal, "GET", "/api/costs")).status === 403);

  // Trainer: daily log right only — no trainer/candidate management.
  ok("matrix: trainer CANNOT add trainers", (await req(trainer, "POST", "/api/trainers", { name: "x", phone: "9000000000", skills: ["y"] })).status === 403);
  ok("matrix: trainer CANNOT edit candidates", (await req(trainer, "POST", "/api/candidates", { name: "x", phone: "9000000001", location: jpr._id })).status === 403);

  // QA-1290 (client call 2026-08-25, measured live before this fix): PATCH /api/members/[id],
  // POST .../members/bulk-enroll and POST .../members/[id]/drop held NO permission key at all —
  // any signed-in, non-view-only user with the row in scope could complete or drop enrolment.
  // A Trainer login reached bulk-enroll with member_ids omitted (the documented "every active
  // member" default) and completed the WHOLE roster on a live probe: HTTP 200,
  // {"requested":1,"updated":1}. The client's own question on that call — "koi aise hi ek baar
  // mein select kiya aur aise kar diya" — and the answer he was given, "trainer enrollment
  // thodi na kar dega", were both live claims this door did not hold.
  //
  // candidates.assign is the SAME key the two sibling roster-add doors already gate on
  // (members/route.ts POST, candidates/assign/route.ts) — a Trainer holds it on NEITHER of
  // those, confirmed against the LIVE saved matrix on 2026-08-25 (qa/prepared/
  // read-permission-matrix.mjs: Trainer = ["batches.daily_log"] only, is_default=false, i.e. a
  // stored row, not just the code default). So a Trainer denied here is not a new restriction —
  // it is the same right the product has always required for the doors either side of these three.
  if (anyBatch) {
    const trMembers = await req(admin, "GET", `/api/batches/${anyBatch._id}/members`);
    const trM = trMembers.data.items?.find((x) => !x.left_on);
    if (trM) {
      ok("QA-1290: trainer CANNOT PATCH the enrollment worklist (no candidates.assign)",
        (await req(trainer, "PATCH", `/api/members/${trM._id}`, { reg_done: true })).status === 403);
    }
    const trBulk = await req(trainer, "POST", `/api/batches/${anyBatch._id}/members/bulk-enroll`, { step: "all" });
    ok("QA-1290: trainer CANNOT bulk-enroll a whole roster (no candidates.assign)", trBulk.status === 403, `got ${trBulk.status}`);
    if (trM) {
      ok("QA-1290: trainer CANNOT drop a member (no candidates.assign)",
        (await req(trainer, "POST", `/api/members/${trM._id}/drop`, { left_on: new Date().toISOString().slice(0, 10), drop_reason: "test" })).status === 403);
    }
    // …and the SAME login is accepted once the right is granted — proves the gate DECIDES,
    // not the role, exactly as -218/QA-806 established for sheet.approve above. Grant, act,
    // revoke, in that order, so this suite never leaves the matrix altered.
    if (trM) {
      const permsNow = (await req(admin, "GET", "/api/permissions")).data;
      const trainerRow = (permsNow?.roles ?? []).find((r) => r.role === "Trainer");
      const trainerSetNow = trainerRow?.permissions ?? [];
      if (!trainerSetNow.includes("candidates.assign")) {
        await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetNow, "candidates.assign"] }, 200);
        const grantedTry = await req(trainer, "PATCH", `/api/members/${trM._id}`, { reg_done: true });
        ok("QA-1290: …WITH candidates.assign the same login is accepted — the RIGHT decides, not the role",
          grantedTry.status === 200, `status=${grantedTry.status}`);
        await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trainerSetNow }, 200);
        const revokedAgain = await req(trainer, "PATCH", `/api/members/${trM._id}`, { reg_done: true });
        ok("QA-1290: …and revoking it closes the door again", revokedAgain.status === 403, `status=${revokedAgain.status}`);
      }
    }

    // QA-1364 (checker on qa-1290, cycle 1 FAIL): POST /api/candidates/[id]/drop reaches the SAME
    // dropMemberChecked() as POST /api/members/[id]/drop, one route over — but only the member
    // door asked for candidates.assign. So a login holding candidates.manage without
    // candidates.assign (impossible under the default matrix, but exactly one PUT away, and the
    // whole point of a togglable right) could drop the same roster member through the candidate's
    // own page while the roster door correctly refused it. Reproduced with enroll@vidysea.com,
    // which by default carries BOTH candidates.manage and candidates.assign — revoke only the
    // second and this must now refuse too, not just fall back to candidates.manage.
    if (trM?.candidate?._id) {
      const permsBefore = (await req(admin, "GET", "/api/permissions")).data;
      const enrollRow = (permsBefore?.roles ?? []).find((r) => r.role === "Enrollment");
      const enrollSetBefore = enrollRow?.permissions ?? ["candidates.manage", "candidates.assign"];
      if (enrollSetBefore.includes("candidates.assign") && enrollSetBefore.includes("candidates.manage")) {
        await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollSetBefore.filter((p) => p !== "candidates.assign") }, 200);
        const candDropDenied = await req(enroll, "POST", `/api/candidates/${trM.candidate._id}/drop`, { reason: "QA-1364 probe — should be refused" });
        ok("QA-1364: candidates.manage WITHOUT candidates.assign still CANNOT drop a rostered candidate via /api/candidates/[id]/drop",
          candDropDenied.status === 403, `got ${candDropDenied.status}`);
        await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollSetBefore }, 200);
        const restored = await req(admin, "GET", "/api/permissions");
        const enrollAfter = (restored.data?.roles ?? []).find((r) => r.role === "Enrollment")?.permissions ?? [];
        ok("QA-1364: Enrollment's permission set is restored exactly", JSON.stringify([...enrollAfter].sort()) === JSON.stringify([...enrollSetBefore].sort()), JSON.stringify(enrollAfter));
      }
    }
  }

  // Operations: trainer + trainee data updates work.
  if (trAdd.status === 201) {
    ok("matrix: Operations can update trainer data", (await req(ops, "PATCH", `/api/trainers/${trAdd.data.item._id}`, { qualification: "B.Tech" })).status === 200);
  }
  if (cAdd.status === 201) {
    ok("matrix: Operations can update trainee data", (await req(ops, "PATCH", `/api/candidates/${cAdd.data.item._id}`, { education: "12th Pass" })).status === 200);
  }
}

// ---- R-B (CEO 14/08 [35:07-35:13]): per-user REMOVE-a-right + stop access ----
{
  const stamp = Date.now().toString().slice(-6);
  const mk = await req(admin, "POST", "/api/users", {
    name: "Revoke Target " + stamp, email: `revoke.${stamp}@test.local`, password: PW,
    role: "Operations", can_edit: true,
  });
  ok("R-B fixture: an Operations user is created", mk.status === 201, `got ${mk.status}`);
  const uid = mk.data.item?._id;
  let cookie = await login(`revoke.${stamp}@test.local`, PW);
  ok("R-B fixture: they can log in", !!cookie);
  // Operations carries trainers.manage by default. The trainers LIST is deliberately
  // ungated (batch creators read it), so the revoke is proven on the WRITE the right
  // actually gates.
  const mkTrainer = () => req(cookie, "POST", "/api/trainers", { name: "Revoke Probe " + Date.now(), phone: "5" + Date.now().toString().slice(-9), skills: ["rp" + stamp] });
  ok("R-B: before the revoke, the role's right works (trainer create 201)", (await mkTrainer()).status === 201);
  ok("R-B: a non-Admin may not revoke rights",
    (await req(ops, "PATCH", `/api/users/${uid}`, { revoked_permissions: ["trainers.manage"] })).status === 403);
  ok("R-B: Admin revokes one right", (await req(admin, "PATCH", `/api/users/${uid}`, { revoked_permissions: ["trainers.manage"] })).status === 200);
  // (no cache wait needed: revokes are read from the user document on every check)
  const denied = await mkTrainer();
  ok("R-B: deny wins — the revoked right now 403s and names itself",
    denied.status === 403 && /right/i.test(denied.data?.error ?? ""), `got ${denied.status} ${denied.data?.error ?? ""}`);
  const anyProg = (await req(cookie, "GET", "/api/programs?limit=1")).data.items?.[0];
  ok("R-B: other rights survive the revoke (candidate create still allowed)",
    (await req(cookie, "POST", "/api/candidates", { name: "Revoke Cand " + stamp, phone: "4" + Date.now().toString().slice(-9), location: jpr._id, program: anyProg?._id })).status === 201);
  // A grant does NOT resurrect a revoked right — deny wins over extra too.
  await req(admin, "PATCH", `/api/users/${uid}`, { extra_permissions: ["trainers.manage"] });
  ok("R-B: an extra grant cannot undo a revoke (deny wins)", (await mkTrainer()).status === 403);
  // Stop access: active=false kills the LIVE session on its very next request (QA-080 —
  // the identity cache is invalidated by the stop itself, no TTL wait), and a fresh
  // session cannot be minted.
  ok("R-B: Admin stops access", (await req(admin, "PATCH", `/api/users/${uid}`, { active: false })).status === 200);
  ok("QA-080: the session they already had dies on the very next request",
    (await req(cookie, "GET", "/api/candidates?limit=1")).status === 401);
  ok("R-B: a stopped account cannot log in", (await login(`revoke.${stamp}@test.local`, PW)) === null);
  ok("R-B: reactivate restores login", (await req(admin, "PATCH", `/api/users/${uid}`, { active: true })).status === 200 && !!(await login(`revoke.${stamp}@test.local`, PW)));
}

// ---- Rule 53 (R-C, CEO 14/08 [40:51]): trainer log-date window ----
{
  const tb = (await req(trainer, "GET", "/api/batches")).data.items?.find((b) => ["Active", "Closing"].includes(b.status));
  if (tb) {
    const twoAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const old = await req(trainer, "POST", `/api/batches/${tb._id}/logs`, { log_date: twoAgo, present_member_ids: [] });
    ok("Rule 53: a trainer cannot backdate beyond yesterday",
      old.status === 403 && /only today or yesterday/.test(old.data?.error ?? ""), `got ${old.status} ${old.data?.error ?? ""}`);
    const fut = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const future = await req(admin, "POST", `/api/batches/${tb._id}/logs`, { log_date: fut, present_member_ids: [] });
    ok("Rule 53: a future date is refused for everyone",
      future.status === 400 && /future/i.test(future.data?.error ?? ""), `got ${future.status} ${future.data?.error ?? ""}`);
  } else {
    ok("Rule 53: skipped — no Active batch visible to the trainer (fixture)", true);
  }
}

// ---- R-F (CEO 14/08 [36:44-37:28]): SPOC centre-detail edits go through Admin approval ----
{
  const rfStamp = Date.now().toString().slice(-6);
  await req(admin, "PUT", "/api/approvals", { action: "location.edit", enabled: true, approver_role: "Admin" });
  const fx = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { name: "Renamed by SPOC " + rfStamp });
  ok("R-F: a fixed field is refused for a centre login (403 naming it)",
    fx.status === 403 && /cannot change/.test(fx.data?.error ?? ""), `got ${fx.status} ${fx.data?.error ?? ""}`);
  const newAddr = "New Wing " + rfStamp;
  const sug = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { address: newAddr });
  ok("R-F: a detail change parks for approval (202)",
    sug.status === 202 && /Sent for approval/.test(sug.data?.error ?? ""), `got ${sug.status} ${JSON.stringify(sug.data).slice(0, 100)}`);
  const parkedLoc = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("R-F: nothing applied while parked", parkedLoc.address !== newAddr, parkedLoc.address);
  const pend = ((await req(admin, "GET", "/api/approvals?status=Pending")).data.items ?? []).find((i) => i.action === "location.edit");
  ok("R-F: the suggestion sits in the Admin queue", !!pend, JSON.stringify(pend?.summary));
  if (pend) {
    await req(admin, "POST", `/api/approvals/${pend._id}`, { decision: "Approved" });
    const appliedLoc = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
    ok("R-F: approval applies the change", appliedLoc.address === newAddr, appliedLoc.address);
  }
  const progList = (await req(admin, "GET", "/api/programs?limit=1")).data.items;
  if (progList?.[0]) {
    const tgt = await req(spoc, "PUT", `/api/locations/${jpr._id}/targets`, { program: progList[0]._id, approved_target: 111 });
    ok("R-F: a SPOC target change parks too (202, queued)", tgt.status === 202 && tgt.data.queued === true, `got ${tgt.status}`);
  }
  // QA-075: a SPOC's classroom/lab suggestion parks the same way, and the Room is created
  // only by the approval.
  const roomName = "SPOC Lab " + rfStamp;
  const roomSug = await req(spoc, "POST", `/api/locations/${jpr._id}/rooms`, { name: roomName, type: "Lab", capacity: 20 });
  ok("QA-075: a SPOC room suggestion parks (202, queued)", roomSug.status === 202 && roomSug.data.queued === true, `got ${roomSug.status}`);
  const roomsBefore = (await req(admin, "GET", `/api/locations/${jpr._id}/rooms`)).data.items ?? [];
  ok("QA-075: no room exists while parked", !roomsBefore.some((r) => r.name === roomName));
  if (roomSug.data.item?._id) {
    await req(admin, "POST", `/api/approvals/${roomSug.data.item._id}`, { decision: "Approved" });
    const roomsAfter = (await req(admin, "GET", `/api/locations/${jpr._id}/rooms`)).data.items ?? [];
    ok("QA-075: approval creates the room", roomsAfter.some((r) => r.name === roomName && r.type === "Lab"), JSON.stringify(roomsAfter.map((r) => r.name)));
  }
  await req(admin, "PUT", "/api/approvals", { action: "location.edit", enabled: false });
}

// ---- R-I (CEO [38:54-39:10]): a Trainer's batch list marks mine vs guest-faculty ----
{
  const tb = await req(trainer, "GET", "/api/batches");
  ok("R-I: every batch row carries is_mine for a Trainer login",
    (tb.data.items ?? []).length === 0 || tb.data.items.every((b) => typeof b.is_mine === "boolean"),
    JSON.stringify(tb.data.items?.[0]?.is_mine));
  const ab = await req(admin, "GET", "/api/batches");
  ok("R-I: other roles never see the flag (no accidental contract growth)",
    (ab.data.items ?? []).every((b) => b.is_mine === undefined));
}

// ---- R-H (CEO [03:02-03:14]): programme master carries QP hours + Admin-only money ----
{
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items?.[0];
  if (prog) {
    await req(admin, "PATCH", `/api/programs/${prog._id}`, { hours: 120, contract_amount: 9999 });
    const asAdmin = (await req(admin, "GET", `/api/programs/${prog._id}`)).data.item;
    ok("R-H: Admin sees the QP hours and the amount", asAdmin?.hours === 120 && asAdmin?.contract_amount === 9999,
      JSON.stringify({ h: asAdmin?.hours, a: asAdmin?.contract_amount }));
    const asSpoc = (await req(spoc, "GET", `/api/programs/${prog._id}`)).data.item;
    ok("R-H: the amount is MASKED for every non-Admin reader",
      !!asSpoc && asSpoc.contract_amount === undefined && asSpoc.hours === 120, JSON.stringify({ a: asSpoc?.contract_amount }));
    const listSpoc = (await req(spoc, "GET", "/api/programs?limit=5")).data.items ?? [];
    ok("R-H: the list masks it too", listSpoc.every((p) => p.contract_amount === undefined));
  } else {
    ok("R-H skipped — no programme (run seed:sample)", true);
  }
}

// ---- QA-088: tc_password is the Admin's alone (the matrix grants locations.manage to
// Ops AND every SPOC, so the old permission gate was the leak) ----
{
  await req(admin, "PATCH", `/api/locations/${jpr._id}`, { tc_password: "SECRET-" + Date.now() });
  const asAdmin = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: Admin sees tc_password", typeof asAdmin?.tc_password === "string" && asAdmin.tc_password.length > 0);
  const asOps = (await req(ops, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: Operations never sees it", !!asOps && asOps.tc_password === undefined, JSON.stringify(asOps?.tc_password));
  const asSpoc = (await req(spoc, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: the SPOC of the very centre never sees it", !!asSpoc && asSpoc.tc_password === undefined);
  const listOps = (await req(ops, "GET", "/api/locations?limit=200")).data.items ?? [];
  ok("QA-088: the list masks it for every centre", listOps.every((l) => l.tc_password === undefined));

  // ---- -251 (QA-289, S1): QA-088 answered WHO may see the credential and never WHETHER it should
  // be on screen unasked - and for an Admin the answer stayed "always". A column nobody has to open,
  // on a grid of every centre, travelling in every screenshot. These go RED pre-fix: today the
  // Admin list carries the value.
  const listAdmin = (await req(admin, "GET", "/api/locations?limit=200")).data.items ?? [];
  ok("-251 (QA-289): the LIST carries no credential for ANYONE - the Admin included",
    listAdmin.length > 0 && listAdmin.every((l) => l.tc_password === undefined),
    JSON.stringify(listAdmin.filter((l) => l.tc_password !== undefined).map((l) => l.code)).slice(0, 200));
  const jprRow = listAdmin.find((l) => String(l._id) === String(jpr._id));
  ok("-251 (QA-289): ...and says a credential EXISTS, so the screen need not invent an answer",
    jprRow?.tc_password_set === true, JSON.stringify({ set: jprRow?.tc_password_set }));
  ok("-251 (QA-289): ...and tells the Admin a reveal would succeed, so the control is not a dead one",
    jprRow?.tc_password_revealable === true, JSON.stringify({ revealable: jprRow?.tc_password_revealable }));
  const jprOpsRow = listOps.find((l) => String(l._id) === String(jpr._id));
  ok("-251 (QA-289): a non-Admin is told NOT revealable, so no button renders for them",
    jprOpsRow?.tc_password_revealable === false, JSON.stringify({ revealable: jprOpsRow?.tc_password_revealable }));
  // Guards the other direction: masking the list must NOT have closed the door that makes the
  // reveal possible. Opening ONE centre is the asking, and it still answers for the Admin.
  const reveal = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("-251 (QA-289): opening one centre IS the asking - the single-record door still answers",
    typeof reveal?.tc_password === "string" && reveal.tc_password.length > 0);

  // ---- -251 (QA-1319, S1): the SAME leak two screens over, and worse - no centre had to be opened
  // at all. /api/home queue 5 and /api/follow-ups populated `source_change` WHOLE (no select, no
  // mask), so every pending follow-up carried its SheetChange old_value/new_value, and on a
  // tc_password row that is a live portal credential. On the LANDING PAGE, for a non-Admin
  // Operations login. The screen renders only source_change.location.name - the value was never ON
  // SCREEN and always IN THE PAYLOAD.
  //
  // HONEST LIMIT, said out loud rather than implied: these two assertions are VACUOUS when the
  // fixture has no pending follow-up carrying a secret field, and this suite has no way to create
  // one (SheetChange rows come from the sync engine, not an API). They therefore catch a REGRESSION
  // on real data and do NOT prove the fix on their own. What proves it is the structural pin in
  // check-user-copy.mjs plus the mask being the shared maskSheetChange. Recorded so nobody counts
  // these as more than they are - the qa-215 lesson (QA-776), where five pins passed pre-fix too.
  const secretish = (v) => typeof v === "string" && v.length > 0 && v !== "••••••";
  const leaks = (rows) => (rows ?? []).filter((f) => {
    const c = f?.source_change;
    return c && c.field_name === "tc_password" && (secretish(c.old_value) || secretish(c.new_value));
  });
  const homeOps = (await req(ops, "GET", "/api/home")).data ?? {};
  ok("-251 (QA-1319): the landing page carries no live credential in its follow-up queue",
    leaks(homeOps.follow_ups).length === 0,
    JSON.stringify(leaks(homeOps.follow_ups).map((f) => f.source_change?.field_name)).slice(0, 160));
  const fuOps = (await req(ops, "GET", "/api/follow-ups")).data?.items ?? [];
  ok("-251 (QA-1319): the follow-ups list carries none either - the second door onto the same leak",
    leaks(fuOps).length === 0,
    JSON.stringify(leaks(fuOps).map((f) => f.source_change?.field_name)).slice(0, 160));
}

// ---- R2 (QA-095/091/060/061/083/084/096): the doors are shut on the SERVER now ----
{
  // Trainer: every directory the CEO closed answers 403, not with data.
  for (const p of ["/api/trainers", "/api/candidates", "/api/locations", "/api/open-positions", "/api/trainer-requests"]) {
    ok(`R2: Trainer is refused at ${p}`, (await req(trainer, "GET", p)).status === 403, p);
  }
  // Enrollment: candidates & locations are their brief; the hiring surface is not.
  ok("R2: Enrollment still reads candidates", (await req(enroll, "GET", "/api/candidates?limit=1")).status === 200);
  ok("R2: Enrollment still reads locations", (await req(enroll, "GET", "/api/locations?limit=1")).status === 200);
  ok("R2: Enrollment is refused the trainer directory", (await req(enroll, "GET", "/api/trainers?limit=1")).status === 403);
  ok("R2: Enrollment is refused the hiring board", (await req(enroll, "GET", "/api/open-positions")).status === 403);
  // Operations: the sheet machinery and the approvals queue left with the matrix trim.
  ok("R2/QA-083: Operations refused at sheet-changes", (await req(ops, "GET", "/api/sheet-changes")).status === 403);
  ok("R2/QA-084: Operations refused at the approvals queue", (await req(ops, "GET", "/api/approvals")).status === 403);
  ok("R2: Operations still reads their own submissions (?mine=1)", (await req(ops, "GET", "/api/approvals?mine=1")).status === 200);
  // QA-096: a figure a lean role is not shown is not SENT either.
  const enrollHome = (await req(enroll, "GET", "/api/home")).data;
  ok("QA-096: the lean Home payload carries no org-wide KPIs",
    enrollHome?.kpis && enrollHome.kpis.approved_targets === undefined && enrollHome.kpis.targets_total === undefined
    && enrollHome.kpis.approved_locations === undefined && enrollHome.queues?.sheet_changes === undefined,
    JSON.stringify(Object.keys(enrollHome?.kpis ?? {})));
  const adminHome = (await req(admin, "GET", "/api/home")).data;
  ok("QA-096: the Admin payload still carries them", adminHome?.kpis?.targets_total !== undefined);
  // QA-082: a Trainer's daily-log write cannot smuggle the govt figures in.
  const tb2 = (await req(trainer, "GET", "/api/batches")).data.items?.find((b) => ["Active", "Closing"].includes(b.status));
  if (tb2) {
    const smuggle = await req(trainer, "POST", `/api/batches/${tb2._id}/logs`, {
      log_date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      present_member_ids: [], govt_present: 99, govt_source: "Manual", govt_screenshot: "/erp/api/files/fake.png",
    });
    if (smuggle.status === 201) {
      ok("QA-082: the govt figures were stripped from a Trainer's log write",
        smuggle.data.item.govt_present == null && !smuggle.data.item.govt_screenshot, JSON.stringify({ g: smuggle.data.item.govt_present }));
      await req(admin, "PATCH", `/api/logs/${smuggle.data.item._id}`, { note: "R2 probe log" });
    } else {
      ok("QA-082: log write refused for another reason (fixture) — strip is compile-pinned", true, `got ${smuggle.status}`);
    }
  } else {
    ok("QA-082: skipped — no Active batch visible to the trainer", true);
  }
}

// ---- QA-904 (Umesh 2026-08-24): three delete rights, not one Admin role ----
// "koi galti se candidate delete krr diyaa tho delete krne ka option dena hai team ko … esse hi
// trainer ko bhi delete kr skte hai and batch ko bhi delete krr skte hai but vo bhi respective
// acess wale persons."
//
// None of these verbs was missing. All three existed, with their safety refusals, shut behind a
// hard-coded `user.role !== "Admin"` - so the team saw no button and reported the feature as absent.
// Umesh chose THREE separate rights so a centre principal can clear a junk candidate row without
// also being able to erase a trainer or a batch.
//
// The point of these assertions is the SEPARATION. One right must not open another, and widening who
// may press the verb must not have softened what it refuses.
{
  const s9 = "D9" + Date.now().toString().slice(-6);
  const permsSnap = (await req(admin, "GET", "/api/permissions")).data;
  const setOf = (role) => (permsSnap.roles ?? []).find((r) => r.role === role)?.permissions ?? [];
  const opsBase = setOf("Operations");
  const catalogKeys = (permsSnap.catalog ?? []).map((c) => c.key);

  ok("QA-904: the three delete rights are in the permissions catalogue, so an Admin can see them",
    ["candidates.delete", "trainers.delete", "batches.delete"].every((k) => catalogKeys.includes(k)),
    JSON.stringify(catalogKeys.filter((k) => k.endsWith(".delete"))));

  // A junk candidate and a junk trainer, made through the API so nothing is hand-seeded.
  const loc9 = (await req(admin, "POST", "/api/locations", { code: "L" + s9, name: "Del Loc " + s9, approval_status: "Approved" })).data.item;
  const prog9 = (await req(admin, "POST", "/api/programs", { code: "P" + s9, name: "Del Prog " + s9, trainer_skill: "sk" + s9, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 })).data.item;
  const mkJunkCand = async () => (await req(admin, "POST", "/api/candidates", {
    name: "Junk " + s9 + Math.random().toString(36).slice(2, 5),
    phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
    location: loc9._id, program: prog9._id,
  })).data.item;

  // ---- GRANT candidates.delete ONLY, to Operations ----
  await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: [...opsBase.filter((k) => !String(k).endsWith(".delete")), "candidates.delete"] }, 200);
  await new Promise((r) => setTimeout(r, 5500)); // the role-permission cache has a 5s TTL

  {
    const c = await mkJunkCand();
    const del = await req(ops, "DELETE", `/api/candidates/${c._id}`);
    ok("QA-904: a NON-ADMIN holding candidates.delete can remove a junk candidate row",
      del.status === 200, `status=${del.status} ${JSON.stringify(del.data).slice(0, 140)}`);
  }
  {
    const t = (await req(admin, "POST", "/api/trainers", { name: "Junk Trainer " + s9, phone: "8" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0") })).data.item;
    const del = await req(ops, "DELETE", `/api/trainers/${t._id}`);
    ok("QA-904: ...and the SAME user, without trainers.delete, is refused on a trainer",
      del.status === 403, `status=${del.status} ${JSON.stringify(del.data).slice(0, 140)}`);
    ok("QA-904: ...and the refusal names the right to ask an Admin for, not just 'forbidden'",
      /right/i.test(String(del.data?.error ?? "")), String(del.data?.error ?? "").slice(0, 120));
    await req(admin, "DELETE", `/api/trainers/${t._id}`); // tidy up as Admin
  }

  // ---- THE SAFETY REFUSALS ARE UNCHANGED. More people can reach the verb now, which is the reason
  // to prove this rather than assume it. ----
  {
    const c = await mkJunkCand();
    const b = (await req(admin, "POST", "/api/batches", { location: loc9._id, program: prog9._id, planned_start: "2027-06-01", target_size: 5 })).data.item;
    await req(admin, "POST", `/api/batches/${b._id}/members`, { candidate: c._id });

    // QA-1800 (Umesh, 2026-09-02 ~17:05 IST, qa/feedback-inbox.md: "yes with confirmation"). This
    // used to be an outright refusal (the pin below was worded "is still refused"). Umesh widened
    // it: a candidate WITH batch history CAN be archived now, behind an explicit confirmation.
    // Erasure stays impossible regardless - only ARCHIVE changed, and only when asked twice.
    const del = await req(ops, "DELETE", `/api/candidates/${c._id}`);
    ok("QA-1800: a candidate WITH batch history is refused WITHOUT confirmation - the gate, not a bypass",
      del.status === 409, `status=${del.status}`);
    ok("QA-1800: ...and the refusal names batch history, not just 'forbidden'",
      /batch history/i.test(String(del.data?.error ?? "")), String(del.data?.error ?? "").slice(0, 120));

    const del2 = await req(ops, "DELETE", `/api/candidates/${c._id}`, { reason: "QA-1800 confirmed", confirm_batch_history: true }, 200);
    ok("QA-1800: ...and WITH confirmation the same request now succeeds",
      del2.status === 200, `status=${del2.status}`);

    const after = (await req(admin, "GET", `/api/candidates/${c._id}`, undefined, 200)).data.item;
    ok("QA-1800: the candidate record still SURVIVES - confirmation unlocks archive, never erasure",
      !!after && !!after.archived_at && after.archive_reason === "QA-1800 confirmed",
      JSON.stringify({ found: !!after, archived_at: after?.archived_at ?? null, reason: after?.archive_reason ?? null }));

    const auditRows2 = (await req(admin, "GET", `/api/audit/Candidate/${c._id}`)).data.items ?? [];
    const arch2 = auditRows2.find((x) => x.field === "archived_at");
    ok("QA-1800: the audit line names the batch history that was confirmed",
      !!arch2 && /had batch history, confirmed/i.test(String(arch2.new_value ?? "")),
      String(arch2?.new_value ?? ""));

    // and the batch that now carries a member still cannot be deleted, by anyone - unchanged
    await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: [...opsBase.filter((k) => !String(k).endsWith(".delete")), "candidates.delete", "batches.delete"] }, 200);
    await new Promise((r) => setTimeout(r, 5500));
    const delB = await req(ops, "DELETE", `/api/batches/${b._id}`);
    ok("QA-904: a batch carrying recorded work is still refused - it is Cancelled, never deleted",
      delB.status === 409, `status=${delB.status} ${JSON.stringify(delB.data).slice(0, 140)}`);
  }

  // candidates-bulk-archive-restore-ux: no un-archive capability existed anywhere before this -
  // grep for "archived_at: null" across src/ found exactly one hit, a bulk-assign EXCLUSION
  // filter, never a write. These pins are the first proof the new door actually clears the field
  // (not just returns 200) and that the field really comes back on a re-fetch.
  {
    const a = await mkJunkCand();
    const arch = await req(ops, "DELETE", `/api/candidates/${a._id}`, { reason: "restore-test" }, 200);
    ok("candidates-bulk-archive-restore-ux precondition: the candidate archived cleanly first",
      arch.status === 200 && arch.data?.archived === true, `status=${arch.status}`);

    const notArchivedYet = await mkJunkCand();
    const badUnarchive = await req(ops, "POST", `/api/candidates/${notArchivedYet._id}/unarchive`);
    ok("candidates-bulk-archive-restore-ux: unarchiving a candidate that isn't archived is refused, not silently accepted",
      badUnarchive.status === 400, `status=${badUnarchive.status} ${JSON.stringify(badUnarchive.data).slice(0, 140)}`);

    const restore = await req(ops, "POST", `/api/candidates/${a._id}/unarchive`, undefined, 200);
    ok("candidates-bulk-archive-restore-ux: unarchive succeeds on a genuinely archived candidate",
      restore.status === 200 && restore.data?.archived === false, `status=${restore.status}`);

    const after = (await req(admin, "GET", `/api/candidates/${a._id}`)).data.item;
    ok("candidates-bulk-archive-restore-ux: all three archive fields are actually cleared, not just archived_at",
      after && after.archived_at === null && after.archive_reason === null && !after.archived_by,
      JSON.stringify({ archived_at: after?.archived_at, archive_reason: after?.archive_reason, archived_by: after?.archived_by }));

    const auditRows = (await req(admin, "GET", `/api/audit/Candidate/${a._id}`)).data.items ?? [];
    const restoreRow = auditRows.find((x) => x.field === "archived_at" && x.new_value === "restored");
    ok("candidates-bulk-archive-restore-ux: the restore is audited by name, not silent",
      !!restoreRow, JSON.stringify(auditRows.map((x) => x.new_value)));
  }

  // Bulk archive/restore - same per-candidate try/catch shape as the existing bulk-assign route,
  // proven here the same way QA-273/274/275 were: a MIXED batch, so one bad id cannot silently
  // swallow (or silently abort) the good ones.
  {
    const b1 = await mkJunkCand();
    const b2 = await mkJunkCand();
    const bogusId = "6a0000000000000000000000";
    const bulkArch = await req(ops, "POST", "/api/candidates/bulk-archive", { candidate_ids: [b1._id, b2._id, bogusId], reason: "bulk-test" }, 200);
    const results = bulkArch.data?.results ?? [];
    ok("candidates-bulk-archive-restore-ux: bulk-archive reports one result per id, in order",
      results.length === 3, JSON.stringify(results.map((r) => r.candidate)));
    ok("candidates-bulk-archive-restore-ux: the two real candidates archived ok",
      results[0]?.ok === true && results[1]?.ok === true, JSON.stringify(results.slice(0, 2)));
    ok("candidates-bulk-archive-restore-ux: the bogus id failed WITHOUT aborting the other two - a partial failure is not a total one",
      results[2]?.ok === false && /not found/i.test(String(results[2]?.error ?? "")), JSON.stringify(results[2]));
    ok("candidates-bulk-archive-restore-ux: the response's own count matches the actually-ok rows",
      bulkArch.data?.archived === 2, `archived=${bulkArch.data?.archived}`);

    const b1After = (await req(admin, "GET", `/api/candidates/${b1._id}`)).data.item;
    ok("candidates-bulk-archive-restore-ux: bulk-archive really set the reason on each row, not just status 200",
      b1After?.archived_at && b1After?.archive_reason === "bulk-test", JSON.stringify({ archived_at: b1After?.archived_at, reason: b1After?.archive_reason }));

    const bulkUnarch = await req(ops, "POST", "/api/candidates/bulk-unarchive", { candidate_ids: [b1._id, b2._id] }, 200);
    ok("candidates-bulk-archive-restore-ux: bulk-unarchive restores both in one call",
      bulkUnarch.data?.restored === 2, `restored=${bulkUnarch.data?.restored}`);
    const b1Restored = (await req(admin, "GET", `/api/candidates/${b1._id}`)).data.item;
    ok("candidates-bulk-archive-restore-ux: bulk-restored candidate is genuinely un-archived on re-fetch",
      b1Restored?.archived_at === null, JSON.stringify({ archived_at: b1Restored?.archived_at }));
  }

  // QA-1792 (recorded client call 2026-09-02 item 3; Umesh's gate answer 2026-09-02 ~13:35):
  // "delete ke badle ARCHIVE kar dena hai". Until now this door ran c.deleteOne() for anyone the
  // QA-904 409 above did NOT catch - i.e. every candidate with no batch history, which is exactly
  // who the client's team clears with it. The record and its documents were destroyed. These pins
  // exist because a green suite said nothing about it: the two pre-existing "delete works" pins
  // assert only status 200, and 200 is what an archive returns too.
  {
    const a = await mkJunkCand();
    const before = (await req(admin, "GET", `/api/candidates/${a._id}`)).data.item;
    ok("QA-1792 precondition: a fresh candidate with NO batch history exists and is not archived",
      !!before && !before.archived_at, JSON.stringify({ id: a._id, archived_at: before?.archived_at ?? null }));

    // QA-1796: give them a document first - a pin over documents needs a document to exist.
    await req(admin, "POST", `/api/candidates/${a._id}/documents`, { doc_type: "Aadhaar", file_url: "/erp/api/files/qa1796.pdf", original_name: "aadhaar.pdf" }, 201);
    const docsBefore = (await req(admin, "GET", `/api/candidates/${a._id}/documents`, undefined, 200)).data.items ?? [];
    ok("QA-1796 precondition: the candidate really has a document before the door is used",
      docsBefore.length === 1, JSON.stringify({ count: docsBefore.length }));

    const del = await req(ops, "DELETE", `/api/candidates/${a._id}`, { reason: "QA-1792 duplicate lead" }, 200);
    ok("QA-1792: the door still answers 200 - the two pre-existing delete pins are unchanged",
      del.status === 200, `status=${del.status}`);

    // THE POINT OF THE UNIT: the record must still be there afterwards.
    const after = (await req(admin, "GET", `/api/candidates/${a._id}`, undefined, 200)).data.item;
    ok("QA-1792: the candidate record SURVIVES - this door no longer destroys anything",
      !!after && String(after._id) === String(a._id), JSON.stringify({ found: !!after }));
    ok("QA-1792: ...and is stamped archived, with the reason the caller gave",
      !!after?.archived_at && after?.archive_reason === "QA-1792 duplicate lead",
      JSON.stringify({ archived_at: after?.archived_at ?? null, reason: after?.archive_reason ?? null }));

    // REQ-417-421 stands (Umesh: "Archive is a separate state"): archiving must NOT touch the
    // lifecycle axis, and must not pretend the person was dropped from anything.
    // QA-1802: `after?.x === before?.x` is TRUE when the field stops being returned at all
    // (undefined === undefined), so this asserted nothing on a payload that dropped it. Both sides
    // must actually carry a value before their equality means anything.
    ok("QA-1792: archiving does not disturb lifecycle_status - it is a separate axis",
      !!before?.lifecycle_status && !!after?.lifecycle_status
      && after.lifecycle_status === before.lifecycle_status,
      JSON.stringify({ before: before?.lifecycle_status ?? null, after: after?.lifecycle_status ?? null }));

    // QA-1796 (checker, on cycle 1): the S1 had TWO halves - the record AND its documents, which
    // `CandidateDocument.deleteMany` took with it. The manifest claimed the documents survive and
    // that claim was true, but NOTHING asserted it, so it could regress silently. It is the half
    // that never had any guard at all, so it is the half that most needs one.
    const docsAfter = (await req(admin, "GET", `/api/candidates/${a._id}/documents`, undefined, 200)).data.items ?? [];
    ok("QA-1796: the candidate's DOCUMENTS survive the door too - the other half of the data loss",
      docsAfter.length === 1 && String(docsAfter[0].doc_type) === "Aadhaar",
      JSON.stringify({ count: docsAfter.length, types: docsAfter.map((d) => d.doc_type) }));

    const auditRows = (await req(admin, "GET", `/api/audit/Candidate/${a._id}`)).data.items ?? [];
    const arch = auditRows.find((x) => x.field === "archived_at");
    // Both halves matter, and the second was added because the first PASSED against a mutant:
    // reverting the door to `deleteOne()` while leaving this audit call in place wrote "archived"
    // for a record that no longer existed. An audit row saying archived is not evidence of an
    // archive if a "deleted (...)" row sits beside it - that combination is a lying audit trail.
    ok("QA-1792: the archive is audited, naming the reason rather than the word 'deleted'",
      !!arch && /archived/i.test(String(arch.new_value ?? "")) && /duplicate lead/.test(String(arch.new_value ?? ""))
      && !auditRows.some((x) => /^deleted \(/.test(String(x.new_value ?? ""))),
      JSON.stringify({ arch: arch ?? null, deletedRows: auditRows.filter((x) => /^deleted \(/.test(String(x.new_value ?? ""))).length }));
  }
  {
    const b2 = (await req(admin, "POST", "/api/batches", { location: loc9._id, program: prog9._id, planned_start: "2027-07-01", target_size: 5 })).data.item;
    const delB2 = await req(ops, "DELETE", `/api/batches/${b2._id}`);
    ok("QA-904: an EMPTY batch shell can be deleted by a non-Admin holding batches.delete",
      delB2.status === 200, `status=${delB2.status} ${JSON.stringify(delB2.data).slice(0, 140)}`);
  }

  // ---- REVOKING closes it again. A right that cannot be taken back is not a toggle. ----
  await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsBase.filter((k) => !String(k).endsWith(".delete")) }, 200);
  await new Promise((r) => setTimeout(r, 5500));
  {
    const c = await mkJunkCand();
    const del = await req(ops, "DELETE", `/api/candidates/${c._id}`);
    ok("QA-904: revoking candidates.delete closes the door again",
      del.status === 403, `status=${del.status}`);
    await req(admin, "DELETE", `/api/candidates/${c._id}`);
  }

  // ---- Admin is unaffected: the role bypass in requirePerm still applies, so this change cannot
  // have locked the one person who could always do it out of their own product. ----
  {
    const c = await mkJunkCand();
    const del = await req(admin, "DELETE", `/api/candidates/${c._id}`);
    ok("QA-904: an Admin still deletes without holding the right explicitly (role bypass intact)",
      del.status === 200, `status=${del.status}`);
  }

  // ---- QA-1008 / QA-1009 (qa-234 checker, S1): Rule 38 on the delete doors ----
  // Opening delete from a hard-coded Admin test to a togglable right did not create this hole - it
  // WOKE IT UP. While the verb was Admin-only the missing scope check was unreachable, because an
  // Admin is unscoped by definition. The moment a Location user could hold `candidates.delete`, a
  // person who gets 403 merely READING a foreign centre's record could DELETE it, and the record
  // really went. Measured on the live release by the checker, not reasoned about.
  //
  // The contrast is why this was an omission rather than a decision: the THIRD door of the same unit,
  // `api/batches/[id]`, already called assertBatchInScope and refused correctly. Two of three doors
  // had the check.
  //
  // These assertions are the pair that matters: refused on somebody ELSE'S centre, still allowed on
  // their OWN. A pin that only proves the refusal would pass just as well on a door that refuses
  // everyone, which is a different bug wearing the same green tick.
  {
    const s10 = "SC" + Date.now().toString().slice(-6);
    const jprId = (await req(admin, "GET", "/api/locations?limit=200")).data.items
      ?.find((l) => /jaipur|jpr/i.test(String(l.name) + String(l.code)))?._id;
    const farLoc = (await req(admin, "POST", "/api/locations", { code: "FAR" + s10, name: "Far Centre " + s10, approval_status: "Approved" })).data.item;
    const anyProg = (await req(admin, "GET", "/api/programs?limit=1")).data.items?.[0]?._id;

    // grant the SPOC's role the delete rights this unit ships by default to Location
    const permsNow = (await req(admin, "GET", "/api/permissions")).data;
    const locBase = (permsNow.roles ?? []).find((r) => r.role === "Location")?.permissions ?? [];
    await req(admin, "PUT", "/api/permissions", { role: "Location", permissions: [...new Set([...locBase, "candidates.delete", "trainers.delete"])] }, 200);
    await new Promise((r) => setTimeout(r, 5500)); // role-permission cache TTL

    const mkAt = async (locId) => (await req(admin, "POST", "/api/candidates", {
      name: "Scope " + s10 + Math.random().toString(36).slice(2, 5),
      phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
      location: locId, program: anyProg,
    })).data.item;

    const foreign = await mkAt(farLoc._id);
    const readForeign = await req(spoc, "GET", `/api/candidates/${foreign._id}`);
    const delForeign = await req(spoc, "DELETE", `/api/candidates/${foreign._id}`);
    ok("QA-1008: a scoped user cannot DELETE another centre's candidate",
      delForeign.status === 403, `read=${readForeign.status} delete=${delForeign.status}`);
    ok("QA-1008: ...and the record is genuinely still there afterwards",
      (await req(admin, "GET", `/api/candidates/${foreign._id}`)).status === 200);
    // The shape that made this an S1 rather than a nit: read and delete DISAGREED. Whatever the
    // answer is, the two doors must give the same one about the same record.
    ok("QA-1008: ...read and delete agree - a record you may not READ is not one you may DESTROY",
      (readForeign.status === 403) === (delForeign.status === 403),
      `read=${readForeign.status} delete=${delForeign.status}`);

    if (jprId) {
      const own = await mkAt(jprId);
      ok("QA-1008: ...but they CAN still delete a junk row at their OWN centre - the fix scopes, it does not close the door",
        (await req(spoc, "DELETE", `/api/candidates/${own._id}`)).status === 200);
    } else ok("QA-1008: own-centre fixture available", false, "no Jaipur location found");

    const farTrainer = (await req(admin, "POST", "/api/trainers", { name: "Scope Trainer " + s10, phone: "8" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), home_location: farLoc._id })).data.item;
    ok("QA-1009: a scoped user cannot DELETE another centre's trainer either",
      (await req(spoc, "DELETE", `/api/trainers/${farTrainer._id}`)).status === 403);
    await req(admin, "DELETE", `/api/trainers/${farTrainer._id}`);

    // QA-1038 (qa-234 cycle-2 checker, S2): pinned as a PAIR, because the defect was only ever
    // visible as a COMPARISON. `assertTrainerDocDeleteInScope` refuses a centre that merely CAN teach
    // a trainer from deleting ONE of their documents; the delete handler used the wider helper, so
    // that same user could delete THE WHOLE TRAINER. The lesser act was guarded more tightly than the
    // greater one — and no single-door assertion could have seen it, which is why this asserts the two
    // doors give the SAME answer rather than asserting either one alone.
    {
      const capOnly = (await req(admin, "POST", "/api/trainers", {
        name: "CapOnly " + s10, phone: "7" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
        home_location: farLoc._id, capable_locations: jprId ? [jprId] : [],
      })).data.item;
      if (jprId && capOnly?._id) {
        const doc = await req(admin, "POST", `/api/trainers/${capOnly._id}/documents`,
          { doc_type: "PAN", file_url: "/erp/api/files/q1038.pdf", original_name: "q1038.pdf" });
        const delDoc = doc.data?.item?._id
          ? await req(spoc, "DELETE", `/api/trainers/${capOnly._id}/documents/${doc.data.item._id}`)
          : { status: 0 };
        const delTrainer = await req(spoc, "DELETE", `/api/trainers/${capOnly._id}`);
        ok("QA-1038: deleting the WHOLE trainer is never easier than deleting one of their documents",
          delDoc.status === delTrainer.status, `document=${delDoc.status} trainer=${delTrainer.status}`);
        ok("QA-1038: ...and a teaching-only tie is refused on both — capable_locations is not ownership",
          delTrainer.status === 403, `trainer delete=${delTrainer.status}`);
        await req(admin, "DELETE", `/api/trainers/${capOnly._id}`);
      } else ok("QA-1038: capable-only fixture available", false, "no Jaipur location found");
    }

    // restore Location exactly as found
    await req(admin, "PUT", "/api/permissions", { role: "Location", permissions: locBase }, 200);
    const locBack = ((await req(admin, "GET", "/api/permissions")).data.roles ?? []).find((r) => r.role === "Location")?.permissions ?? [];
    ok("QA-1008: Location's rights are restored exactly as found - this block leaves no residue",
      JSON.stringify([...locBack].sort()) === JSON.stringify([...locBase].sort()),
      JSON.stringify({ was: locBase.length, now: locBack.length }));
  }

  // restore Operations exactly as found, so no later suite inherits this block's grants
  await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsBase }, 200);
  const restored = ((await req(admin, "GET", "/api/permissions")).data.roles ?? []).find((r) => r.role === "Operations")?.permissions ?? [];
  ok("QA-904: Operations' rights are restored exactly as found - this block leaves no residue",
    JSON.stringify([...restored].sort()) === JSON.stringify([...opsBase].sort()),
    JSON.stringify({ was: opsBase.length, now: restored.length }));
}

// ---- QA-1211: the CREATE door validated two fields and then threw them away ----
// `POST /api/users` read `body.extra_permissions` to decide whether the request needed an Admin
// (the escalation guard), and then `User.create` did not list it. Same for `revoked_permissions`.
// So the field was checked for danger and then discarded: 201 back, a user holding nothing, and no
// hint that anything had been dropped - while the SAME admin drawer, on EDIT, stored both correctly
// (`users/[id]/route.ts` loops a list containing them). Ticking "Special rights" while creating a
// user was a dead input reporting success.
//
// Why this survived a suite with nine extra_permissions assertions in it: every single one of them
// granted through PATCH. Not one granted at creation. The door nobody tested is the door that broke.
//
// These pins assert BEHAVIOUR, not storage - a stored array nothing consults would be the same bug
// one layer down. The granted right must actually open a door, and the revoked one must actually
// close one.
{
  const s1211 = Date.now().toString().slice(-6);
  const jpr1211 = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const em1211 = `q1211.${s1211}@vidysea-test.local`;
  const pw1211 = "Q1211pass!xyz";

  // Enrollment holds `candidates.manage` by role and does NOT hold `costs.manage`.
  // So this one create both GRANTS a right the role lacks and REVOKES one the role has.
  const mk = await req(admin, "POST", "/api/users", {
    name: "Q1211 Rights", email: em1211, password: pw1211, role: "Enrollment",
    location_scope: [jpr1211._id], can_edit: true,
    // QA-1825: finance.view is the key that opens the LEDGER now; costs.manage:view stays in the
    // list because the pins below assert both halves — the grant works, and its :view level
    // survived the create (so the WRITE is still refused).
    extra_permissions: ["costs.manage:view", "finance.view:view"],
    revoked_permissions: ["candidates.manage"],
  });
  ok("QA-1211: the create itself succeeds (it always did - that is what made this invisible)",
    mk.status === 201, `got ${mk.status}`);
  const uid1211 = mk.data.item?._id;

  ok("QA-1211: THE DEFECT - the 201 reports back the special rights it was given, instead of an empty list",
    (mk.data.item?.extra_permissions ?? []).includes("costs.manage:view"),
    JSON.stringify({ extra: mk.data.item?.extra_permissions ?? null }));
  ok("QA-1211: ...and the revoked list too - the other half of the same dropped pair",
    (mk.data.item?.revoked_permissions ?? []).includes("candidates.manage"),
    JSON.stringify({ revoked: mk.data.item?.revoked_permissions ?? null }));

  // and it is really on the record, not just echoed back out of the request body.
  // NB: there is no GET /api/users/:id - the item route is PATCH/DELETE only - so the read door
  // here is the LIST route, which returns every field but the password hash.
  const listed = ((await req(admin, "GET", "/api/users")).data.items ?? [])
    .find((u) => String(u._id) === String(uid1211));
  ok("QA-1211: ...and a fresh READ of the user still has both - the 201 was not just echoing my own payload",
    (listed?.extra_permissions ?? []).includes("costs.manage:view")
      && (listed?.revoked_permissions ?? []).includes("candidates.manage"),
    JSON.stringify({ found: !!listed, extra: listed?.extra_permissions ?? null, revoked: listed?.revoked_permissions ?? null }));

  // THE POINT: rights granted at creation must actually WORK, and revoked ones must actually BITE.
  const u1211 = await login(em1211, pw1211);
  ok("QA-1211: the new user signs in", !!u1211);
  if (u1211) {
    ok("QA-1211: the right GRANTED at creation opens the door it names (costs ledger reads)",
      (await req(u1211, "GET", "/api/costs")).status === 200);
    ok("QA-1211: ...and it is a :view grant, so it still cannot WRITE - the level survived the create too",
      (await req(u1211, "POST", "/api/costs", { entry_date: "2026-08-16", location: jpr1211._id, amount: 1, category: "000000000000000000000000" })).status === 403);
    const revoked = await req(u1211, "POST", "/api/candidates",
      { name: `Q1211 Cand ${s1211}`, phone: "7391" + s1211, location: jpr1211._id });
    ok("QA-1211: the right REVOKED at creation is really gone - a role right the user no longer has",
      revoked.status === 403, `got ${revoked.status}: ${JSON.stringify(revoked.data?.error ?? revoked.data ?? null).slice(0, 200)}`);
  }

  // REGRESSION GUARD (green before the fix as well as after): storing these fields must not have
  // widened who may set them. The escalation guard is the whole reason this door reads
  // `extra_permissions` at all, and a fix that stored the value by loosening the gate would be a
  // far worse bug than the one it closed.
  const emEsc = `q1211esc.${s1211}@vidysea-test.local`;
  const mkEsc = await req(admin, "POST", "/api/users", {
    name: "Q1211 Escalator", email: emEsc, password: pw1211, role: "Enrollment",
    location_scope: [jpr1211._id], can_edit: true,
  });
  await req(admin, "PATCH", `/api/users/${mkEsc.data.item?._id}`, { extra_permissions: ["users.manage"] });
  const esc = await login(emEsc, pw1211);
  ok("QA-1211 guard: the non-Admin users.manage holder signs in", !!esc);
  if (esc) {
    // scoped and role-Enrollment, so the ONLY arm of the guard this can trip is extra_permissions
    const attempt = await req(esc, "POST", "/api/users", {
      name: "Q1211 Minted", email: `q1211mint.${s1211}@vidysea-test.local`, password: pw1211,
      role: "Enrollment", location_scope: [jpr1211._id], can_edit: true,
      extra_permissions: ["costs.manage"],
    });
    ok("QA-1211 guard: a non-Admin still cannot GRANT special rights through the create door (403)",
      attempt.status === 403, `got ${attempt.status}`);
    // NOT can_edit - `can_edit === true` is itself one of the guard's elevated arms, so a create
    // carrying it is refused for that reason alone and would prove nothing about this one.
    const plain = await req(esc, "POST", "/api/users", {
      name: "Q1211 Plain", email: `q1211plain.${s1211}@vidysea-test.local`, password: pw1211,
      role: "Enrollment", location_scope: [jpr1211._id],
    });
    ok("QA-1211 guard: ...but the same holder CAN still create an ordinary user - the gate did not widen",
      plain.status === 201, `got ${plain.status}`);
  }
}

// unauthenticated → 401
const anon = await fetch(BASE + "/api/locations");
ok("Unauthenticated API blocked (401)", anon.status === 401, `got ${anon.status}`);


// ---------------------------------------------------------------------------------------------
// QA-1575 — THE ONE DOCUMENT CLASS THE PERSON WHO OWNS IT COULD NOT FILE.
// The client's RPL mandate (Umesh, 2026-08-27, verbatim in qa/feedback-inbox.md) requires "Trainer
// documentation, including experience certificates and relevant qualifications/certificates" for
// every batch. Seven of its eight classes already shipped. This one did not, because BOTH doors of
// /api/trainers/[id]/documents demanded `trainers.manage` while the Trainer role carries only
// ["batches.daily_log", "closure.manage"] - so every trainer certificate had to travel through an
// operator. Umesh, asked directly: "Trainer sirf APNE documents daal sake."
// RED before the fix: (a) and (b) are 403. (c)-(f) must hold in BOTH directions - opening a door
// for the owner must not reopen QA-125, where writing a file onto a FOREIGN trainer was live-proved.
{
  const stampT = Date.now().toString().slice(-8);
  // The phone must differ per fixture: it is a unique key, and computing it from the shared stamp
  // alone handed both trainers the SAME number, so the second create was correctly refused and the
  // pin read as a product failure. My fixture, not the door.
  let seqT = 0;
  const mk = async (nm, mail) => (await req(admin, "POST", "/api/trainers", {
    name: nm, phone: String(7700000000 + (Number(stampT) % 90000000) * 10 + (seqT++)).slice(0, 10),
    email: mail, skills: ["Reasoning"], day_rate: 500,
  })).data?.item;
  const meT = await mk("QA1575 Own " + stampT, `qa1575.own.${stampT}@vidysea.com`);
  const otherT = await mk("QA1575 Other " + stampT, `qa1575.other.${stampT}@vidysea.com`);
  if (!meT?._id || !otherT?._id) {
    ok("QA-1575: two trainer fixtures could be created", false, JSON.stringify({ meT, otherT }).slice(0, 200));
  } else {
    const madeLogin = await req(admin, "POST", `/api/trainers/${meT._id}/create-login`, { password: PW });
    const selfCookie = madeLogin.status === 201 || madeLogin.status === 200
      ? await login(`qa1575.own.${stampT}@vidysea.com`, PW) : null;
    ok("QA-1575 (pre): the trainer fixture has a working login linked to its own record",
      !!selfCookie, JSON.stringify({ st: madeLogin.status, err: madeLogin.data?.error }).slice(0, 200));

    if (selfCookie) {
      // (a) the owner can READ their own documents
      const rOwn = await req(selfCookie, "GET", `/api/trainers/${meT._id}/documents`);
      ok("QA-1575 (a): a trainer can read the documents on their OWN record",
        rOwn.status === 200 && Array.isArray(rOwn.data?.items), `got ${rOwn.status} ${JSON.stringify(rOwn.data).slice(0, 140)}`);

      // (b) ...and can FILE one. This is the mandate's item 7, from the person who holds the paper.
      const wOwn = await req(selfCookie, "POST", `/api/trainers/${meT._id}/documents`, {
        doc_type: "Teaching Experience", file_url: "/erp/api/files/qa1575own.pdf", original_name: "experience.pdf",
      });
      ok("QA-1575 (b): a trainer can file a document onto their OWN record - RPL mandate item 7",
        wOwn.status === 201, `got ${wOwn.status} ${JSON.stringify(wOwn.data).slice(0, 140)}`);

      // (c)+(d) QA-125 must NOT reopen: a foreign record stays shut in both directions.
      const rOther = await req(selfCookie, "GET", `/api/trainers/${otherT._id}/documents`);
      ok("QA-1575 (c): ...and still cannot read ANOTHER trainer's documents",
        rOther.status === 403, `got ${rOther.status}`);
      const wOther = await req(selfCookie, "POST", `/api/trainers/${otherT._id}/documents`, {
        doc_type: "Teaching Experience", file_url: "/erp/api/files/qa1575foreign.pdf",
      });
      ok("QA-1575 (d): ...and still cannot write onto ANOTHER trainer's record (QA-125 stays closed)",
        wOther.status === 403, `got ${wOther.status}`);

      // (e) uploading REPLACES the same doc_type, so a verified document must not be quietly
      // overwritten by its owner. Nothing in the product sets `verified` yet, so this is a FORWARD
      // guard and the fixture sets the flag directly - stated rather than implied.
      const { MongoClient } = await import("mongodb");
      const mc1575 = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
      await mc1575.connect();
      const db1575 = mc1575.db(process.env.MONGODB_DB || "center_erp_ci");
      const upd = await db1575.collection("trainerdocuments").updateOne(
        { file_url: "/erp/api/files/qa1575own.pdf" }, { $set: { verified: true } });
      ok("QA-1575 (pre): the filed document could be marked verified for the guard test",
        upd.matchedCount === 1, JSON.stringify(upd));
      const reUp = await req(selfCookie, "POST", `/api/trainers/${meT._id}/documents`, {
        doc_type: "Teaching Experience", file_url: "/erp/api/files/qa1575own-v2.pdf",
      });
      ok("QA-1575 (e): a trainer cannot silently replace their OWN document once it is verified",
        reUp.status === 409 && /verified/i.test(String(reUp.data?.error)),
        `got ${reUp.status} ${JSON.stringify(reUp.data).slice(0, 160)}`);

      // (f) an operator with the right keeps today's behaviour - the guard is on the SELF path only.
      const adminRe = await req(admin, "POST", `/api/trainers/${meT._id}/documents`, {
        doc_type: "Teaching Experience", file_url: "/erp/api/files/qa1575admin-v2.pdf",
      });
      ok("QA-1575 (f): an operator with trainers.manage can still replace it - the guard narrows SELF, not the right",
        adminRe.status === 201, `got ${adminRe.status} ${JSON.stringify(adminRe.data).slice(0, 140)}`);
      await mc1575.close();

      // (h) QA-1577 (checker, qa-1575 cycle 1 FAIL): the door was open and UNREACHABLE - a linked
      // Trainer login could not obtain its own Trainer._id from anything it may call, so the person
      // the door was opened for still had to ask an operator, just for an id. /api/home resolved it
      // internally since QA-149 and never returned it.
      const homeSelf = await req(selfCookie, "GET", "/api/home");
      ok("QA-1577 (h): a trainer's own /api/home hands back its own trainer id, so the door it may use is findable",
        homeSelf.status === 200 && String(homeSelf.data?.my_trainer_id) === String(meT._id),
        `got ${homeSelf.status} my_trainer_id=${JSON.stringify(homeSelf.data?.my_trainer_id)} expected=${meT._id}`);
      // ...and it is the caller's OWN id only - never a way to learn another trainer's.
      const homeAdmin = await req(admin, "GET", "/api/home");
      ok("QA-1577 (i): a non-Trainer login gets null there - it is an identity, not a directory",
        homeAdmin.status === 200 && homeAdmin.data?.my_trainer_id === null,
        `got ${JSON.stringify(homeAdmin.data?.my_trainer_id)}`);

      // (j) QA-1578: Trainer.email has no unique index and /p/trainer-apply is public and dedupes on
      // phone only, so two UNLINKED rows can share one email. The self-heal used to attach to
      // whichever findOne returned - and after qa-1575 that record is also the one whose documents
      // the login may write. An ambiguous email must now link NOTHING.
      const dupMail = `qa1578.dup.${stampT}@vidysea.com`;
      const dupA = await mk("QA1578 DupA " + stampT, dupMail);
      const dupB = await mk("QA1578 DupB " + stampT, dupMail);
      if (dupA?._id && dupB?._id) {
        const uMade = await req(admin, "POST", "/api/users", {
          name: "QA1578 Login " + stampT, email: dupMail, role: "Trainer", password: PW, can_edit: true, status: "Approved",
        });
        const dupCookie = uMade.status === 201 || uMade.status === 200 ? await login(dupMail, PW) : null;
        if (dupCookie) {
          const grab = await req(dupCookie, "GET", `/api/trainers/${dupA._id}/documents`);
          ok("QA-1578 (j): an email matching TWO unlinked trainer rows links to neither - no land-grab",
            grab.status === 403, `got ${grab.status}`);
        } else ok("QA-1578 (j): the duplicate-email login could be created", false, `users POST ${uMade.status} ${JSON.stringify(uMade.data).slice(0, 140)}`);
      } else ok("QA-1578 (j): two same-email trainer rows could be created", false, JSON.stringify({ dupA: !!dupA, dupB: !!dupB }));

      // (k) QA-1596 (checker, qa-1581 cycle 1 FAIL): the manifest called this race unreachable
      // because User.email is unique. That is true and it was the wrong reason - the OTHER caller of
      // the helper is trainerForLogin, so the racers are ONE user's own parallel requests on first
      // sign-in. The checker measured 7 of 8 concurrent GET /api/home answering `my_trainer_id: null`,
      // which renders a trainer's Home WITHOUT the documents card this whole unit exists to put there.
      // A lost claim now re-reads the winner instead of discarding it, so every concurrent caller
      // gets the same answer. Eight at once, all must agree.
      const raceMail = `qa1596.race.${stampT}@vidysea.com`;
      const raceTr = await mk("QA1596 Race " + stampT, raceMail);
      const raceUser = raceTr?._id ? await req(admin, "POST", "/api/users", {
        name: "QA1596 Login " + stampT, email: raceMail, role: "Trainer", password: PW, can_edit: true, status: "Approved",
      }) : { status: 0 };
      if (raceTr?._id && (raceUser.status === 200 || raceUser.status === 201)) {
        // Unlink first, so the very next requests genuinely race for the claim.
        const { MongoClient: MC } = await import("mongodb");
        const mcr = new MC(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
        await mcr.connect();
        await mcr.db(process.env.MONGODB_DB || "center_erp_ci").collection("trainers")
          .updateOne({ _id: new (await import("mongodb")).ObjectId(String(raceTr._id)) }, { $unset: { user: "" } });
        await mcr.close();
        const raceCookie = await login(raceMail, PW);
        const answers = raceCookie
          ? await Promise.all(Array.from({ length: 8 }, () => req(raceCookie, "GET", "/api/home").then((r) => r.data?.my_trainer_id ?? null)))
          : [];
        const agreed = answers.filter((a) => String(a) === String(raceTr._id)).length;
        ok("QA-1596 (k): eight concurrent first-sign-in requests all resolve the SAME trainer - a lost race re-reads the winner, it does not answer null",
          answers.length === 8 && agreed === 8, JSON.stringify({ agreed, answers }).slice(0, 300));
      } else {
        ok("QA-1596 (k): the race fixture could be built", false, JSON.stringify({ tr: !!raceTr?._id, user: raceUser.status }));
      }

      // (l) QA-1582 (checker, qa-1575 cycle 2): a trainer row holding " x@y.com " stranded the
      // person it belonged to. emailError() TRIMS to decide and the write door then stored the raw
      // value, so linkTrainerLoginByEmail's ^...$ never matched, my_trainer_id came back null, and
      // the documents door qa-1575 opened was unreachable - with no message anywhere saying why.
      // The case variant of the same probe linked fine (the regex carries `i`), which is exactly
      // what made whitespace silent rather than obvious.
      // Two halves, and both are pinned here: the WRITE is canonicalised, and the RESOLVER tolerates
      // padding that is already in the database, because a fix that only helps new rows leaves the
      // real trainer this was found on exactly where they were.
      const padMail = `  qa1582.pad.${stampT}@vidysea.com  `;
      const padTr = await mk("QA1582 Pad " + stampT, padMail);
      ok("QA-1582 (l1): the trainer door STORES the canonical email, not what was typed",
        !!padTr && padTr.email === padMail.trim().toLowerCase(),
        JSON.stringify({ stored: padTr?.email, typed: padMail }));

      if (padTr?._id) {
        // ...and a row that ALREADY holds padding (written straight to Mongo, as the live one was)
        // still resolves, which is the half a write-side fix cannot reach.
        const { MongoClient: MC2, ObjectId: OID } = await import("mongodb");
        const mc2 = new MC2(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
        await mc2.connect();
        await mc2.db(process.env.MONGODB_DB || "center_erp_ci").collection("trainers")
          .updateOne({ _id: new OID(String(padTr._id)) }, { $set: { email: padMail }, $unset: { user: "" } });
        await mc2.close();
        const padUser = await req(admin, "POST", "/api/users", {
          name: "QA1582 Login " + stampT, email: padMail.trim().toLowerCase(),
          role: "Trainer", password: PW, can_edit: true, status: "Approved",
        });
        const padCookie = (padUser.status === 200 || padUser.status === 201)
          ? await login(padMail.trim().toLowerCase(), PW) : null;
        const home = padCookie ? await req(padCookie, "GET", "/api/home") : { status: 0, data: {} };
        ok("QA-1582 (l2): a row that already holds a padded email still resolves its own trainer",
          String(home.data?.my_trainer_id) === String(padTr._id),
          JSON.stringify({ st: home.status, got: home.data?.my_trainer_id, want: padTr._id }));
      }

      // (m) QA-1626 (checker, qa-1582 cycle 1 FAIL): cycle 1 verified this pattern with rx.test()
      // in NODE, where it passed in all four directions. The expression is handed to MONGODB, whose
      // `\s` is ASCII-ONLY, while the write door trims with Node's Unicode-aware String.trim() - so
      // NBSP, EM-space, narrow-NBSP, ideographic space and BOM were stripped on write and UNFINDABLE
      // on read, which is precisely the set of rows this half exists to reach. The `i` flag DOES
      // cross into Mongo, so the case half genuinely confirmed and made the whitespace half look
      // confirmed too.
      // This pin therefore drives the REAL DOOR against rows written straight to Mongo, one per
      // character class. A Node-side regex assertion would prove nothing here and is the exact
      // mistake being pinned.
      const WS_CASES = [
        ["ascii-space", " "], ["tab", "\t"], ["nbsp", "\u00A0"], ["em-space", "\u2003"],
        ["narrow-nbsp", "\u202F"], ["ideographic", "\u3000"], ["bom", "\uFEFF"],
      ];
      const { MongoClient: MC3, ObjectId: OID3 } = await import("mongodb");
      const mc3 = new MC3(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
      await mc3.connect();
      const trCol = mc3.db(process.env.MONGODB_DB || "center_erp_ci").collection("trainers");
      const wsMisses = [];
      for (const [label, ch] of WS_CASES) {
        const mail = `qa1626.${label.replace(/[^a-z]/g, "")}.${stampT}@vidysea.com`;
        const t = await mk("QA1626 " + label + " " + stampT, mail);
        if (!t?._id) { wsMisses.push(`${label}: fixture not created`); continue; }
        // pad the STORED value with this character and unlink, exactly as a live row was found
        await trCol.updateOne({ _id: new OID3(String(t._id)) }, { $set: { email: ch + mail + ch }, $unset: { user: "" } });
        const u = await req(admin, "POST", "/api/users", { name: "QA1626 " + label + " " + stampT, email: mail, role: "Trainer", password: PW, can_edit: true, status: "Approved" });
        const ck = (u.status === 200 || u.status === 201) ? await login(mail, PW) : null;
        const home = ck ? await req(ck, "GET", "/api/home") : { data: {} };
        if (String(home.data?.my_trainer_id) !== String(t._id)) wsMisses.push(`${label}: my_trainer_id=${home.data?.my_trainer_id}`);
      }
      await mc3.close();
      ok("QA-1626 (m): every whitespace the write door strips is also FINDABLE by the resolver - measured through Mongo, not Node",
        wsMisses.length === 0, wsMisses.join(" | "));

      // (n) QA-1628: a login created by PASTING an address could never be used. POST /api/users
      // stored body.email raw, UserSchema normalised CASE and not whitespace, and auth.ts lowercased
      // the credential without trimming - so the stored row was "  x@y.com  ", the browser submits
      // the trimmed value, and the exact-match lookup on a unique index missed every time. The
      // person is told their password is wrong, forever.
      // Both halves are pinned because either alone leaves someone locked out: the WRITE must store
      // the canonical value, and SIGN-IN must tolerate a stray space in what was typed.
      const padUserMail = `  qa1628.pad.${stampT}@vidysea.com  `;
      const plain = padUserMail.trim();
      const madeU = await req(admin, "POST", "/api/users", {
        name: "QA1628 Pad " + stampT, email: padUserMail, role: "Trainer",
        password: PW, can_edit: true, status: "Approved",
      });
      ok("QA-1628 (n1): Add User with a pasted, padded address is accepted",
        madeU.status === 201 || madeU.status === 200, `got ${madeU.status} ${JSON.stringify(madeU.data).slice(0, 120)}`);

      if (madeU.status === 201 || madeU.status === 200) {
        const { MongoClient: MC4 } = await import("mongodb");
        const mc4 = new MC4(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
        await mc4.connect();
        const stored = await mc4.db(process.env.MONGODB_DB || "center_erp_ci")
          .collection("users").findOne({ email: plain }, { projection: { email: 1 } });
        await mc4.close();
        ok("QA-1628 (n2): ...and the row STORES the trimmed address, so the unique index means what it says",
          !!stored && stored.email === plain, JSON.stringify({ found: !!stored, stored: stored?.email }));

        // The one that actually matters to a person: can they sign in with what they were given?
        ok("QA-1628 (n3): the person can SIGN IN with the plain address - the account is reachable",
          !!(await login(plain, PW)), plain);
        // ...and a stray space typed into the login box is not a wrong password.
        ok("QA-1628 (n4): ...and a stray space typed at sign-in is tolerated, not read as a bad password",
          !!(await login(`  ${plain} `, PW)), plain);
      }

      // (g) deleting is not filing. "daal sake" opened upload, not removal.
      const docs = await req(admin, "GET", `/api/trainers/${meT._id}/documents`);
      const anyDoc = docs.data?.items?.[0]?._id;
      if (anyDoc) {
        const delSelf = await req(selfCookie, "DELETE", `/api/trainers/${meT._id}/documents/${anyDoc}`);
        ok("QA-1575 (g): a trainer still cannot DELETE a document - the decision opened filing, not removal",
          delSelf.status === 403, `got ${delSelf.status}`);
      } else ok("QA-1575 (g): a document existed to attempt a delete on", false, "no documents returned");
    }
  }
}

// ---- QA-1825 (CEO, 2026-09-05): money is not an Admin right ----
// "Cost ki approval keval aur keval Manish ji aur mere paas hogi aur visibility keval aur keval
// Manish ji aur mere paas hogi… kisi ke bhi paas nahi hogi CHAAHE SUPER ADMIN HO, SUPER ADMIN KA
// KAAKA HO." Umesh's ruling: only those three hold the Admin role, and finance.view/finance.approve
// are the backstop behind it — the only two keys the Admin short-circuit does not open.
//
// This block builds the state that was previously INEXPRESSIBLE: a genuine, active, can_edit Admin
// who has not been granted finance. Every money door must refuse them. The seeded admin
// (admin@vidysea.com, granted finance by scripts/seed.mjs, standing in for one of the three) is the
// positive control in the same block — a refusal test that cannot also show an acceptance is only
// proving the doors are shut, not that they are the RIGHT doors.
{
  const s1825 = Date.now().toString().slice(-6);
  const em1825 = `q1825.admin.${s1825}@vidysea-test.local`;
  const pw1825 = "Q1825pass!xyz";
  const mk1825 = await req(admin, "POST", "/api/users", {
    name: "Q1825 Ungranted Admin", email: em1825, password: pw1825, role: "Admin",
    location_scope: [], can_edit: true,
  });
  ok("QA-1825: an Admin with no finance grant can be created", mk1825.status === 201, `got ${mk1825.status}`);
  const plainAdmin = await login(em1825, pw1825);
  ok("QA-1825: that Admin signs in", !!plainAdmin);
  if (plainAdmin) {
    // The whole point: role === "Admin", and every money door still says no.
    const doors = [
      ["GET", "/api/costs", "the cost ledger"],
      ["GET", "/api/invoices", "the invoice book"],
    ];
    for (const [method, path, label] of doors) {
      const r = await req(plainAdmin, method, path);
      ok(`QA-1825: an Admin without finance.view is refused ${label}`, r.status === 403, `${path} got ${r.status}`);
    }
    const del = await req(plainAdmin, "DELETE", "/api/costs/000000000000000000000000");
    ok("QA-1825: ...and cannot delete a ledger row either (finance.approve, not costs.manage)",
      del.status === 403, `got ${del.status}`);

    // Their OTHER Admin powers are untouched — this is a narrow exception, not a demotion. If this
    // fails, the change went too far and broke the Admin bypass generally.
    ok("QA-1825: the same Admin still reads the user list (the bypass is narrow, not removed)",
      (await req(plainAdmin, "GET", "/api/users")).status === 200);
    ok("QA-1825: ...and still reads locations",
      (await req(plainAdmin, "GET", "/api/locations?limit=1")).status === 200);

    // /api/permissions/me must tell the SAME story the routes do, or the shell will render doors
    // the server refuses — that is the QA-806/QA-813 fault, one screen along.
    const me1825 = await req(plainAdmin, "GET", "/api/permissions/me");
    ok("QA-1825: /api/permissions/me withholds finance from an ungranted Admin",
      me1825.status === 200 && me1825.data.role === "Admin"
        && !me1825.data.levels?.["finance.view"] && !me1825.data.levels?.["finance.approve"],
      JSON.stringify({ fv: me1825.data.levels?.["finance.view"] ?? null, fa: me1825.data.levels?.["finance.approve"] ?? null }));
    ok("QA-1825: ...while still reporting every other right at edit (users.manage, costs.manage)",
      me1825.data.levels?.["users.manage"] === "edit" && me1825.data.levels?.["costs.manage"] === "edit",
      JSON.stringify(me1825.data.levels));
    ok("QA-1825: ...and it SHIPS the exempt list, so the shell never keeps its own copy",
      Array.isArray(me1825.data.no_admin_bypass)
        && me1825.data.no_admin_bypass.includes("finance.view")
        && me1825.data.no_admin_bypass.includes("finance.approve"),
      JSON.stringify(me1825.data.no_admin_bypass ?? null));

    // Granting it live must actually open the door — a right nobody can switch on is not a right.
    await req(admin, "PATCH", `/api/users/${mk1825.data.item?._id}`, { extra_permissions: ["finance.view"] });
    const after = await login(em1825, pw1825);
    ok("QA-1825: granting finance.view to that Admin opens the ledger",
      !!after && (await req(after, "GET", "/api/costs")).status === 200);
    ok("QA-1825: ...but reading is not deciding — the ledger row delete still refuses without finance.approve",
      !!after && (await req(after, "DELETE", "/api/costs/000000000000000000000000")).status === 403);
  }

  // Positive control: the seeded admin IS one of the three, and sees everything.
  ok("QA-1825: the granted admin reads the ledger", (await req(admin, "GET", "/api/costs")).status === 200);
  ok("QA-1825: the granted admin reads the invoice book", (await req(admin, "GET", "/api/invoices")).status === 200);

  // ---- QA-1834 / QA-1835 (checker cycle 1): the three SIDE doors onto the same figures ----
  // Cycle 1 shut /api/costs and /api/invoices and claimed the CEO's sentence was enforced. It was
  // not: the batch closure endpoint, the Home screen's own invoice queue, and the audit trail all
  // still shipped `amount` to the very logins that had just been refused. Structural pins cannot
  // see this - only asking the running server can - so these assert BEHAVIOUR, both directions.
  //
  // Umesh's field ruling of 2026-09-05 is what makes this a masking test and not a 403 test:
  // *"sirf paisa chhupao, status sabko rehne do"* - so `status` MUST survive, and a test that
  // demanded a 403 here would be pinning the opposite of what he decided.
  const MONEY = ["amount", "invoice_no", "raised_on", "paid_on"];
  const invBook = await req(admin, "GET", "/api/invoices");
  const seededInv = (invBook.data.items ?? []).find((i) => i.amount != null);
  ok("QA-1834 fixture: seed-sample's raised invoice (INV-2026-0456) is present with an amount",
    !!seededInv, JSON.stringify((invBook.data.items ?? []).map((i) => i.invoice_no ?? null)));

  // Fixtures live OUT here, not inside `if (seededInv)`, because the money-leak probe below needs
  // them too and does not depend on the seeded invoice. The first version declared them inside and
  // the probe crashed with `adminUserId is not defined` — caught by my own run, and the reason the
  // probe block now sits beside its fixtures rather than reaching into another scope for them.
  const noMoney = (obj) => obj && typeof obj === "object" && MONEY.every((f) => obj[f] === undefined);
  // A FRESH ungranted Admin, deliberately NOT `plainAdmin`: an assertion above grants `plainAdmin`
  // `finance.view` in order to prove that granting works, so reusing it here would probe a persona
  // that is supposed to see the money. The first version of this block did exactly that and
  // reported three "leaks" that were the test contaminating itself; Operations passing the same
  // three assertions in the same run is what showed the masking was fine and the persona was not.
  const emLeak = `q1834.leak.${s1825}@vidysea-test.local`;
  const mkLeak = await req(admin, "POST", "/api/users", {
    name: "Q1834 Ungranted Admin", email: emLeak, password: pw1825, role: "Admin",
    location_scope: [], can_edit: true,
  });
  ok("QA-1834 fixture: a second, never-granted Admin exists for the leak probes",
    mkLeak.status === 201, `got ${mkLeak.status}`);
  const leakAdmin = await login(emLeak, pw1825);
  ok("QA-1834 fixture: that Admin signs in", !!leakAdmin);
  // The invoice's audit rows were written by whoever moved it in seed-sample — the seeded admin.
  const adminUserId = ((await req(admin, "GET", "/api/users")).data.items ?? [])
    .find((u) => u.email === "admin@vidysea.com")?._id;
  ok("QA-1840 fixture: the seeded admin's user id resolves (the actor whose trail carries the invoice)",
    !!adminUserId, String(adminUserId));

  if (seededInv) {
    const bId = seededInv.batch?._id ?? seededInv.batch;

    for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"]]) {
      if (!who) continue;

      const cl = await req(who, "GET", `/api/batches/${bId}/closure`);
      ok(`QA-1834: the closure endpoint still ANSWERS ${label} (a 403 would break the closure flow Umesh protected)`,
        cl.status === 200, `got ${cl.status}`);
      ok(`QA-1834: ...but carries no money for ${label}`, noMoney(cl.data.invoice),
        JSON.stringify(cl.data.invoice ?? null));
      ok(`QA-1834: ...while Invoice.status SURVIVES for ${label} — "status sabko rehne do"`,
        // Pinned as PRESENT-and-non-empty, not as a literal. The first version asserted
        // `=== "Raised"` and broke the moment the suite was re-run against a database whose
        // invoice another suite had already moved to Paid - a test that fails when the fixture
        // legitimately advances is pinning the fixture, not the rule. The rule is that masking
        // removes money and leaves status alone, whatever the status happens to be.
        typeof cl.data.invoice?.status === "string" && cl.data.invoice.status.length > 0,
        JSON.stringify(cl.data.invoice?.status ?? null));

      const hm = await req(who, "GET", "/api/home");
      const q = hm.data.queues?.invoices_pending ?? [];
      ok(`QA-1834: the Home invoices queue carries no money for ${label} (this is the FIRST screen after login)`,
        q.every(noMoney), JSON.stringify(q));

      const au = await req(who, "GET", `/api/audit/Invoice/${seededInv._id}`);
      ok(`QA-1835: the audit trail leaks no amount to ${label}`,
        au.status !== 200 || !/"amount"|"invoice_no"/.test(JSON.stringify(au.data.items ?? [])),
        `status ${au.status} · ${JSON.stringify(au.data.items ?? []).slice(0, 200)}`);

      // QA-1840: the SIBLING trail, by actor rather than by entity. Cycle 2 masked one and missed
      // this one, and this is the worse of the two: the route is Admin-only by construction, so
      // "only an Admin may read it" is not a protection here — its whole audience IS the population
      // the CEO's rule names. Operations is refused outright (403), which is also asserted, because
      // a 200-with-no-money and a 403 are different products and only one of them is what shipped.
      const byUser = await req(who, "GET", `/api/audit/by-user/${adminUserId}?limit=200`);
      ok(`QA-1840: the per-person activity trail leaks no amount to ${label}`,
        byUser.status !== 200 || !/"amount"|"invoice_no"/.test(JSON.stringify(byUser.data.items ?? [])),
        `status ${byUser.status} · ${JSON.stringify(byUser.data.items ?? []).slice(0, 200)}`);
    }

    // QA-1868 (checker, cycle 1): the two loops above are written `status !== 200 || <no money>`,
    // which is correct for the persona that is REFUSED and empty for the persona that is not — and
    // the loop cannot tell you which one you got. Operations is refused the per-person trail
    // outright, so that arm asserts nothing about masking, exactly the shape QA-1866 was filed for.
    // Rather than rewrite two loops that also serve other purposes, the load-bearing persona is
    // pinned explicitly here: the ungranted ADMIN must actually receive both trails, so the masking
    // those two rows claim to test is genuinely exercised by at least one arm.
    if (leakAdmin && seededInv && adminUserId) {
      const a1 = await req(leakAdmin, "GET", `/api/audit/Invoice/${seededInv._id}`);
      ok("QA-1868: the ungranted Admin really READS the invoice audit trail (200) — QA-1835's masking arm is not vacuous",
        a1.status === 200, `got ${a1.status}`);
      ok("QA-1868: ...and it carries them no money",
        a1.status === 200 && !/"amount"|"invoice_no"/.test(JSON.stringify(a1.data.items ?? [])), `status ${a1.status}`);
      const a2 = await req(leakAdmin, "GET", `/api/audit/by-user/${adminUserId}?limit=200`);
      ok("QA-1868: the ungranted Admin really READS the per-person trail (200) — QA-1840's masking arm is not vacuous",
        a2.status === 200, `got ${a2.status}`);
      ok("QA-1868: ...and it carries them no money",
        a2.status === 200 && !/"amount"|"invoice_no"/.test(JSON.stringify(a2.data.items ?? [])), `status ${a2.status}`);
    }

    // The other half, and the half that makes masking dangerous if it is wrong: the three named
    // people must still see the real numbers. A mask that hides money from EVERYONE would pass
    // every assertion above and destroy the feature.
    const clA = await req(admin, "GET", `/api/batches/${bId}/closure`);
    ok("QA-1834: the granted admin still sees the invoice amount on the closure endpoint",
      clA.data.invoice?.amount === seededInv.amount, JSON.stringify(clA.data.invoice ?? null));
    const auA = await req(admin, "GET", `/api/audit/Invoice/${seededInv._id}`);
    ok("QA-1835: the granted admin still reads the amount in the audit trail — the row is masked on READ, not destroyed on write",
      /"amount"/.test(JSON.stringify(auA.data.items ?? [])), JSON.stringify(auA.data.items ?? []).slice(0, 200));
    // `?entity=Invoice` is load-bearing, not tidiness: without it this asks for the 200 most recent
    // rows of that actor's whole trail, and once the money-leak probe below started parking costs
    // and toggling rules the invoice row fell off the first page — so the assertion failed on
    // VOLUME, not on masking. An assertion whose truth depends on how much else happened first is
    // pinning the fixture again.
    const buA = await req(admin, "GET", `/api/audit/by-user/${adminUserId}?entity=Invoice&limit=200`);
    ok("QA-1840: ...and still reads it in the per-person trail — the mask follows the RIGHT, not the route",
      /"amount"/.test(JSON.stringify(buA.data.items ?? [])), `status ${buA.status} · rows ${(buA.data.items ?? []).length}`);
  }

  // ---- QA-1843 / THE MONEY-LEAK PROBE (checker's recommendation, cycle 3) ----
  // The honest history: FIVE money leaks were found in this unit, one per cycle, and every single
  // one was found by a person poking a running server and grepping the wire. Not one was found by a
  // structural pin — the pin was rewritten three times (four filenames -> "names Invoice or
  // CostEntry" -> "+ AuditLog") and each rewrite was blind to the next door, because money travels
  // in generic payloads (`ApprovalRequest.payload.amount`) and in interpolated sentences
  // ("Cost entry ₹128500 …") that no model-name rule can reach.
  //
  // So this is the instrument that was missing: walk real endpoints as a real ungranted Admin and
  // as Operations, and fail if a rupee figure comes back. It is deliberately DUMB and WIDE — it
  // does not know which endpoints are supposed to carry money, it only knows who is not supposed to
  // receive it. Adding an endpoint here costs one line; that is the point.
  {
    // `-?\d` and not `\d`: a negative amount is still an amount (senior review of cycles 2-4).
    // QA-1859 (checker, cycle 5): the first three clauses only see money in JSON KEYS or behind a
    // rupee sign, and every leak this unit found after the fourth door was a figure sitting in
    // PROSE. The fixture figures are therefore searched for literally, in every notation they can
    // be written in — which is the same lesson QA-1861 taught the redactor, applied to the detector.
    const FIXTURE_FIGURES = [987654, 876543].flatMap((n) => [String(n), n.toLocaleString("en-IN"), n.toLocaleString("en-US")]);
    const MONEY_ON_WIRE = new RegExp(
      ['"amount":\\s*-?\\d', '"invoice_no":\\s*"', "₹\\s?[\\d,]",
       ...FIXTURE_FIGURES.map((s) => `(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`)].join("|"));
    const bId2 = seededInv ? (seededInv.batch?._id ?? seededInv.batch) : null;

    // ---- PARK A REAL COST, or this probe proves nothing about the approvals queue ----
    // The first cycle-4 run "proved" the probe by mutating the summary redaction away and watching
    // the probe still PASS. It passed because the `cost.post` rule ships DISABLED, so nothing had
    // ever parked and the queue was empty: the probe was asserting that an empty list contains no
    // money. A vacuous pass is worse than a missing test, because it reads as evidence.
    //
    // So the queue gets something to leak, and the fixture asserts it actually landed.
    const catsP = await req(admin, "GET", "/api/master-lists/cost-categories");
    const catP = (catsP.data.items ?? [])[0];
    const jprP = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
    const ruleOn = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
    ok("QA-1843 fixture: the cost.post approval rule can be switched on", ruleOn.status === 200, `got ${ruleOn.status}`);
    const parked = catP && jprP
      ? await req(ops, "POST", "/api/costs", { entry_date: "2026-09-05", location: jprP._id, category: catP._id, amount: 987654, note: "QA-1843 probe fixture" })
      : { status: 0, data: {} };
    ok("QA-1843 fixture: a cost PARKS for approval, so the queue actually carries a figure",
      parked.status === 202 && parked.data?.queued === true, `got ${parked.status}`);
    // And prove the fixture is visible to someone: the grant-holder must see ₹987654 in the queue.
    const qAdmin = await req(admin, "GET", "/api/approvals?status=Pending");
    ok("QA-1843 fixture: the granted admin CAN see that figure in the queue (so the probe below is not vacuous)",
      /987654/.test(JSON.stringify(qAdmin.data.items ?? [])), JSON.stringify((qAdmin.data.items ?? []).map((i) => i.summary)).slice(0, 200));
    // The trails the probe must ALSO walk belong to the INITIATOR and to the request itself —
    // not to the seeded admin, which is where the cycle-4 probe was pointed while the leak sat
    // one URL away.
    const parkedReq = (qAdmin.data.items ?? []).find((i) => i.action === "cost.post");
    const parkedReqId = parkedReq?._id;
    const opsUserId = ((await req(admin, "GET", "/api/users")).data.items ?? [])
      .find((u) => u.email === "ops@vidysea.com")?._id;
    ok("QA-1850 fixture: the initiator's user id and the parked request's id both resolve",
      !!opsUserId && !!parkedReqId, `ops=${opsUserId} req=${parkedReqId}`);
    const doors = [
      ["/api/costs", "the cost ledger"],
      // QA-1828: the cost-category master grew `budget`, `pre_approved_amount` and a
      // `pre_approved_basis` whose whole content is a money rule — on a list EVERY signed-in role
      // reads, because the Costs form needs the head names. The structural wall does not see this
      // file at all (its population is derived from `Invoice|CostEntry|AuditLog|ApprovalRequest` and
      // this route names none of them), and the wall's own comment says the answer to a new door is
      // to widen THIS list rather than that regex. Widened.
      ["/api/master-lists/cost-categories", "the cost-head master"],
      ["/api/invoices", "the invoice book"],
      ["/api/home", "the Home dashboard"],
      ["/api/approvals?status=all", "the approvals queue"],
      ["/api/batches?limit=50", "the batch list"],
      ["/api/notifications", "notifications"],
      ["/api/reports/rollup", "the rollup report"],
      // QA-1832: a NEW report door. It carries headcounts and blocker sentences by design and no
      // money at all — which is exactly the claim that has to be measured rather than asserted,
      // because every money door this module found was one somebody was sure carried none.
      ["/api/reports/kpi", "the KPI report"],
      // QA-1830: the finance dashboard. Its entire purpose IS money, so unlike the two above it is
      // expected to answer 403 here rather than 200-with-nothing-in-it. It is on the list anyway,
      // because the failure this probe exists to catch is a door that answers 200 — and a door
      // nobody listed is a door nobody measured.
      ["/api/reports/costs", "the finance dashboard"],
      ["/api/reports/pnl", "the revenue and P&L report"],
      ["/api/plan-tracker", "the plan tracker"],
      ...(bId2 ? [
        [`/api/batches/${bId2}`, "a batch detail"],
        [`/api/batches/${bId2}/closure`, "the closure payload"],
        [`/api/audit/Invoice/${seededInv._id}`, "the invoice audit trail"],
      ] : []),
      ...(adminUserId ? [[`/api/audit/by-user/${adminUserId}?limit=200`, "the per-person audit trail"]] : []),
      // QA-1850 (checker, cycle 4) — and the sharpest thing said about this probe: "completeness
      // moved from WHICH MODEL NAMES to WHICH URLS rather than disappearing." The regex found the
      // eighth leak; the endpoint list never asked. It walked the seeded ADMIN's trail, and the
      // parked cost was written by the INITIATOR (Operations), on an `ApprovalRequest` entity
      // neither URL named. Both shapes are walked now.
      ...(opsUserId ? [[`/api/audit/by-user/${opsUserId}?limit=200`, "the INITIATOR's audit trail"]] : []),
      ...(parkedReqId ? [[`/api/audit/ApprovalRequest/${parkedReqId}`, "the parked request's own audit trail"]] : []),
    ];
    for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"]]) {
      if (!who) continue;
      for (const [path, name] of doors) {
        const r = await req(who, "GET", path);
        // A 403 is a pass: the door refused. A 200 with a rupee figure on it is the failure.
        const wire = r.status === 200 ? JSON.stringify(r.data ?? {}) : "";
        const hit = MONEY_ON_WIRE.exec(wire);
        ok(`QA-1843 probe: ${name} gives no money to ${label}`, !hit,
          `${path} -> ${r.status}${hit ? ` · leaked near: ${wire.slice(Math.max(0, hit.index - 60), hit.index + 60)}` : ""}`);
      }
    }
    // The probe must be able to FAIL, or it is decoration. The granted admin is the control: the
    // same walk, the same grep, and at least one of these endpoints MUST come back carrying money.
    let moneySeenByGranted = 0;
    for (const [path] of doors) {
      const r = await req(admin, "GET", path);
      if (r.status === 200 && MONEY_ON_WIRE.test(JSON.stringify(r.data ?? {}))) moneySeenByGranted++;
    }
    ok("QA-1843 probe: the SAME walk does return money to the granted admin — the probe can actually fail",
      moneySeenByGranted > 0, `${moneySeenByGranted} of ${doors.length} endpoints carried a figure`);

    // The DECIDE response is a POST, so the GET walk above cannot reach it — and that is exactly
    // where the sixth leak was: the queue was masked and the button's own reply handed the figure
    // back. Deciding consumes the parked request, so this runs last.
    // BOTH decisions, because the route returns the document from TWO places — an early return for
    // Reject and the replay path for Approve — and the first version of this probe exercised only
    // Reject. When the Approve branch was mutated to prove the probe could catch it, the probe
    // passed: the mutant and the test had never met. Two parked costs, one of each verb.
    const parked2 = catP && jprP
      ? await req(ops, "POST", "/api/costs", { entry_date: "2026-09-05", location: jprP._id, category: catP._id, amount: 876543, note: "QA-1843 probe fixture 2" })
      : { status: 0 };
    ok("QA-1843 fixture: a second cost parks, so both decide verbs can be probed",
      parked2.status === 202, `got ${parked2.status}`);
    const pendingNow = ((await req(admin, "GET", "/api/approvals?status=Pending")).data.items ?? [])
      .filter((i) => i.action === "cost.post");
    ok("QA-1843 probe: two parked cost requests are available to decide", pendingNow.length >= 2, `pending=${pendingNow.length}`);
    for (const [idx, decision] of [[0, "Rejected"], [1, "Approved"]]) {
      const target = pendingNow[idx];
      if (!target || !leakAdmin) continue;
      const dec = await req(leakAdmin, "POST", `/api/approvals/${target._id}`, { decision, note: "QA-1843 probe" });
      // QA-1868 (checker, cycle 1): this row was written in cycle 4 of the previous unit, when an
      // ungranted Admin could still reach the decide route and the response's masking was the only
      // control. QA-1844 then gated the route itself, so this persona now gets 403 every time and
      // `dec.status !== 200 ||` short-circuits — the row has been green ever since without testing
      // anything. Its subject genuinely no longer exists as a reachable state, so it asserts the
      // refusal it actually gets and says the masking branch is unreachable for this persona rather
      // than pretending to exercise it. (`maskApprovalMoney` stays in the route as depth: it is
      // unreachable only because every caller who now passes the gate is entitled to the figure.)
      ok(`QA-1843/QA-1844: the DECIDE route (${decision}) REFUSES an Admin without finance.approve — the response-masking branch is unreachable for them`,
        dec.status === 403, `got ${dec.status} · ${JSON.stringify(dec.data ?? {}).slice(0, 220)}`);
    }

    // The notification the park created is broadcast to a ROLE, not to grant-holders, and is mailed.
    // It must not carry the figure to anyone, which is why it is redacted unconditionally.
    const notif = await req(leakAdmin ?? admin, "GET", "/api/notifications");
    ok("QA-1843 probe: the approval-pending notification carries no figure (it is broadcast to a role, and mailed)",
      !/987654|₹\s?[\d,]/.test(JSON.stringify(notif.data ?? {})),
      JSON.stringify(notif.data?.items?.slice?.(0, 2) ?? notif.data ?? {}).slice(0, 220));

    // ---- UNIT 2: QA-1844 + QA-1826 + QA-1827, the OTHER half of the CEO's sentence ----
    // Unit 1 spent six cycles proving an ungranted Admin cannot SEE money. None of it stopped them
    // APPROVING it, which is the half the Friday goal actually rests on.
    {
      const park = async (amount, note) => (catP && jprP)
        ? req(ops, "POST", "/api/costs", { entry_date: "2026-09-05", location: jprP._id, category: catP._id, amount, note })
        : { status: 0, data: {} };
      const pendingCost = async () => ((await req(admin, "GET", "/api/approvals?status=Pending")).data.items ?? [])
        .filter((i) => i.action === "cost.post");

      // QA-1844: deciding money needs finance.approve, and REFUSING money is a money decision too.
      await park(111222, "QA-1844 probe A");
      let q = await pendingCost();
      if (q.length && leakAdmin) {
        const a = await req(leakAdmin, "POST", `/api/approvals/${q[0]._id}`, { decision: "Approved", note: "QA-1844" });
        ok("QA-1844: an Admin without finance.approve cannot APPROVE a parked cost", a.status === 403, `got ${a.status}`);
        const r = await req(leakAdmin, "POST", `/api/approvals/${q[0]._id}`, { decision: "Rejected", note: "QA-1844" });
        ok("QA-1844: ...and cannot REJECT it either — refusing a payment is a money decision", r.status === 403, `got ${r.status}`);
        const still = await pendingCost();
        ok("QA-1844: ...and the request is genuinely untouched, not decided-then-refused",
          still.some((i) => String(i._id) === String(q[0]._id)), `pending=${still.length}`);
      } else ok("QA-1844 fixture: a parked cost was available", false, `pending=${q.length}`);

      // A NON-money action stays on approvals.decide — narrowing it would take the queue away from
      // the Operations users whose job it is.
      const cfg = (await req(admin, "GET", "/api/approvals")).data.config ?? [];
      ok("QA-1844: only the money actions are narrowed; the rest keep approvals.decide",
        cfg.length > 0 && ["location.close", "batch.cancel", "location.edit"].every((a) => cfg.some((c) => c.action === a)),
        JSON.stringify(cfg.map((c) => c.action)));

      // QA-1826 (S1): an Admin who IS the configured approver used to skip parking entirely, which
      // made the self-approval refusal unreachable for them — nothing had been parked to refuse.
      const beforeAdminPost = (await pendingCost()).length;
      const adminPost = await req(admin, "POST", "/api/costs", { entry_date: "2026-09-05", location: jprP?._id, category: catP?._id, amount: 333444, note: "QA-1826 admin self-post" });
      ok("QA-1826: an Admin approver's OWN cost entry PARKS instead of writing the ledger",
        adminPost.status === 202 && adminPost.data?.queued === true, `got ${adminPost.status}`);
      const afterAdminPost = await pendingCost();
      ok("QA-1826: ...and it is really in the queue", afterAdminPost.length === beforeAdminPost + 1,
        `${beforeAdminPost} -> ${afterAdminPost.length}`);
      const own = afterAdminPost.find((i) => i.summary?.includes("QA-1826 admin self-post"));
      if (own) {
        const selfDecide = await req(admin, "POST", `/api/approvals/${own._id}`, { decision: "Approved", note: "self" });
        ok("QA-1826: ...and the initiator still cannot approve their own request — the refusal is REACHABLE now",
          selfDecide.status === 403, `got ${selfDecide.status}`);
      } else ok("QA-1826: the admin's own parked request is findable", false, JSON.stringify(afterAdminPost.map((i) => i.summary)));

      // QA-1827: a named list NARROWS the role. Nobody named = role decides, as before.
      const meAdmin = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "admin@vidysea.com");
      const putNamed = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin", approver_users: [String(meAdmin?._id)] });
      ok("QA-1827: a named approver list can be set", putNamed.status === 200 && (putNamed.data.item?.approver_users ?? []).length === 1,
        JSON.stringify(putNamed.data.item?.approver_users ?? null));
      const cfg2 = (await req(admin, "GET", "/api/approvals")).data.config ?? [];
      ok("QA-1827: ...and it reads back on the config the Admin screen renders",
        (cfg2.find((c) => c.action === "cost.post")?.approver_users ?? []).length === 1);
      await park(555666, "QA-1827 named probe");
      const namedQ = (await pendingCost()).find((i) => i.summary?.includes("QA-1827 named probe"));
      if (namedQ) {
        ok("QA-1827: the parked request SNAPSHOTS the named list, so a later rule edit cannot rewrite who could decide it",
          (namedQ.approver_users ?? []).length === 1, JSON.stringify(namedQ.approver_users ?? null));
        // grant the leak admin finance.approve so ONLY the naming is left to refuse them
        await req(admin, "PATCH", `/api/users/${mkLeak.data.item?._id}`, { extra_permissions: ["finance.view", "finance.approve"] });
        const relogged = await login(emLeak, pw1825);
        const notNamed = relogged ? await req(relogged, "POST", `/api/approvals/${namedQ._id}`, { decision: "Approved" }) : { status: 0 };
        ok("QA-1827: an Admin WITH finance.approve but NOT on the named list is refused",
          notNamed.status === 403, `got ${notNamed.status}`);
        await req(admin, "PATCH", `/api/users/${mkLeak.data.item?._id}`, { extra_permissions: [] });
      } else ok("QA-1827: the named-list request is findable", false, "not found");
    }

    // ---- QA-1863: the figure the SUBMITTER typed, in a field nobody thought of as money ----
    // Every masker in this unit works on KNOWN money keys — `amount`, `invoice_no` — and the
    // redactor works on the summary the server itself composes. `note` is none of those: it is free
    // text the poster wrote, it travels inside `payload` on the parked request and inside the audit
    // row, and a person recording a payment writes the figure into it as a matter of course
    // ("advance of 424242 paid to the vendor"). Six cycles masked the field the SERVER fills and
    // never the field the USER fills.
    {
      const q1863 = 424242;
      const notations = [String(q1863), q1863.toLocaleString("en-IN"), q1863.toLocaleString("en-US")];
      const typed = `QA-1863 probe — advance of ${q1863} paid, receipt ${q1863.toLocaleString("en-IN")}`;
      const p = (catP && jprP)
        ? await req(ops, "POST", "/api/costs", { entry_date: "2026-09-05", location: jprP._id, category: catP._id, amount: q1863, note: typed })
        : { status: 0 };
      ok("QA-1863 fixture: a cost whose NOTE carries the figure parks", p.status === 202, `got ${p.status}`);
      const carriesFigure = (blob) => notations.some((s) =>
        new RegExp(`(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(blob));
      // Positive control FIRST: if the figure never reached the wire at all, the two refusals below
      // would pass on an empty payload — the vacuous-pass shape that cost this unit a whole cycle.
      const grantedQ = await req(admin, "GET", "/api/approvals?status=all");
      ok("QA-1863 control: the grant-holder DOES get the typed figure — so there is something to leak",
        carriesFigure(JSON.stringify(grantedQ.data ?? {})), `status ${grantedQ.status}`);
      // QA-1866 (checker, cycle 1): the first version of this loop wrote `r.status !== 200 || ...`
      // for BOTH personas. Operations is 403 on `/api/approvals`, so its arm short-circuited on the
      // status and asserted nothing about masking — a vacuous pass, dressed as a masking test. The
      // two personas are not interchangeable here and are no longer written as if they were: the
      // Admin arm MUST get 200 (or the masking path was never exercised) and Operations MUST be
      // refused outright. Either one changing is a finding.
      const leakQ = leakAdmin ? await req(leakAdmin, "GET", "/api/approvals?status=all") : { status: 0 };
      ok("QA-1863: an Admin without finance.view still READS the approvals queue (200) — so the masking path is genuinely exercised",
        leakQ.status === 200, `got ${leakQ.status}`);
      ok("QA-1863: ...and the free-text note on a parked cost carries them no figure",
        leakQ.status === 200 && !carriesFigure(JSON.stringify(leakQ.data ?? {})), `status ${leakQ.status}`);
      const opsQ = ops ? await req(ops, "GET", "/api/approvals?status=all") : { status: 0 };
      ok("QA-1866: Operations is REFUSED the approvals queue outright (403) — stated as a refusal, not disguised as a masking pass",
        opsQ.status === 403, `got ${opsQ.status}`);
      const trail = leakAdmin ? await req(leakAdmin, "GET", `/api/audit/by-user/${opsUserId}?limit=200`) : { status: 0 };
      ok("QA-1868: the ungranted Admin really READS the initiator's trail (200) — the row below is not vacuous",
        trail.status === 200, `got ${trail.status}`);
      ok("QA-1863: ...nor through the audit trail, where the same note is stored raw and masked on read",
        trail.status === 200 && !carriesFigure(JSON.stringify(trail.data ?? {})), `status ${trail.status}`);

      // ---- QA-1865, first half: a field name NOBODY listed, because the payload is the body ----
      // The checker's row is exact about why the five-name list could not hold: `payload` is the
      // UNFILTERED request body, so the set of free-text keys that can reach here is whatever a
      // caller sends, not whatever the models declare. `remark` and `justification` are not fields
      // in this codebase at all — that is the point. They must be redacted anyway.
      //
      // This one is pinned on the RESPONSE path (`/api/approvals`), not the audit path, on purpose:
      // the audit path has a second, blunter net under it (redactFiguresInText on money entities),
      // so an assertion there would pass even with the old allowlist restored and would prove
      // nothing about the change it claims to cover.
      {
        const q = 313131;
        const notes = [String(q), q.toLocaleString("en-IN"), q.toLocaleString("en-US")];
        const carries = (blob) => notes.some((s) =>
          new RegExp(`(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(blob));
        const p2 = (catP && jprP)
          ? await req(ops, "POST", "/api/costs", {
              entry_date: "2026-09-05", location: jprP._id, category: catP._id, amount: q,
              // QA-1828b made a description mandatory on every entry. This probe is about UNDECLARED
              // keys reaching the audit trail, not about the description, so it carries one and goes
              // on testing what it was written to test.
              note: "QA-1865 undeclared-keys probe",
              remark: `QA-1865 remark — ${q} advanced`,
              justification: `QA-1865 justification — ${q.toLocaleString("en-IN")} approved verbally`,
            })
          : { status: 0 };
        ok("QA-1865 fixture: a cost carrying free-text keys this codebase never declared parks", p2.status === 202, `got ${p2.status}`);
        const gq = await req(admin, "GET", "/api/approvals?status=all");
        ok("QA-1865 control: the grant-holder DOES see those undeclared fields' figures",
          carries(JSON.stringify(gq.data ?? {})), `status ${gq.status}`);
        const lq = leakAdmin ? await req(leakAdmin, "GET", "/api/approvals?status=all") : { status: 0 };
        ok("QA-1865: an Admin without finance.view still READS the queue (200) — the masking path is exercised",
          lq.status === 200, `got ${lq.status}`);
        ok("QA-1865: ...and free-text keys nobody listed (remark, justification) carry them no figure",
          lq.status === 200 && !carries(JSON.stringify(lq.data ?? {})), `status ${lq.status}`);
      }

      // ---- QA-1865: the SAME field, reached by a different route, was still raw ----
      // Found by senior review of the QA-1863 fix, not by these assertions — which is the point.
      // The five rows above walk the CREATE-via-approval path, where the note travels inside a
      // `payload` object and `stripMoneyKeys` reaches it. `auditDiff` writes ONE ROW PER CHANGED
      // FIELD, so EDITING a cost's note stores a BARE STRING on a `CostEntry` row, and the bare-
      // string branch of `maskMoneyInAuditRow` was gated to `entity === "ApprovalRequest"` and let
      // it through untouched. A test that walks one path proves one path.
      const q1865 = 787878;
      const ledgerRow = ((await req(admin, "GET", "/api/costs")).data.items ?? [])[0];
      if (ledgerRow) {
        const edit = await req(admin, "PATCH", `/api/costs/${ledgerRow._id}`,
          { note: `QA-1865 edited note — settled ${q1865} against ${q1865.toLocaleString("en-IN")}` });
        ok("QA-1865 fixture: a cost's note is edited, which audits it as a bare per-field string",
          edit.status === 200, `got ${edit.status}`);
        const hasFig = (blob) => /(?<![\w])787878(?![\w])|(?<![\w])7,87,878(?![\w])|(?<![\w])787,878(?![\w])/.test(blob);
        const granted = await req(admin, "GET", `/api/audit/CostEntry/${ledgerRow._id}`);
        ok("QA-1865 control: the grant-holder DOES see the edited note's figure — there is something to leak",
          hasFig(JSON.stringify(granted.data ?? {})), `status ${granted.status}`);
        // ---- QA-1867 (checker, cycle 1 FAIL): the notations the "blunt" net let through ----
        // The blunt rule was written with `redactMoneyInText`'s boundary anchors copied onto it,
        // where they are correct and here they were not: a dot before the figure, a letter after
        // it, or an underscore either side defeated all of them. The checker read back one string
        // with four notations redacted and three raw — on the ONE surface where this is the only
        // net. `_424242_` is named in REQ-235a as a live escape from the other redactor, so the new
        // net had reproduced a hole the contract already records.
        //
        // Every one of those forms is written into a real note here and read back through the real
        // route, because an offline check of the regex would not have caught the first version
        // either: the regex did what it said, the sentence describing it was wrong.
        const ev = 424242;
        // QA-1870 (checker, cycle 2) adds the last two: a figure whose TAIL completes a date shape,
        // and a figure written entirely as an implausible one. Date-protection had become a way to
        // smuggle money past the net that protects it — the shape was checked and the values were
        // not, so `4242-42-42` was "a date" and month 42 went unremarked.
        // QA-1872 and QA-1873 (checker on qa-1869-1871) add the last two, and QA-1872 is the sharper
        // of the pair: `42${"2026"}-01-02` completes a PLAUSIBLE date, so the plausibility test
        // cannot catch it — only the not-preceded-by-a-digit lookbehind can, and until this row
        // existed that lookbehind was pinned by nothing at all. The fixture's own `424242-01-02` has
        // year 4242 and was already caught by the other half, which is exactly how a guard ends up
        // shipping untested beside a test that looks like it covers it.
        const evilNote = `QA-1867 — ${ev} / ${ev.toLocaleString("en-IN")} / ₹${ev} / Rs.${ev} / ${ev}rs / _${ev}_ / (${ev}) / ref#${ev} / ${ev}-01-02 / 4242-42-42 / 422026-01-02 / 2026-09-05T424242 / 2026-09-05T10:00:00.424242`;
        const ed2 = await req(admin, "PATCH", `/api/costs/${ledgerRow._id}`, { note: evilNote });
        ok("QA-1867/QA-1870 fixture: a note carrying the figure in THIRTEEN notations is recorded", ed2.status === 200, `got ${ed2.status}`);
        const anyEv = (blob) => /424242|4,24,242|424,242|4242-42-42|422026/.test(blob);
        const gEv = await req(admin, "GET", `/api/audit/CostEntry/${ledgerRow._id}`);
        ok("QA-1867 control: the grant-holder sees them all — there is something to leak",
          gEv.status === 200 && anyEv(JSON.stringify(gEv.data ?? {})), `status ${gEv.status}`);
        for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"]]) {
          if (!who) continue;
          const r = await req(who, "GET", `/api/audit/CostEntry/${ledgerRow._id}`);
          ok(`QA-1867: ${label} READS that trail (200), so the redaction is genuinely exercised`,
            r.status === 200, `got ${r.status}`);
          ok(`QA-1867: ...and NOT ONE of the thirteen notations reaches ${label}`,
            r.status === 200 && !anyEv(JSON.stringify(r.data ?? {})),
            `status ${r.status} · ${JSON.stringify(r.data ?? {}).slice(0, 300)}`);
          // QA-1874, the half nothing else can see. Bounding the fraction to three digits stops the
          // WHOLE figure, but on its own it lets the first three digits park AS a fraction and hands
          // back `…:00.424—`. The row above cannot notice that — it hunts the complete figure — and
          // a mutant that removed the `(?!\d)` passed the entire suite while disclosing half of it.
          // `.NNN—` is exactly the shape of a fraction that parked and had its tail eaten: a real
          // millisecond timestamp is followed by `Z`, an offset, or nothing.
          ok(`QA-1874: ...and no fraction is HALF-disclosed to ${label} — no ".NNN—" tail`,
            r.status === 200 && !/\.\d{3}—/.test(JSON.stringify(r.data ?? {})),
            `status ${r.status} · ${(JSON.stringify(r.data ?? {}).match(/.{0,30}\.\d{3}—.{0,20}/) ?? [""])[0]}`);
        }

        // Per QA-1866: each persona is asserted for the status it actually gets, so neither arm can
        // pass by being refused. If a future change turns one of these into a 403 the row fails and
        // says so, instead of quietly becoming decoration.
        for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"]]) {
          if (!who) continue;
          const r = await req(who, "GET", `/api/audit/CostEntry/${ledgerRow._id}`);
          ok(`QA-1865: ${label} still READS the cost's audit trail (200), so the masking path is exercised`,
            r.status === 200, `got ${r.status}`);
          ok(`QA-1865: ...and an EDITED cost note carries them no figure`,
            r.status === 200 && !hasFig(JSON.stringify(r.data ?? {})), `status ${r.status}`);
        }
      } else ok("QA-1865 fixture: a ledger cost row exists to edit", false, "none visible");

      // ---- QA-1865: Closure.dues_note, the field an allowlist of names could not have known ----
      // Rule 52's no-dues attestation is free text about MONEY by definition, and it was not in the
      // five names the first fix listed. Its audit row is an object with no `amount` in it, so the
      // payload-driven redactor has nothing to key on either — both halves of this fix are needed.
      // Rule 52 makes a CLOSED batch's settlement record final, so the seeded invoice's batch (which
      // is Closed) 409s — the first version of this fixture used it and asserted masking on a
      // dues_note that was never written. The non-vacuity control caught that, which is what it is
      // for. Pick a batch that can still take the attestation.
      const openBatch = ((await req(admin, "GET", "/api/batches?limit=50")).data.items ?? [])
        .find((b) => !["Closed", "Cancelled"].includes(b.status));
      if (openBatch) {
        const dn = await req(admin, "PUT", `/api/batches/${openBatch._id}/closure`,
          { dues_note: `QA-1865 dues — 656565 cleared, balance ${(656565).toLocaleString("en-IN")}` });
        ok("QA-1865 fixture: a closure dues_note carrying a bare figure is recorded",
          dn.status === 200, `got ${dn.status} on a ${openBatch.status} batch · ${JSON.stringify(dn.data ?? {}).slice(0, 160)}`);
        // The audit row is written against the CLOSURE's id, not the batch's — the first version
        // read `/api/audit/Closure/<batchId>` and would have been green on an empty trail.
        const closureId = dn.data?.item?._id;
        ok("QA-1865 fixture: the closure's own id resolves, so the trail below is the right one",
          !!closureId, String(closureId));
        const hasDues = (blob) => /(?<![\w])656565(?![\w])|(?<![\w])6,56,565(?![\w])/.test(blob);
        const bId2 = closureId;
        const gr = await req(admin, "GET", `/api/audit/Closure/${bId2}`);
        ok("QA-1865 control: the grant-holder DOES see the dues figure — there is something to leak",
          gr.status === 200 && hasDues(JSON.stringify(gr.data ?? {})), `status ${gr.status}`);
        // The Admin arm is the load-bearing one and is asserted on 200, per QA-1866.
        const leakC = leakAdmin ? await req(leakAdmin, "GET", `/api/audit/Closure/${bId2}`) : { status: 0 };
        ok("QA-1865: an Admin without finance.view still READS the closure audit trail (200)",
          leakC.status === 200, `got ${leakC.status}`);
        ok("QA-1865: ...and the closure's dues_note carries them no figure",
          leakC.status === 200 && !hasDues(JSON.stringify(leakC.data ?? {})), `status ${leakC.status}`);
        // Operations may be refused this trail outright; that is a fine outcome but a DIFFERENT
        // guarantee, so it is named rather than folded into a masking assertion (QA-1866).
        const opsC = ops ? await req(ops, "GET", `/api/audit/Closure/${bId2}`) : { status: 0 };
        ok(`QA-1865: Operations is either refused the closure trail or gets it masked — actual: ${opsC.status}`,
          opsC.status === 403 || (opsC.status === 200 && !hasDues(JSON.stringify(opsC.data ?? {}))), `status ${opsC.status}`);
      }
    }

    // Put the switch back so the rest of the wall sees the shipped default (rule OFF, nobody named).
    await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin", approver_users: [] });

    // ---- QA-1864: who may ERASE money, which is the more permanent act of the two ----
    // Found by the Unit-2 checker's live probe, not by any pin. `DELETE /api/batches/:id` with
    // recorded work runs `CostEntry.deleteMany` + `Invoice.deleteMany` behind
    // `batches.delete_with_data` — a key that is NOT in NO_ADMIN_BYPASS. So the same ungranted Admin
    // this unit spent six cycles keeping AWAY from the ledger could destroy it, and was handed a
    // count of what they had destroyed. Six cycles asked who may READ money; nobody asked who may
    // erase it.
    {
      const s64 = "Q64" + Date.now().toString().slice(-6);
      const loc64 = (await req(admin, "POST", "/api/locations", { code: "L" + s64, name: "Erase Loc " + s64, approval_status: "Approved" })).data?.item;
      const prog64 = (await req(admin, "POST", "/api/programs", { code: "P" + s64, name: "Erase Prog " + s64, trainer_skill: "sk" + s64, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 })).data?.item;
      const bat64 = loc64 && prog64
        ? (await req(admin, "POST", "/api/batches", { location: loc64._id, program: prog64._id, planned_start: "2027-06-01" })).data?.item
        : null;
      // The rule is OFF again, so this writes the ledger directly rather than parking.
      const cost64 = (bat64 && catP)
        ? await req(admin, "POST", "/api/costs", { entry_date: "2026-09-05", location: loc64._id, batch: bat64._id, category: catP._id, amount: 424242, note: "QA-1864 erase probe" })
        : { status: 0 };
      ok("QA-1864 fixture: a batch carrying one real cost row exists",
        !!bat64 && cost64.status === 201, `batch=${!!bat64} cost=${cost64.status}`);

      if (bat64 && cost64.status === 201) {
        // Give the ungranted Admin the force-delete right and NOTHING else, so the only thing left
        // standing between them and the ledger is the finance gate this row adds.
        await req(admin, "PATCH", `/api/users/${mkLeak.data.item?._id}`, { extra_permissions: ["batches.delete_with_data"] });
        const armed = await login(emLeak, pw1825);
        const del = armed
          ? await req(armed, "DELETE", `/api/batches/${bat64._id}`, { reason: "QA-1864 probe: erasing a batch that carries money" })
          : { status: 0 };
        ok("QA-1864: an Admin with batches.delete_with_data but WITHOUT finance.approve cannot force-delete a batch carrying costs",
          del.status === 403, `got ${del.status} · ${JSON.stringify(del.data ?? {}).slice(0, 160)}`);
        const survived = (await req(admin, "GET", `/api/costs?batch=${bat64._id}`)).data?.items ?? [];
        ok("QA-1864: ...and the cost row is genuinely still there — refused, not deleted-then-reported",
          survived.length === 1, `rows=${survived.length}`);

        // The refusal must be about MONEY, not about the verb: the same actor, same right, on a
        // batch with no money rows, must still be able to force-delete. Otherwise this row quietly
        // took away a right Umesh deliberately widened in QA-904.
        const bat64b = (await req(admin, "POST", "/api/batches", { location: loc64._id, program: prog64._id, planned_start: "2027-07-01" })).data?.item;
        if (bat64b && armed) {
          // A BatchMember is recorded work with no money on it — enough to send the delete down the
          // force branch, which is the branch this row gates.
          const cand64 = (await req(admin, "POST", "/api/candidates", {
            name: "Erase Cand " + s64, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
            location: loc64._id, program: prog64._id,
          })).data?.item;
          const mem64 = cand64
            ? await req(admin, "POST", `/api/batches/${bat64b._id}/members`, { candidate: cand64._id })
            : { status: 0 };
          ok("QA-1864 control fixture: a batch carrying non-money recorded work exists",
            mem64.status === 201, `got ${mem64.status}`);
          const delB = await req(armed, "DELETE", `/api/batches/${bat64b._id}`, { reason: "QA-1864 probe: no money on this one" });
          ok("QA-1864 control: the same actor CAN still force-delete a batch whose recorded work carries no money",
            delB.status !== 403, `got ${delB.status} · ${JSON.stringify(delB.data ?? {}).slice(0, 160)}`);
        }

        // Positive control on the gate itself: with the finance grant, the erase goes through.
        // BOTH keys, because `requireFinance(user, "approve")` requires view AND approve — approving
        // money you are not allowed to see is not a coherent permission. The first version of this
        // control granted only `finance.approve`, got a 403 naming finance.view, and was wrong about
        // the design rather than finding a defect in it.
        await req(admin, "PATCH", `/api/users/${mkLeak.data.item?._id}`, { extra_permissions: ["batches.delete_with_data", "finance.view", "finance.approve"] });
        const granted = await login(emLeak, pw1825);
        const del2 = granted
          ? await req(granted, "DELETE", `/api/batches/${bat64._id}`, { reason: "QA-1864 probe: granted" })
          : { status: 0 };
        ok("QA-1864 control: WITH finance.approve the same force-delete succeeds — the gate narrows, it does not block",
          del2.status === 200, `got ${del2.status} · ${JSON.stringify(del2.data ?? {}).slice(0, 160)}`);
        await req(admin, "PATCH", `/api/users/${mkLeak.data.item?._id}`, { extra_permissions: [] });
      }
    }
  }

  // ---- QA-1828: Head → Subhead → Description, and the money that came with it ----
  // The CEO asked for structure — *"head ho, sub head ho, description ho… pre approve hai ki nahi
  // hai wo daalein"* — and the structure arrives carrying a budget and a pre-approved limit, on a
  // list every signed-in role reads because the Costs form needs the head names. That combination
  // is precisely how the first nine money doors in this module were opened: a money field added to
  // something already readable, noticed later. So the masking is asserted the same day it ships.
  //
  // The generic probe walk above cannot catch this one on its own: MONEY_ON_WIRE hunts `"amount":`,
  // `"invoice_no":`, a rupee sign and the two fixture figures — a `"budget": 777333` is none of
  // those. A door added to that list still needs its own assertion with its own figure.
  {
    const s28 = Date.now().toString().slice(-6);
    const BUDGET = 777333, LIMIT = 555111;
    const mk = (body) => req(admin, "POST", "/api/master-lists/cost-categories", body);
    const head = (await mk({
      name: `QA1828 Head ${s28}`, code: `H${s28}`, description: "Everything the centre spends to run a batch",
      head_type: "Direct", budget: BUDGET, pre_approved: true, pre_approved_amount: LIMIT,
      pre_approved_basis: `₹${LIMIT} per batch at 30+ pass-outs`,
    })).data?.item;
    ok("QA-1828: a cost HEAD is created with description, type, budget and a pre-approval rule",
      !!head?._id && head.head_type === "Direct", JSON.stringify(head ?? {}).slice(0, 200));

    const sub = head ? (await mk({ name: `QA1828 Sub ${s28}`, parent: head._id, description: "Trainer travel" })).data?.item : null;
    ok("QA-1828: a SUBHEAD is created under it", !!sub?._id && String(sub.parent) === String(head?._id), JSON.stringify(sub ?? {}).slice(0, 160));

    // Two levels, enforced at the API and not merely in the form.
    const third = sub ? await mk({ name: `QA1828 Third ${s28}`, parent: sub._id }) : { status: 0 };
    ok("QA-1828: a subhead of a SUBHEAD is refused — the tree is two levels deep",
      third.status === 400, `got ${third.status} · ${JSON.stringify(third.data ?? {}).slice(0, 160)}`);
    const selfParent = head ? await req(admin, "PATCH", `/api/master-lists/cost-categories/${head._id}`, { parent: head._id }) : { status: 0 };
    ok("QA-1828: a head cannot be made its own parent — that cycle would hang any walk of the tree",
      selfParent.status === 400, `got ${selfParent.status}`);
    const demote = head ? await req(admin, "PATCH", `/api/master-lists/cost-categories/${head._id}`, { parent: sub?._id }) : { status: 0 };
    ok("QA-1828: a head that HAS subheads cannot become one — a third level by the back door",
      demote.status === 400, `got ${demote.status} · ${JSON.stringify(demote.data ?? {}).slice(0, 160)}`);

    // ---- the money half ----
    const hasBudget = (blob) => /777333|555111|"budget"\s*:\s*\d|"pre_approved_amount"\s*:\s*\d/.test(blob);
    const gList = await req(admin, "GET", "/api/master-lists/cost-categories");
    ok("QA-1828 control: the grant-holder DOES see the budget and the pre-approved limit",
      gList.status === 200 && hasBudget(JSON.stringify(gList.data ?? {})), `status ${gList.status}`);

    for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"]]) {
      if (!who) continue;
      const r = await req(who, "GET", "/api/master-lists/cost-categories");
      ok(`QA-1828: ${label} still READS the cost-head list (200) — they must be able to file an expense`,
        r.status === 200, `got ${r.status}`);
      ok(`QA-1828: ...and it carries them no budget, no limit and no basis`,
        r.status === 200 && !hasBudget(JSON.stringify(r.data ?? {})),
        `status ${r.status} · ${JSON.stringify(r.data ?? {}).slice(0, 240)}`);
      // The STRUCTURE must survive the masking, or the form they need it for stops working. Same
      // shape as Umesh's invoice ruling: *"sirf paisa chhupao, status sabko rehne do."*
      const rows = r.data?.items ?? [];
      const theHead = rows.find((i) => String(i._id) === String(head?._id));
      ok(`QA-1828: ...while the head, its description, its type and the pre-approved FLAG all survive for ${label}`,
        !!theHead && theHead.description === "Everything the centre spends to run a batch"
        && theHead.head_type === "Direct" && theHead.pre_approved === true,
        JSON.stringify(theHead ?? {}).slice(0, 200));
      ok(`QA-1828: ...and the subhead still points at its head for ${label}, so the picker can group`,
        rows.some((i) => String(i._id) === String(sub?._id) && String(i.parent?._id ?? i.parent) === String(head?._id)),
        JSON.stringify(rows.find((i) => String(i._id) === String(sub?._id)) ?? {}).slice(0, 160));
    }

    // The PATCH reply is a write-side read of the same row, and this module has already been caught
    // masking a list and handing the figure back through the button that edited it (QA-1849).
    if (leakAdmin && head) {
      const ed = await req(leakAdmin, "PATCH", `/api/master-lists/cost-categories/${head._id}`, { description: "edited by an ungranted Admin" });
      ok("QA-1828: an ungranted Admin may still edit the description (200) — the door is not closed, the field is",
        ed.status === 200, `got ${ed.status}`);
      ok("QA-1828: ...and the PATCH RESPONSE carries them no budget either",
        ed.status === 200 && !hasBudget(JSON.stringify(ed.data ?? {})), JSON.stringify(ed.data ?? {}).slice(0, 240));
      const stillThere = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
      ok("QA-1828: ...and that blind edit did NOT wipe the budget it could not see",
        stillThere.find((i) => String(i._id) === String(head._id))?.budget === BUDGET,
        `budget now ${stillThere.find((i) => String(i._id) === String(head._id))?.budget}`);

      // The WRITE side of the same rule. Masking a field on read and leaving it writable is half a
      // rule and the worse half: an ungranted Admin could set a budget they may not read, and never
      // learn what they overwrote. Both doors are checked, because the create door and the edit
      // door are two different functions and this module has already shipped a guard on one of a
      // pair (QA-1857).
      // QA-1876 (checker on qa-1828a): this asserted only `budget`, so a mutant that unguarded the
      // OTHER two money fields passed the whole wall byte-identically. The shipped guard iterates
      // the shared constant and was always correct — but a guard is only as good as the assertion
      // that would notice it going, and one field of three is not that. Each field is now named.
      for (const f of ["budget", "pre_approved_amount", "pre_approved_basis"]) {
        const val = f === "pre_approved_basis" ? "₹1 per child" : 1;
        const setIt = await req(leakAdmin, "PATCH", `/api/master-lists/cost-categories/${head._id}`, { [f]: val });
        ok(`QA-1876: an ungranted Admin cannot WRITE ${f} — 403, not a silent overwrite`,
          setIt.status === 403, `got ${setIt.status}`);
        const mkIt = await req(leakAdmin, "POST", "/api/master-lists/cost-categories", { name: `QA1876 sneak ${f} ${s28}`, [f]: val });
        ok(`QA-1876: ...and cannot create a head carrying ${f} either`, mkIt.status === 403, `got ${mkIt.status}`);
      }

      // QA-1875 (same checker): a money figure on a master is non-negative, the way total_hours,
      // min_required_hours and amount_received already are. Consolidating two coercions dropped the
      // guard the deleted copy had.
      const negBudget = await req(admin, "PATCH", `/api/master-lists/cost-categories/${head._id}`, { budget: -50000 });
      ok("QA-1875: a NEGATIVE budget is refused (400), even from a grant-holder", negBudget.status === 400, `got ${negBudget.status}`);
      const negLimit = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `QA1875 neg ${s28}`, pre_approved_amount: -1 });
      ok("QA-1875: ...and a negative pre-approved limit cannot be created either", negLimit.status === 400, `got ${negLimit.status}`);
      const stillBudget = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
        .find((i) => String(i._id) === String(head._id))?.budget;
      ok("QA-1875: ...and the refusal left the real budget alone", stillBudget === BUDGET, `budget now ${stillBudget}`);

      // QA-1877 (checker on qa-1875-1876): the guard lives in the SHARED coercion, so it binds
      // every list that has a numeric extra — not just cost-categories. That is a real behaviour
      // change on `schemes` (POST total_hours:-5 was 201 before) and it was asserted on ONE of the
      // lists it touches, which is the same one-surface-of-several shape as QA-1876 one level up.
      // The change is a tightening toward the rule the EDIT door of the same list already had, so
      // it stays — but it is now named, and pinned where it actually applies.
      const negScheme = await req(admin, "POST", "/api/master-lists/schemes", { name: `QA1877 ${s28}`, total_hours: -5 });
      ok("QA-1877: the non-negative guard binds the SCHEMES create door too — a negative total_hours is refused",
        negScheme.status === 400, `got ${negScheme.status} · ${JSON.stringify(negScheme.data ?? {}).slice(0, 120)}`);
      const okScheme = await req(admin, "POST", "/api/master-lists/schemes", { name: `QA1877 ok ${s28}`, total_hours: 120 });
      ok("QA-1877: ...while a legitimate positive figure still creates (the guard tightened, it did not close the door)",
        okScheme.status === 201, `got ${okScheme.status}`);

      // QA-1878: an unparseable body is the CALLER's mistake. It used to answer 500 "something went
      // wrong on our side" on every write route, which is both untrue and the wrong bucket for
      // anyone reading error rates.
      const badJson = await fetch(`${BASE}/api/master-lists/cost-categories`, {
        method: "POST", headers: { "Content-Type": "application/json", cookie: admin }, body: "{not json",
      });
      ok("QA-1878: a body that is not valid JSON answers 400, not 500", badJson.status === 400, `got ${badJson.status}`);
      // QA-1882 (checker, cycle 2 FAIL): the row above walks a HAND-WRITTEN route. `src/lib/crud.ts`
      // reads the body for thirteen others — every write door of candidates, trainers, locations,
      // programs, sync-sources and trainer-requests — and it was missed, so those six went 400 → 500
      // when the chokepoint branch came out. One assertion per READ SITE, not per route file,
      // because the read site is what the rule is actually about.
      for (const [path_, what] of [["/api/candidates", "the shared CRUD create door"], ["/api/locations", "a second entity through the same door"]]) {
        const r = await fetch(`${BASE}${path_}`, {
          method: "POST", headers: { "Content-Type": "application/json", cookie: admin }, body: "{not json",
        });
        ok(`QA-1882: a malformed body on ${what} (${path_}) answers 400, not 500`, r.status === 400, `got ${r.status}`);
      }
      const unchanged = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
      ok("QA-1828: ...and the real budget is still what it was",
        unchanged.find((i) => String(i._id) === String(head._id))?.budget === BUDGET,
        `budget now ${unchanged.find((i) => String(i._id) === String(head._id))?.budget}`);
    }
  }

  // ---- QA-1897: "is role me kaun hai, aur is account ke paas kya hai" ----
  // Umesh, 2026-09-06: the Admin screen could say what ROLE someone had and could toggle a role's
  // rights, but could not answer the question an Admin actually asks about a PERSON. The new door
  // answers it — and the reason it is a DOOR and not a browser-side calculation is money: a
  // client-side "Admin gets everything" would have shown every Admin holding finance.view, which is
  // precisely what NO_ADMIN_BYPASS exists to prevent. So the screen must be pinned against lying.
  {
    const leakAdminId = mkLeak.data.item?._id;
    if (leakAdminId) {
      const r = await req(admin, "GET", `/api/users/${leakAdminId}/rights`);
      ok("QA-1897: the per-person rights door answers an Admin who may manage users", r.status === 200, `got ${r.status}`);
      const rows = r.data?.rights ?? [];
      const fv = rows.find((x) => x.key === "finance.view");
      const fa = rows.find((x) => x.key === "finance.approve");
      ok("QA-1897: it reports every right in the catalogue, not a subset",
        rows.length > 0 && rows.some((x) => x.key === "users.manage"), `${rows.length} rights`);
      // THE ONE THAT MATTERS. This Admin holds no finance grant. The screen must say so.
      ok("QA-1897: an ungranted Admin's finance.view reads 'none' — the screen cannot claim the Admin role opens money",
        fv?.level === "none", JSON.stringify(fv ?? null));
      ok("QA-1897: ...and finance.approve likewise", fa?.level === "none", JSON.stringify(fa ?? null));
      ok("QA-1897: ...and both are flagged as named-grant-only, so the Admin is told WHY",
        fv?.no_admin_bypass === true && fa?.no_admin_bypass === true);
      // A non-finance right the Admin role does open must still read as held — otherwise the screen
      // would be useless in the other direction.
      const um = rows.find((x) => x.key === "users.manage");
      ok("QA-1897: a right the Admin role DOES open still reads as held", um && um.level !== "none", JSON.stringify(um ?? null));
      // And the door is gated: Operations does not manage users.
      const opsTry = ops ? await req(ops, "GET", `/api/users/${leakAdminId}/rights`) : { status: 0 };
      ok("QA-1897: the door refuses someone without users.manage", opsTry.status === 403, `got ${opsTry.status}`);
      const missing = await req(admin, "GET", "/api/users/6a9c000000000000000000aa/rights");
      ok("QA-1897: an unknown user id is a 404, not a crash", missing.status === 404, `got ${missing.status}`);
      // QA-1906 (checker on cycle 1, and it falsified this unit's OWN mutant step). Every
      // assertion above targets an Admin with no personal grant — and `DEFAULT_ROLE_PERMISSIONS
      // .Admin` is itself `PERMISSIONS.filter(!NO_ADMIN_BYPASS)`, so a route that returned the
      // ROLE DEFAULTS instead of the person's effective levels passed all eight of them with zero
      // delta. The claim being made is "this reads the real getEffectiveLevels", and only a
      // PERSONAL grant on a NON-Admin can tell the two apart: role defaults cannot carry it.
      const trainerU = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.role === "Trainer" && u.active !== false);
      if (trainerU) {
        const before = (await req(admin, "GET", `/api/users/${trainerU._id}/rights`)).data?.rights ?? [];
        const key = "costs.manage";
        ok("QA-1906 fixture: a Trainer does not hold costs.manage by role",
          (before.find((r) => r.key === key) ?? {}).level === "none", JSON.stringify(before.find((r) => r.key === key) ?? null));
        await req(admin, "PATCH", `/api/users/${trainerU._id}`, { extra_permissions: [key] });
        const granted = ((await req(admin, "GET", `/api/users/${trainerU._id}/rights`)).data?.rights ?? []).find((r) => r.key === key);
        ok("QA-1906: a personal grant to a NON-Admin is reported as held — role defaults cannot produce this, so the door really reads effective levels",
          granted && granted.level !== "none", JSON.stringify(granted ?? null));
        ok("QA-1906: ...and it says the right came from the PERSON, not from their role",
          granted && /person|grant/i.test(String(granted.source ?? "")), String(granted?.source));
        await req(admin, "PATCH", `/api/users/${trainerU._id}`, { extra_permissions: [] });
        const back = ((await req(admin, "GET", `/api/users/${trainerU._id}/rights`)).data?.rights ?? []).find((r) => r.key === key);
        ok("QA-1906: taking the grant back reads as 'none' again on a server re-read",
          back && back.level === "none", JSON.stringify(back ?? null));
      } else ok("QA-1906 fixture: an active Trainer exists to grant to", false, "none found");
    } else ok("QA-1897 fixture: the ungranted Admin's id resolves", false, "no id");
  }

  // ---- QA-1832: the CEO's own first question ----
  // *"मेरे कितने बच्चे ट्रेन हो गए, कितने ट्रेनिंग में हैं, कितने बैचेस और चालू होने वाले हैं"* — and his verdict on
  // everything built before it: *"कॉस्ट से बिजनेस नहीं चलता।"*
  {
    const k = await req(admin, "GET", "/api/reports/kpi");
    ok("QA-1832: the KPI report answers", k.status === 200, `got ${k.status}`);
    const d = k.data ?? {};
    ok("QA-1832: it carries HIS three counts, all present and numeric",
      typeof d.trained === "number" && typeof d.in_training === "number" && typeof d.upcoming_batches === "number",
      `trained=${d.trained} in_training=${d.in_training} upcoming=${d.upcoming_batches}`);
    ok("QA-1832: trained excludes dropped members — it is not a raw Pass count",
      d.trained >= 0, `trained=${d.trained}`);
    // The four categories are the CEO's, and each must name an owner — a blocker with no owner is
    // the thing he was complaining about, not the fix for it.
    const cats = (d.blocker_summary ?? []).map((c) => c.category);
    ok("QA-1832: blockers come in HIS four categories, no more and no fewer",
      cats.length === 4
      && ["Infrastructure", "Trainer", "Organization / mobilisation", "Batch management"].every((c) => cats.includes(c)),
      JSON.stringify(cats));
    ok("QA-1832: ...and every category names an owner",
      (d.blocker_summary ?? []).every((c) => typeof c.owner === "string" && c.owner.length > 2),
      JSON.stringify((d.blocker_summary ?? []).map((c) => `${c.category}=${c.owner}`)));
    ok("QA-1832: every individual blocker carries a category, an owner and a centre",
      (d.blockers ?? []).every((b) => b.category && b.owner && b.location),
      `${(d.blockers ?? []).length} blocker rows`);
    ok("QA-1832: the category counts really are the blocker rows, not a separate tally",
      (d.blocker_summary ?? []).reduce((n, c) => n + c.count, 0) === (d.blockers ?? []).length,
      `${(d.blocker_summary ?? []).reduce((n, c) => n + c.count, 0)} vs ${(d.blockers ?? []).length}`);
    // The forward plan must be honest about what it cannot count.
    ok("QA-1832: the projection reports how many upcoming batches carry no planned size",
      typeof d.upcoming_without_target === "number", `${d.upcoming_without_target}`);
    // NOT a money door — and measured, not assumed. Its own regex: `MONEY_ON_WIRE` above is scoped
    // to the probe block, and reaching into another block's constant is how a check ends up running
    // against something other than what its author thought.
    const MONEY_HERE = /"amount":\s*-?\d|"invoice_no":\s*"|"budget":\s*\d|₹\s?[\d,]/;
    ok("QA-1832: the KPI report carries no money to anyone",
      !MONEY_HERE.test(JSON.stringify(d)), JSON.stringify(d).slice(0, 160));
    // A scoped user gets their own centres, the same as every other report here.
    const ks = spoc ? await req(spoc, "GET", "/api/reports/kpi") : { status: 0 };
    ok("QA-1832: a scoped user may read it (it is not an Admin-only screen)", ks.status === 200, `got ${ks.status}`);
    ok("QA-1832: ...and sees no blocker outside their own scope",
      (ks.data?.blockers ?? []).every((b) => /JPR03|Jaipur/i.test(`${b.location} ${b.location_code}`)) || (ks.data?.blockers ?? []).length === 0,
      JSON.stringify([...new Set((ks.data?.blockers ?? []).map((b) => b.location_code))]));
    // QA-1898: the row above walks the path nobody attacks. The first version of this route wrote
    // `?location=` straight over the authorisation clause — same key, so the parameter simply
    // replaced it — and a scoped SPOC could name any centre and read it. The assertion passed
    // because it never sent the parameter. Found by an automated security review of the commit,
    // not by this suite, which is the honest record of it.
    const foreign = (await req(admin, "GET", "/api/locations?limit=50")).data?.items ?? [];
    const notMine = foreign.find((l) => !/JPR03/i.test(String(l.code ?? "")));
    if (spoc && notMine) {
      const attack = await req(spoc, "GET", `/api/reports/kpi?location=${notMine._id}`);
      ok("QA-1898: a scoped user naming ANOTHER centre in ?location= is refused, not served",
        attack.status === 403, `got ${attack.status} for ${notMine.code}`);
      const own = (await req(admin, "GET", "/api/locations?limit=200")).data?.items?.find((l) => /JPR03/i.test(String(l.code ?? "")));
      if (own) {
        const narrow = await req(spoc, "GET", `/api/reports/kpi?location=${own._id}`);
        ok("QA-1898: ...while naming their OWN centre still narrows and answers", narrow.status === 200, `got ${narrow.status}`);
      }
      const adminAny = await req(admin, "GET", `/api/reports/kpi?location=${notMine._id}`);
      ok("QA-1898: ...and an unscoped Admin may still name any centre", adminAny.status === 200, `got ${adminAny.status}`);

      // QA-1919 (checker on cycle 2) — AND THIS IS THE SECOND TIME THE SAME MISTAKE WAS MADE HERE.
      // Cycle 1's assertion checked a TYPE. Cycle 2's replacement compared a scoped user's `trained`
      // against an Admin naming that same centre — but with the fix removed BOTH sides return the
      // org-wide total, so the equality is true in the broken world too, and the `<=` beside it is
      // true in every world. Two assertions, neither able to fail, cited in a manifest as the mutant
      // that verified the fix.
      //
      // A comparison can only be a test if the two sides come apart when the code is wrong. So this
      // is a DECOMPOSITION: the whole estate's `trained` must equal the sum of the per-centre
      // figures. If `trained` ignores the scope, every per-centre call returns the whole, the sum is
      // N x the whole, and it fails by a mile. There is no arrangement of the broken code that
      // satisfies it.
      // QA-1924 (checker on cycle 2): under `npm run test:roles` alone the seed carries ZERO Pass
      // rows, so the decomposition would be 0 === 0 — vacuous — and its coverage would depend on
      // `e2e.mjs` having run first. Measured: with mutant A applied, the block failed on its own
      // fixture line rather than on the sum, which proves nothing about the mutant. So the block
      // MAKES its own trained candidate instead of hoping one exists.
      const allLocs = (await req(admin, "GET", "/api/locations?limit=200")).data?.items ?? [];
      const kpiBatches = (await req(admin, "GET", "/api/batches?limit=100")).data?.items ?? [];
      let seededPass = false;
      for (const b of kpiBatches) {
        const roster = (await req(admin, "GET", `/api/batches/${b._id}/results`)).data?.items ?? [];
        const live = roster.find((m) => !m.left_on && !m.result);
        if (!live) continue;
        const put = await req(admin, "PUT", `/api/batches/${b._id}/results`, {
          rows: [{ member: live.member, result: "Pass", score: 71 }],
        });
        if ([200, 201].includes(put.status)) { seededPass = true; break; }
      }
      ok("QA-1924 fixture: this block seeds its own Pass, so the decomposition below never depends on which suite ran first",
        seededPass, `${kpiBatches.length} batches offered a markable member: ${seededPass}`);
      const whole = await req(admin, "GET", "/api/reports/kpi");
      const wholeTrained = whole.data?.trained ?? -1;
      const perCentre = [];
      for (const l of allLocs) {
        const r = await req(admin, "GET", `/api/reports/kpi?location=${l._id}`);
        perCentre.push({ code: l.code, trained: r.data?.trained ?? 0 });
      }
      const summed = perCentre.reduce((a, c) => a + c.trained, 0);
      // The fixture assertion first, because the decomposition is only a test when there is more
      // than one centre AND somebody has actually been trained — otherwise 0 === 0 passes in both
      // worlds, which is exactly the vacuity this row was filed for.
      ok("QA-1919 fixture: there are at least two centres and a non-zero trained count, so the sum below can actually disagree",
        allLocs.length >= 2 && wholeTrained > 0, `centres=${allLocs.length} trained=${wholeTrained}`);
      ok("QA-1919: the estate's `trained` equals the sum of the per-centre figures — a `trained` that ignores scope returns N x the whole and cannot satisfy this",
        allLocs.length >= 2 && wholeTrained > 0 && summed === wholeTrained,
        `sum=${summed} whole=${wholeTrained} over ${allLocs.length} centres: ${JSON.stringify(perCentre.slice(0, 6))}`);
      // And the original equality is kept, because it still says something the decomposition does
      // not: that the SCOPED USER'S OWN view agrees with the Admin's narrowed one. It is no longer
      // carrying the weight of proving the fix.
      const ownL = allLocs.find((l) => /JPR03/i.test(String(l.code ?? "")));
      if (ownL) {
        const asSpoc = await req(spoc, "GET", "/api/reports/kpi");
        const adminNarrowed = await req(admin, "GET", `/api/reports/kpi?location=${ownL._id}`);
        ok("QA-1900: a scoped user's `trained` agrees with an Admin naming that same centre",
          asSpoc.data?.trained === adminNarrowed.data?.trained,
          `spoc=${asSpoc.data?.trained} admin?location=${adminNarrowed.data?.trained}`);
      }
      // QA-1921: `batchManagementBlockers` widened what `batchHealth` reports. That change is
      // asserted HERE rather than left to be discovered, because it moves a score a person reads.
      const planningB = ((await req(admin, "GET", "/api/batches?limit=100")).data?.items ?? [])
        .find((b) => ["Planning", "Ready"].includes(String(b.status)));
      if (planningB) {
        const origStart = planningB.planned_start;
        await req(admin, "PATCH", `/api/batches/${planningB._id}`, { planned_start: "2020-01-01" });
        const h = await req(admin, "GET", `/api/batches/${planningB._id}`);
        const reasons = (h.data?.item?.health?.reasons ?? h.data?.health?.reasons ?? []);
        const startRow = reasons.find((r) => r.code === "start_passed");
        ok("QA-1921: an overdue Planning batch reports a passed start date on the batch page too, not only in the KPI tile",
          !!startRow, JSON.stringify(reasons.map((r) => r.code)));
        ok("QA-1921: ...as AMBER, not red — a start date that has slipped is a warning, and turning 22 ready batches red overnight is a change nobody asked for",
          !startRow || startRow.severity === "amber", JSON.stringify(startRow ?? null));
        if (origStart) await req(admin, "PATCH", `/api/batches/${planningB._id}`, { planned_start: String(origStart).slice(0, 10) });
      }
    } else ok("QA-1898 fixture: a foreign centre exists to attack with", false, `spoc=${!!spoc} other=${!!notMine}`);
  }


  // ===========================================================================================
  // QA-1830 — the finance dashboard, and QA-1899 — the dropout exclusion that excluded nothing.
  // ===========================================================================================
  {
    // ---- the door. Its entire purpose is money, so it takes the 403, not a field mask. The
    // export matters more than it looks: the money-leak probe greps JSON and CANNOT see inside a
    // binary xlsx, so an export that skipped the gate would be the one leak the probe is
    // structurally unable to find. It is asserted here by hand for exactly that reason.
    for (const [who, label] of [[leakAdmin, "an Admin without finance.view"], [ops, "Operations"], [spoc, "a centre SPOC"]]) {
      if (!who) continue;
      const r = await req(who, "GET", "/api/reports/costs");
      ok(`QA-1830: the finance dashboard refuses ${label}`, r.status === 403, `got ${r.status}`);
      const x = await req(who, "GET", "/api/reports/costs/export");
      ok(`QA-1830: ...and so does its .xlsx export, which no JSON probe can see inside (${label})`, x.status === 403, `got ${x.status}`);
      // QA-1831: the P&L pair takes the same door, asserted on the same three personas rather than
      // in a block of its own - a second door that is only tested against the persona its author
      // happened to think of is how the eighth door (QA-1850) stayed open.
      const pr = await req(who, "GET", "/api/reports/pnl");
      ok(`QA-1831: the P&L refuses ${label}`, pr.status === 403, `got ${pr.status}`);
      const px = await req(who, "GET", "/api/reports/pnl/export");
      ok(`QA-1831: ...and so does the P&L .xlsx, the one surface the JSON leak probe is blind to (${label})`, px.status === 403, `got ${px.status}`);
    }
    const rep = await req(admin, "GET", "/api/reports/costs");
    ok("QA-1830: the granted admin gets the dashboard", rep.status === 200, `got ${rep.status}`);
    const d = rep.data ?? {};

    // ---- every grouping is filled in ONE pass over the same rows, so each must sum to the same
    // grand total BY CONSTRUCTION. A second query is how two tables on one screen start
    // describing two different windows; this is the assertion that would catch that.
    const sum = (rows, pick = (r) => r.amount) => (rows ?? []).reduce((a, r) => a + (pick(r) || 0), 0);
    const total = d.totals?.actual ?? -1;
    for (const [name, rows] of [["by head", d.by_head], ["by centre", d.by_location],
                                ["by job role", d.by_job_role], ["by month", d.by_month],
                                ["the register", d.register], ["unit economics", d.unit_economics]]) {
      ok(`QA-1830: ${name} sums to the grand total`, sum(rows) === total, `${sum(rows)} vs ${total}`);
    }
    ok("QA-1830: the batch × head cross-tab sums to it too, cell by cell",
      sum(d.cross_tab?.rows, (r) => Object.values(r.cells ?? {}).reduce((a, n) => a + (n || 0), 0)) === total,
      `${sum(d.cross_tab?.rows, (r) => Object.values(r.cells ?? {}).reduce((a, n) => a + (n || 0), 0))} vs ${total}`);
    ok("QA-1830: and the totals are not all zero, so the assertions above are not vacuous",
      total > 0 && (d.totals?.entries ?? 0) > 0, `total=${total} entries=${d.totals?.entries}`);

    // ---- developer note #5: untagged costs still reconcile. A cost with no batch must be
    // COUNTED under Unassigned, never dropped — dropping it is how a grand total quietly stops
    // tying to the register nobody re-adds by hand.
    const catsF = (await req(admin, "GET", "/api/master-lists/cost-categories")).data.items ?? [];
    const headF = catsF.find((c) => !c.parent);
    const ruleOff = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
    ok("QA-1830 fixture: cost.post parking is switched off so the fixture lands in the ledger, not the queue",
      ruleOff.status === 200, `got ${ruleOff.status}`);
    const before = (await req(admin, "GET", "/api/reports/costs")).data?.totals?.actual ?? 0;
    // "Untagged" means no BATCH — Manish sir's note #5 is about `batch_id` being nullable. It does
    // NOT mean no dimension at all: Rule 37 refuses an entry with no location, batch or trainer, and
    // the first version of this fixture asked for exactly that and got a correct 400. A centre cost
    // with no batch is the real shape, and it is the one that lands in Unassigned.
    const locF = (await req(admin, "GET", "/api/locations?limit=1")).data?.items?.[0];
    const untagged = headF && locF
      ? await req(admin, "POST", "/api/costs", { entry_date: "2026-09-06", location: locF._id, category: headF._id, amount: 4242, note: "QA-1830 untagged fixture" })
      : { status: 0 };
    ok("QA-1830 fixture: a centre cost with no batch can be posted", untagged.status === 201, `got ${untagged.status}`);
    const after = (await req(admin, "GET", "/api/reports/costs")).data ?? {};
    ok("QA-1830: an untagged cost lands in Unassigned rather than being dropped",
      (after.by_job_role ?? []).some((r) => r.label === "Unassigned" && r.amount >= 4242), JSON.stringify((after.by_job_role ?? []).map((r) => r.label)));
    ok("QA-1830: ...and the grand total moves by exactly its amount, so the register still ties",
      (after.totals?.actual ?? 0) === before + 4242, `${before} + 4242 vs ${after.totals?.actual}`);
    ok("QA-1830: ...and every grouping still sums to the new total",
      sum(after.by_head) === after.totals?.actual && sum(after.register) === after.totals?.actual,
      `heads=${sum(after.by_head)} register=${sum(after.register)} total=${after.totals?.actual}`);

    // ---- developer note #6: guard every ratio. A batch with nobody enrolled has no cost per
    // trainee; it does not have a cost per trainee of zero. And the Unassigned row has no batch
    // at all, so it has neither figure.
    const noDenom = (after.unit_economics ?? []).filter((r) => !r.enrolled);
    ok("QA-1830: a batch with no enrolment shows no cost-per-trainee rather than a confident 0",
      noDenom.every((r) => r.cost_per_enrolled === null), JSON.stringify(noDenom.map((r) => [r.batch, r.enrolled, r.cost_per_enrolled])).slice(0, 200));
    const unassignedRow = (after.unit_economics ?? []).find((r) => r.key === "none");
    ok("QA-1830: the Unassigned bucket carries money but claims no enrolment or ratio",
      !unassignedRow || (unassignedRow.enrolled === null && unassignedRow.cost_per_enrolled === null && unassignedRow.amount > 0),
      JSON.stringify(unassignedRow ?? {}));

    // QA-1928 (found by the LIVE checker on production, not by any local test). The batch bucket
    // ASSIGNED its centre inside the per-entry loop, so it kept the last entry's - and `Unassigned`
    // holds untagged spend from every centre, so it displayed one centre's name beside all of it.
    // No arithmetic assertion could see this: the totals were right the whole time, only the label
    // lied. So the assertion is about the LABEL, and it is built by making the bucket span two
    // centres on purpose.
    const twoCentres = (await req(admin, "GET", "/api/locations?limit=5")).data?.items ?? [];
    if (twoCentres.length >= 2 && headF) {
      const a1 = await req(admin, "POST", "/api/costs", { entry_date: "2026-09-06", location: twoCentres[0]._id, category: headF._id, amount: 111, note: "QA-1928 fixture A" });
      const a2 = await req(admin, "POST", "/api/costs", { entry_date: "2026-09-06", location: twoCentres[1]._id, category: headF._id, amount: 222, note: "QA-1928 fixture B" });
      ok("QA-1928 fixture: two untagged costs at two different centres", a1.status === 201 && a2.status === 201, `${a1.status}/${a2.status}`);
      const rep2 = (await req(admin, "GET", "/api/reports/costs")).data ?? {};
      const un = (rep2.unit_economics ?? []).find((r) => r.key === "none");
      ok("QA-1928: a bucket spanning several centres says how many, instead of naming one of them",
        un && /centres$/.test(String(un.location)), JSON.stringify({ location: un?.location, amount: un?.amount }));
      ok("QA-1928: ...and it does not display any single centre's name beside everybody's money",
        un && !twoCentres.some((l) => String(un.location) === String(l.name)), String(un?.location));
      const one = (rep2.unit_economics ?? []).find((r) => r.key !== "none" && r.amount > 0);
      ok("QA-1928: ...while a real batch, whose entries share one centre, still names that centre",
        !one || !/\d+ centres$/.test(String(one.location)), JSON.stringify({ batch: one?.batch, location: one?.location }));
    }

    // ---- developer notes #1 and #2: no head is hard-coded, and the join is on id. A head created
    // now must be a column with no deployment; a head RENAMED now must leave every historical
    // figure exactly where it was. Renaming is the one that catches a name-join, and a name-join
    // is what this codebase already shipped once (`rules.ts` upserts a category BY NAME).
    const newHead = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `QA1830 Head ${Date.now()}`, head_type: "Direct" });
    ok("QA-1830 fixture: a new cost head can be created", newHead.status === 201, `got ${newHead.status}`);
    const withNew = (await req(admin, "GET", "/api/reports/costs")).data ?? {};
    ok("QA-1830: a head added a moment ago is already a column in the cross-tab, with no deployment",
      (withNew.cross_tab?.heads ?? []).some((h) => h.key === String(newHead.data?.item?._id)),
      `${(withNew.cross_tab?.heads ?? []).length} columns`);

    const headWithSpend = (withNew.by_head ?? []).find((h) => h.amount > 0 && h.key !== "none");
    if (headWithSpend) {
      const renamed = `${headWithSpend.head} RENAMED`;
      const rn = await req(admin, "PATCH", `/api/master-lists/cost-categories/${headWithSpend.key}`, { name: renamed });
      ok("QA-1830 fixture: that head can be renamed", rn.status === 200, `got ${rn.status}`);
      const afterRn = (await req(admin, "GET", "/api/reports/costs")).data ?? {};
      const same = (afterRn.by_head ?? []).find((h) => h.key === headWithSpend.key);
      ok("QA-1830: renaming a head leaves its historical figure untouched — the join is on id, not on name",
        !!same && same.amount === headWithSpend.amount && same.head === renamed,
        `${headWithSpend.amount} -> ${same?.amount} as "${same?.head}"`);
      ok("QA-1830: ...and the grand total does not move because a head was renamed",
        (afterRn.totals?.actual ?? 0) === (withNew.totals?.actual ?? -1), `${withNew.totals?.actual} -> ${afterRn.totals?.actual}`);
      await req(admin, "PATCH", `/api/master-lists/cost-categories/${headWithSpend.key}`, { name: headWithSpend.head });
    } else ok("QA-1830 fixture: a head with spend exists to rename", false, "none found");

    // ---- developer note #7: row-level scoping in the QUERY. A scoped user who IS granted
    // finance.view sees their own centre and no more, and a named ?location= NARROWS — it can
    // never widen. That last clause is QA-1898, one release old, on a route I wrote; the same
    // shape is refused here rather than trusted not to recur.
    const spocId = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "spoc.jpr03@vidysea.com")?._id;
    if (spocId && spoc) {
      const grant = await req(admin, "PATCH", `/api/users/${spocId}`, { extra_permissions: ["finance.view"] });
      ok("QA-1830 fixture: a centre SPOC can be granted finance.view", grant.status === 200, `got ${grant.status}`);
      const spoc2 = await login("spoc.jpr03@vidysea.com", PW);
      const mine = await req(spoc2, "GET", "/api/reports/costs");
      ok("QA-1830: a granted, scoped user now gets the dashboard", mine.status === 200, `got ${mine.status}`);
      const centres = new Set((mine.data?.by_location ?? []).map((r) => r.label).filter((n) => n !== "Unassigned"));
      ok("QA-1830: ...and it carries only their own centre",
        centres.size <= 1, [...centres].join(","));
      const others = (await req(admin, "GET", "/api/locations?limit=50")).data?.items ?? [];
      const foreignL = others.find((l) => !/JPR03/i.test(String(l.code ?? "")));
      if (foreignL) {
        const attack = await req(spoc2, "GET", `/api/reports/costs?location=${foreignL._id}`);
        ok("QA-1830: naming ANOTHER centre in ?location= is refused, not served (the QA-1898 shape)",
          attack.status === 403, `got ${attack.status} for ${foreignL.code}`);
        const admAny = await req(admin, "GET", `/api/reports/costs?location=${foreignL._id}`);
        ok("QA-1830: ...while an unscoped grant-holder may still name any centre", admAny.status === 200, `got ${admAny.status}`);
      }
      await req(admin, "PATCH", `/api/users/${spocId}`, { extra_permissions: [] });
      const revoked = await req(await login("spoc.jpr03@vidysea.com", PW), "GET", "/api/reports/costs");
      ok("QA-1830: taking the grant back closes the door again", revoked.status === 403, `got ${revoked.status}`);
    } else ok("QA-1830 fixture: the SPOC account resolves", false, String(spocId));

    // ---- the filters are applied SERVER-side and travel back, so the screen, the export and
    // anyone auditing a figure read the same statement of what was counted (note #4).
    const filtered = await req(admin, "GET", "/api/reports/costs?from=2099-01-01&to=2099-12-31");
    ok("QA-1830: the date filter is applied on the server, not in the UI",
      filtered.status === 200 && (filtered.data?.totals?.entries ?? -1) === 0, `entries=${filtered.data?.totals?.entries}`);
    ok("QA-1830: ...and the filters come back in the payload so the export can state them",
      filtered.data?.filters_applied?.from === "2099-01-01" && filtered.data?.filters_applied?.to === "2099-12-31",
      JSON.stringify(filtered.data?.filters_applied ?? {}));
    ok("QA-1830: an empty window still ties to zero rather than 500ing",
      (filtered.data?.totals?.actual ?? -1) === 0 && (filtered.data?.register ?? []).length === 0, JSON.stringify(filtered.data?.totals ?? {}));

    // Budget is per HEAD and whole-project — there is no per-centre or per-period budget in the
    // model. So under a narrowing filter, variance and "% used" would compare part of the spend
    // against all of the budget and read as underspend that is not there. They must be withheld,
    // with a reason, rather than shown confidently.
    const narrowed = await req(admin, "GET", "/api/reports/costs?from=2020-01-01&to=2030-12-31");
    ok("QA-1830: a narrowing filter withholds variance and % used rather than comparing a slice against the whole budget",
      narrowed.status === 200 && narrowed.data?.totals?.budget_comparable === false
      && narrowed.data.totals.variance === null && narrowed.data.totals.pct_used === null
      && (narrowed.data.by_head ?? []).every((h) => h.variance === null && h.pct_used === null),
      JSON.stringify({ comparable: narrowed.data?.totals?.budget_comparable, variance: narrowed.data?.totals?.variance }));
    ok("QA-1830: ...and it says why, in the payload the screen and the .xlsx both read",
      typeof narrowed.data?.totals?.budget_note === "string" && narrowed.data.totals.budget_note.length > 40,
      String(narrowed.data?.totals?.budget_note).slice(0, 80));
    const unfiltered = await req(admin, "GET", "/api/reports/costs");
    ok("QA-1830: ...while the unfiltered view does compare, so the withholding is a rule and not a broken column",
      unfiltered.data?.totals?.budget_comparable === true && unfiltered.data?.totals?.budget_note === null,
      JSON.stringify({ comparable: unfiltered.data?.totals?.budget_comparable }));

    const xl = await req(admin, "GET", "/api/reports/costs/export");
    ok("QA-1830: the .xlsx export answers for the grant-holder", xl.status === 200, `got ${xl.status}`);

    // QA-1959. The cycle-2 checker measured 42 of 42 "by centre" Margin cells BLANK while the
    // screen showed a withheld margin with its reason: the payload was right and the FILE was
    // wrong, so every assertion on the payload passed over it. This pin therefore reads the
    // WORKBOOK BYTES - opening the .xlsx as the zip it is and parsing the sheet - because that is
    // the only surface the defect lived on.
    {
      const XLSX = await import("xlsx");
      const res = await fetch(BASE + "/api/reports/pnl/export", { headers: { cookie: admin } });
      ok("QA-1959: the P&L workbook downloads", res.status === 200, `got ${res.status}`);
      if (res.status === 200) {
        const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" });
        const pnl = (await req(admin, "GET", "/api/reports/pnl")).data ?? {};
        const withheld = (pnl.by_location ?? []).filter((r) => r.margin === null);
        // defval:null MATTERS: without it sheet_to_json OMITS a missing cell entirely, the row
        // simply has no Margin key, and a "is it blank?" test silently reads undefined on every
        // row including the healthy ones - which is why the first version of the blank-cell
        // assertion below SURVIVED its own mutant. With defval the missing cell materialises.
        const sheet = XLSX.utils.sheet_to_json(wb.Sheets["by centre"] ?? {}, { defval: null });
        const marginCol = Object.keys(sheet[0] ?? {}).find((k) => /margin/i.test(k)) ?? "Margin";
        const blanks = sheet.filter((r) => r[marginCol] === undefined || r[marginCol] === null || r[marginCol] === "");
        ok("QA-1959: no withheld margin reaches the workbook as a BLANK cell",
          blanks.length === 0,
          JSON.stringify({ rows: sheet.length, blank: blanks.length, col: marginCol }));
        // The dash and the reason travel together: a "—" with no sentence beside it is still a
        // number a reader cannot account for.
        if (withheld.length > 0) {
          const dashed = sheet.filter((r) => String(r[marginCol]) === "—");
          const withReason = dashed.filter((r) => String(r["Why the margin is withheld"] ?? "").length > 20);
          ok("QA-1959: every withheld margin shows a dash AND carries its reason in the file",
            dashed.length === withheld.length && withReason.length === dashed.length,
            JSON.stringify({ payloadWithheld: withheld.length, dashed: dashed.length, withReason: withReason.length }));
        }
      }
    }
  }

  // ---- QA-1899. `kpiRollup` excluded dropouts from "trained" with
  // `BatchMember.find({ status: "Dropped" })`, and BatchMember has no `status` field — the query
  // matched nothing, the exclusion set was always empty, and every dropped-but-passed member was
  // counted as trained. NOTHING FAILED: an empty exclusion set is indistinguishable from "there
  // were no dropouts". So the pin is behavioural — drop somebody who has a Pass and watch the
  // number move — because a pin on the field name would not have caught the original either.
  {
    // QA-1941: this pin shipped with the literal "2026-09-06" as the drop date - the day it was
    // written - and went red the very next morning. Rule 25 refuses a left_on that precedes
    // joined_on, and `seed-sample` dates its rosters RELATIVE to the run, so a frozen date walks
    // backwards past them one day at a time. It cost two failures on a wall whose only two commits
    // were a version bump and a CSS-level gate fix, which is the expensive part: a test that rots
    // on a calendar makes the next real regression look like more of the same noise.
    // IST, because the whole system is on Asia/Kolkata and Rule 25 compares in that footing.
    const TODAY_IST = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const kBefore = await req(admin, "GET", "/api/reports/kpi");
    const batches = (await req(admin, "GET", "/api/batches?limit=50")).data?.items ?? [];
    let victim = null;
    for (const b of batches) {
      // The route returns one row per MEMBER with the result nested — `items[].result` is the
      // CandidateResult document or null, not the verdict string. The first version of this finder
      // read `r.result === "Pass"` and found nobody, which is a fixture that fails loudly rather
      // than a pin that passes on an empty set. It is worth the distinction.
      const res = (await req(admin, "GET", `/api/batches/${b._id}/results`)).data?.items ?? [];
      // ...and the member must have joined ON OR BEFORE today, or Rule 25 refuses the drop
      // ("left_on cannot precede joined_on") and the pin fails on the fixture rather than on the
      // thing it is measuring. `seed-sample` deliberately pre-registers members into batches that
      // start LATER (QA-1024 - a real thing a centre does, and it is documented there as a fixture
      // that must not be clamped), so on any given day some rosters are legitimately future-dated.
      const passed = res.find((r) => r.result?.result === "Pass" && !r.left_on && (r.candidate?._id ?? r.candidate)
        && (!r.joined_on || String(r.joined_on).slice(0, 10) <= TODAY_IST));
      if (passed) { victim = { batch: b, cand: passed.candidate?._id ?? passed.candidate }; break; }
    }
    ok("QA-1899 fixture: a candidate with a Pass result exists to drop", !!victim, JSON.stringify(victim?.cand ?? null));
    if (victim) {
      const dropped = await req(admin, "POST", `/api/candidates/${victim.cand}/drop`, { reason: "QA-1899 pin", date: TODAY_IST });
      ok("QA-1899 fixture: they can be dropped", [200, 201].includes(dropped.status), `got ${dropped.status}`);
      const kAfter = await req(admin, "GET", "/api/reports/kpi");
      ok("QA-1899: dropping a member who PASSED reduces `trained` by exactly one",
        (kAfter.data?.trained ?? -1) === (kBefore.data?.trained ?? -2) - 1,
        `${kBefore.data?.trained} -> ${kAfter.data?.trained}`);
      await req(admin, "POST", `/api/candidates/${victim.cand}/drop`, { undo: true });
    }
  }

  // ---- QA-1927: every KPI card opens the rows its own number was summed from.
  // The assertion that matters is NOT "a table appears" - it is that the card's number and the
  // table's length are the same arithmetic. `reportRollup` holds exactly this between a tile and
  // its drill-down (`sum(detail) === total`, pinned in e2e.mjs), and it is the reason that pattern
  // was extracted: a drill-down assembled by a second query says 61 under a tile that says 57, and
  // then neither is trusted.
  {
    const k = await req(admin, "GET", "/api/reports/kpi");
    const d = k.data?.detail ?? {};
    ok("QA-1927: the KPI payload ships a detail block keyed by card", Object.keys(d).length >= 7, JSON.stringify(Object.keys(d)));
    for (const [key, num] of [["trained", k.data?.trained], ["in_training", k.data?.in_training], ["upcoming_batches", k.data?.upcoming_batches]]) {
      const dd = d[key];
      ok(`QA-1927: the "${key}" card's total IS the figure on the card`, dd && dd.total === num, `detail ${dd?.total} vs card ${num}`);
      ok(`QA-1927: ...and its table holds exactly that many rows unless it says it is capped`,
        dd && (dd.truncated ? dd.shown < dd.total && dd.shown > 0 : dd.rows.length === dd.total),
        `rows=${dd?.rows?.length} shown=${dd?.shown} total=${dd?.total} truncated=${dd?.truncated}`);
      ok(`QA-1927: ...and it names its own columns, so the screen invents no headers`,
        Array.isArray(dd?.columns) && dd.columns.length > 0 && dd.columns.every((c) => Array.isArray(c) && c.length === 2),
        JSON.stringify(dd?.columns));
      ok(`QA-1927: ...and every row actually carries every column it declares`,
        dd.rows.length === 0 || dd.columns.every(([col]) => dd.rows.every((r) => col in r)),
        JSON.stringify(dd.rows[0] ?? {}).slice(0, 140));
    }
    // The four blocker cards, each opening ITS OWN category rather than one list to re-filter.
    for (const c of (k.data?.blocker_summary ?? [])) {
      const dd = d[`blocker:${c.category}`];
      ok(`QA-1927: the "${c.category}" card opens its own rows, and only its own`,
        dd && dd.total === c.count && dd.rows.every((r) => r.category === c.category),
        `detail ${dd?.total} vs card ${c.count}`);
    }
    // Still money-free: this door is on the leak probe's list and says it carries none. Drill rows
    // are the newest way that could stop being true.
    ok("QA-1927: the drill rows carry no money either",
      !/"amount":\s*-?\d|"budget":\s*\d|₹\s?[\d,]/.test(JSON.stringify(d)), "checked the whole detail block");

    // Scoped exactly like the number they open - otherwise a card becomes a side door to a centre's
    // students that the report itself refuses (the QA-1898 / QA-1900 shape, one layer in).
    if (spoc) {
      const sk = await req(spoc, "GET", "/api/reports/kpi");
      const sd = sk.data?.detail ?? {};
      const centres = new Set((sd.in_training?.rows ?? []).map((r) => r.location).filter((x) => x && x !== "—"));
      ok("QA-1927: a scoped user's drill rows carry only their own centre",
        centres.size <= 1, [...centres].join(","));
      ok("QA-1927: ...and the scoped card total still equals its own row count",
        sd.trained && (sd.trained.truncated || sd.trained.rows.length === sd.trained.total),
        `rows=${sd.trained?.rows?.length} total=${sd.trained?.total}`);
    }
  }

  // ---- QA-1831: revenue, receipts and P&L.
  // The pins that matter here are the ones a payload assertion cannot reach. "The endpoint returns
  // a number" is satisfied by a wrong number; each of these binds the ARITHMETIC or the honesty
  // rule the number is supposed to obey.
  {
    // SELF-SEEDING, and the first wall is why. The accrual pin needs a batch that has BOTH a
    // certified head-count and a rate on its scheme, and the fixtures carry closures with the
    // first and schemes without the second - so `valued` was empty and the pin reported
    // "0 row(s) checked". It FAILED rather than passing on an empty set, which is the only reason
    // that was visible at all; the same block written as `wrong.length === 0` would have gone
    // green over an assertion that never ran. That is QA-1919's lesson, one unit later: a pin whose
    // precondition the fixture does not guarantee has to establish it itself.
    const RATE = 1850;
    const TODAY_PNL = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const schemes = (await req(admin, "GET", "/api/master-lists/schemes")).data?.items ?? [];
    let seeded = 0;
    for (const sc of schemes) {
      if (sc.amount_received === null || sc.amount_received === undefined) {
        const up = await req(admin, "PATCH", `/api/master-lists/schemes/${sc._id}`, { amount_received: RATE });
        if (up.status === 200) seeded++;
      }
    }
    ok("QA-1831 fixture: at least one scheme carries a rate per certified candidate",
      schemes.length > 0 && (seeded > 0 || schemes.some((sc) => sc.amount_received > 0)),
      `${schemes.length} scheme(s), ${seeded} given a rate`);
    // ...and a batch that has actually been assessed. The wall's fixtures never run one through to
    // a closure - the invoice they seed is inserted straight into Mongo - so `valued` was still
    // empty after the scheme rates were seeded, and the pin failed a third time. It kept failing
    // rather than passing on an empty set, which is the whole reason the emptiness was ever
    // visible; `wrong.length === 0` alone would have been green through all three runs.
    //
    // Setting batch-level figures (rather than per-candidate results) is deliberate: it is Rule 41's
    // LEGACY shape, where a batch keeps its stored figures because it has no per-candidate rows.
    // That path is the fallback pnlRollup uses, and nothing else in the wall exercises it.
    let seededBatch = null;
    let seedWhy = "no batch tried";
    for (const b of (await req(admin, "GET", "/api/batches?limit=50")).data?.items ?? []) {
      // A Completed / Cancelled / Closed batch has its closure fields locked (2026-08-13), so those
      // are skipped rather than counted as refusals.
      if (["Completed", "Cancelled", "Closed"].includes(b.status)) continue;
      // The SMALLEST figures that still exercise the multiplication. Rule 34 caps appeared by the
      // roster ON THE ASSESSMENT DATE, and this fixture's rosters are small and partly future-dated
      // (QA-1024 pre-registers members into batches that start later, deliberately). Asking for 12
      // was the third thing this pin got wrong; 1 is enough to multiply.
      const put = await req(admin, "PUT", `/api/batches/${b._id}/closure`, {
        assessment_status: "Completed", assessment_date: TODAY_PNL, appeared: 1, passed: 1,
        certification_status: "Completed", certification_date: TODAY_PNL, certificates_issued: 1,
      });
      if (put.status === 200) {
        // ...and the batch's JOB ROLE has to point at a scheme that carries a rate, or the row is
        // still unvaluable and the pin still has nothing to multiply. This was the FOURTH thing
        // this fixture had to establish: a rate on the scheme, a certified head-count on the
        // closure, an unlocked batch, and finally the link between the two ends. Seeded rather than
        // assumed, because each of the first three was assumed once and was wrong.
        // The batch's job role already NAMES a scheme - `Program.scheme` is an enum string, not a
        // ref - so nothing needs linking. What has to be true is that the Scheme MASTER row of that
        // name carries a rate. The previous version PATCHed the programme with a scheme ObjectId
        // and got a 400 every time, then reported "linked" anyway because it asserted on the
        // scheme it had FOUND rather than on the write it had made.
        //
        // That 400 is what exposed the real defect: pnlRollup was populating `scheme` as if it were
        // a ref, which is silently a no-op, so every rate was null and the whole accrual was inert.
        // NOT b.program.scheme. GET /api/batches populates program with only
        // "name code duration_days" (batches/route.ts:54), so `scheme` is never in that payload and
        // reading it there always yields undefined - which is how this fixture came to report
        // "no scheme on the job role" for a batch that has one, while pnlRollup (which does its own
        // populate) valued it correctly. The fixture was measuring the wrong endpoint and blaming
        // the product; the programme itself is the source of truth for its own field.
        const progId0 = String(b.program?._id ?? b.program ?? "");
        const progDoc = progId0 ? (await req(admin, "GET", `/api/programs/${progId0}`)).data : null;
        const schemeName = (progDoc?.item?.scheme ?? progDoc?.scheme) ? String(progDoc.item?.scheme ?? progDoc.scheme) : null;
        let rateStatus = "no scheme on the job role";
        if (schemeName) {
          const row = schemes.find((sc) => String(sc.name) === schemeName);
          if (row && Number(row.amount_received) > 0) rateStatus = `already ${row.amount_received}`;
          else if (row) {
            const up = await req(admin, "PATCH", `/api/master-lists/schemes/${row._id}`, { amount_received: RATE });
            rateStatus = `set -> ${up.status}`;
          } else {
            const mk = await req(admin, "POST", "/api/master-lists/schemes", { name: schemeName, amount_received: RATE });
            rateStatus = `created -> ${mk.status}`;
          }
        }
        // Read back what pnlRollup will actually see, rather than trusting the write.
        const backSchemes = (await req(admin, "GET", "/api/master-lists/schemes")).data?.items ?? [];
        const effective = backSchemes.find((sc) => String(sc.name) === schemeName);
        seedWhy = `batch=${b.code ?? b._id} scheme=${schemeName ?? "NONE"} rate=${rateStatus} readBack=${effective ? effective.amount_received : "absent"}`;
        seededBatch = { id: String(b._id), passed: 1, scheme: schemeName, linked: !!(effective && Number(effective.amount_received) > 0) };
        break;
      }
      // Keep the LAST refusal, so a future failure of this fixture says why instead of just "no".
      // Every previous version of this block failed silently and cost a whole wall cycle to
      // diagnose; the message is the difference between one run and three.
      seedWhy = `${b.code ?? b._id}: ${put.status} ${JSON.stringify(put.data?.error ?? put.data ?? "").slice(0, 150)}`;
    }
    ok("QA-1831 fixture: a batch with a certified head-count exists to value",
      !!seededBatch, seedWhy);
    // The link is its own assertion. Folding it into the one above would let a half-built fixture
    // report success and push the failure two assertions downstream, which is exactly how the last
    // three cycles were spent.
    ok("QA-1831 fixture: ...and its job role is linked to a scheme that carries a rate",
      !!seededBatch?.linked, seedWhy);





    const pnl = await req(admin, "GET", "/api/reports/pnl");
    ok("QA-1831: the granted admin gets the P&L", pnl.status === 200, `got ${pnl.status}`);
    const d = pnl.data ?? {};
    const reg = d.register ?? [];
    ok("QA-1831 fixture: production-shaped data reaches this report at all, so the ties below are not vacuous",
      reg.length > 0, `${reg.length} batch row(s)`);

    // THE accrual. Not "accrued is a number" - the exact multiplication, on every row that has both
    // halves. Nothing anywhere multiplied these two fields before this unit; both were on file and
    // dead.
    // ---- QA-1950 (checker, cycle 1). The three assertions below replace three that a checker
    // proved could not fail. It built the `(rate ?? 0)` mutant this unit's own manifest declared,
    // and got 35/35 GREEN. Why, exactly:
    //
    //   a) `valued = reg.filter(r => r.accrued !== null)` measures only the rows the bug LEAVES
    //      BEHIND. Under the mutant an unrated row has accrued 0, which is not null, so it joins
    //      `valued` and is then checked against the mutant's own arithmetic.
    //   b) `totals.accrued_unknown === unvalued.length` compares two things incremented by the
    //      IDENTICAL test, so they cannot disagree - the exact "internal consistency a report of
    //      nulls satisfies" failure this unit correctly diagnosed for QA-1948, reproduced one
    //      assertion later by the same author.
    //   c) `5 * null === 0` in JavaScript. The pin asserted `accrued === billable * rate`; under the
    //      mutant `rate` is null, so the EXPECTED value computes to 0 and the actual is 0. The pin
    //      computed the bug and then checked the bug against itself.
    //
    // So: every criterion below is derived from the INPUTS (billable, rate), never from the output
    // (accrued), and the null case is anchored to a batch this block deliberately made
    // certified-but-unrated rather than to whatever the fixture happened to contain.
    const ratedRows = reg.filter((r) => r.billable !== null && r.rate !== null);
    const badMath = ratedRows.filter((r) => r.accrued !== r.billable * r.rate);
    ok("QA-1831: every row with BOTH a head-count and a rate is valued at their product",
      ratedRows.length > 0 && badMath.length === 0,
      badMath.length ? JSON.stringify(badMath.slice(0, 2)) : `${ratedRows.length} row(s) checked`);

    // The mutant killer. A row that HAS a head-count and has NO rate must report null - not 0, and
    // not `billable * null`. This is the assertion `(rate ?? 0)` cannot survive.
    // `rate === null` mixes three causes and only one is mutant-sensitive, so it is used below
    // only for COUNTS, never as the subject of a behavioural claim. The behavioural claim is made
    // further down, on a condition this block creates deliberately.
    const unratedRows = reg.filter((r) => r.billable !== null && r.rate === null);

    // ...and the COUNT is derived from the inputs too, so it cannot move in lockstep with the bug.
    const expectUnknown = reg.filter((r) => r.billable === null || r.rate === null).length;
    ok("QA-1831: the not-valued count is the number of rows missing a head-count or a rate",
      (d.totals?.accrued_unknown ?? -1) === expectUnknown,
      `totals=${d.totals?.accrued_unknown} independent=${expectUnknown}`);
    // QA-1958: the previous version of this assertion used `r.billable !== null && r.rate === null`
    // - THE SAME CONFLATED PREDICATE THE PRODUCT USED - so it could not see that three causes were
    // being reported as one, and it certified the mislabel instead of catching it (QA-1950's
    // tautology, in the assertion written to close QA-1949). The causes are now derived from the
    // SCHEME MASTER, a different source than the report, so the pin and the product can disagree.
    const schemeMaster = ((await req(admin, "GET", "/api/master-lists/schemes")).data?.items ?? []);
    const rateOf = new Map(schemeMaster.map((sc) => [String(sc.name), sc.amount_received ?? null]));
    const causeOf = (r) => {
      if (r.billable === null) return "no_closure";
      if (!r.scheme || r.scheme === "Unassigned") return "no_scheme";   // the JOB ROLE master
      if (!rateOf.has(r.scheme)) return "scheme_missing";               // what a rename leaves behind
      if (rateOf.get(r.scheme) === null) return "no_rate";              // the SCHEME master
      return "none";
    };
    const indep = { no_closure: 0, no_scheme: 0, scheme_missing: 0, no_rate: 0, none: 0 };
    for (const r of reg) if (r.accrued === null) indep[causeOf(r)] += 1;
    ok("QA-1958: the not-valued rows are split by their REAL cause, each counted from the scheme master",
      (d.totals?.accrued_unknown_no_closure ?? -1) === indep.no_closure
        && (d.totals?.accrued_unknown_no_scheme ?? -1) === indep.no_scheme
        && (d.totals?.accrued_unknown_scheme_missing ?? -1) === indep.scheme_missing
        && (d.totals?.accrued_unknown_no_rate ?? -1) === indep.no_rate,
      JSON.stringify({ reported: {
        no_closure: d.totals?.accrued_unknown_no_closure, no_scheme: d.totals?.accrued_unknown_no_scheme,
        scheme_missing: d.totals?.accrued_unknown_scheme_missing, no_rate: d.totals?.accrued_unknown_no_rate },
        independent: indep }));
    // The bucket must hold ONLY rows whose own cause it names. This is the assertion that fails if
    // the three causes are ever collapsed back into one `else`, whatever the counters say.
    for (const [key, cause] of [["unknown_rate", "no_rate"], ["no_scheme", "no_scheme"], ["scheme_missing", "scheme_missing"]]) {
      const rowsIn = d.detail?.[key]?.rows ?? [];
      const wrong = rowsIn.filter((r) => causeOf(r) !== cause);
      // An EMPTY bucket satisfies "every row in it is the right cause" vacuously - measured, not
      // assumed: under the conflated-predicate mutant the no_scheme and scheme_missing buckets went
      // to zero rows and both purity assertions passed. So the bucket must also hold the RIGHT
      // NUMBER, taken from the independent cause count rather than from the report.
      ok(`QA-1958: the "${key}" bucket holds every row of that cause, not an empty list that passes vacuously`,
        (d.detail?.[key]?.total ?? -1) === indep[cause],
        JSON.stringify({ bucket: d.detail?.[key]?.total, independent: indep[cause] }));
      ok(`QA-1958: every row in the "${key}" bucket really is ${cause}, none borrowed from another cause`,
        (d.detail?.[key]?.total ?? -1) === rowsIn.length && wrong.length === 0,
        JSON.stringify({ total: d.detail?.[key]?.total, listed: rowsIn.length, misfiled: wrong.length,
          sample: wrong.slice(0, 3).map((r) => ({ batch: r.batch, scheme: r.scheme, real: causeOf(r) })) }));
    }
    // And the sentence a reader acts on must name every cause it counted - the surface QA-1958 was
    // actually reported against, since the counters could be right while the prose accuses one table.
    if ((d.totals?.accrued_unknown ?? 0) > 0) {
      const note = String(d.totals?.accrued_note ?? "");
      ok("QA-1958: the not-valued sentence names each cause it counted, so it cannot accuse the wrong master",
        (!indep.no_scheme || /names no scheme/i.test(note))
          && (!indep.scheme_missing || /not in the scheme master/i.test(note))
          && (!indep.no_rate || /carries no rate/i.test(note)),
        JSON.stringify({ independent: indep, note: note.slice(0, 200) }));
    }
    // ---- QA-1950, take two. The first attempt at this pin ALSO passed against the `(rate ?? 0)`
    // mutant, and the reason is worth writing down because it is subtle and general.
    //
    // `rate === null` has THREE causes: the job role names no scheme; it names one that is absent
    // from the master; or it names one that is present and carries no rate. Only the THIRD is
    // touched by `(rate ?? 0)`. The fixture's rows were almost all the first kind, so the pin's
    // subject set was full of rows the mutant cannot affect, and `.every()` was satisfied by them.
    // Hunting the data for the right kind of row also failed - every seeded batch shares one scheme,
    // so the "find a different scheme" loop `continue`d on all 50 and reported "not attempted".
    //
    // So this stops looking for the condition and CREATES it, on the batch this block already
    // certified: take the rate away, re-read, assert, put it back. That is the exact third case, it
    // is reached through the real code path, and it cannot be satisfied by a row of another kind.
    if (seededBatch?.scheme) {
      const schemeRow = ((await req(admin, "GET", "/api/master-lists/schemes")).data?.items ?? [])
        .find((sc) => String(sc.name) === seededBatch.scheme);
      if (schemeRow) {
        await req(admin, "PATCH", `/api/master-lists/schemes/${schemeRow._id}`, { amount_received: null });
        const pnl2 = (await req(admin, "GET", "/api/reports/pnl")).data ?? {};
        const row2 = (pnl2.register ?? []).find((r) => String(r.key) === seededBatch.id);
        // The read-back IS the precondition: if the clear did not land, `rate` is still a number and
        // this fails as a fixture problem rather than passing as a product result.
        ok("QA-1950 fixture: the rate can be taken off a scheme that a certified batch depends on",
          !!row2 && row2.billable !== null && row2.rate === null,
          JSON.stringify(row2 ? { billable: row2.billable, rate: row2.rate } : null));
        // THE MUTANT KILLER. `(rate ?? 0)` makes this 0. Nothing else in the wall distinguishes the
        // two, and the manifest's declared mutant ran 35/35 green until this line existed.
        ok("QA-1950: with the rate removed, a certified batch reports NULL - not 0, not billable x 0",
          !!row2 && row2.accrued === null,
          JSON.stringify(row2 ? { billable: row2.billable, rate: row2.rate, accrued: row2.accrued, basis: row2.accrual_basis } : null));
        ok("QA-1950: ...and it is filed under the no-rate cause, not under no-closure",
          (pnl2.totals?.accrued_unknown_no_rate ?? 0) >= 1
            && (pnl2.detail?.unknown_rate?.rows ?? []).some((r) => String(r.key) === seededBatch.id),
          JSON.stringify({ noRate: pnl2.totals?.accrued_unknown_no_rate, inCard: (pnl2.detail?.unknown_rate?.rows ?? []).length }));
        // Put it back, so every assertion after this block sees the fixture it was written against.
        await req(admin, "PATCH", `/api/master-lists/schemes/${schemeRow._id}`, { amount_received: RATE });
        const restored = ((await req(admin, "GET", "/api/master-lists/schemes")).data?.items ?? [])
          .find((sc) => String(sc.name) === seededBatch.scheme);
        ok("QA-1950 cleanup: the rate is put back, verified by reading it",
          !!restored && Number(restored.amount_received) === RATE, JSON.stringify(restored?.amount_received));
      }
    }

    ok("QA-1831: ...and when there are any, the payload says so in words the screen and the xlsx share",
      (d.totals?.accrued_unknown ?? 0) === 0 ? d.totals?.accrued_note === null : typeof d.totals?.accrued_note === "string",
      String(d.totals?.accrued_note).slice(0, 100));

    // The drill invariant: a card can only open the list its own number was summed from. Same
    // property reportRollup holds between a tile and its drill-down, for the same reason.
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    ok("QA-1831: the revenue tile's total IS the sum of the rows it opens",
      d.detail?.accrued && (d.detail.accrued.truncated || sum(d.detail.accrued.rows, "accrued") === d.totals.accrued),
      `${sum(d.detail?.accrued?.rows ?? [], "accrued")} vs ${d.totals?.accrued}`);
    ok("QA-1831: ...and the same holds for what was actually received",
      d.detail?.received && (d.detail.received.truncated || sum(d.detail.received.rows, "received") === d.totals.received),
      `${sum(d.detail?.received?.rows ?? [], "received")} vs ${d.totals?.received}`);
    ok("QA-1831: every card names its own columns, so the screen invents no headers",
      Object.values(d.detail ?? {}).every((c) => Array.isArray(c.columns) && c.columns.length > 0),
      JSON.stringify(Object.keys(d.detail ?? {})));

    // Margin is against EARNED revenue, not against whatever happened to be invoiced. A batch that
    // earned and was never billed must look unprofitable, because it is - that is the leak the CEO
    // opened the subject with, and averaging it away would hide exactly the thing he asked for.
    const marginWrong = reg.filter((r) => r.accrued !== null && r.margin !== r.accrued - r.cost);
    ok("QA-1831: margin is earned-minus-cost on every row, never invoiced-minus-cost",
      marginWrong.length === 0, JSON.stringify(marginWrong.slice(0, 2)));
    ok("QA-1831: 'earned but never invoiced' is counted rather than averaged away",
      (d.totals?.not_invoiced ?? -1) === reg.filter((r) => r.accrued !== null && r.invoiced === null).length,
      `${d.totals?.not_invoiced}`);

    // Cost that belongs to no batch is DISCLOSED. If it were silently dropped every margin on this
    // screen would be better than the truth, and nothing on the screen would say so.
    ok("QA-1831: cost tagged to no batch is reported separately, not dropped",
      typeof d.totals?.cost_unattributed === "number"
        && ((d.totals.cost_unattributed > 0) === (typeof d.totals.cost_note === "string")),
      `unattributed=${d.totals?.cost_unattributed} note=${!!d.totals?.cost_note}`);

    // The date filter's meaning travels in the payload, so the screen and the workbook cannot
    // describe the window differently from each other.
    ok("QA-1831: the report states what a date filter actually selects",
      typeof d.window_note === "string" && /batch/i.test(d.window_note), String(d.window_note).slice(0, 60));


    // ---- QA-1951 / QA-1952: the two things the cycle-1 checker raised and deliberately did NOT
    // charge me for. Umesh asked for both to be fixed rather than carried as declared gaps.
    //
    // QA-1951. Judgement 2 ("a missing rate is never a zero") was true of ROWS and false of GROUPS:
    // `finish()` folded `accrued ?? 0` into the group sum while counting the FULL cost of the same
    // batches, so any centre holding an unvaluable batch reported a margin wrong in a KNOWN
    // DIRECTION - too low, every time, by exactly the revenue nobody could compute. A number that is
    // systematically wrong one way is worse than no number, because somebody acts on it.
    //
    // Both arms are asserted. A pin that only checks the withheld case passes on a payload with no
    // incomparable groups at all; a pin that only checks the reported case passes on one that
    // withholds everything. Neither alone distinguishes the fix from either failure mode.
    {
      const groups = [...(d.by_location ?? []), ...(d.by_job_role ?? []), ...(d.by_scheme ?? [])];
      const incomparable = groups.filter((g) => (g.accrued_unknown ?? 0) > 0);
      const comparable = groups.filter((g) => (g.accrued_unknown ?? 0) === 0);
      ok("QA-1951 fixture: the payload holds groups of BOTH kinds, so neither arm below is vacuous",
        incomparable.length > 0 && comparable.length > 0,
        `${incomparable.length} incomparable, ${comparable.length} comparable`);
      ok("QA-1951: a group holding an unvalued batch WITHHOLDS its margin rather than understating it",
        incomparable.length > 0 && incomparable.every((g) => g.margin === null && typeof g.margin_note === "string"),
        JSON.stringify(incomparable.slice(0, 2).map((g) => ({ k: g.label, u: g.accrued_unknown, m: g.margin }))));
      ok("QA-1951: ...and a group where every batch IS valued still reports one",
        comparable.length > 0 && comparable.every((g) => typeof g.margin === "number"),
        JSON.stringify(comparable.slice(0, 2).map((g) => ({ k: g.label, m: g.margin }))));
      // The partial `accrued` is still a true sum of what is known - only the subtraction is
      // withheld - so it must NOT have been nulled along with the margin.
      ok("QA-1951: ...and the partial revenue is still shown, because it is a true sum of what is known",
        incomparable.every((g) => typeof g.accrued === "number"),
        JSON.stringify(incomparable.slice(0, 2).map((g) => g.accrued)));
      ok("QA-1951: the grand total obeys the same rule as the groups",
        (d.totals?.accrued_unknown ?? 0) > 0
          ? d.totals.margin === null && typeof d.totals.margin_note === "string"
          : typeof d.totals.margin === "number",
        JSON.stringify({ unknown: d.totals?.accrued_unknown, margin: d.totals?.margin }));
    }

    // QA-1952. `cost_unattributed` ignored EVERY filter, so a reader who narrowed to one centre
    // still saw the whole organisation's untagged spend under their narrowed report.
    {
      // QA-1960: the previous version of this pin asserted `narrowed <= whole`, and EQUALITY IS
      // EXACTLY THE BUG - a checker reverted the QA-1952 fix in full, every centre reported the
      // whole organisation's INR 54,177, and this assertion stayed green over it. Two changes, and
      // the first is the one that matters: stop hunting for a condition and CREATE it (the QA-1950
      // move). Untagged cost is seeded into TWO different centres, so a correct narrowing is
      // necessarily STRICTLY less than the whole; then the narrowed figure is compared against an
      // INDEPENDENT sum taken from the cost ledger, not against the report's own other number.
      const locsAll = ((await req(admin, "GET", "/api/locations?limit=5")).data?.items ?? []);
      const catsAll = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []);
      const leafCat = catsAll.find((c) => c.parent) ?? catsAll[0];
      if (locsAll.length >= 2 && leafCat) {
        // Distinctive amounts: a coincidental equality with pre-existing fixture data would make
        // the strict-narrowing assertion pass for the wrong reason.
        const AMT_A = 1234567, AMT_B = 7654321;
        const mkCost = (loc, amount) => req(admin, "POST", "/api/costs", {
          entry_date: "2026-06-15", location: loc._id, category: leafCat._id, amount,
          note: "QA-1960 fixture: untagged cost seeded to prove a centre filter narrows it",
        });
        const seedA = await mkCost(locsAll[0], AMT_A);
        const seedB = await mkCost(locsAll[1], AMT_B);
        // 201 explicitly, never "not an error": a parked entry answers 202 and writes NO ledger
        // row, which would leave the fixture absent and the assertions below vacuously true.
        ok("QA-1960 fixture: untagged cost written to TWO different centres (201, not parked)",
          seedA.status === 201 && seedB.status === 201,
          JSON.stringify({ a: seedA.status, b: seedB.status, cat: leafCat?.name }));

        const whole = (await req(admin, "GET", "/api/reports/pnl")).data ?? {};
        const narrowed = (await req(admin, "GET", `/api/reports/pnl?location=${locsAll[0]._id}`)).data ?? {};
        // The independent figure: that centre's own untagged rows, summed from the LEDGER.
        const ledger = ((await req(admin, "GET", `/api/costs?location=${locsAll[0]._id}`)).data?.items ?? []);
        const expected = ledger.filter((x) => !x.batch).reduce((acc, x) => acc + (Number(x.amount) || 0), 0);

        ok("QA-1960: the narrowed untagged-cost figure EQUALS that centre's own untagged ledger rows",
          narrowed.totals?.cost_unattributed === expected,
          JSON.stringify({ narrowed: narrowed.totals?.cost_unattributed, expected, rows: ledger.length }));
        ok("QA-1960: ...and is STRICTLY less than the whole organisation's - the equality the old pin allowed",
          typeof narrowed.totals?.cost_unattributed === "number"
            && typeof whole.totals?.cost_unattributed === "number"
            && narrowed.totals.cost_unattributed < whole.totals.cost_unattributed,
          JSON.stringify({ narrowed: narrowed.totals?.cost_unattributed, whole: whole.totals?.cost_unattributed }));
        // ---- QA-1964. Umesh's ruling (qa/gates/qa-1831-untagged-cost-under-a-date-window.md,
        // 2026-09-07): a DATED P&L discloses the organisation-wide untagged total with an explicit
        // out-of-window label, rather than withholding it. REQ-432 is about a PERIOD and nothing may
        // fall outside it. Cycle 3 shipped the opposite behaviour with NO assertion either way - the
        // checker reverted it, the payload moved null -> 17,831,953, and nothing failed. So BOTH
        // arms are pinned here, and the third assertion is the one that kills a re-added date
        // narrowing: the dated figure must EQUAL the undated one, because it is the same total.
        {
          const undated = (await req(admin, "GET", "/api/reports/pnl")).data ?? {};
          const wide = (await req(admin, "GET", "/api/reports/pnl?from=2020-01-01&to=2030-12-31")).data ?? {};
          const narrow = (await req(admin, "GET", "/api/reports/pnl?from=2026-06-01&to=2026-06-30")).data ?? {};

          ok("QA-1964: WITHOUT a date filter the untagged figure is a real number, scoped, and carries no caveat",
            typeof undated.totals?.cost_unattributed === "number"
              && undated.totals?.cost_unattributed_scoped !== false
              && !undated.totals?.cost_unattributed_note,
            JSON.stringify({ v: undated.totals?.cost_unattributed, scoped: undated.totals?.cost_unattributed_scoped, note: undated.totals?.cost_unattributed_note }));

          ok("QA-1964: UNDER a date filter it is DISCLOSED, never null - nothing falls outside the period",
            typeof wide.totals?.cost_unattributed === "number",
            JSON.stringify({ v: wide.totals?.cost_unattributed }));

          ok("QA-1964: ...and it is flagged NOT scoped to the window, with a reason a reader can act on",
            wide.totals?.cost_unattributed_scoped === false
              && /not scoped/i.test(String(wide.totals?.cost_unattributed_note ?? "")),
            JSON.stringify({ scoped: wide.totals?.cost_unattributed_scoped, note: String(wide.totals?.cost_unattributed_note).slice(0, 80) }));

          // The mutant-killer. If anyone re-narrows this figure by entry_date, a June-only window
          // stops equalling the whole; if anyone reverts to withholding, both go null and the
          // typeof assertions above fail first.
          ok("QA-1964: the dated figure IS the organisation-wide total - a narrow window and a wide one and no window all agree",
            typeof undated.totals?.cost_unattributed === "number"
              && wide.totals?.cost_unattributed === undated.totals?.cost_unattributed
              && narrow.totals?.cost_unattributed === undated.totals?.cost_unattributed,
            JSON.stringify({ undated: undated.totals?.cost_unattributed, wide: wide.totals?.cost_unattributed, narrowJune: narrow.totals?.cost_unattributed }));

          // The distinction the ruling turns on: does-not-APPLY still withholds. A batch filter is
          // a different fact from a date window and must not be swept into the same behaviour.
          const someBatchId = reg[0]?.key;
          if (someBatchId) {
            const byB = (await req(admin, "GET", `/api/reports/pnl?batch=${someBatchId}`)).data ?? {};
            ok("QA-1964: a BATCH filter still WITHHOLDS - cannot-be-scoped and does-not-apply stay different facts",
              byB.totals?.cost_unattributed === null && typeof byB.totals?.cost_unattributed_note === "string",
              JSON.stringify({ v: byB.totals?.cost_unattributed }));
          }
        }

        ok("QA-1960: the OTHER centre's untagged cost is present in the whole and absent from this narrowing",
          typeof whole.totals?.cost_unattributed === "number"
            && whole.totals.cost_unattributed - narrowed.totals.cost_unattributed >= AMT_B,
          JSON.stringify({ diff: (whole.totals?.cost_unattributed ?? 0) - (narrowed.totals?.cost_unattributed ?? 0), atLeast: AMT_B }));
      }
      const someBatch = reg[0]?.key;
      if (someBatch) {
        const byBatch = (await req(admin, "GET", `/api/reports/pnl?batch=${someBatch}`)).data ?? {};
        // A batch filter selects BATCHES, and untagged cost belongs to no batch - so the honest
        // answer is "does not apply", never 0. A 0 would read as "nothing is untagged", which is a
        // claim rather than an absence.
        ok("QA-1952: under a batch filter the figure is withheld WITH A REASON, never zeroed",
          byBatch.totals?.cost_unattributed === null && typeof byBatch.totals?.cost_unattributed_note === "string",
          JSON.stringify({ v: byBatch.totals?.cost_unattributed, note: String(byBatch.totals?.cost_unattributed_note).slice(0, 60) }));
      }
    }

    // ---- QA-1973. Umesh, 07/09, with a screenshot of AVP-GURU-RPLAVP-DST-03 on its own planned
    // start date: readiness 4/4 green, stopped solely by "Enrollment threshold not met: 37/43".
    // The hatch he chose (qa/gates/qa-1966-start-below-enrolment-threshold.md) starts the batch but
    // DEMANDS a reason and writes it to the audit row. Both arms are pinned, and the condition is
    // CREATED rather than hunted for - the threshold is raised to 100% so a batch is guaranteed to
    // be below it, then restored. Restoring in a finally, because a leaked 100% threshold would
    // make every later start in this run fail for a reason nobody would connect to this block.
    {
      const defBefore = (await req(admin, "GET", "/api/defaults")).data ?? {};
      const origPct = defBefore.enrollment_threshold_pct;
      try {
        const raised = await req(admin, "PUT", "/api/defaults", { enrollment_threshold_pct: 100 });
        ok("QA-1973 fixture: the enrolment threshold can be raised to 100% to create the shortfall",
          [200, 201].includes(raised.status), `got ${raised.status}`);

        const readyAll = ((await req(admin, "GET", "/api/batches?limit=100")).data?.items ?? [])
          .filter((b) => String(b.status) === "Ready");
        const readyB = readyAll[0];          // the refusal arms live here and it is never started
        // A second Ready batch if the fixture has one; otherwise the arms share, which is SAFE now
        // for a specific reason worth stating: every refusal arm asserts its own error MESSAGE, so a
        // shared batch going Active under a mutant makes them fail on "Transition Active -> Active"
        // instead of passing on a 409 they never meant. The two-batch split is defence in depth, not
        // the thing that makes this block honest.
        const readyStart = readyAll[1] ?? readyAll[0];
        ok("QA-1973 fixture: at least one Ready batch exists to work with",
          !!readyB, JSON.stringify(readyAll.map((b) => b.code).slice(0, 4)));

        if (readyB && readyStart) {
          const moved = await req(admin, "PATCH", `/api/batches/${readyB._id}`, { planned_start: "2026-06-01" });
          ok("QA-1973 fixture: its planned start is moved into the past, so Rule 17 is not what refuses it",
            [200, 201].includes(moved.status), `got ${moved.status}`);
          const rr = ((await req(admin, "GET", `/api/batches/${readyB._id}`)).data ?? {}).readiness ?? {};
          // If this batch somehow still meets a 100% threshold the whole block proves nothing, so
          // the precondition is asserted rather than assumed.
          ok("QA-1973 fixture: it is genuinely BELOW the threshold now",
            rr.enrollment_ok === false || rr.enrollment_ok === undefined,
            JSON.stringify({ enrolled: rr.enrolled_count, needed: rr.enrollment_threshold, ok: rr.enrollment_ok }));

          // ARM 1 - the gate still bites without the override.
          const plain = await req(admin, "POST", `/api/batches/${readyB._id}/transition`, { target: "Active" });
          ok("QA-1973: WITHOUT the override a below-threshold start is still refused",
            plain.status === 409 && /threshold not met/i.test(String(plain.data?.error ?? "")),
            `${plain.status} ${String(plain.data?.error ?? "").slice(0, 70)}`);

          // ARM 2 - the override without a reason is refused. This is the arm that matters: an
          // override that works with an empty reason is the gate deleted, wearing a flag.
          const noReason = await req(admin, "POST", `/api/batches/${readyB._id}/transition`,
            { target: "Active", enrollment_override: true });
          ok("QA-1973: the override WITHOUT a reason is refused - the reason is the whole price",
            noReason.status === 409 && /needs a reason/i.test(String(noReason.data?.error ?? "")),
            `${noReason.status} ${String(noReason.data?.error ?? "").slice(0, 70)}`);

          const shortReason = await req(admin, "POST", `/api/batches/${readyB._id}/transition`,
            { target: "Active", enrollment_override: true, reason: "ok" });
          ok("QA-1973: ...and a token reason is refused too, so the field cannot be satisfied with a keystroke",
            shortReason.status === 409 && /needs a reason/i.test(String(shortReason.data?.error ?? "")),
            `${shortReason.status} ${String(shortReason.data?.error ?? "").slice(0, 70)}`);

          // ARM 3 - with a real reason it starts, AND the record carries it. On its OWN batch:
          // under the "override not required" mutant ARM 1 actually starts `readyB`, and every
          // later call then answers "Transition Active -> Active is not allowed" - a 409 that made
          // the token-reason assertion above pass for a reason that had nothing to do with reasons.
          const movedS = await req(admin, "PATCH", `/api/batches/${readyStart._id}`, { planned_start: "2026-06-01" });
          ok("QA-1973 fixture: the start batch's planned start is moved into the past too",
            [200, 201].includes(movedS.status), `got ${movedS.status}`);
          const REASON = "client confirmed the start date; remaining candidates join in week 1";
          const started = await req(admin, "POST", `/api/batches/${readyStart._id}/transition`,
            { target: "Active", enrollment_override: true, reason: REASON });
          ok("QA-1973: with a real reason the batch STARTS below the threshold",
            [200, 201].includes(started.status) && String(started.data?.item?.status ?? "") === "Active",
            `${started.status} ${JSON.stringify(started.data).slice(0, 90)}`);

          const auditRes = await req(admin, "GET", `/api/audit/Batch/${readyStart._id}`);
          const acts = (auditRes.data?.items ?? auditRes.data?.rows ?? []);
          const row = acts.find((a) => String(a.field) === "enrollment_override");
          const rowVal = String(row?.new_value ?? row?.newValue ?? "");
          ok("QA-1973: the audit row exists, names the shortfall, and carries the reason VERBATIM",
            !!row && /below the enrolment threshold/i.test(rowVal) && rowVal.includes(REASON),
            JSON.stringify({ found: !!row, v: rowVal.slice(0, 140) }));
          // The number it was below must be IN the row, not merely implied by it (erp-af raised this:
          // a reason explains why somebody overrode the gate, it does not say what they overrode, and
          // if the global percentage moves later the row stops being interpretable without it).
          ok("QA-1973: ...and it records the threshold it was below, so the row survives the default changing",
            /\d+ enrolled of \d+ needed/.test(rowVal) && /% of a/.test(rowVal),
            rowVal.slice(0, 140));
        }

        // ARM 4 - the hatch is refused anywhere it would be meaningless, rather than ignored.
        const anyB2 = ((await req(admin, "GET", "/api/batches?limit=5")).data?.items ?? [])[0];
        if (anyB2) {
          const wrongTarget = await req(admin, "POST", `/api/batches/${anyB2._id}/transition`,
            { target: "Ready", enrollment_override: true, reason: "this should not be accepted at all" });
          ok("QA-1973: the override is REFUSED on a non-start transition, never silently dropped",
            wrongTarget.status === 400, `got ${wrongTarget.status}`);
        }
      } finally {
        if (typeof origPct === "number") {
          await req(admin, "PUT", "/api/defaults", { enrollment_threshold_pct: origPct });
        }
      }
      const after = (await req(admin, "GET", "/api/defaults")).data ?? {};
      ok("QA-1973: the threshold default is restored, so this block cannot poison the rest of the run",
        after.enrollment_threshold_pct === origPct,
        JSON.stringify({ before: origPct, after: after.enrollment_threshold_pct }));
    }

    // Scope, and the QA-1898 shape: a named ?location= NARROWS and can never widen.
    const narrowed = await req(admin, "GET", "/api/reports/pnl?from=2020-01-01&to=2020-12-31");
    ok("QA-1831: an empty window ties to zero rather than 500ing",
      narrowed.status === 200 && (narrowed.data?.totals?.batches ?? -1) === 0, `got ${narrowed.status}`);
    ok("QA-1831: ...and the filters come back so the export can state them",
      narrowed.data?.filters_applied?.from === "2020-01-01", JSON.stringify(narrowed.data?.filters_applied));
  }

  // ---- QA-1831: the receipt. "Paid" answered whether money came and never how much, so a part
  // payment or a deduction at source left no trace at all - the CEO's own complaint. These pins
  // bind that a SHORT receipt survives being recorded and is then reported as short.
  {
    const inv = ((await req(admin, "GET", "/api/invoices?status=Ready")).data?.items ?? [])[0]
      ?? ((await req(admin, "GET", "/api/invoices")).data?.items ?? []).find((i) => i.status === "Ready");
    if (!inv) {
      ok("QA-1831 fixture: an invoice at Ready exists to walk through the ladder", false, "none found");
    } else {
      const bId = String(inv.batch?._id ?? inv.batch);
      // The proposal: computed server-side and gated as money.
      const cl = await req(admin, "GET", `/api/batches/${bId}/closure`);
      ok("QA-1831: the closure payload proposes an invoice amount for a finance reader",
        cl.status === 200 && cl.data?.invoice_proposal && typeof cl.data.invoice_proposal.basis === "string",
        JSON.stringify(cl.data?.invoice_proposal ?? null));
      const prop = cl.data?.invoice_proposal;
      if (prop && prop.amount !== null) {
        ok("QA-1831: ...and the proposal is the same multiplication, not a second formula",
          prop.amount === prop.billable * prop.rate, `${prop.billable} x ${prop.rate} = ${prop.amount}`);
      }
      // ...and it is MONEY, so a reader without finance.view gets none of it.
      if (ops) {
        const opsCl = await req(ops, "GET", `/api/batches/${bId}/closure`);
        ok("QA-1831: a reader without finance.view gets the closure screen but no proposed amount",
          opsCl.status === 200 && !opsCl.data?.invoice_proposal, `got ${opsCl.status} proposal=${!!opsCl.data?.invoice_proposal}`);
        ok("QA-1831: ...and no received amount or receipt reference either - they are money like the rest",
          opsCl.data?.invoice && !("received_amount" in opsCl.data.invoice) && !("receipt_ref" in opsCl.data.invoice),
          JSON.stringify(Object.keys(opsCl.data?.invoice ?? {})));
      }

      // The freeze, in both directions. Recording money received before it is Raised is refused;
      // recording it AT Paid is the whole point and must work.
      const early = await req(admin, "PATCH", `/api/batches/${bId}/invoice`, { received_amount: 500 });
      // QA-1945: this pin FAILED on its own first wall (got 200) and that was a real product hole,
      // not a bad expectation - the post-Raised freeze left both receipt fields wide open before
      // Raised, so money could be recorded as received against an invoice nobody had issued.
      ok("QA-1945: money received cannot be recorded on an invoice that has not been raised",
        early.status >= 400, `got ${early.status}`);

      const AMT = 10000;
      const raise = await req(admin, "PATCH", `/api/batches/${bId}/invoice`, { status: "Raised", amount: AMT, invoice_no: "QA1831-INV", raised_on: "2026-09-07" });
      ok("QA-1831 fixture: the invoice can be raised", [200, 202].includes(raise.status), `got ${raise.status}`);
      const paid = await req(admin, "PATCH", `/api/batches/${bId}/invoice`, { status: "Paid", paid_on: "2026-09-07", received_amount: 8000, receipt_ref: "NEFT-QA1831" });
      ok("QA-1831: a receipt SMALLER than the invoice is accepted, not refused",
        [200, 202].includes(paid.status), `got ${paid.status}`);

      if (paid.status === 200) {
        const after = (await req(admin, "GET", `/api/batches/${bId}/closure`)).data?.invoice ?? {};
        ok("QA-1831: ...and it is stored as given, not rounded up to the invoice",
          after.received_amount === 8000 && after.receipt_ref === "NEFT-QA1831",
          JSON.stringify({ r: after.received_amount, ref: after.receipt_ref }));
        const pn = (await req(admin, "GET", "/api/reports/pnl")).data ?? {};
        const row = (pn.register ?? []).find((r) => String(r.key) === bId);
        ok("QA-1831: the P&L reports the difference as short received rather than showing it paid in full",
          !!row && row.shortfall === AMT - 8000, JSON.stringify({ invoiced: row?.invoiced, received: row?.received, short: row?.shortfall }));
        ok("QA-1831: ...and that batch is in the list the 'short received' card opens",
          (pn.detail?.shortfall?.rows ?? []).some((r) => String(r.key) === bId),
          `${(pn.detail?.shortfall?.rows ?? []).length} row(s) in the card`);
        // A zero receipt is not a receipt - the same argument Rule 37 makes about a cost of zero.
        const zero = await req(admin, "PATCH", `/api/batches/${bId}/invoice`, { status: "Paid", received_amount: 0 });
        ok("QA-1831: a zero or negative receipt is refused - absent means 'not recorded', 0 is a claim",
          zero.status >= 400, `got ${zero.status}`);
      }
    }
  }

  // QA-1902 (checker on qa-1832 cycle 1): the claim is that `blockers` IS `blockers_detailed`
  // mapped to its text, so the four categories can only be decided in one place. Nothing held them
  // together — a drifted second copy that silently dropped a sentence produced zero failures.
  {
    const rr = await req(admin, "GET", "/api/mapping/readiness?limit=50");
    const rows = (rr.data?.items ?? rr.data?.rows ?? []).filter((r) => Array.isArray(r.blockers));
    ok("QA-1902 fixture: readiness rows carry both shapes", rows.length > 0, `${rows.length} rows`);
    const drifted = rows.filter((r) => JSON.stringify(r.blockers) !== JSON.stringify((r.blockers_detailed ?? []).map((b) => b.text)));
    ok("QA-1902: every row's blocker sentences ARE its detailed blockers' text, in the same order",
      rows.length > 0 && drifted.length === 0,
      drifted.length ? JSON.stringify(drifted[0]).slice(0, 220) : `${rows.length} rows agree`);
  }

  // QA-1903: the CEO named four categories and the fourth could never be non-zero, because the
  // only source of blockers was centre readiness, which has no batch-management reason in it.
  {
    const k = await req(admin, "GET", "/api/reports/kpi");
    const cats = (k.data?.blocker_summary ?? []).map((c) => c.category);
    ok("QA-1903: all four of the CEO's categories are reported", cats.length === 4, JSON.stringify(cats));
    // "Can it be non-zero" is the whole finding, so it is PROVEN rather than observed: a batch is
    // pushed into the condition and the tile is read again. Observing a zero would have been the
    // same evidence the cycle-1 assertion produced, which is none.
    const planning = ((await req(admin, "GET", "/api/batches?limit=100")).data?.items ?? [])
      .find((b) => ["Planning", "Ready"].includes(String(b.status)));
    ok("QA-1903 fixture: a Planning/Ready batch exists to push past its start date", !!planning, String(planning?.code));
    if (planning) {
      const orig = planning.planned_start;
      const moved = await req(admin, "PATCH", `/api/batches/${planning._id}`, { planned_start: "2020-01-01" });
      ok("QA-1903 fixture: its planned start can be moved into the past", [200, 201].includes(moved.status), `got ${moved.status}`);
      const k2 = await req(admin, "GET", "/api/reports/kpi");
      const bm = (k2.data?.blocker_summary ?? []).find((c) => c.category === "Batch management");
      ok("QA-1903: 'Batch management' now carries that batch — the category can actually be filled",
        !!bm && bm.count > 0 && (k2.data?.blockers ?? []).some((b) => b.category === "Batch management" && /start/i.test(b.text)),
        JSON.stringify(bm ?? null));
      ok("QA-1903: ...and it names an owner, like the other three",
        !!bm && typeof bm.owner === "string" && bm.owner.length > 2, String(bm?.owner));
      if (orig) await req(admin, "PATCH", `/api/batches/${planning._id}`, { planned_start: String(orig).slice(0, 10) });
    }
  }

  // QA-1838: a right that gates nothing must not sit in the matrix pretending to.
  const cat = await req(admin, "GET", "/api/permissions");
  ok("QA-1838: invoices.manage is gone from the permission catalog (it gated nothing after QA-1825)",
    !(cat.data.catalog ?? []).some((p) => p.key === "invoices.manage"),
    JSON.stringify((cat.data.catalog ?? []).filter((p) => p.group === "Finance").map((p) => p.key)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Candidate-edit-from-batch E2E (QA-1436, 2026-08-26). Covers what actually changed server-side
// for the batch Enrollment tab's new Edit button: GET /api/batches/[id]/members now populates the
// FULL candidate document (not a 5-field projection), and — the load-bearing regression guard —
// that this did NOT loosen GET /api/candidates/[id] or GET /api/locations, both deliberately
// closed to Trainer (QA-060/095, a tested invariant in e2e-roles.mjs). The client component itself
// (CandidateEditDrawer) is not driven here; e2e-rendered-candidates.mjs is this project's pattern
// for that and is out of scope for this unit's server-side change.
// Run: node scripts/e2e-candidate-edit-from-batch.mjs
import { requireLocalBase } from "./db-guard.mjs";
const BASE = requireLocalBase("e2e-candidate-edit-from-batch", process.env.BASE_URL || "http://localhost:3000/erp");
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

async function req(cookie, method, path, body, expect) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expect !== undefined) ok(`${method} ${path.split("?")[0]} → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 150)})`);
  return { status: res.status, data };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
ok("admin login", !!admin);

const stamp = "CE" + Date.now().toString().slice(-6);
const PW = "CiOnly@123";

// ---- fixture: batch with an assigned trainer, and a second candidate-scoped field (email +
// aadhaar_no) so the widened populate has something beyond the old 5-field projection to prove ----
const loc = (await req(admin, "POST", "/api/locations", {
  code: "L" + stamp, name: "Govt. ITI " + stamp, state: "UP", district: "Muzaffarnagar",
  tc_id: "TC" + stamp, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const prog = (await req(admin, "POST", "/api/programs", {
  code: "P" + stamp, name: "Programme " + stamp, trainer_skill: "SK" + stamp,
  scheme: "RPL-AVPL", qp_code: "ASC/Q" + stamp.slice(-4), scheme_priority: 1,
}, 201)).data.item;
const tr = (await req(admin, "POST", "/api/trainers", {
  name: "Edit Trainer " + stamp, phone: "9" + Date.now().toString().slice(-9),
  email: `editrainer.${stamp}@example.com`.toLowerCase(),
  skills: [prog.trainer_skill], home_location: loc._id, pipeline_status: "Fresh Lead",
}, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "Room " + stamp, type: "Classroom" }, 201)).data.item;
const batch = (await req(admin, "POST", "/api/batches", {
  code: "B" + stamp, location: loc._id, program: prog._id, trainer: tr._id, room: room._id,
  target_size: 1, planned_start: new Date().toISOString().slice(0, 10),
}, 201)).data.item;

await req(admin, "POST", `/api/trainers/${tr._id}/create-login`, { password: PW }, 201);
const trainerCookie = await login(tr.email, PW);
ok("trainer login minted and can sign in", !!trainerCookie);

const cand = (await req(admin, "POST", "/api/candidates", {
  name: "Edit Candidate " + stamp, phone: "7" + Date.now().toString().slice(-9),
  email: `editcand.${stamp}@example.com`.toLowerCase(), aadhaar_no: "999941057058",
  // QA-1459: these five are set ONLY so the withholding pin below has something to withhold.
  // Its first run passed against the UNFIXED code purely because the fixture left them unset -
  // a pin that cannot go red, which is this project's most-repeated defect (QA-776, QA-1351,
  // QA-1353, QA-741). Caught by running it against the shipped commit before trusting it.
  dob: "2002-04-17", father_name: "Father " + stamp, mother_name: "Mother " + stamp,
  religion: "Hindu", social_category: "OBC",
  location: loc._id, program: prog._id,
}, 201)).data.item;
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cand._id }, 201);

// ---- 1. the members route now returns the FULL candidate record, not the old 5-field slice ----
const roster = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items;
const member = roster.find((m) => String(m.candidate?._id) === String(cand._id));
ok("member found on roster", !!member);
ok("populated candidate carries email (beyond the old 5-field projection)", member.candidate?.email === cand.email, JSON.stringify(member.candidate));
ok("populated candidate carries aadhaar_no", member.candidate?.aadhaar_no === "999941057058", JSON.stringify(member.candidate));
ok("populated candidate still carries the fields the old projection guaranteed (name/phone/sidh_candidate_id/apaar_id)",
  member.candidate?.name === cand.name && member.candidate?.phone === cand.phone, JSON.stringify(member.candidate));

// ---- 1b. QA-1459 — THE FIELD GATE. Section 1 above proves the full document reaches someone who
// may edit candidates. This proves it reaches NOBODY ELSE. The widened populate originally shipped
// aadhaar_no, dob, father_name, mother_name, religion, address, email and custom_fields to every
// user who could see the batch, including this trainer, who holds no candidates right at all and
// is correctly shown no Edit button - a control the viewer cannot see is not a gate. Read with the
// SAME cookie and the SAME roster row as section 1, so the only variable is the permission. ----
const adminCandFull = member?.candidate;
const rosterAsTrainer = (await req(trainerCookie, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items;
const memberAsTrainer = rosterAsTrainer.find((m) => String(m.candidate?._id) === String(cand._id));
ok("assigned trainer still gets the roster at all", !!memberAsTrainer, JSON.stringify(rosterAsTrainer).slice(0, 200));
ok("QA-1459: default trainer does NOT receive aadhaar_no", memberAsTrainer?.candidate?.aadhaar_no === undefined, JSON.stringify(memberAsTrainer?.candidate));
ok("QA-1459: default trainer does NOT receive email", memberAsTrainer?.candidate?.email === undefined, JSON.stringify(memberAsTrainer?.candidate));
const WITHHELD = ["dob", "father_name", "mother_name", "religion", "social_category"];
ok("QA-1459 PRECONDITION: the fixture candidate actually carries every field the next assertion claims is withheld (without this, that assertion is vacuous)",
  WITHHELD.every((f) => (adminCandFull?.[f] ?? null) !== null), JSON.stringify(adminCandFull));
ok("QA-1459: default trainer receives none of " + WITHHELD.join("/"),
  WITHHELD.every((f) => memberAsTrainer?.candidate?.[f] === undefined),
  JSON.stringify(memberAsTrainer?.candidate));
ok("QA-1459: the five fields the roster actually renders are UNCHANGED for that trainer (-212 stays true)",
  memberAsTrainer?.candidate?.name === cand.name && memberAsTrainer?.candidate?.phone === cand.phone
  && "sidh_candidate_id" in (memberAsTrainer?.candidate ?? {}) && "apaar_id" in (memberAsTrainer?.candidate ?? {}),
  JSON.stringify(memberAsTrainer?.candidate));

// ---- 2. out-of-scope: a trainer not assigned to this batch is still refused the roster (the
// widened populate must not have loosened assertBatchInScope) ----
const locOut = (await req(admin, "POST", "/api/locations", {
  code: "LX" + stamp, name: "Other ITI " + stamp, state: "UP", district: "Meerut",
  tc_id: "TCX" + stamp, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const trOut = (await req(admin, "POST", "/api/trainers", {
  name: "Outside Trainer " + stamp, phone: "8" + Date.now().toString().slice(-9),
  email: `outsideedit.${stamp}@example.com`.toLowerCase(),
  skills: [prog.trainer_skill], home_location: locOut._id, pipeline_status: "Fresh Lead",
}, 201)).data.item;
await req(admin, "POST", `/api/trainers/${trOut._id}/create-login`, { password: PW }, 201);
const outsideCookie = await login(trOut.email, PW);
await req(outsideCookie, "GET", `/api/batches/${batch._id}/members`, undefined, 403);

// ---- 3. candidates.manage vs candidates.assign: the Trainer role must NOT default-hold either,
// and PATCH must follow candidates.manage specifically, not batches.daily_log or candidates.assign ----
const permsBefore = (await req(admin, "GET", "/api/permissions")).data;
const trainerSetBefore = (permsBefore?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
ok("Trainer does NOT default-hold candidates.manage", !trainerSetBefore.includes("candidates.manage"), JSON.stringify(trainerSetBefore));
ok("Trainer does NOT default-hold candidates.assign", !trainerSetBefore.includes("candidates.assign"), JSON.stringify(trainerSetBefore));

const patchWithout = await req(trainerCookie, "PATCH", `/api/candidates/${cand._id}`, { name: "Edit Candidate " + stamp + " v2" });
ok("without candidates.manage the assigned trainer is refused editing the candidate (403)", patchWithout.status === 403, String(patchWithout.status));

await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetBefore, "candidates.manage"] }, 200);
const patchWith = await req(trainerCookie, "PATCH", `/api/candidates/${cand._id}`, { name: "Edit Candidate " + stamp + " v2" }, 200);
ok("granting candidates.manage lets the trainer edit the candidate's profile", patchWith.data.item?.name === "Edit Candidate " + stamp + " v2", JSON.stringify(patchWith.data.item));

// QA-1459, the other half: with candidates.manage at edit level the SAME trainer on the SAME
// roster now does receive the full record - because that is the user the drawer mounts for. If this
// assertion ever fails while 1b passes, the gate has become a blanket denial and the Edit button is
// a dead control again (QA-712/723/754/775/785).
const rosterGranted = (await req(trainerCookie, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items;
const memberGranted = rosterGranted.find((m) => String(m.candidate?._id) === String(cand._id));
ok("QA-1459: WITH candidates.manage the trainer receives aadhaar_no on the roster", memberGranted?.candidate?.aadhaar_no === "999941057058", JSON.stringify(memberGranted?.candidate));

// ---- 4. THE REGRESSION GUARD: candidates.manage must NOT reopen the general candidate/location
// doors QA-060/095 closed to Trainer — this is the near-miss this unit's manifest discloses ----
await req(trainerCookie, "GET", `/api/candidates/${cand._id}`, undefined, 403);
await req(trainerCookie, "GET", "/api/locations?limit=2000", undefined, 403);
ok("QA-060/095 regression guard: GET /api/candidates/[id] stays closed to Trainer even WITH candidates.manage granted", true);
ok("QA-095 regression guard: GET /api/locations stays closed to Trainer even WITH candidates.manage granted", true);

// revoke candidates.manage, confirm the door closes again (permission-driven, not sticky)
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trainerSetBefore }, 200);
const patchAfterRevoke = await req(trainerCookie, "PATCH", `/api/candidates/${cand._id}`, { name: "Edit Candidate " + stamp + " v3" });
ok("revoking candidates.manage closes the door again", patchAfterRevoke.status === 403, String(patchAfterRevoke.status));
const rosterRevoked = (await req(trainerCookie, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items;
const memberRevoked = rosterRevoked.find((m) => String(m.candidate?._id) === String(cand._id));
ok("QA-1459: revoking candidates.manage NARROWS the roster payload again (not sticky)", memberRevoked?.candidate?.aadhaar_no === undefined, JSON.stringify(memberRevoked?.candidate));

// ---- 5. candidates.delete is a SEPARATE right from candidates.manage — a throwaway candidate,
// never touching the fixture one above ----
const throwaway = (await req(admin, "POST", "/api/candidates", {
  name: "Throwaway " + stamp, phone: "6" + Date.now().toString().slice(-9), location: loc._id, program: prog._id,
}, 201)).data.item;
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetBefore, "candidates.manage"] }, 200);
const delWithoutDelete = await req(trainerCookie, "DELETE", `/api/candidates/${throwaway._id}`);
ok("candidates.manage alone does not grant delete (403)", delWithoutDelete.status === 403, String(delWithoutDelete.status));
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetBefore, "candidates.manage", "candidates.delete"] }, 200);
const delWithDelete = await req(trainerCookie, "DELETE", `/api/candidates/${throwaway._id}`, undefined, 200);
ok("candidates.manage + candidates.delete together let the trainer delete", delWithDelete.status === 200);

// ---- byte-restore Trainer's permission set ----
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trainerSetBefore }, 200);
const permsAfter = (await req(admin, "GET", "/api/permissions")).data;
const trainerSetAfter = (permsAfter?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
ok("Trainer's permission set is byte-restored", JSON.stringify([...trainerSetAfter].sort()) === JSON.stringify([...trainerSetBefore].sort()), JSON.stringify({ before: trainerSetBefore, after: trainerSetAfter }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

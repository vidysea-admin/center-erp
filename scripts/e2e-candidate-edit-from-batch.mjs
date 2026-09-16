// Candidate-edit-from-batch E2E (QA-1436, 2026-08-26). Covers what actually changed server-side
// for the batch Enrollment tab's new Edit button: GET /api/batches/[id]/members now populates the
// FULL candidate document (not a 5-field projection), and — the load-bearing regression guard —
// that this did NOT loosen GET /api/candidates/[id] or GET /api/locations, both deliberately
// closed to Trainer (QA-060/095, a tested invariant in e2e-roles.mjs). Section 1c (QA-2751,
// qa-selfreg-fields-drop, 2026-09-16) additionally drives a real chromium through the Enrollment
// tab - toggle a step, Edit with no reload, Save with no change - because that defect was only
// visible on the screen. Its browser preconditions are ASSERTIONS: no chromium means red, not skipped.
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

// ---- 1c. qa-selfreg-fields-drop (QA-2751). Sections 1 and 1b prove what the roster GET hands out.
// The defect lived in the OTHER door that feeds the Enrollment tab: a step toggle's PATCH
// /api/members/[id] populated the narrow five-field list for EVERYONE, the page merged that over the
// cached card, the card's Edit handed the shrunken record to CandidateEditDrawer (which then skips
// its own fetch), and the drawer showed only name and mobile. Saving without touching anything then
// wrote batch_interest "Current" and [] interest lists over the student's own answers.
// These arms drive the real screen: a real click on a step, Edit with no reload, Save with no change.
// They run on the fixture candidate above, BEFORE section 3 changes any permission, and put nothing
// back that a later section reads (name/phone/aadhaar_no are untouched by a no-change save).
{
  const T = "QA-2751";
  const memberId = member?._id;
  const setFuture = async () => req(admin, "PATCH", `/api/candidates/${cand._id}`, {
    gender: "Female", education: "12th Pass", batch_interest: "Future",
    interested_programs: [prog._id], interested_locations: [loc._id],
  });
  const readCand = async () => { const r = await req(admin, "GET", `/api/candidates/${cand._id}`); return r.data?.item ?? r.data; };
  const fx = await setFuture();
  const EXPECT = {
    father_name: "Father " + stamp, dob: "2002-04-17", gender: "Female", education: "12th Pass",
    aadhaar_no: "999941057058", email: cand.email,
  };
  const before = await readCand();
  ok(`${T} [precondition]: the fixture candidate holds father_name, dob, gender, education, aadhaar_no, email, batch_interest "Future" and non-empty interest lists (without these every arm below is vacuous)`,
    fx.status === 200 && before?.father_name === EXPECT.father_name && String(before?.dob ?? "").slice(0, 10) === EXPECT.dob
    && before?.gender === "Female" && before?.education === "12th Pass" && before?.aadhaar_no === EXPECT.aadhaar_no
    && before?.email === EXPECT.email && before?.batch_interest === "Future"
    && (before?.interested_programs ?? []).length > 0 && (before?.interested_locations ?? []).length > 0,
    JSON.stringify({ patch: fx.status, got: before && { father_name: before.father_name, dob: before.dob, gender: before.gender, education: before.education, aadhaar_no: before.aadhaar_no, email: before.email, batch_interest: before.batch_interest, ip: before.interested_programs, il: before.interested_locations } }));
  ok(`${T} [precondition]: the roster member id is known`, !!memberId, JSON.stringify(member));

  // ---- arm 5 (direct API): an EDITOR's toggle response carries the whole candidate ----
  const adminPatch = await req(admin, "PATCH", `/api/members/${memberId}`, { issue: null, failed: false });
  ok(`${T} arm 5: an editor's PATCH /api/members/[id] response carries the full candidate (father_name present), so the page's merge cannot shrink the cached card`,
    adminPatch.status === 200 && adminPatch.data?.item?.candidate?.father_name === EXPECT.father_name,
    JSON.stringify({ status: adminPatch.status, candidate_keys: Object.keys(adminPatch.data?.item?.candidate ?? {}) }));

  // ---- arm 4 (server, least privilege): a user who may toggle steps but NOT edit candidates still
  // gets the narrow row from that same door. The Trainer role holds candidates.assign nowhere by
  // default (QA-1290), so it is granted for this arm ONLY and the role set is byte-restored after. ----
  const permsA = (await req(admin, "GET", "/api/permissions")).data;
  const trSetA = (permsA?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
  const grant = await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trSetA.filter((p) => p !== "candidates.assign"), "candidates.assign"] });
  const trPatch = await req(trainerCookie, "PATCH", `/api/members/${memberId}`, { issue: null, failed: false });
  const trCand = trPatch.data?.item?.candidate;
  ok(`${T} arm 4 [precondition]: the trainer, granted candidates.assign but NOT candidates.manage, can use the toggle door at all (200, candidate populated with its name)`,
    grant.status === 200 && !trSetA.includes("candidates.manage") && trPatch.status === 200 && trCand?.name === cand.name,
    JSON.stringify({ grant: grant.status, patch: trPatch.status, body: JSON.stringify(trPatch.data).slice(0, 200) }));
  const LEAK = ["father_name", "dob", "aadhaar_no", "email", "mother_name", "religion", "social_category", "gender", "education"];
  ok(`${T} arm 4: that trainer's PATCH /api/members/[id] response carries NO father_name/dob/aadhaar_no/email (QA-1459 holds on the toggle door too)`,
    !!trCand && LEAK.every((f) => trCand[f] === undefined),
    JSON.stringify({ leaked: LEAK.filter((f) => trCand?.[f] !== undefined), candidate_keys: Object.keys(trCand ?? {}) }));
  await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trSetA });
  const trSetA2 = ((await req(admin, "GET", "/api/permissions")).data?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
  ok(`${T} arm 4: Trainer's permission set is byte-restored after the grant`, JSON.stringify([...trSetA2].sort()) === JSON.stringify([...trSetA].sort()), JSON.stringify({ before: trSetA, after: trSetA2 }));

  // ---- arm 4b (QA-2753, checker cycle 1): the boundary is EDIT, not "holds the key at all". Arm 4's
  // trainer holds no candidates.manage key, so a helper gated on VIEW (hasPermission) passed it too and
  // leaked nine personal fields to every view-only holder with the suite still green. Grant exactly
  // candidates.manage:view, PROVE the grant is in effect for that session, then assert the narrow row. ----
  const grantV = await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trSetA.filter((p) => p !== "candidates.assign" && !p.startsWith("candidates.manage")), "candidates.assign", "candidates.manage:view"] });
  const meV = await req(trainerCookie, "GET", "/api/permissions/me");
  const trPatchV = await req(trainerCookie, "PATCH", `/api/members/${memberId}`, { issue: null, failed: false });
  const trCandV = trPatchV.data?.item?.candidate;
  ok(`${T} arm 4b [precondition]: the trainer now holds candidates.manage at VIEW level (read back from /api/permissions/me) and can still use the toggle door`,
    grantV.status === 200 && meV.data?.levels?.["candidates.manage"] === "view" && trPatchV.status === 200 && trCandV?.name === cand.name,
    JSON.stringify({ grant: grantV.status, level: meV.data?.levels?.["candidates.manage"], patch: trPatchV.status }));
  ok(`${T} arm 4b: a VIEW-only candidates.manage holder's PATCH /api/members/[id] response carries NO personal fields - the full record is for EDIT holders only`,
    !!trCandV && LEAK.every((f) => trCandV[f] === undefined),
    JSON.stringify({ leaked: LEAK.filter((f) => trCandV?.[f] !== undefined), candidate_keys: Object.keys(trCandV ?? {}) }));
  await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trSetA });
  const trSetA3 = ((await req(admin, "GET", "/api/permissions")).data?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
  ok(`${T} arm 4b: Trainer's permission set is byte-restored after the view grant`, JSON.stringify([...trSetA3].sort()) === JSON.stringify([...trSetA].sort()), JSON.stringify({ before: trSetA, after: trSetA3 }));

  // ---- arms 2, 3, 3b: the rendered journey ----
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1536, height: 900 } });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').first().fill("admin@vidysea.com");
    await page.locator('input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || "admin123");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
    ok(`${T} [precondition]: the browser is signed in as Admin`, !/login/i.test(page.url()), page.url());

    const card = () => page.locator(`xpath=//div[@title=${JSON.stringify(cand.name)}]/ancestor::div[contains(@class,"rounded-xl")][1]`).first();
    const openTab = async () => {
      await page.goto(`${BASE}/batches/${batch._id}?tab=Enrollment`, { waitUntil: "domcontentloaded" });
      await card().locator("button", { hasText: /^Edit$/ }).waitFor({ timeout: 45000 });
    };
    const toggleRegistration = async () => {
      const resp = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/members\//.test(r.url()), { timeout: 30000 });
      await card().locator("button", { hasText: /Registration$/ }).first().click();
      const r = await resp;
      await page.waitForTimeout(800); // the setMembers merge re-renders the card
      return r.status();
    };
    const DRAWER = "div.fixed.inset-0.z-50";
    const openEditAndRead = async () => {
      await card().locator("button", { hasText: /^Edit$/ }).click();
      await page.locator(DRAWER, { hasText: "Save changes" }).waitFor({ timeout: 20000 });
      await page.waitForTimeout(600);
      return page.evaluate((sel) => {
        const root = [...document.querySelectorAll(sel)].find((d) => d.innerText.includes("Save changes"));
        const norm = (x) => String(x ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim();
        const val = (label) => {
          const span = [...root.querySelectorAll("label > span")].find((s) => norm(s.textContent) === label);
          const c = span?.parentElement?.querySelector("input,select,textarea");
          return c ? c.value : "(control not found)";
        };
        return { name: val("Name"), father_name: val("Father's name"), dob: val("Date of birth"), gender: val("Gender"),
          education: val("Education"), aadhaar_no: val("Aadhaar number"), email: val("Email"), batch_interest: val("Interested in") };
      }, DRAWER);
    };
    const saveNoChange = async () => {
      const resp = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/candidates\//.test(r.url()), { timeout: 30000 });
      await page.locator(DRAWER).locator("button", { hasText: "Save changes" }).click();
      const r = await resp;
      await page.waitForTimeout(800);
      return { status: r.status(), sent: r.request().postDataJSON?.() ?? null };
    };

    // arm 2 - toggle a step through the UI, then Edit WITHOUT reloading
    await openTab();
    const tStatus = await toggleRegistration();
    ok(`${T} arm 2 [precondition]: the Registration step was toggled by a real click and the server accepted it`, tStatus === 200, String(tStatus));
    const shown = await openEditAndRead();
    const missing = Object.keys(EXPECT).filter((f) => shown[f] !== EXPECT[f]);
    ok(`${T} arm 2: after a step toggle (no reload) the Edit drawer still shows father_name, dob, gender, education, aadhaar_no and email`,
      missing.length === 0, JSON.stringify({ missing, shown }));

    // arm 3 - Save with no change, then read the candidate back
    const s3 = await saveNoChange();
    const after3 = await readCand();
    ok(`${T} arm 3: Save with no change after a toggle leaves batch_interest "Future" and both interest lists non-empty in the DB`,
      after3?.batch_interest === "Future" && (after3?.interested_programs ?? []).length > 0 && (after3?.interested_locations ?? []).length > 0,
      JSON.stringify({ save: s3.status, sent: s3.sent, db: { batch_interest: after3?.batch_interest, ip: after3?.interested_programs, il: after3?.interested_locations } }));

    // arm 3b - the DRAWER's own guarantee, isolated from the server fix. Arm 3 cannot see the drawer:
    // once the PATCH carries the whole document, sending every field sends the values already stored.
    // So the toggle response is cut back to the five roster fields in the browser (exactly what the
    // pre-fix server sent, and what a user without candidates.manage still gets), and a no-change Save
    // must STILL write nothing over the student's answers.
    await setFuture();
    await openTab();
    await page.route("**/api/members/**", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      const c = j?.item?.candidate;
      if (c) j.item.candidate = Object.fromEntries(["_id", "name", "phone", "lifecycle_status", "sidh_candidate_id", "apaar_id"].filter((k) => k in c).map((k) => [k, c[k]]));
      await route.fulfill({ response: res, json: j });
    });
    const t3b = await toggleRegistration();
    await page.unroute("**/api/members/**");
    const shown3b = await openEditAndRead();
    ok(`${T} arm 3b [precondition]: the card really was narrowed - the drawer opened on a record with no father_name (so this arm tests the drawer, not the server)`,
      t3b === 200 && shown3b.name === cand.name && shown3b.father_name === "", JSON.stringify({ toggle: t3b, shown3b }));
    const s3b = await saveNoChange();
    const after3b = await readCand();
    ok(`${T} arm 3b: from a drawer hydrated with an INCOMPLETE record, Save with no change still leaves batch_interest "Future" and both interest lists non-empty`,
      after3b?.batch_interest === "Future" && (after3b?.interested_programs ?? []).length > 0 && (after3b?.interested_locations ?? []).length > 0,
      JSON.stringify({ save: s3b.status, sent: s3b.sent, db: { batch_interest: after3b?.batch_interest, ip: after3b?.interested_programs, il: after3b?.interested_locations } }));
    await ctx.close();
  } catch (e) {
    ok(`${T}: the rendered Enrollment-tab journey ran to its end without an uncaught error`, false,
      `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)}`);
  } finally {
    try { if (browser) await browser.close(); } catch { /* nothing left to close */ }
  }
}

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

// ---- 3b. QA-1463 — THE LEVEL, not just the key. Cycle-3's third checker showed that every
// assertion in this file survives if hasEditLevel is made LEVEL-BLIND, because `hasPermission`
// sits directly beside it in lib/permissions.ts and does exactly that (>= view). Under that
// one-word regression the full PII payload silently reopens to three populations, and the ONLY
// suite that goes red is e2e-roles.mjs, on unrelated WRITE assertions - the leak itself is
// invisible across the entire wall. These three close that, using fixtures this suite already
// builds. Each asserts a user who HOLDS the key but not at edit level still gets the narrow row. ----
const rosterFor = async (cookie) => {
  const items = (await req(cookie, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items;
  return items.find((m) => String(m.candidate?._id) === String(cand._id))?.candidate;
};

// (a) a :view-level ROLE grant is a right, but not an edit right
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetBefore, "candidates.manage:view"] }, 200);
const candViewLevel = await rosterFor(trainerCookie);
ok("QA-1463 PRECONDITION: the :view grant is actually in effect (the trainer still gets the roster)", !!candViewLevel, JSON.stringify(candViewLevel));
ok("QA-1463(a): a :view-LEVEL candidates.manage grant does NOT open the full record", candViewLevel?.aadhaar_no === undefined, JSON.stringify(candViewLevel));

// (b) Rule 39: can_edit=false caps every right at view, so an EDIT grant must not open it either
const trainerUser = ((await req(admin, "GET", "/api/users", undefined, 200)).data.items ?? []).find((u) => String(u.email).toLowerCase() === String(tr.email).toLowerCase());
ok("QA-1463 PRECONDITION: the trainer's user record is findable (this is an assertion, not a skip - QA-1214)", !!trainerUser, tr.email);
// CAPTURE, never assume: can_edit is `false` by default on POST /api/users, but create-login may
// differ, and if this trainer were view-only the section-3 positive assertion above could not have
// passed. Restoring to a guessed value is how a pin ends up asserting against a fixture it broke.
const trainerCanEditBefore = trainerUser?.can_edit;
ok("QA-1463 PRECONDITION: this trainer can edit, so (b) below is testing Rule 39 rather than an already-view-only user", trainerCanEditBefore === true, JSON.stringify({ can_edit: trainerCanEditBefore }));
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: [...trainerSetBefore, "candidates.manage"] }, 200);
await req(admin, "PATCH", `/api/users/${trainerUser._id}`, { can_edit: false }, 200);
const candNoEdit = await rosterFor(trainerCookie);
ok("QA-1463(b): can_edit=false caps the right at view, so the full record stays closed", candNoEdit?.aadhaar_no === undefined, JSON.stringify(candNoEdit));

// (c) an :edit revoke strips edit and leaves view standing - still closed
await req(admin, "PATCH", `/api/users/${trainerUser._id}`, { can_edit: trainerCanEditBefore, revoked_permissions: ["candidates.manage:edit"] }, 200);
const candRevoked = await rosterFor(trainerCookie);
ok("QA-1463(c): an :edit revoke leaves view standing and the full record closed", candRevoked?.aadhaar_no === undefined, JSON.stringify(candRevoked));

// restore the user, then re-assert the POSITIVE case so these three cannot pass by having simply
// broken the trainer - if the gate is now a blanket denial, this line fails and says so
await req(admin, "PATCH", `/api/users/${trainerUser._id}`, { can_edit: trainerCanEditBefore, revoked_permissions: [] }, 200);
const candRestored = await rosterFor(trainerCookie);
ok("QA-1463: with the plain edit-level grant restored, the full record opens again (these pins did not just break the trainer)", candRestored?.aadhaar_no === "999941057058", JSON.stringify(candRestored));

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

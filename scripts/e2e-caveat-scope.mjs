// The unmatched-portal-row caveat, and WHICH QUESTION each of its numbers answers.
//
// PROVENANCE: this began as the CHECKER's own probe against qa-1766 cycle 2 (its recipe is quoted
// in QA-1777). It is promoted here because the QA-1772 scoping fix - an S2 that reached a
// client-facing screen - had no behavioural pin at all, and neither existing pin could see the
// regression class: the e2e-govt NON-ZERO guard reads 3 under the fix and 6 under the bug, and both
// satisfy `> 0`; the structural pin in check-user-copy is blind to any change made INSIDE the
// shared helper.
//
// THE WHOLE POINT OF THIS FILE IS ITS FIXTURE: TWO Active batches at ONE centre. Every defect in
// this family is invisible on a single-batch fixture, because a count that wrongly describes the
// centre and a count that correctly describes the batch are the same number when the centre has
// one batch. Do not 'simplify' this to one batch.
//
// Batch A additionally carries TWO MEMBERS WITH THE SAME NAME. That is not decoration either: an
// ambiguous row is the only way a centre-filed row can carry a name that IS on a roster, and the
// centre count's one exclusion (QA-1776 - drop names already explained on a member's own line) can
// only be pinned by such a row.
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
const localDate = (ms = Date.now()) => { const n = new Date(ms); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };
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
async function req(cookie, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function upload(cookie, fields) {
  const fd = new FormData();
  if (fields.confirm === "1" && fields.accept_name_match === undefined) fields = { ...fields, accept_name_match: "1" };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(BASE + "/api/govt-attendance", { method: "POST", headers: { cookie }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
if (!admin) { console.log("FAIL  admin login"); process.exit(1); }

const S = Date.now().toString().slice(-6);
const TC = `TCV${S}`;
const N = `CV${S}`;
const TWIN = `${N} Twin Sharma`;   // ONE name, TWO members on batch A - the ambiguity this needs

const loc = (await req(admin, "POST", "/api/locations", {
  name: `${N} Centre`, code: `CV${S}`, external_id: TC, city: "Gurugram", state: "Haryana",
  approval_status: "Approved", operational_status: "Active",
})).data.item;
ok("[C0] fixture centre created", !!loc?._id, JSON.stringify(loc).slice(0, 200));
const program = ((await req(admin, "GET", "/api/programs?limit=10")).data.items ?? [])[0];

async function mkBatch(tag, memberNames) {
  const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: `${N} Lab ${tag}`, type: "Lab", capacity: 30 })).data.item ?? {};
  const trainer = (await req(admin, "POST", "/api/trainers", {
    name: `${N} Trainer ${tag}`, phone: `9${S.slice(1)}${tag === "A" ? "7" : "8"}001`, skills: ["Testing"],
    home_location: loc._id, pipeline_status: "Certified", max_concurrent_batches: 4,
    available_from: localDate(Date.now() - 30 * 86400_000),
  })).data.item;
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: program._id, target_size: 2, trainer: trainer._id, room: room._id,
    planned_start: localDate(),
  })).data;
  if (!b?.item?._id) { console.log(`BATCH ${tag} CREATE FAILED: ` + JSON.stringify(b).slice(0, 400)); process.exit(1); }
  const bb = b.item;
  const cands = [];
  for (let i = 0; i < memberNames.length; i++) {
    const c = (await req(admin, "POST", "/api/candidates", {
      name: memberNames[i], phone: `9${S.slice(1)}${tag === "A" ? "2" : "3"}${String(i).padStart(3, "0")}`,
      location: loc._id, program: program._id,
    })).data.item;
    const m = (await req(admin, "POST", `/api/batches/${bb._id}/members`, { candidate: c._id, joined_on: localDate(Date.now() - 20 * 86400_000) })).data.item;
    await req(admin, "PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true });
    cands.push(c);
  }
  await req(admin, "POST", `/api/batches/${bb._id}/transition`, { target: "Ready" });
  const a = await req(admin, "POST", `/api/batches/${bb._id}/transition`, { target: "Active" });
  ok(`[C0] batch ${tag} reached Active`, a.status === 200 || a.status === 201, JSON.stringify(a.data).slice(0, 200));
  bb.cands = cands;
  return bb;
}
const b1 = await mkBatch("A", [TWIN, TWIN]);
const b2 = await mkBatch("B", [`${N} Bstud0`, `${N} Bstud1`]);

const att = async (b) => (await req(admin, "GET", `/api/batches/${b._id}/attendance`)).data;
const counts = async () => {
  const [a1, a2] = [await att(b1), await att(b2)];
  return {
    b1: a1.unresolved_portal_rows, b1c: a1.unresolved_portal_rows_centre,
    b2: a2.unresolved_portal_rows, b2c: a2.unresolved_portal_rows_centre,
  };
};

const header = "Sl. No., Org Name,Attendance ID,Candidate Name,Candidate ID,Candidate Type,Designation,Total Working days,Total Days Present,Total Days Absent,Total Days Late,Total Hours,Total Days Leave,Average Per Day,Details";
const row = (i, name) => `${i},TESTORG Gurugram -${TC},9910000${i},${name},,Trainee,Trainee,11,3,3,0,21:00:00,0,07:00:00,`;

const base = await counts();
console.log("BASELINE " + JSON.stringify(base));
ok("[C1] baseline: every one of the four counts starts at 0",
  base.b1 === 0 && base.b1c === 0 && base.b2 === 0 && base.b2c === 0, JSON.stringify(base));

// ---- a CENTRE-scoped import whose rows match NOBODY on either roster -------------------------
const locCsv = [header, row(1, `${N} StrangerOne`), row(2, `${N} StrangerTwo`)].join("\n");
const locImp = await upload(admin, { file: new File([Buffer.from(locCsv)], `centre-${S}.csv`, { type: "text/csv" }), location: loc._id, confirm: "1", period_label: `centre ${S}` });
ok("[C1] centre-scoped import committed (filed against no batch)", locImp.status === 201, `${locImp.status} ${JSON.stringify(locImp.data).slice(0, 200)}`);
const afterLoc = await counts();
console.log("AFTER CENTRE-SCOPED IMPORT " + JSON.stringify(afterLoc));

ok("[C2] QA-1772: a centre-filed import's unmatched rows do NOT land on ANY batch's OWN caveat - a count printed on one batch may only describe that batch",
  afterLoc.b1 === 0 && afterLoc.b2 === 0, JSON.stringify(afterLoc));
ok("[C3] QA-1776: but they are NOT silent either - both batches at the centre now report 2 unmatched rows AT THIS CENTRE, filed under no batch",
  afterLoc.b1c === 2 && afterLoc.b2c === 2, JSON.stringify(afterLoc));

const locDetail = await req(admin, "GET", `/api/govt-attendance/${locImp.data._id}`);
ok("[C3b] and that centre figure is the same 2 the import screen itself reports as not_enrolled - the number that used to appear on no batch screen at all",
  locDetail.data.not_enrolled_count === afterLoc.b1c,
  `import screen ${JSON.stringify(locDetail.data.not_enrolled_count)} vs batch centre-count ${afterLoc.b1c}`);

// ---- a BATCH-scoped import of unmatched rows onto b1 -----------------------------------------
const b1Csv = [header, row(3, `${N} OrphanOne`), row(4, `${N} OrphanTwo`)].join("\n");
const b1Imp = await upload(admin, { file: new File([Buffer.from(b1Csv)], `b1-${S}.csv`, { type: "text/csv" }), batch: b1._id, confirm: "1", period_label: `b1 ${S}` });
ok("[C4] batch-scoped import onto A committed", b1Imp.status === 201, `${b1Imp.status} ${JSON.stringify(b1Imp.data).slice(0, 200)}`);
const afterB1 = await counts();
console.log("AFTER BATCH-SCOPED IMPORT ON A " + JSON.stringify(afterB1));

ok("[C4] NON-VACUITY: rows filed against A DO raise A's own caveat, and do not touch B's",
  afterB1.b1 === 2 && afterB1.b2 === 0, JSON.stringify(afterB1));
ok("[C5] DISJOINTNESS: and they do not leak into EITHER batch's centre count - the two numbers partition the rows, they do not overlap",
  afterB1.b1c === 2 && afterB1.b2c === 2, JSON.stringify(afterB1));

// ---- a CENTRE-scoped row carrying a name that IS on A's roster (ambiguous, two Twins) ---------
const twinCsv = [header, row(5, TWIN)].join("\n");
const twinImp = await upload(admin, { file: new File([Buffer.from(twinCsv)], `twin-${S}.csv`, { type: "text/csv" }), location: loc._id, confirm: "1", period_label: `twin ${S}` });
ok("[C6] centre-scoped import of the shared-name row committed", twinImp.status === 201, `${twinImp.status} ${JSON.stringify(twinImp.data).slice(0, 200)}`);
const afterTwin = await counts();
console.log("AFTER SHARED-NAME CENTRE ROW " + JSON.stringify(afterTwin));

ok("[C6] EXCLUSION: a centre row whose name is already on THIS batch's roster is NOT added to its centre count - it is already shown on those members' own lines, and counting it here would tell one story twice",
  afterTwin.b1c === afterB1.b1c, `A centre count ${afterB1.b1c} -> ${afterTwin.b1c}`);
ok("[C7] AND THE EXCLUSION IS NAME-SCOPED, not a blanket silence: the same row DOES raise B's centre count, because that name is on nobody's roster there",
  afterTwin.b2c === afterB1.b2c + 1, `B centre count ${afterB1.b2c} -> ${afterTwin.b2c}`);

const a1 = await att(b1);
ok("[C8] and the claim behind [C6] is measured, not assumed: A really does explain that row on a member's own line (awaiting_match)",
  (a1.members ?? []).some((m) => m.awaiting_match),
  JSON.stringify((a1.members ?? []).map((m) => ({ n: m.name, aw: m.awaiting_match }))).slice(0, 300));
ok("[C8] and A's OWN-batch caveat is unmoved by it - a centre row is never counted as the batch's own",
  afterTwin.b1 === afterB1.b1, `A own count ${afterB1.b1} -> ${afterTwin.b1}`);

// ---- QA-1811: the exclusion must be about what a screen RENDERS, not about a name -------------
// The checker's cycle-1 finding, promoted. awaitingMatchFor() returns null for basis "portal"
// (rules.ts:3614 - a member the portal has already answered for is never pulled back into limbo by
// a namesake). So once EVERY live member of the shared name has portal hours, NOTHING renders the
// centre row - and an exclusion keyed on the name alone still drops it, putting the row on no
// surface at all. That is the very defect QA-1776 exists to close, narrowed and still alive.
//
// Resolving A's two batch-filed orphan rows onto the two Twins is how both of them acquire portal
// hours through the product's own door.
{
  const b1Rows = (await req(admin, "GET", `/api/govt-attendance/${b1Imp.data._id}`)).data.rows ?? [];
  const orphans = b1Rows.filter((r) => /OrphanOne|OrphanTwo/.test(String(r.name)));
  ok("[C9-pre] the two batch-filed orphan rows are there to resolve", orphans.length === 2,
    JSON.stringify(b1Rows.map((r) => r.name)));
  for (let i = 0; i < orphans.length; i++) {
    const res = await req(admin, "POST", `/api/govt-attendance/${b1Imp.data._id}/rows/${orphans[i]._id}/match`,
      { candidate: b1.cands[i]._id, reason: "e2e-caveat-scope: give the Twins portal hours" });
    ok(`[C9-pre] orphan row ${i + 1} resolved onto Twin ${i + 1}`, res.status === 200 || res.status === 201,
      `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const a1b = await att(b1);
  ok("[C9-pre] and BOTH Twins now read on the portal basis, so nothing on A can render an awaiting_match",
    (a1b.members ?? []).filter((m) => !m.left_on).every((m) => !m.awaiting_match),
    JSON.stringify((a1b.members ?? []).map((m) => ({ n: m.name, aw: !!m.awaiting_match, b: m.basis }))).slice(0, 300));

  const afterResolve = await counts();
  console.log("AFTER RESOLVING BOTH TWINS " + JSON.stringify(afterResolve));
  ok("[C9] QA-1811: with nothing left to render it, the shared-name centre row is COUNTED again - the exclusion is about what a screen SHOWS, never about a name being present on a roster",
    afterResolve.b1c === afterTwin.b1c + 1,
    `A centre count ${afterTwin.b1c} -> ${afterResolve.b1c}; if this is unchanged the row is on NO surface`);
  ok("[C9] and B is untouched by A resolving its own rows",
    afterResolve.b2c === afterTwin.b2c, `B centre count ${afterTwin.b2c} -> ${afterResolve.b2c}`);
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

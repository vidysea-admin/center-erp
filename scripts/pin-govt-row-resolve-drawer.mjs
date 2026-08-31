// Pin for qa-govt-row-resolve-drawer: proves the batch Attendance screen now gets enough data
// (rowId/importId refs) to open the resolve drawer directly, and that resolving through it via
// POST .../match (the same endpoint the drawer calls) actually clears the row.
const BASE = process.env.BASE_URL || "http://localhost:3479/erp";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

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
  return [csrfCookie, session].join("; ");
}
async function req(cookie, method, path, body, expect) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(BASE + path, { method, headers: isForm ? { cookie } : { "Content-Type": "application/json", cookie }, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch {}
  if (expect && res.status !== expect) console.log(`  (unexpected status ${res.status} for ${method} ${path}: ${JSON.stringify(data).slice(0, 200)})`);
  return { status: res.status, data };
}

const admin = await login("admin@vidysea.com", "admin123");
if (!admin) { console.error("FATAL: admin login failed"); process.exit(1); }

const STAMP = String(Date.now()).slice(-8);
const NAME = `PINDRW${STAMP}`;
const localDate = (ms) => { const n = new Date(ms); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };

const programs = (await req(admin, "GET", "/api/programs?limit=200")).data.items;
const program = programs[0];
const loc = (await req(admin, "POST", "/api/locations", { code: "PD" + STAMP, name: `${NAME} Centre`, approval_status: "Approved", operational_status: "Active", city: "Testville" }, 201)).data.item;
ok("fixture: location created", !!loc?._id);

const batch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 2, planned_start: localDate(Date.now() + 7 * 86400_000) }, 201)).data.item;
ok("fixture: batch created", !!batch?._id, JSON.stringify(batch));

// Two candidates sharing a name, no portal id — the Bhadohi shape.
const c1 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Anil Kumar`, phone: `${STAMP}01`, location: loc._id, program: program._id }, 201)).data.item;
const c2 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Anil Kumar`, phone: `${STAMP}02`, location: loc._id, program: program._id }, 201)).data.item;
ok("fixture: two same-named candidates created", !!c1?._id && !!c2?._id);
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c1._id }, 201);
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c2._id }, 201);

// TWO portal rows under that shared name — the real Bhadohi shape (CAN_41019211/CAN_40951102) —
// no portal ID on either candidate, so both must come back Ambiguous.
const csv = `Name,Candidate ID,Total Working Days,Total Days Attended,Total Hours\n`
  + `${NAME} Anil Kumar,PIN${STAMP}A,10,5,40\n`
  + `${NAME} Anil Kumar,PIN${STAMP}B,10,3,20\n`;
const fd = new FormData();
fd.append("file", new File([Buffer.from(csv)], "pin.csv", { type: "text/csv" }));
fd.append("batch", batch._id); fd.append("confirm", "1"); fd.append("period_label", `pin ${STAMP}`);
const uploadRes = await fetch(`${BASE}/api/govt-attendance`, { method: "POST", headers: { cookie: admin }, body: fd });
const uploadData = await uploadRes.json().catch(() => ({}));
ok("fixture: import committed", uploadRes.status === 201, JSON.stringify(uploadData).slice(0, 200));

// The batch Attendance screen — the caller this whole unit is about.
const att = (await req(admin, "GET", `/api/batches/${batch._id}/attendance`)).data;
const m1 = (att.members ?? []).find((m) => String(m.candidate_id) === String(c1._id));
const m2 = (att.members ?? []).find((m) => String(m.candidate_id) === String(c2._id));
ok("attendance: both same-named members show awaiting_match", !!m1?.awaiting_match && !!m2?.awaiting_match, JSON.stringify({ m1: m1?.awaiting_match, m2: m2?.awaiting_match }));
const refs1 = m1?.awaiting_match?.refs ?? [];
ok("attendance: awaiting_match carries at least one {rowId, importId} ref — THE POINT of this unit", refs1.length > 0 && !!refs1[0].rowId && !!refs1[0].importId, JSON.stringify(refs1));
ok("attendance: TWO unresolved rows under this name are both named (the Bhadohi shape)", refs1.length === 2, JSON.stringify(refs1));

if (refs1.length >= 2) {
  const [rowA, rowB] = refs1;
  // Same GET the drawer itself calls — confirm it resolves against the refs the attendance screen handed us.
  const rowGet = await req(admin, "GET", `/api/govt-attendance/${rowA.importId}/rows/${rowA.rowId}/match`);
  ok("drawer GET: resolves using the importId/rowId the batch screen supplied", rowGet.status === 200 && rowGet.data.row?.name === `${NAME} Anil Kumar`, JSON.stringify(rowGet.data).slice(0, 200));
  const options = rowGet.data.options ?? [];
  ok("drawer GET: both same-named candidates are offered, phone-distinguished, no suggestion yet (nobody resolved)",
    options.length >= 2 && options.some((o) => o.phone === c1.phone) && options.some((o) => o.phone === c2.phone) && !options.some((o) => o.suggested));

  // Resolve the FIRST row to c1 — exactly what the drawer's "This one — match it" button does.
  const resolve = await req(admin, "POST", `/api/govt-attendance/${rowA.importId}/rows/${rowA.rowId}/match`, { candidate: c1._id, reason: "pin: phone matches c1" });
  ok("resolve: POST succeeds via the refs threaded from the batch screen", resolve.status === 200, JSON.stringify(resolve.data).slice(0, 200));

  const c1After = (await req(admin, "GET", `/api/candidates/${c1._id}`)).data.item;
  ok("resolve: c1 is now stamped with the FIRST row's portal ID (from the sheet, not typed)", c1After?.sidh_candidate_id?.replace(/_/g, "") === `PIN${STAMP}A`, c1After?.sidh_candidate_id);

  // THE POINT of this plan: open the SECOND (sibling) ambiguous row and confirm c1 is now
  // excluded/contradicted (they hold a DIFFERENT portal ID) and c2 is pre-selected by elimination.
  const rowBGet = await req(admin, "GET", `/api/govt-attendance/${rowB.importId}/rows/${rowB.rowId}/match`);
  const optionsB = rowBGet.data.options ?? [];
  const c1OptB = optionsB.find((o) => String(o.candidate) === String(c1._id));
  const c2OptB = optionsB.find((o) => String(o.candidate) === String(c2._id));
  ok("sibling row: c1 (already matched elsewhere) shows contradicted, not a live option",
    !!c1OptB?.contradicted, JSON.stringify(c1OptB));
  ok("sibling row: c2 is pre-suggested as the sole remaining candidate — THE ASK",
    c2OptB?.suggested === true && typeof c2OptB.suggested_reason === "string" && c2OptB.suggested_reason.length > 0, JSON.stringify(c2OptB));

  // Resolve the sibling row WITHOUT overriding the suggestion — the drawer would pre-fill this
  // exact pick; POSTing it as-is proves the "admin chaahe tho edit krr lega, but the default is
  // already right" flow end to end.
  const resolveB = await req(admin, "POST", `/api/govt-attendance/${rowB.importId}/rows/${rowB.rowId}/match`, { candidate: c2._id, reason: "pin: pre-selected by elimination" });
  ok("sibling resolve: POST succeeds on the pre-selected pick", resolveB.status === 200, JSON.stringify(resolveB.data));

  const attAfter = (await req(admin, "GET", `/api/batches/${batch._id}/attendance`)).data;
  const m1After = (attAfter.members ?? []).find((m) => String(m.candidate_id) === String(c1._id));
  const m2After = (attAfter.members ?? []).find((m) => String(m.candidate_id) === String(c2._id));
  ok("attendance AFTER both resolves: c1's awaiting_match is cleared (now has real govt hours)", !m1After?.awaiting_match && !!m1After?.govt, JSON.stringify(m1After?.awaiting_match ?? m1After?.govt));
  ok("attendance AFTER both resolves: c2's awaiting_match is ALSO cleared", !m2After?.awaiting_match && !!m2After?.govt, JSON.stringify(m2After?.awaiting_match ?? m2After?.govt));
} else {
  fail++; console.log("FAIL  (skipped resolve — fewer than 2 refs to work with)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

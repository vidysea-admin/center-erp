// Sync engine E2E: serves a CSV via /api/upload, syncs it, verifies Rules 1,2,3,5,7,8.
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
let cookie = "";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function req(method, path, body, expect) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    headers: isForm ? { cookie } : { "Content-Type": "application/json", cookie },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch {}
  if (expect !== undefined) ok(`${method} ${path} → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 150)})`);
  return { status: res.status, data };
}

// login
const csrfRes = await fetch(BASE + "/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
const loginRes = await fetch(BASE + "/api/auth/callback/credentials", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
  body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  redirect: "manual",
});
const session = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
cookie = [csrfCookie, session].join("; ");

const stamp = "S" + Date.now().toString().slice(-6);

// location matched by external_id, with an ACTIVE batch so Close generates follow-ups
const prog = (await req("POST", "/api/programs", { code: "P" + stamp, name: "Sync Prog " + stamp, trainer_skill: "SyncSkill" + stamp }, 201)).data.item;
const loc = (await req("POST", "/api/locations", { code: "L" + stamp, name: "Sync Loc " + stamp, external_id: stamp, approval_status: "Approved", city: "Jaipur" }, 201)).data.item;
const room = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: "CR1", type: "Classroom" }, 201)).data.item;
const trainer = (await req("POST", "/api/trainers", { name: "SyncTrainer " + stamp, phone: "9" + Date.now().toString().slice(-9), skills: ["SyncSkill" + stamp] }, 201)).data.item;
const today = new Date().toISOString().slice(0, 10);
const batch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 1 }, 201)).data.item;
const cand = (await req("POST", "/api/candidates", { name: "SyncCand", phone: "8" + Date.now().toString().slice(-9), location: loc._id, program: prog._id }, 201)).data.item;
const mem = (await req("POST", `/api/batches/${batch._id}/members`, { candidate: cand._id }, 201)).data.item;
await req("PATCH", `/api/members/${mem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);

// upload CSV: change City + Target, status Rejected
const csv = `Center ID,Status,City,Target\n${stamp},Rejected,Kota,210\n`;
const fd = new FormData();
fd.append("file", new File([csv], "sheet.csv", { type: "text/csv" }));
const up = (await req("POST", "/api/upload", fd, 200)).data;

// sync source with mappings
const src = (await req("POST", "/api/sync-sources", {
  name: "Test sheet " + stamp,
  source_url: new URL(up.url, BASE).href,
  field_mappings: { "Center ID": "external_id", "Status": "approval_status", "City": "city", "Target": `approved_target:P${stamp}` },
}, 201)).data.item;

// run sync → 3 changes (status Approved→Rejected, city Jaipur→Kota, target ∅→210)
const run1 = (await req("POST", `/api/sync-sources/${src._id}/run`, undefined, 200)).data;
ok("Rule 1: 3 differing mapped fields detected", run1.created === 3, JSON.stringify(run1));
// idempotent: second run creates no dupes
const run2 = (await req("POST", `/api/sync-sources/${src._id}/run`, undefined, 200)).data;
ok("re-run creates no duplicate changes", run2.created === 0, JSON.stringify(run2));

const changes = (await req("GET", "/api/sheet-changes?status=Open")).data.items.filter((c) => c.location?._id === loc._id);
ok("changes carry impact snapshot (Rule 3)", changes.every((c) => c.impact_snapshot?.active_batches === 1), JSON.stringify(changes[0]?.impact_snapshot));

// apply Update target
const tChange = changes.find((c) => c.field_name.startsWith("approved_target:"));
await req("POST", `/api/sheet-changes/${tChange._id}/apply`, { action: "Update target" }, 200);
const targets = (await req("GET", `/api/locations/${loc._id}/targets`)).data.items;
ok("Rule 4: approved_target written from sheet", targets[0]?.approved_target === 210, JSON.stringify(targets[0]?.approved_target));

// apply Close location on the status change → follow-ups generated, change stays Open (Rule 7)
const sChange = changes.find((c) => c.field_name === "approval_status");
await req("POST", `/api/sheet-changes/${sChange._id}/apply`, { action: "Close location" }, 400); // no reason
const applied = (await req("POST", `/api/sheet-changes/${sChange._id}/apply`, { action: "Close location", note: "Rejected in SDP sheet" }, 200)).data;
ok("Rule 8: follow-ups generated (stop batch + release trainer + return candidates)", applied.followUps === 3, `got ${applied.followUps}`);
const after = (await req("GET", "/api/sheet-changes?status=Open")).data.items.find((c) => c._id === sChange._id);
ok("Rule 7: change stays Open while follow-ups pending", !!after && after.pending_followups === 3, JSON.stringify(after?.pending_followups));
const locAfter = (await req("GET", `/api/locations/${loc._id}`)).data.item;
ok("Rule 5: operational_status Closed with reason, batches untouched", locAfter.operational_status === "Closed" && locAfter.status_reason === "Rejected in SDP sheet");
const batchAfter = (await req("GET", `/api/batches/${batch._id}`)).data.item;
ok("Rule 5: batch NOT auto-stopped", batchAfter.status === "Active", batchAfter.status);

// resolve all follow-ups → change auto-Actions (Rule 7)
const fups = (await req("GET", "/api/follow-ups?status=Pending")).data.items.filter((f) => f.source_change?._id === sChange._id);
for (const f of fups) await req("POST", `/api/follow-ups/${f._id}`, { status: "Done" }, 200);
const settled = (await req("GET", "/api/sheet-changes?status=Actioned")).data.items.find((c) => c._id === sChange._id);
ok("Rule 7: change auto-Actioned once follow-ups resolved", !!settled);

// Rule 2: break the column set → Partial, no changes
const badCsv = `Center ID,City\n${stamp},Udaipur\n`;
const fd2 = new FormData();
fd2.append("file", new File([badCsv], "bad.csv", { type: "text/csv" }));
const up2 = (await req("POST", "/api/upload", fd2, 200)).data;
await req("PATCH", `/api/sync-sources/${src._id}`, { source_url: new URL(up2.url, BASE).href }, 200);
const run3 = (await req("POST", `/api/sync-sources/${src._id}/run`, undefined, 200)).data;
ok("Rule 2: missing columns → Partial, zero changes", run3.status === "Partial" && run3.created === 0, JSON.stringify(run3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

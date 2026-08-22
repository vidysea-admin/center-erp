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

// Build an in-memory xlsx and hand it to the watcher as a data: URL — lets the tab
// add/remove tests drive an arbitrary workbook shape without any external hosting.
// Resolved from the repo's own node_modules — an absolute file:/// path here kept every
// CI run red (Linux runners have no D: drive) while passing silently on the dev laptop.
const xlsxMod = await import("xlsx");
const XLSX = xlsxMod.default ?? xlsxMod;
function wbDataUrl(tabs) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(tabs)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return "data:application/octet-stream;base64," + XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

// location matched by external_id, with an ACTIVE batch so Close generates follow-ups
const prog = (await req("POST", "/api/programs", { code: "P" + stamp, name: "Sync Prog " + stamp, trainer_skill: "SyncSkill" + stamp }, 201)).data.item;
const loc = (await req("POST", "/api/locations", { code: "L" + stamp, name: "Sync Loc " + stamp, external_id: stamp, approval_status: "Approved", city: "Jaipur" }, 201)).data.item;
const room = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: "CR1", type: "Classroom" }, 201)).data.item;
const trainer = (await req("POST", "/api/trainers", { name: "SyncTrainer " + stamp, phone: "9" + Date.now().toString().slice(-9), skills: ["SyncSkill" + stamp] }, 201)).data.item;
const _n = new Date(); // LOCAL date, matching the UI (IST-midnight window fix — see e2e.mjs)
const today = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, "0")}-${String(_n.getDate()).padStart(2, "0")}`;
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

// ---- rollback (2026-08-13): an applied target update can be put back exactly ----
{
  const reverted = await req("POST", `/api/sheet-changes/${tChange._id}/revert`, {}, 200);
  const after = (await req("GET", `/api/locations/${loc._id}/targets`)).data.items;
  ok("revert restores the previous target value",
    String(after[0]?.approved_target ?? "") === String(tChange.old_value ?? ""),
    JSON.stringify({ now: after[0]?.approved_target, wanted: tChange.old_value }));
  ok("…and the change row records who reverted and to what",
    /Reverted to/.test(reverted.data.item?.note ?? ""), reverted.data.item?.note);
  // A status action is NOT a value swap — the button must refuse, not guess.
  await req("POST", `/api/sheet-changes/${tChange._id}/revert`, {}, 400); // already reverted (status no longer Actioned)
  // Re-apply so the rest of the suite continues against the sheet's value.
  // (the change is Ignored now; apply requires Open — set the target back by hand instead)
  await req("PUT", `/api/locations/${loc._id}/targets`, { program: (targets[0].program?._id ?? targets[0].program), approved_target: 210 }, 200);
}

// apply Close location on the status change → follow-ups generated, change stays Open (Rule 7)
const sChange = changes.find((c) => c.field_name === "approval_status");
await req("POST", `/api/sheet-changes/${sChange._id}/apply`, { action: "Close location" }, 400); // no reason
const applied = (await req("POST", `/api/sheet-changes/${sChange._id}/apply`, { action: "Close location", note: "Rejected in SDP sheet" }, 200)).data;
ok("Rule 8: follow-ups generated (stop batch + release trainer + return candidates)", applied.followUps === 3, `got ${applied.followUps}`);
const after = (await req("GET", "/api/sheet-changes?status=Open")).data.items.find((c) => c._id === sChange._id);
ok("Rule 7: change stays Open while follow-ups pending", !!after && after.pending_followups === 3, JSON.stringify(after?.pending_followups));
const locAfter = (await req("GET", `/api/locations/${loc._id}`)).data.item;
// UPDATED 2026-08-12 (audit sync S1-3). This used to assert the centre was Closed the instant
// the action was applied — which is precisely the defect: Rule 1 then refused daily logs for the
// batch still running there, so attendance mid-delivery could not be recorded. Rule 6 says Close
// "cannot be applied … until the generated FollowUpActions are resolved or explicitly skipped",
// so the close is now deferred: the reason is recorded, follow-ups are raised, and the centre
// keeps operating until they are settled (asserted below, after they are resolved).
ok("Rule 6: the reason is recorded but the close waits for the follow-ups",
  locAfter.operational_status !== "Closed" && locAfter.status_reason === "Rejected in SDP sheet",
  `${locAfter.operational_status} / ${locAfter.status_reason}`);
const batchAfter = (await req("GET", `/api/batches/${batch._id}`)).data.item;
ok("Rule 5: batch NOT auto-stopped", batchAfter.status === "Active", batchAfter.status);

// resolve all follow-ups → change auto-Actions (Rule 7)
const fups = (await req("GET", "/api/follow-ups?status=Pending")).data.items.filter((f) => f.source_change?._id === sChange._id);
for (const f of fups) await req("POST", `/api/follow-ups/${f._id}`, { status: "Done" }, 200);
const settled = (await req("GET", "/api/sheet-changes?status=Actioned")).data.items.find((c) => c._id === sChange._id);
ok("Rule 7: change auto-Actioned once follow-ups resolved", !!settled);
// …and the deferred close finally lands, which is the other half of Rule 6 (audit sync S1-3).
const locSettled = (await req("GET", `/api/locations/${loc._id}`)).data.item;
ok("Rule 6: the centre closes once every follow-up is settled",
  locSettled.operational_status === "Closed", locSettled.operational_status);

// Rule 2: break the column set → Partial, no changes
const badCsv = `Center ID,City\n${stamp},Udaipur\n`;
const fd2 = new FormData();
fd2.append("file", new File([badCsv], "bad.csv", { type: "text/csv" }));
const up2 = (await req("POST", "/api/upload", fd2, 200)).data;
await req("PATCH", `/api/sync-sources/${src._id}`, { source_url: new URL(up2.url, BASE).href }, 200);
const run3 = (await req("POST", `/api/sync-sources/${src._id}/run`, undefined, 200)).data;
ok("Rule 2: missing columns → Partial, zero changes", run3.status === "Partial" && run3.created === 0, JSON.stringify(run3));

// ============================================================================
// Dynamic tabs (2026-08-12): the client adds/removes tabs without telling anyone.
// Every tab must be covered, new tabs announced, removed tabs announced.
// ============================================================================
const tabStamp = "TAB" + Date.now().toString().slice(-6);
const T1 = [["Institution Name", "Job role", "Target"], ["Alpha " + tabStamp, "Drone", "100"]];
const T2 = [["Institution Name", "Job role", "Target"], ["Beta " + tabStamp, "Solar", "200"]];
const T3 = [["Institution Name", "Job role", "Target"], ["Gamma " + tabStamp, "EV", "300"]];

const mine = (items, srcId) => (items ?? []).filter((c) => String(c.sync_source?._id ?? c.sync_source) === String(srcId));

const dynSrc = (await req("POST", "/api/sync-sources", {
  name: "Watch Source Dyn " + tabStamp, mode: "watch",
  key_columns: ["Institution Name", "Job role"],
  source_url: wbDataUrl({ "Batch Plan": T1, "Back Date": T2 }),
}, 201)).data.item;

// Run 1 — baseline. Two tabs, no noise.
const dr1 = (await req("POST", `/api/sync-sources/${dynSrc._id}/run`, {}, 200)).data;
ok("all tabs read on the first run (baseline, no flood)", dr1.tabs === 2 && dr1.changes === 0, JSON.stringify(dr1));

// Run 2 — client ADDS a third tab and edits a row in an existing one.
const T1b = [["Institution Name", "Job role", "Target"], ["Alpha " + tabStamp, "Drone", "150"]];
await req("PATCH", `/api/sync-sources/${dynSrc._id}`, { source_url: wbDataUrl({ "Batch Plan": T1b, "Back Date": T2, "Planning 2027": T3 }) }, 200);
const dr2 = (await req("POST", `/api/sync-sources/${dynSrc._id}/run`, {}, 200)).data;
ok("new tab is picked up automatically (3 tabs now)", dr2.tabs === 3, JSON.stringify(dr2));
const ch2 = mine((await req("GET", "/api/workbook-changes?status=New")).data.items, dynSrc._id);
const newTab = ch2.find((c) => c.tab === "Planning 2027" && c.row_key === "Tab: Planning 2027");
ok("a NEW TAB is announced, not absorbed silently", newTab?.change_type === "Added" && newTab.new_value.includes("appeared"), JSON.stringify(newTab));
ok("…and it does not flood one change per row", ch2.filter((c) => c.tab === "Planning 2027").length === 1);
ok("edits in an existing tab still tracked alongside", ch2.some((c) => c.tab === "Batch Plan" && c.column === "Target" && c.old_value === "100" && c.new_value === "150"));

// Run 3 — the new tab now tracks rows normally.
const T3b = [["Institution Name", "Job role", "Target"], ["Gamma " + tabStamp, "EV", "350"]];
await req("PATCH", `/api/sync-sources/${dynSrc._id}`, { source_url: wbDataUrl({ "Batch Plan": T1b, "Back Date": T2, "Planning 2027": T3b }) }, 200);
await req("POST", `/api/sync-sources/${dynSrc._id}/run`, {}, 200);
const ch3 = mine((await req("GET", "/api/workbook-changes?status=New")).data.items, dynSrc._id);
ok("row edits inside the newly-added tab are tracked", ch3.some((c) => c.tab === "Planning 2027" && c.column === "Target" && c.old_value === "300" && c.new_value === "350"));

// ---- version history (2026-08-13): every content change keeps a full copy of the tab ----
{
  const hist = (await req("GET", `/api/sync-sources/${dynSrc._id}/snapshots?tab=${encodeURIComponent("Batch Plan")}`)).data;
  ok("each change stores a browsable version", (hist.items?.length ?? 0) >= 2, `versions=${hist.items?.length}`);
  const [newer, older] = hist.items;
  const d = (await req("GET", `/api/sync-sources/${dynSrc._id}/snapshots?tab=${encodeURIComponent("Batch Plan")}&from=${older._id}&to=${newer._id}`)).data;
  ok("the diff between two versions names the exact cell",
    d.changes?.some((x) => x.column === "Target" && x.old_value === "100" && x.new_value === "150"), JSON.stringify(d.changes));
  const dRev = (await req("GET", `/api/sync-sources/${dynSrc._id}/snapshots?tab=${encodeURIComponent("Batch Plan")}&from=${newer._id}&to=${older._id}`)).data;
  ok("…and clicking the versions in the wrong order still reads old → new",
    dRev.changes?.some((x) => x.column === "Target" && x.old_value === "100" && x.new_value === "150"), JSON.stringify(dRev.changes));
  const csvRes = await fetch(`${BASE}/api/sync-sources/${dynSrc._id}/snapshots?snap=${older._id}&format=csv`, { headers: { cookie } });
  const csv = await csvRes.text();
  ok("any version downloads as CSV — the practical rollback of the sheet's data",
    csvRes.headers.get("content-type")?.includes("text/csv") && csv.includes("Institution Name") && csv.includes("100"),
    csv.slice(0, 80));
  const tabsList = (await req("GET", `/api/sync-sources/${dynSrc._id}/snapshots`)).data;
  ok("the history browser lists every tab with its version count",
    (tabsList.tabs ?? []).some((t) => t.tab === "Batch Plan" && t.versions >= 2), JSON.stringify(tabsList.tabs));
}

// Run 4 — client DELETES a tab.
await req("PATCH", `/api/sync-sources/${dynSrc._id}`, { source_url: wbDataUrl({ "Batch Plan": T1b, "Planning 2027": T3b }) }, 200);
const dr4 = (await req("POST", `/api/sync-sources/${dynSrc._id}/run`, {}, 200)).data;
ok("tab count drops when a tab is deleted", dr4.tabs === 2, JSON.stringify(dr4));
const ch4 = mine((await req("GET", "/api/workbook-changes?status=New")).data.items, dynSrc._id);
const goneTab = ch4.find((c) => c.row_key === "Tab: Back Date" && c.change_type === "Removed");
ok("a DELETED TAB is announced", !!goneTab && goneTab.new_value.includes("gone from the workbook"), JSON.stringify(goneTab));

// Run 5 — the removal must not re-fire on every poll.
await req("POST", `/api/sync-sources/${dynSrc._id}/run`, {}, 200);
const ch5 = mine((await req("GET", "/api/workbook-changes?status=New")).data.items, dynSrc._id);
ok("deleted-tab alert fires once, not every tick", ch5.filter((c) => c.row_key === "Tab: Back Date").length === 1);

// ---- people are told the moment the sheet moves (2026-08-12) ----
// Name a tab row exactly like a real location so the per-centre alert can find it.
const notifyLoc = (await req("POST", "/api/locations", { code: "NL" + tabStamp, name: "Notify Centre " + tabStamp, approval_status: "Approved" }, 201)).data.item;
const NT1 = [["Institution Name", "Job role", "Target"], ["Notify Centre " + tabStamp, "Drone", "100"]];
const notifySrc = (await req("POST", "/api/sync-sources", {
  name: "Watch Source Notify " + tabStamp, mode: "watch",
  key_columns: ["Institution Name", "Job role"], source_url: wbDataUrl({ Master: NT1 }),
}, 201)).data.item;
await req("POST", `/api/sync-sources/${notifySrc._id}/run`, {}, 200); // baseline, silent
// The list is capped at 100, so counting totals cannot prove growth — assert on the
// specific alert this run should produce instead.
const beforeMine = ((await req("GET", "/api/notifications?status=all")).data.items ?? [])
  .filter((n) => String(n.message ?? "").includes(tabStamp)).length;
const NT2 = [["Institution Name", "Job role", "Target"], ["Notify Centre " + tabStamp, "Drone", "175"]];
await req("PATCH", `/api/sync-sources/${notifySrc._id}`, { source_url: wbDataUrl({ Master: NT2 }) }, 200);
await req("POST", `/api/sync-sources/${notifySrc._id}/run`, {}, 200);
const afterNotifs = (await req("GET", "/api/notifications?status=all")).data.items ?? [];
const afterMine = afterNotifs.filter((n) => String(n.message ?? "").includes(tabStamp)).length;
ok("a sheet change alerts immediately (not only after 48h)", afterMine > beforeMine, `${beforeMine} → ${afterMine}`);
const summary = afterNotifs.find((n) => n.type === "workbook_change_new" && n.message.includes(tabStamp));
ok("reviewers get a summary naming the tab and count", !!summary && summary.message.includes("Master (1)"), JSON.stringify(summary?.message));
const perLoc = afterNotifs.find((n) => n.type === "workbook_change_location" && String(n.location?._id ?? n.location) === String(notifyLoc._id));
ok("the affected centre gets its own alert", !!perLoc && perLoc.message.includes("Notify Centre"), JSON.stringify(perLoc?.message));
ok("…and it is scoped to that location so its SPOC sees it", !!perLoc?.location);
const baselineNoise = afterNotifs.filter((n) => n.type === "workbook_change_new" && n.message.includes("Watch Source Notify " + tabStamp));
ok("the first baseline run raises no alert, only the later change does", baselineNoise.length === 1, `${baselineNoise.length}`);

// ---- the REAL client workbook, every tab, through the server ----
const realDyn = (await req("POST", "/api/sync-sources", {
  name: "Watch Source Real " + tabStamp, mode: "watch",
  key_columns: ["Institution Name", "Job role"],
  source_url: "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE",
}, 201)).data.item;
const realRun = (await req("POST", `/api/sync-sources/${realDyn._id}/run`, {}, 200)).data;
ok("REAL client workbook fetched server-side, every tab snapshotted", realRun.status === "OK" && realRun.tabs >= 1, JSON.stringify(realRun));

// ---- -100: THE SINGLE-TRUTH POLICY (Umesh 17/08: "bus OneDrive wala sync karna hai, baaki
// sheets nahi — this is a must thing"). He decided this once on 13/08, the two Google workbooks
// were deleted from production, and a setup script upserted them straight back on 14/08 06:35:38.
// It is a gate in code now, so the wall is where it must be proved. ----
{
  const GOOGLE = "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/edit";
  const CLIENT = "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";
  const g1 = await req("POST", "/api/sync-sources", { name: "Google master " + tabStamp, mode: "watch", source_url: GOOGLE });
  ok("-100: our own Google workbook is REFUSED at registration (this is the exact sheet that came back on 14/08)", g1.status === 400 && /client's OneDrive sheet/i.test(String(g1.data?.error ?? "")), `${g1.status} ${JSON.stringify(g1.data).slice(0, 160)}`);
  const gone = (await req("GET", "/api/sync-sources?limit=1000")).data.items ?? [];
  ok("-100: …and nothing was created by the attempt", !gone.some((x) => /docs\.google\.com/i.test(String(x.source_url))), JSON.stringify(gone.filter((x) => /google/i.test(String(x.source_url))).map((x) => x.name)));
  const hiring = await req("POST", "/api/sync-sources", { name: "Trainer hiring " + tabStamp, mode: "watch", source_url: "https://docs.google.com/spreadsheets/d/1d-2n2kXkiqV5YHV4n6Cs5-KE3FVsNwGbPGvfCNXRZXQ" });
  ok("-100: the second Google sheet (trainer hiring) is refused too — the rule is the workbook, not a blocklist of two", hiring.status === 400, String(hiring.status));
  // An EXISTING source cannot be walked off the client workbook by editing it either.
  const walk = await req("PATCH", `/api/sync-sources/${realDyn._id}`, { source_url: GOOGLE });
  ok("-100: an existing source cannot be EDITED onto a Google sheet (400)", walk.status === 400, String(walk.status));
  const stillReal = (await req("GET", `/api/sync-sources/${realDyn._id}`)).data.item;
  ok("-100: …and the refused edit did not partially land — the URL is unchanged", /onedrive\.live\.com/i.test(String(stillReal?.source_url)), String(stillReal?.source_url).slice(0, 60));
  // "Test link" is a server-side fetch of whatever was pasted — same gate, or it is the way round.
  const probe = await req("POST", "/api/sync-sources/test", { source_url: GOOGLE });
  ok("-100: the 'Test link' probe refuses it as well (no server-side fetch of a foreign sheet)", probe.status === 400, String(probe.status));
  // The duplicate that produced the doubling: the SAME workbook, twice, in mapped mode.
  const m1 = await req("POST", "/api/sync-sources", { name: "Client mapped A " + tabStamp, mode: "mapped", source_url: CLIENT, field_mappings: { "TC ID": "external_id" } }, 201);
  const m2 = await req("POST", "/api/sync-sources", { name: "Client mapped B " + tabStamp, mode: "mapped", source_url: CLIENT + "?rtime=abc123&redeem=xyz", field_mappings: { "TC ID": "external_id" } });
  ok("-100 (the 37-shown-as-74 defect): the same workbook cannot be registered twice in mapped mode — even with a different query string", m1.status === 201 && m2.status === 400 && /already registered in mapped mode/i.test(String(m2.data?.error ?? "")), `${m1.status} ${m2.status} ${String(m2.data?.error ?? "").slice(0, 120)}`);
  await req("DELETE", `/api/sync-sources/${m1.data.item._id}`);
  // A row that predates the policy (written straight to Mongo, as the setup script does) still
  // cannot be RUN — the API gate alone would not have stopped what happened on 14/08.
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const dbs = mc.db(process.env.MONGODB_DB || "center_erp_ci");
  const ins = await dbs.collection("syncsources").insertOne({
    name: "Legacy Google row " + tabStamp, source_url: GOOGLE, mode: "watch",
    interval_minutes: 5, frequency: "Manual only", key_columns: [], active: true,
    field_mappings: {}, createdAt: new Date(), updatedAt: new Date(),
  });
  const legacyRun = await req("POST", `/api/sync-sources/${ins.insertedId}/run`, {});
  ok("-100: a Google source written STRAIGHT INTO MONGO (how the setup script re-armed them) cannot be run — 400, not a sync", legacyRun.status === 400, `${legacyRun.status} ${String(legacyRun.data?.error ?? "").slice(0, 100)}`);
  await dbs.collection("syncsources").deleteOne({ _id: ins.insertedId });
  await mc.close();
  // The client workbook itself must still work — the whole point is one sheet, not no sheets.
  const okProbe = await req("POST", "/api/sync-sources/test", { source_url: CLIENT });
  ok("-100: the client's own workbook still probes green (the policy allows exactly one sheet, and this is it)", okProbe.status === 200 && okProbe.data?.ok === true, JSON.stringify(okProbe.data).slice(0, 120));
}

// ---- -100 (checker QA-170): "Create location…" was offered on ANY added row of ANY tab. In
// Umesh's 17/08 screenshot it sat beside a Trainer_Nomination row — one click from minting a
// centre out of a trainer's nomination. A centre row is one carrying an Institution Name. ----
{
  const nomTab = [["Trainer Name", "For Which Location", "Status"], ["Paurush", "Mirzapur GGP", "Nominated"]];
  const src = (await req("POST", "/api/sync-sources", {
    name: "Nomination-shaped " + tabStamp, mode: "watch", key_columns: ["Trainer Name"],
    source_url: wbDataUrl({ Trainer_Nomination: nomTab }),
  }, 201)).data.item;
  await req("POST", `/api/sync-sources/${src._id}/run`, {}, 200); // baseline
  await req("PATCH", `/api/sync-sources/${src._id}`, {
    source_url: wbDataUrl({ Trainer_Nomination: [...nomTab, ["Ravi", "Kanpur", "Nominated"]] }),
  }, 200);
  await req("POST", `/api/sync-sources/${src._id}/run`, {}, 200); // the new row is detected
  const added = ((await req("GET", "/api/workbook-changes?status=all&tab=Trainer_Nomination")).data.items ?? [])
    .find((r) => r.change_type === "Added" && /Ravi/.test(String(r.row_key)));
  ok("-100 (QA-170): a nomination row IS detected as an added row (the feed still works)", !!added, JSON.stringify(added && { t: added.tab, k: added.row_key }));
  if (added) {
    const prefill = await req("GET", `/api/workbook-changes/${added._id}/create-location`);
    ok("-100 (QA-170): …but it cannot be turned into a centre — 400, naming the tab, on the prefill itself", prefill.status === 400 && /not a centre row/i.test(String(prefill.data?.error ?? "")), `${prefill.status} ${String(prefill.data?.error ?? "").slice(0, 120)}`);
    const create = await req("POST", `/api/workbook-changes/${added._id}/create-location`, { name: "Sneaky Centre", code: "SNEAK1" });
    const made = (await req("GET", "/api/locations?limit=200")).data.items ?? [];
    ok("-100 (QA-170): and POSTing it directly is refused too — no Location is created behind the UI's back", create.status === 400 && !made.some((l) => l.name === "Sneaky Centre"), `${create.status}`);
  }
}

// ---- -100 (checker QA-169): which sheet a row came from is on the row, and filterable — the
// fact whose absence let two Google workbooks poll for three days in plain sight. ----
{
  const feed = (await req("GET", "/api/workbook-changes?status=all")).data;
  ok("-100 (QA-169): the Sheet Watch feed lists the sheets its rows came from, flagging any that is not the client workbook", Array.isArray(feed.sources) && feed.sources.length > 0 && feed.sources.every((x) => "is_client_workbook" in x && x.name), JSON.stringify(feed.sources?.slice(0, 3)));
  ok("-100 (QA-169): every row carries its source name, so the Sheet column can never be blank", (feed.items ?? []).every((r) => !!r.sync_source?.name), String((feed.items ?? []).filter((r) => !r.sync_source?.name).length) + " row(s) without a source");
  const one = feed.sources[0];
  const filtered = (await req("GET", `/api/workbook-changes?status=all&source=${one._id}`)).data;
  ok("-100 (QA-169): filtering by sheet returns only that sheet's rows, and the tab list narrows with it", (filtered.items ?? []).every((r) => String(r.sync_source?._id ?? r.sync_source) === String(one._id)) && (filtered.items ?? []).length > 0, `${(filtered.items ?? []).length} row(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-12 audit — the five sync S1 defects
// ─────────────────────────────────────────────────────────────────────────────
{
  const s2 = "T" + Date.now().toString().slice(-6);
  const p2 = (await req("POST", "/api/programs", { code: "P" + s2, name: "Audit Prog " + s2, trainer_skill: "AudSkill" + s2 }, 201)).data.item;
  const l2 = (await req("POST", "/api/locations", { code: "L" + s2, name: "Audit Loc " + s2, external_id: s2, approval_status: "Approved", city: "Jaipur" }, 201)).data.item;

  const mkSource = async (csv, name) => {
    const fd = new FormData();
    fd.append("file", new File([csv], "s.csv", { type: "text/csv" }));
    const u = (await req("POST", "/api/upload", fd, 200)).data;
    return (await req("POST", "/api/sync-sources", {
      name, source_url: new URL(u.url, BASE).href,
      field_mappings: { "Center ID": "external_id", "City": "city", "Target": `approved_target:P${s2}` },
    }, 201)).data.item;
  };

  // ---- sync S1-1: a blank cell used to write approved_target = 0, and "1,200" used to write 1 ----
  // A thousands separator is a legitimate way for a sheet to hold 1200, so it is read, not
  // refused. What must never happen is a silent wrong number: no truncation, and no
  // "empty cell means zero".
  const findTgt = async () => ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => c.field_name === `approved_target:P${s2}` && String(c.location?._id ?? c.location) === String(l2._id));

  const srcThousands = await mkSource(`Center ID,City,Target\n${s2},Kota,"1,200"\n`, "Audit num " + s2);
  await req("POST", `/api/sync-sources/${srcThousands._id}/run`, undefined, 200);
  const tgtChange = await findTgt();
  if (tgtChange) {
    ok("sync S1-1: the sheet's thousands separator survives into the change", tgtChange.new_value === "1,200", JSON.stringify(tgtChange.new_value));
    await req("POST", `/api/sheet-changes/${tgtChange._id}/apply`, { action: "Update target" }, 200);
    const t = (await req("GET", `/api/locations/${l2._id}/targets`)).data.items ?? [];
    ok("sync S1-1: \"1,200\" is stored as 1200, not truncated to 1", t.some((x) => x.approved_target === 1200), JSON.stringify(t.map((x) => x.approved_target)));
  } else { ok("sync S1-1: target change detected", false, "no change row"); }

  // a blank cell must be refused outright rather than becoming a target of zero
  const srcBlank = await mkSource(`Center ID,City,Target\n${s2},Kota,\n`, "Audit blank " + s2);
  await req("POST", `/api/sync-sources/${srcBlank._id}/run`, undefined, 200);
  const blankChange = await findTgt();
  if (blankChange) {
    const rb = await req("POST", `/api/sheet-changes/${blankChange._id}/apply`, { action: "Update target" });
    ok("sync S1-1: a blank target cell is refused, not written as 0", rb.status === 400, `got ${rb.status}: ${JSON.stringify(rb.data).slice(0, 110)}`);
    const t2 = (await req("GET", `/api/locations/${l2._id}/targets`)).data.items ?? [];
    ok("sync S1-1: …and the real target is left alone", t2.some((x) => x.approved_target === 1200), JSON.stringify(t2.map((x) => x.approved_target)));
  }

  // ---- sync S1-2: a truncated row must not read as "the client cleared this field" ----
  const srcShort = await mkSource(`Center ID,City,Target\n${s2}\n`, "Audit short " + s2);
  const shortRun = (await req("POST", `/api/sync-sources/${srcShort._id}/run`, undefined, 200)).data;
  ok("sync S1-2: a row missing mapped columns is reported Partial, not applied", shortRun.status === "Partial", JSON.stringify(shortRun));
  ok("sync S1-2: …and proposes no changes at all", (shortRun.created ?? 0) === 0, JSON.stringify(shortRun));

  // ---- sync S1-3: Rule 6 — cannot Close a location that still has a running batch ----
  const pr3 = (await req("POST", `/api/locations/${l2._id}/rooms`, { name: "CR", type: "Classroom" }, 201)).data.item;
  const tr3 = (await req("POST", "/api/trainers", { name: "AudTrainer " + s2, phone: "7" + Date.now().toString().slice(-9), skills: ["AudSkill" + s2] }, 201)).data.item;
  const td = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const b3 = (await req("POST", "/api/batches", { location: l2._id, program: p2._id, trainer: tr3._id, room: pr3._id, planned_start: td, target_size: 1 }, 201)).data.item;
  const c3 = (await req("POST", "/api/candidates", { name: "AudCand " + s2, phone: "6" + Date.now().toString().slice(-9), location: l2._id, program: p2._id }, 201)).data.item;
  const m3 = (await req("POST", `/api/batches/${b3._id}/members`, { candidate: c3._id }, 201)).data.item;
  await req("PATCH", `/api/members/${m3._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${b3._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${b3._id}/transition`, { target: "Active" }, 200);

  const srcClose = await mkSource(`Center ID,City,Target\n${s2},Udaipur,50\n`, "Audit close " + s2);
  await req("POST", `/api/sync-sources/${srcClose._id}/run`, undefined, 200);
  const openNow = (await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [];
  const cityChange = openNow.find((c) => c.field_name === "city" && String(c.location?._id ?? c.location) === String(l2._id));
  if (cityChange) {
    const closed = await req("POST", `/api/sheet-changes/${cityChange._id}/apply`, { action: "Close location", note: "audit test" });
    ok("sync S1-3: Rule 6 defers the close and raises follow-ups instead", closed.status === 200 && closed.data.deferred === true && (closed.data.followUps ?? 0) > 0, JSON.stringify(closed.data).slice(0, 160));
    const stillLive = (await req("GET", `/api/locations/${l2._id}`)).data.item;
    ok("sync S1-3: …the centre keeps operating until they are settled", stillLive.operational_status !== "Closed", stillLive.operational_status);
    // the batch must still be able to record attendance — the operational point of Rule 6
    const logAfter = await req("POST", `/api/batches/${b3._id}/logs`, { log_date: td, present_member_ids: [m3._id] });
    ok("sync S1-3: the running batch can still record its daily log", logAfter.status === 201, `got ${logAfter.status}`);

    // ---- sync S1-8: bulkIgnore must not close a change that still has Pending follow-ups ----
    const stopped = await req("POST", `/api/sheet-changes/${cityChange._id}/apply`, { action: "Stop location", note: "audit stop" });
    ok("Stop location applies and raises follow-ups", stopped.status === 200, `got ${stopped.status}`);
    const afterStop = (await req("GET", `/api/sheet-changes/${cityChange._id}`)).data.item
      ?? ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? []).find((c) => String(c._id) === String(cityChange._id));
    if (afterStop) {
      ok("Rule 7: it stays Open while follow-ups are Pending", afterStop.status === "Open", afterStop.status);
      const bi = (await req("POST", "/api/sheet-changes/bulk-ignore", { ids: [cityChange._id] }, 200)).data;
      ok("sync S1-8: bulk-ignore refuses a change with Pending follow-ups", (bi.skipped ?? 0) === 1 && (bi.ignored ?? 0) === 0, JSON.stringify(bi));
      const stillOpen = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? []).find((c) => String(c._id) === String(cityChange._id));
      ok("sync S1-8: …so it is still Open, with its real action intact", !!stillOpen && stillOpen.action_taken === "Stop location", JSON.stringify({ s: stillOpen?.status, a: stillOpen?.action_taken }));
    }
  } else { ok("sync S1-3/S1-8: city change detected", false, "no change row"); }

  // ---- sync S1-4: Close/Stop from the Sync Inbox must answer to the approval matrix ----
  await req("PUT", "/api/approvals", { action: "location.stop", enabled: true, approver_role: "Operations" });
  const srcAppr = await mkSource(`Center ID,City,Target\n${s2},Ajmer,60\n`, "Audit appr " + s2);
  await req("POST", `/api/sync-sources/${srcAppr._id}/run`, undefined, 200);
  const apprChange = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => c.field_name === "city" && c.new_value === "Ajmer" && String(c.location?._id ?? c.location) === String(l2._id));
  if (apprChange) {
    const parked = await req("POST", `/api/sheet-changes/${apprChange._id}/apply`, { action: "Stop location", note: "needs approval" });
    ok("sync S1-4: Stop from the Sync Inbox is parked for approval like the Location screen", parked.status === 202, `got ${parked.status}: ${JSON.stringify(parked.data).slice(0, 120)}`);
  }
  await req("PUT", "/api/approvals", { action: "location.stop", enabled: false });
}

// ---- tab mappings (2026-08-13): user-approved column→field ingestion, no operator needed ----
{
  const s3 = "TM" + Date.now().toString().slice(-6);
  const locT = (await req("POST", "/api/locations", { code: "TML" + s3, name: "TabMap Loc " + s3, approval_status: "Approved", city: "Gurugram" }, 201)).data.item;
  const progT = (await req("POST", "/api/programs", { code: "TMQ" + s3, name: "TabMap Prog " + s3, trainer_skill: "TMSkill" + s3 }, 201)).data.item;

  // A candidate tab shaped like the client's real ones: totals row ABOVE the header, an "age"
  // column instead of DOB, "Enrolled" as the status word, and one row with an unusable phone.
  // Every name/phone is run-stamped — key collisions with a previous run would read as
  // "existing entity" and turn creations into review items (the e2e-govt.mjs lesson).
  const d8 = Date.now().toString().slice(-8);
  const nAsha = `Asha ${s3}`, nBinod = `Binod ${s3}`, nBadPhone = `BadPhone ${s3}`, nTrOne = `TabTrainer ${s3}`;
  const candTab = [
    ["Registrations till 30th", "", "", "", ""],
    ["Name", "Mobile", "What is your age?", "Enrolled Status", "Qualification"],
    [nAsha, "98" + d8, "22", "Enrolled", "12th"],
    [nBinod, "97" + d8, "25", "", "Graduate"],
    [nBadPhone, "98111", "30", "", "10th"], // 5 digits — unusable, must be flagged + skipped by name
  ];
  const trTab = [
    ["Trainer Name", "Mobile Number", "Email", "Education Attained"],
    [nTrOne, "96" + d8, "one@example.com", "B.Tech"],
  ];
  const srcTm = (await req("POST", "/api/sync-sources", {
    name: "TabMap source " + s3, source_url: wbDataUrl({ "Reg July": candTab, "Trainer_Master": trTab }), mode: "watch", interval_minutes: 5,
  }, 201)).data.item;
  await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200); // baseline snapshots

  // The wizard's proposal: obvious columns matched, header found below the totals row, and the
  // required-but-uncovered fields named so the user knows what a constant must supply.
  const sug = (await req("POST", `/api/sync-sources/${srcTm._id}/tab-mappings/suggest`, { tab: "Reg July", entity_type: "Candidate" }, 200)).data;
  const sugMap = Object.fromEntries(sug.suggestions.map((s) => [s.header, s.field]));
  ok("suggest: Name→name, Mobile→phone, age→dob", sugMap["Name"] === "name" && sugMap["Mobile"] === "phone" && sugMap["What is your age?"] === "dob", JSON.stringify(sugMap));
  ok("suggest: header found below the totals row", sug.header_row === 1, String(sug.header_row));
  ok("suggest: names location+program as still required", sug.required_missing.includes("location") && sug.required_missing.includes("program"), JSON.stringify(sug.required_missing));
  ok("suggest: preview flags the unusable phone by row", (sug.preview ?? []).some((p) => p.label === nBadPhone && p.warnings.length > 0), JSON.stringify(sug.preview?.map((p) => p.warnings)));

  const cols = [
    { header: "Name", field: "name" }, { header: "Mobile", field: "phone" },
    { header: "What is your age?", field: "dob" }, { header: "Enrolled Status", field: "sidh_status" },
    { header: "Qualification", field: "education" },
  ];
  // Approval refuses a mapping that cannot actually create rows (required fields uncovered),
  // a key supplied as a constant, and an unknown field.
  await req("PUT", `/api/sync-sources/${srcTm._id}/tab-mappings`, { tab: "Reg July", entity_type: "Candidate", columns: cols, constants: {}, key_field: "phone" }, 400);
  await req("PUT", `/api/sync-sources/${srcTm._id}/tab-mappings`, { tab: "Reg July", entity_type: "Candidate", columns: cols.slice(0, 1), constants: { phone: "9", location: locT._id, program: progT._id }, key_field: "phone" }, 400);
  await req("PUT", `/api/sync-sources/${srcTm._id}/tab-mappings`, { tab: "Reg July", entity_type: "Candidate", columns: [...cols, { header: "X", field: "not_a_field" }], constants: { location: locT._id, program: progT._id }, key_field: "phone" }, 400);
  // Approve with tab-level constants for centre + job role → import runs on the next watch.
  await req("PUT", `/api/sync-sources/${srcTm._id}/tab-mappings`, { tab: "Reg July", entity_type: "Candidate", columns: cols, constants: { location: locT._id, program: progT._id }, key_field: "phone" }, 200);
  await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200);

  const tms1 = (await req("GET", `/api/sync-sources/${srcTm._id}/tab-mappings`, undefined, 200)).data.items;
  const repC = tms1.find((m) => m.tab === "Reg July")?.last_report;
  ok("initial import: 2 candidates created", repC?.created === 2, JSON.stringify(repC));
  ok("initial import: the phone-less row is skipped BY NAME, never silently", (repC?.skipped ?? []).some((s) => s.includes(nBadPhone)), JSON.stringify(repC?.skipped));

  const cands = (await req("GET", `/api/candidates?location=${locT._id}&limit=100`)).data.items ?? [];
  const asha = cands.find((c) => c.name === nAsha);
  ok("created row carries constants + transforms (program, Enrolled→Registered, 12th→12th Pass)",
    !!asha && String(asha.program?._id ?? asha.program) === String(progT._id) && asha.sidh_status === "Registered" && asha.education === "12th Pass",
    JSON.stringify({ prog: asha?.program?.name, sidh: asha?.sidh_status, edu: asha?.education }));
  ok("…and the age column became an approximate DOB", !!asha?.dob && new Date().getFullYear() - new Date(asha.dob).getFullYear() === 22, String(asha?.dob));

  // The client edits a cell → the change is a REVIEW ITEM on the existing candidate, not a
  // silent overwrite. Apply writes it; revert puts it back.
  candTab[3][0] = nBinod + " Singh";
  await req("PATCH", `/api/sync-sources/${srcTm._id}`, { source_url: wbDataUrl({ "Reg July": candTab, "Trainer_Master": trTab }) }, 200);
  await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200);
  const openTm = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => c.entity_type === "Candidate" && c.field_name === "name" && c.new_value === nBinod + " Singh");
  ok("edited cell became a Candidate review item with tab + row label", !!openTm && openTm.tab === "Reg July" && openTm.impact_snapshot?.row_label === nBinod + " Singh", JSON.stringify({ tab: openTm?.tab, label: openTm?.impact_snapshot?.row_label }));
  if (openTm) {
    const binod = cands.find((c) => c.name === nBinod);
    ok("…and the entity still holds the OLD value until a human applies", !!binod, "pre-change Binod not found in list");
    await req("POST", `/api/sheet-changes/${openTm._id}/apply`, { action: "Apply value" }, 200);
    const afterApply = (await req("GET", `/api/candidates/${openTm.entity}`)).data.item;
    ok("Apply value writes the sheet's value onto the candidate", afterApply?.name === nBinod + " Singh", afterApply?.name);
    await req("POST", `/api/sheet-changes/${openTm._id}/revert`, {}, 200);
    const afterRevert = (await req("GET", `/api/candidates/${openTm.entity}`)).data.item;
    ok("Revert restores the previous value exactly", afterRevert?.name === nBinod, afterRevert?.name);

    // -111 (Umesh 18/08, "user acknowledge kar raha hai … phir se saare sync wapas kar deta hai"):
    // the row is Ignored now, the entity holds the OLD value, and the sheet STILL says "Binod
    // Singh". Move an unrelated cell on the same tab so the tab is re-ingested — before -111 the
    // dedupe looked at Open rows only, so the very same change was created again right here.
    candTab[2][0] = nAsha + " Devi";
    await req("PATCH", `/api/sync-sources/${srcTm._id}`, { source_url: wbDataUrl({ "Reg July": candTab, "Trainer_Master": trTab }) }, 200);
    await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200);
    const allBinod = ((await req("GET", "/api/sheet-changes?status=all")).data.items ?? [])
      .filter((c) => c.entity_type === "Candidate" && c.field_name === "name" && c.new_value === nBinod + " Singh");
    ok("-111: a change the user already decided on (Ignored) is NOT recreated by the next tick — one row, still Ignored",
      allBinod.length === 1 && allBinod[0].status === "Ignored", JSON.stringify(allBinod.map((c) => c.status)));
    const ashaOpen = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
      .find((c) => c.entity_type === "Candidate" && c.field_name === "name" && c.new_value === nAsha + " Devi");
    ok("-111: …while a genuinely NEW cell change on that tab still becomes a review item", !!ashaOpen, "Asha Devi change not queued");
    // Same tick again with the same sheet: still nothing new for either.
    await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200);
    const afterTick = ((await req("GET", "/api/sheet-changes?status=all")).data.items ?? [])
      .filter((c) => c.entity_type === "Candidate" && c.field_name === "name" && [nBinod + " Singh", nAsha + " Devi"].includes(c.new_value));
    ok("-111: a second identical tick adds no rows (2 total: 1 Ignored + 1 Open)", afterTick.length === 2, JSON.stringify(afterTick.map((c) => [c.new_value, c.status])));
  }

  // A second mapping on the SAME source, different tab, different entity — trainers.
  await req("PUT", `/api/sync-sources/${srcTm._id}/tab-mappings`, {
    tab: "Trainer_Master", entity_type: "Trainer", key_field: "phone",
    columns: [{ header: "Trainer Name", field: "name" }, { header: "Mobile Number", field: "phone" }, { header: "Email", field: "email" }, { header: "Education Attained", field: "qualification" }],
    constants: {},
  }, 200);
  await req("POST", `/api/sync-sources/${srcTm._id}/run`, undefined, 200);
  const tms2 = (await req("GET", `/api/sync-sources/${srcTm._id}/tab-mappings`, undefined, 200)).data.items;
  ok("trainer tab imported by its own mapping", tms2.find((m) => m.tab === "Trainer_Master")?.last_report?.created === 1, JSON.stringify(tms2.find((m) => m.tab === "Trainer_Master")?.last_report));
  const trNew = ((await req("GET", `/api/trainers?q=${encodeURIComponent(nTrOne)}&limit=10`)).data.items ?? [])[0];
  ok("created trainer is a real Trainer with the mapped fields", !!trNew && trNew.qualification === "B.Tech", JSON.stringify({ q: trNew?.qualification }));

  // Tab mappings ride on watch sources only — a mapped-mode source must refuse.
  const srcMapped = (await req("POST", "/api/sync-sources", { name: "TabMap mapped " + s3, source_url: wbDataUrl({ X: [["A"], ["1"]] }), mode: "mapped", field_mappings: { A: "external_id" } }, 201)).data.item;
  await req("PUT", `/api/sync-sources/${srcMapped._id}/tab-mappings`, { tab: "X", entity_type: "Candidate", columns: [{ header: "A", field: "phone" }], constants: {}, key_field: "phone" }, 400);
}

// ---- QA-497 (-166): the sheet's PER-ROW government verdict must reach LocationTarget ----
// tc_status was only ever in LOCATION_FIELDS, which is CENTRE-level, while every count in the
// product reads LocationTarget.tc_status. So the client could correct their own master and the
// ERP would not move - which is why the 1,000 (QA-440) had to be corrected by hand, and would
// have had to be corrected by hand again after the next sheet edit.
{
  const s4 = "Q" + Date.now().toString().slice(-6);
  const p4 = (await req("POST", "/api/programs", { code: s4, name: "TC Prog " + s4, trainer_skill: "TCSkill" + s4 }, 201)).data.item;
  const p4b = (await req("POST", "/api/programs", { code: s4 + "B", name: "TC Prog B " + s4, trainer_skill: "TCSkillB" + s4 }, 201)).data.item;
  const l4 = (await req("POST", "/api/locations", { code: "TL" + s4, name: "TC Loc " + s4, external_id: "TC" + s4, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  // The row has to exist first: a government verdict for a job role this centre has no target on
  // is a question, not a write - asserted at the end of this block.
  await req("PUT", `/api/locations/${l4._id}/targets`, { program: p4._id, approved_target: 300, tc_status: "Approved" }, 200);
  const rowOf = async (prog) => ((await req("GET", `/api/locations/${l4._id}/targets`)).data.items ?? [])
    .find((t) => String(t.program?._id ?? t.program) === String(prog._id));

  // CSV upload, the fixture shape this suite already proves works. The first draft used an
  // in-memory xlsx data: URL and the header lookup never found the row - the pin then failed for
  // a reason that had nothing to do with the defect, which is a pin that cannot be trusted either
  // way round.
  const mkSrc = async (csv, label, mappings) => {
    const fd = new FormData();
    fd.append("file", new File([csv], "tc.csv", { type: "text/csv" }));
    const u = (await req("POST", "/api/upload", fd, 200)).data;
    return (await req("POST", "/api/sync-sources", {
      name: label + " " + s4, source_url: new URL(u.url, BASE).href, field_mappings: mappings,
    }, 201)).data.item;
  };
  const openFor = async (field) => ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => c.field_name === field && String(c.location?._id ?? c.location) === String(l4._id));

  // (1) the sheet says this row is NOT approved any more
  const F1 = `tc_status:${s4}`;
  const src1 = await mkSrc(`Center ID,TC Status\nTC${s4},Unapproved\n`, "TC status sheet", { "Center ID": "external_id", "TC Status": F1 });
  const r1 = (await req("POST", `/api/sync-sources/${src1._id}/run`, undefined, 200)).data;
  const c1 = await openFor(F1);
  ok("QA-497: a per-row TC Status change is DETECTED - the sheet can finally address (centre x job role)",
    r1.created === 1 && !!c1, JSON.stringify({ run: r1, change: c1?.field_name ?? null }));
  if (c1) {
    ok("QA-497: ...and the change names the row field, with the ERP's current value as old_value",
      c1.old_value === "Approved" && c1.new_value === "Unapproved", JSON.stringify({ o: c1.old_value, n: c1.new_value }));
    await req("POST", `/api/sheet-changes/${c1._id}/apply`, { action: "Update target" }, 200);
    ok("QA-497: applying it writes LocationTarget.tc_status - the field every count in the product reads",
      (await rowOf(p4))?.tc_status === "Unapproved", JSON.stringify(await rowOf(p4)));
  } else {
    ok("QA-497: ...and the change names the row field", false, "no change row - the mapping was not recognised at all");
    ok("QA-497: applying it writes LocationTarget.tc_status", false, "no change row to apply");
  }

  // (2) a BLANK cell is a REAL value, and this is exactly the QA-440 five rows: blank in the
  // client's master, Approved in the ERP. If blank cannot travel, the sheet cannot say it.
  const src2 = await mkSrc(`Center ID,TC Status\nTC${s4},\n`, "TC blank sheet", { "Center ID": "external_id", "TC Status": F1 });
  const r2 = (await req("POST", `/api/sync-sources/${src2._id}/run`, undefined, 200)).data;
  const c2 = await openFor(F1);
  ok("QA-497: a BLANK cell is detected as a change (blank is what the client's master says on the QA-440 rows)",
    !!c2 && c2.new_value === "", JSON.stringify({ run: r2, o: c2?.old_value, n: JSON.stringify(c2?.new_value ?? null) }));
  if (c2) {
    await req("POST", `/api/sheet-changes/${c2._id}/apply`, { action: "Update target" }, 200);
    const blanked = (await rowOf(p4))?.tc_status;
    ok("QA-497: ...and it lands as blank, not as the string 'undefined' and not left untouched",
      blanked === "" || blanked == null, JSON.stringify({ tc_status: blanked }));
  } else {
    ok("QA-497: ...and it lands as blank", false, "no blank change row to apply");
  }

  // (3) the row's own government TC ID travels the same way - each sheet row carries its own
  // (Charthwal: TC353328 for AVPL, TC352938 for HSL), and that id is the anchor the whole
  // 1,000-target reconciliation was done on.
  const F3 = `tc_id:${s4}`;
  const src3 = await mkSrc(`Center ID,Row TC\nTC${s4},TC999${s4}\n`, "TC id sheet", { "Center ID": "external_id", "Row TC": F3 });
  await req("POST", `/api/sync-sources/${src3._id}/run`, undefined, 200);
  const c3 = await openFor(F3);
  if (c3) await req("POST", `/api/sheet-changes/${c3._id}/apply`, { action: "Update target" }, 200);
  ok("QA-497: the row's own TC ID reaches the row too",
    !!c3 && (await rowOf(p4))?.tc_id === "TC999" + s4, JSON.stringify({ change: !!c3, tc_id: (await rowOf(p4))?.tc_id ?? null }));

  // (4) a status must NEVER conjure the row it describes. approved_target upserts because a
  // target row is created BY its target; a verdict for a job role with no target row is a
  // question for a human, and answering it by inventing a row would put a government approval
  // on a job role nobody has agreed to.
  const F4 = `tc_status:${s4}B`;
  const src4 = await mkSrc(`Center ID,TC Status\nTC${s4},Approved\n`, "TC orphan sheet", { "Center ID": "external_id", "TC Status": F4 });
  await req("POST", `/api/sync-sources/${src4._id}/run`, undefined, 200);
  const c4 = await openFor(F4);
  if (c4) {
    const orphan = await req("POST", `/api/sheet-changes/${c4._id}/apply`, { action: "Update target" });
    ok("QA-497: a verdict for a job role with NO target row is refused and says why - it does not upsert one into existence",
      orphan.status === 409 && /no target row/i.test(String(orphan.data?.error ?? "")), JSON.stringify({ s: orphan.status, e: String(orphan.data?.error ?? "").slice(0, 110) }));
    ok("QA-497: ...and no row was created behind the refusal",
      !(await rowOf(p4b)), JSON.stringify({ created: !!(await rowOf(p4b)) }));
  } else {
    ok("QA-497: a verdict for a job role with NO target row is refused", false, "no change row - the mapping was not recognised at all");
    ok("QA-497: ...and no row was created behind the refusal", !(await rowOf(p4b)), "no change row was raised, so nothing could be written either");
  }
}
// ---- QA-520 (-169): a sheet row finds its centre by its OWN registration number ----
// The government registers a centre per scheme and numbers each registration, so ONE CENTRE HAS
// SEVERAL TC IDs (Charthwal: TC353328 for AVPL, TC352938 for HSL) while Location.external_id holds
// exactly one. Measured on live: 20 of the sheet's 35 TC IDs reached no location at all, including
// four of the five rows QA-440 exists for. Those rows could never be corrected from the sheet, and
// the sync reported a clean run - it did raise a change, with no centre attached to it, which is a
// row nobody can act on.
//
// The number identifies the CENTRE, not the job role: propose-tc-ids.mjs:96 says "A TC ID repeats
// across job-role rows", and live agrees - 35 distinct TC IDs against 55 target rows. So the job
// role still comes from the mapping's :CODE, and the first draft of this block (refuse whenever
// more than one row carries the number) would have blocked most of the sheet.
{
  const s5 = "A" + Date.now().toString().slice(-6);
  const p5 = (await req("POST", "/api/programs", { code: s5, name: "Anchor Prog " + s5, trainer_skill: "AncSkill" + s5 }, 201)).data.item;
  // The centre's key is a DIFFERENT TC ID from the row's - exactly the live shape.
  const l5 = (await req("POST", "/api/locations", { code: "AL" + s5, name: "Anchor Loc " + s5, external_id: "TCCENTRE" + s5, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  await req("PUT", `/api/locations/${l5._id}/targets`, { program: p5._id, approved_target: 400, tc_id: "TCROW" + s5, tc_status: "Approved" }, 200);
  const rowOf5 = async () => ((await req("GET", `/api/locations/${l5._id}/targets`)).data.items ?? [])
    .find((t) => String(t.program?._id ?? t.program) === String(p5._id));
  const mkSrc5 = async (csv, label, mappings) => {
    const fd = new FormData();
    fd.append("file", new File([csv], "anc.csv", { type: "text/csv" }));
    const u = (await req("POST", "/api/upload", fd, 200)).data;
    return (await req("POST", "/api/sync-sources", {
      name: label + " " + s5, source_url: new URL(u.url, BASE).href, field_mappings: mappings,
    }, 201)).data.item;
  };

  // (1) the sheet row carries the ROW's TC ID, which is NOT any centre's key. Today: invisible.
  // The mapping names a DIFFERENT programme code on purpose - the anchored row's own job role
  // must win, because that is the government's answer and the mapping is only a guess.
  const F5 = `tc_status:${s5}`;
  const src5 = await mkSrc5(`TC ID,TC Status\nTCROW${s5},Unapproved\n`, "Anchor sheet",
    { "TC ID": "external_id", "TC Status": F5 });
  const r5 = (await req("POST", `/api/sync-sources/${src5._id}/run`, undefined, 200)).data;
  const c5 = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => String(c.location?._id ?? c.location) === String(l5._id) && String(c.field_name).startsWith("tc_status:"));
  ok("QA-520: a row whose TC ID is NOT its centre's key is finally SEEN, and ATTACHED to that centre - today it raises an orphan change with no centre at all",
    r5.created === 1 && !!c5, JSON.stringify({ run: r5, change: c5?.field_name ?? null }));

  if (c5) {
    ok("QA-520: the change carries the ERP's current value, so the reviewer sees what they are changing",
      c5.field_name === F5 && c5.old_value === "Approved" && c5.new_value === "Unapproved",
      JSON.stringify({ f: c5.field_name, o: c5.old_value, n: c5.new_value }));
    await req("POST", `/api/sheet-changes/${c5._id}/apply`, { action: "Update target" }, 200);
    ok("QA-520: ...and applying it reaches THAT row",
      (await rowOf5())?.tc_status === "Unapproved", JSON.stringify(await rowOf5()));
  } else {
    ok("QA-520: the change carries the ERP's current value", false, "no change row attached to this centre");
    ok("QA-520: ...and applying it reaches THAT row", false, "no change row to apply");
  }

  // (2) the SAME number on a SECOND job role of the SAME centre must keep working. This is the
  // normal shape of the client's sheet - one registration covering several job roles - and the
  // first draft of this feature refused exactly this, which would have blocked most of the sheet.
  const p5b = (await req("POST", "/api/programs", { code: s5 + "B", name: "Anchor Prog B " + s5, trainer_skill: "AncSkillB" + s5 }, 201)).data.item;
  await req("PUT", `/api/locations/${l5._id}/targets`, { program: p5b._id, approved_target: 100, tc_id: "TCROW" + s5, tc_status: "Approved" }, 200);
  const F5b = `tc_status:${s5}B`;
  const srcB = await mkSrc5(`TC ID,TC Status\nTCROW${s5},Unapproved\n`, "Anchor second role",
    { "TC ID": "external_id", "TC Status": F5b });
  const rB = (await req("POST", `/api/sync-sources/${srcB._id}/run`, undefined, 200)).data;
  const cB = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => c.field_name === F5b && String(c.location?._id ?? c.location) === String(l5._id));
  ok("QA-520: one registration number covering SEVERAL job roles is the normal case, not an error - the mapping's :CODE still picks the row",
    rB.status === "OK" && !!cB, JSON.stringify({ run: rB, change: cB?.field_name ?? null }));

  // (3) the ambiguity that IS real: one number claimed by two DIFFERENT centres. Never settled by
  // write order - the whole row is skipped and the run says Partial, never a clean OK.
  const l5b = (await req("POST", "/api/locations", { code: "AL" + s5 + "B", name: "Anchor Loc B " + s5, external_id: "TCCENTRE" + s5 + "B", approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  await req("PUT", `/api/locations/${l5b._id}/targets`, { program: p5._id, approved_target: 50, tc_id: "TCROW" + s5 }, 200);
  const srcDup = await mkSrc5(`TC ID,TC Status\nTCROW${s5},Approved\n`, "Anchor clash sheet",
    { "TC ID": "external_id", "TC Status": F5 });
  const rDup = (await req("POST", `/api/sync-sources/${srcDup._id}/run`, undefined, 200)).data;
  ok("QA-520: one TC ID claimed by TWO CENTRES is refused, not guessed - and the run says Partial, never a clean OK",
    rDup.created === 0 && rDup.status === "Partial" && /more than one centre/i.test(String(rDup.error ?? "")),
    JSON.stringify(rDup));
  ok("QA-520: ...and nothing was written while it was ambiguous",
    (await rowOf5())?.tc_status === "Unapproved", JSON.stringify({ tc_status: (await rowOf5())?.tc_status }));
}
// QA-440 / QA-497 (the half that was left): a LONG sheet - one row per centre x job role, ONE
// "TC Status" column - is the shape the client's master actually has, and until now the mappings
// could only express WIDE (a column per job role, naming its programme as ":CODE"). Pointing that
// one column at one programme code makes BOTH of a centre's job-role rows write that programme's
// target, last row winning, silently - which is why it was never configured and why the 1,000 in
// QA-440 had to be corrected by hand.
//
// Measured on live 2026-08-22 and the reason the resolution is anchored on the TC ID rather than on
// the job-role NAME: two programmes carry the identical name "Drone Service Technician"
// (RPLAVP-DST and PMKVYB-DST), differing only by scheme. The TC ID pins the scheme, so inside one
// TC ID a job-role name appears once - live: 55 target rows, 48 with a tc_id, zero duplicate
// (tc_id + job role) pairs among them.
{
  const s6 = "J" + Date.now().toString().slice(-6);
  const pA = (await req("POST", "/api/programs", { code: s6 + "A", name: "Drone Service Technician " + s6, trainer_skill: "JR" + s6 + "A" }, 201)).data.item;
  const pB = (await req("POST", "/api/programs", { code: s6 + "B", name: "Solar Panel Installation Technician " + s6, trainer_skill: "JR" + s6 + "B" }, 201)).data.item;
  const l6 = (await req("POST", "/api/locations", { code: "JL" + s6, name: "Long Sheet Loc " + s6, external_id: "JCENTRE" + s6, approval_status: "Approved", city: "Bhadohi" }, 201)).data.item;
  // ONE registration number across BOTH job-role rows - the live shape.
  const TC = "TCLONG" + s6;
  // The two rows must DIFFER from what the sheet says, or there is legitimately nothing to report:
  // A is Approved in the ERP and blank in the sheet (the QA-440 shape), B is the mirror image.
  await req("PUT", `/api/locations/${l6._id}/targets`, { program: pA._id, approved_target: 120, tc_id: TC, tc_status: "Approved" }, 200);
  await req("PUT", `/api/locations/${l6._id}/targets`, { program: pB._id, approved_target: 315, tc_id: TC, tc_status: "Unapproved" }, 200);
  const rowsOf6 = async () => ((await req("GET", `/api/locations/${l6._id}/targets`)).data.items ?? []);
  const rowOf6 = async (p) => (await rowsOf6()).find((t) => String(t.program?._id ?? t.program) === String(p._id));

  const fd6 = new FormData();
  // One row per job role, ONE status column, and the two rows disagree - which is the whole point:
  // a centre-level field physically cannot carry two different answers.
  fd6.append("file", new File([[
    `TC ID,Job role,TC Status`,
    `${TC},Drone Service Technician ${s6},`,
    `${TC},Solar Panel Installation Technician ${s6},Approved`,
    ``,
  ].join("\n")], "long.csv", { type: "text/csv" }));
  const u6 = (await req("POST", "/api/upload", fd6, 200)).data;
  const src6 = (await req("POST", "/api/sync-sources", {
    name: "Long sheet " + s6, source_url: new URL(u6.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status" },
  }, 201)).data.item;

  const r6 = (await req("POST", `/api/sync-sources/${src6._id}/run`, undefined, 200)).data;
  const mine6 = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .filter((c) => String(c.location?._id ?? c.location) === String(l6._id));
  const nameOf = (code) => mine6.find((c) => String(c.field_name) === `tc_status:${code}`);
  // PRE-FIX this is 1 change named plain "tc_status" (LOCATION_FIELDS, centre-level) and the two
  // rows fight over it. POST-FIX it is 2, each naming its own job role.
  ok("QA-440: a sheet with ONE ROW PER JOB ROLE addresses each job role separately - two rows, two changes, each naming its own programme",
    r6.created === 2 && !!nameOf(pA.code) && !!nameOf(pB.code) && !mine6.some((c) => String(c.field_name) === "tc_status"),
    JSON.stringify({ created: r6.created, status: r6.status, fields: mine6.map((c) => c.field_name) }));
  // The blank is a real value here - it is exactly what the client's master says for the five rows
  // QA-440 exists for, and a diff that cannot see blank-vs-value cannot report them.
  ok("QA-440: ...and a BLANK cell is carried as a real change, not skipped as missing",
    String(nameOf(pA.code)?.new_value ?? "?") === "" && String(nameOf(pA.code)?.old_value) === "Approved",
    JSON.stringify({ old: nameOf(pA.code)?.old_value, new: nameOf(pA.code)?.new_value }));

  // Applying them must land on the right rows, which is the fact the report's Approved count reads.
  for (const c of mine6) await req("POST", `/api/sheet-changes/${c._id}/apply`, { action: "Update target" }, 200);
  ok("QA-440: applying writes each job role's OWN target row - one is cleared to blank, the other becomes Approved",
    (await rowOf6(pA))?.tc_status === "" && (await rowOf6(pB))?.tc_status === "Approved",
    JSON.stringify({ A: (await rowOf6(pA))?.tc_status, B: (await rowOf6(pB))?.tc_status }));

  // A job role the centre has no target row for is a QUESTION, not a write - the same standard
  // QA-520 holds for a registration number two centres claim.
  const fd6b = new FormData();
  fd6b.append("file", new File([`TC ID,Job role,TC Status\n${TC},Battery System Repair Technician ${s6},Approved\n`], "long2.csv", { type: "text/csv" }));
  const u6b = (await req("POST", "/api/upload", fd6b, 200)).data;
  const src6b = (await req("POST", "/api/sync-sources", {
    name: "Long sheet unknown role " + s6, source_url: new URL(u6b.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status" },
  }, 201)).data.item;
  const r6b = (await req("POST", `/api/sync-sources/${src6b._id}/run`, undefined, 200)).data;
  ok("QA-440: a job role with no target row on that centre is refused and the run says Partial, never a clean OK",
    r6b.created === 0 && r6b.status === "Partial" && /could not be matched to a target row/i.test(String(r6b.error ?? "")),
    JSON.stringify(r6b));

  // The three below are a checker's leads from a run that never got to execute - it destroyed the
  // shared node_modules and returned BLOCKED, but it had READ the diff, and all three were real.
  // Pinned here because each is the unit's own thesis turned back on it.

  // (1) A BLANK job-role cell was the sharpest: the first version guarded resolution with
  // `if (roleText)`, so a blank pushed nothing, resolved to nothing, silently dropped every
  // per-job-role field on that row - and reported OK. The exact "invisible behind last_status: OK"
  // shape this unit exists to kill, rebuilt in the lines written to kill it.
  const fd6c = new FormData();
  fd6c.append("file", new File([`TC ID,Job role,TC Status\n${TC},,Approved\n`], "blankrole.csv", { type: "text/csv" }));
  const u6c = (await req("POST", "/api/upload", fd6c, 200)).data;
  const src6c = (await req("POST", "/api/sync-sources", {
    name: "Long sheet blank role " + s6, source_url: new URL(u6c.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status" },
  }, 201)).data.item;
  const r6c = (await req("POST", `/api/sync-sources/${src6c._id}/run`, undefined, 200)).data;
  ok("QA-440: a BLANK job-role cell is reported, not silently dropped behind a clean OK",
    r6c.created === 0 && r6c.status === "Partial" && /job-role cell is blank/i.test(String(r6c.error ?? "")),
    JSON.stringify(r6c));

  // (2) The message used to say "rows were skipped". Only the per-JOB-ROLE fields are skipped -
  // the row's centre-level fields are still read, because the centre is known and only the job
  // role is not. Both the behaviour and the wording are pinned, since the wording was the wrong half.
  const fd6d = new FormData();
  fd6d.append("file", new File([`TC ID,Job role,TC Status,City\n${TC},Not A Real Job Role ${s6},Approved,Varanasi\n`], "citytoo.csv", { type: "text/csv" }));
  const u6d = (await req("POST", "/api/upload", fd6d, 200)).data;
  const src6d = (await req("POST", "/api/sync-sources", {
    name: "Long sheet city too " + s6, source_url: new URL(u6d.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status", "City": "city" },
  }, 201)).data.item;
  const r6d = (await req("POST", `/api/sync-sources/${src6d._id}/run`, undefined, 200)).data;
  const cityChg = ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => String(c.sync_source?._id ?? c.sync_source) === String(src6d._id) && String(c.field_name) === "city");
  ok("QA-440: an unresolvable job role skips only that row's PER-JOB-ROLE fields - its centre-level fields are still read, and the message says which",
    r6d.status === "Partial" && !!cityChg && /PER-JOB-ROLE FIELDS were skipped/i.test(String(r6d.error ?? "")),
    JSON.stringify({ status: r6d.status, city: cityChg?.new_value, err: String(r6d.error ?? "").slice(0, 120) }));

  // (3) job_role AND a ":CODE" column on one source is the hazard the Admin help text warns about
  // in prose. Prose is not enforcement: on a long sheet the ":CODE" column resolves per MAPPING,
  // so every row of a centre writes that one programme. Refused when the run starts.
  const fd6e = new FormData();
  fd6e.append("file", new File([`TC ID,Job role,TC Status\n${TC},Drone Service Technician ${s6},Approved\n`], "both.csv", { type: "text/csv" }));
  const u6e = (await req("POST", "/api/upload", fd6e, 200)).data;
  const src6e = (await req("POST", "/api/sync-sources", {
    name: "Long sheet both shapes " + s6, source_url: new URL(u6e.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": `tc_status:${pB.code}` },
  }, 201)).data.item;
  const r6e = await req("POST", `/api/sync-sources/${src6e._id}/run`, undefined, 400);
  ok("QA-440: mapping job_role AND a :CODE column on one source is refused, not half-applied",
    r6e.status === 400 && /would write that one programme for every row/i.test(String(r6e.data?.error ?? "")),
    JSON.stringify({ status: r6e.status, error: String(r6e.data?.error ?? "").slice(0, 140) }));

  // (QA-603) ...and a refusal must LEAVE A MARK. It threw before writing the document, so the
  // source row still read last_status "OK" from its previous clean run - and on the Daily schedule
  // the throw is swallowed into a console line, so the screen said the sync was fine while it had
  // not run at all. Every other refusal in runSync saves first.
  const after6e = (await req("GET", `/api/sync-sources/${src6e._id}`)).data.item;
  ok("QA-603: a refused run is RECORDED on the source - it does not keep reporting the last clean run",
    after6e?.last_status === "Failed" && /would write that one programme for every row/i.test(String(after6e?.last_error ?? "")),
    JSON.stringify({ last_status: after6e?.last_status, last_error: String(after6e?.last_error ?? "").slice(0, 80) }));

  // (QA-602) A duplicated mapped header. `colIdx` is last-wins, so before this the sync read the
  // SECOND "Job role" column, decided the programme from it, wrote the government's verdict to that
  // programme's target row, and reported a clean OK. Measured by a checker on -188.
  const fd6f = new FormData();
  fd6f.append("file", new File([`TC ID,Job role,Job role,TC Status\n${TC},Drone Service Technician ${s6},Solar Panel Installation Technician ${s6},Approved\n`], "duphdr.csv", { type: "text/csv" }));
  const u6f = (await req("POST", "/api/upload", fd6f, 200)).data;
  const src6f = (await req("POST", "/api/sync-sources", {
    name: "Long sheet duplicate header " + s6, source_url: new URL(u6f.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status" },
  }, 201)).data.item;
  const r6f = await req("POST", `/api/sync-sources/${src6f._id}/run`, undefined, 400);
  const after6f = (await req("GET", `/api/sync-sources/${src6f._id}`)).data.item;
  ok("QA-602: two mapped columns with the SAME header refuse the run - a value read from the wrong one of two is worse than no sync",
    r6f.status === 400 && /more than one column headed/i.test(String(r6f.data?.error ?? "")) && after6f?.last_status === "Failed",
    JSON.stringify({ status: r6f.status, last_status: after6f?.last_status, error: String(r6f.data?.error ?? "").slice(0, 110) }));

  // (QA-604) The merged Partial shipped in -188 with NO pin, and it was merged for two of the THREE
  // reasons - `ambiguous` stayed in front and swallowed the others. One sheet, two faults, both
  // must be named.
  const s7 = "K" + Date.now().toString().slice(-6);
  const p7 = (await req("POST", "/api/programs", { code: s7, name: "Clash Prog " + s7, trainer_skill: "CL" + s7 }, 201)).data.item;
  const TCX = "TCCLASH" + s7;
  const l7a = (await req("POST", "/api/locations", { code: "KA" + s7, name: "Clash A " + s7, external_id: "KCA" + s7, approval_status: "Approved", city: "Agra" }, 201)).data.item;
  const l7b = (await req("POST", "/api/locations", { code: "KB" + s7, name: "Clash B " + s7, external_id: "KCB" + s7, approval_status: "Approved", city: "Agra" }, 201)).data.item;
  // The SAME registration number on two different centres -> `ambiguous`.
  await req("PUT", `/api/locations/${l7a._id}/targets`, { program: p7._id, approved_target: 100, tc_id: TCX }, 200);
  await req("PUT", `/api/locations/${l7b._id}/targets`, { program: p7._id, approved_target: 100, tc_id: TCX }, 200);
  const fd7 = new FormData();
  // Row 1: the ambiguous TC ID. Row 2: physically short, so it is `truncated`. Two faults, one sheet.
  fd7.append("file", new File([`TC ID,Job role,TC Status,City\n${TCX},Clash Prog ${s7},Approved,Agra\nKCA${s7},Clash Prog ${s7}\n`], "twofaults.csv", { type: "text/csv" }));
  const u7 = (await req("POST", "/api/upload", fd7, 200)).data;
  const src7 = (await req("POST", "/api/sync-sources", {
    name: "Two faults " + s7, source_url: new URL(u7.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "Job role": "job_role", "TC Status": "tc_status", "City": "city" },
  }, 201)).data.item;
  const r7 = (await req("POST", `/api/sync-sources/${src7._id}/run`, undefined, 200)).data;
  ok("QA-604: a sheet with TWO reasons to be Partial reports BOTH - merging two of three reasons left the same defect in a smaller coat",
    r7.status === "Partial" && /more than one centre/i.test(String(r7.error ?? "")) && /missing one or more mapped columns/i.test(String(r7.error ?? "")),
    JSON.stringify({ status: r7.status, error: String(r7.error ?? "").slice(0, 200) }));

  // QA-605: -189 reworded this message ("skipped rather than guessed" -> "skipped ENTIRELY rather
  // than guessed") and shipped the rewording with NO pin. The word carries the distinction the whole
  // -188 correction was about: an ambiguous TC ID abandons the WHOLE row because the centre itself
  // is in doubt, while an unresolvable job role skips only that row's per-job-role fields. Losing
  // "entirely" would quietly re-blur the two, and nothing would have failed.
  ok("QA-605: the ambiguous-TC-ID reason says the row was skipped ENTIRELY - the word that separates it from a job-role skip",
    /skipped entirely rather than guessed/i.test(String(r7.error ?? "")),
    String(r7.error ?? "").slice(0, 160));

  // QA-606: two configuration refusals recorded NOTHING, and -189's comment claimed the opposite
  // ("every other refusal in here saves first"). Both are reachable - assertSyncSourceAllowed never
  // validates mappings - so a source could be refused every night while its row still showed the
  // last clean run. Pinned so the comment cannot become false again without something failing.
  // Its OWN upload: the same workbook cannot be registered twice in mapped mode (the -100 guard),
  // and reusing u7's URL made this block die on a 400 that was entirely correct.
  const mkUpload = async (csv, name) => {
    const f = new FormData();
    f.append("file", new File([csv], name, { type: "text/csv" }));
    return (await req("POST", "/api/upload", f, 200)).data;
  };
  const u8 = await mkUpload(`TC ID,TC Status\n${TCX},Approved\n`, "nomap.csv");
  const src8 = (await req("POST", "/api/sync-sources", {
    name: "No mappings " + s7, source_url: new URL(u8.url, BASE).href, field_mappings: {},
  }, 201)).data.item;
  const r8 = await req("POST", `/api/sync-sources/${src8._id}/run`, undefined, 400);
  const after8 = (await req("GET", `/api/sync-sources/${src8._id}`)).data.item;
  ok("QA-606: a source with NO field mappings is refused AND the refusal is recorded on the row",
    r8.status === 400 && after8?.last_status === "Failed" && /No field mappings configured/i.test(String(after8?.last_error ?? "")),
    JSON.stringify({ status: r8.status, last_status: after8?.last_status }));

  const u9 = await mkUpload(`TC ID,TC Status\n${TCX},Unapproved\n`, "noext.csv");
  const src9 = (await req("POST", "/api/sync-sources", {
    name: "No external_id " + s7, source_url: new URL(u9.url, BASE).href,
    field_mappings: { "TC Status": "tc_status" },
  }, 201)).data.item;
  const r9 = await req("POST", `/api/sync-sources/${src9._id}/run`, undefined, 400);
  const after9 = (await req("GET", `/api/sync-sources/${src9._id}`)).data.item;
  ok("QA-606: a source with no external_id column is refused AND the refusal is recorded on the row",
    r9.status === 400 && after9?.last_status === "Failed" && /must map one column to external_id/i.test(String(after9?.last_error ?? "")),
    JSON.stringify({ status: r9.status, last_status: after9?.last_status }));

  // ---------------------------------------------------------------------------------------------
  // QA-666 (Umesh, 2026-08-22). The team blanked TC Status on FIVE previously-Approved rows of the
  // client workbook and exactly ONE reached the Sync Inbox. Measured on live that day: 20 of the
  // sheet's 35 TC IDs are not any location's `external_id`, and of those five rows exactly one was
  // - TC351180 - which is precisely the one that appeared. The other four were not refused and not
  // reported. They were read as AGREEING, because `loc` was null, a centre-level `stored` fell to
  // "", and a blank sheet cell equals "". The run returned `status: "OK", created: 1`.
  //
  // These three pins are written on the QUESTION ("can a row be dropped without anyone being told"),
  // not on the route, per the standard this project learned in -130.
  const s10 = "U" + Date.now().toString().slice(-6);
  const p10 = (await req("POST", "/api/programs", { code: s10, name: "Unreach Prog " + s10, trainer_skill: "UR" + s10 }, 201)).data.item;
  const TCA = "TCANCH" + s10;   // carried on a target ROW, and NOT the centre's external_id
  const TCN = "TCNONE" + s10;   // carried by nobody at all

  // The centre is findable ONLY through the target row's tc_id — exactly the four rows Umesh lost.
  const l10 = (await req("POST", "/api/locations", {
    code: "UL" + s10, name: "Unreach Loc " + s10, external_id: "DIFFERENT" + s10,
    approval_status: "Approved", city: "Mau", tc_status: "Approved",
  }, 201)).data.item;
  await req("PUT", `/api/locations/${l10._id}/targets`, { program: p10._id, approved_target: 280, tc_id: TCA, tc_status: "Approved" }, 200);

  // (1) THE HEADLINE, and it is Umesh's bug in one row: TC Status was Approved and the sheet now
  // says blank. No `job_role` mapping, so `tc_status` is centre-level — the live configuration at
  // the moment the four rows vanished. Pre-fix `stored` is "" (loc is null), incoming is "", they
  // compare EQUAL and the run reports a clean OK with nothing created.
  const uA = await mkUpload(`TC ID,TC Status\n${TCA},\n`, "anchoronly.csv");
  const srcA = (await req("POST", "/api/sync-sources", {
    name: "Anchor only " + s10, source_url: new URL(uA.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "TC Status": "tc_status" },
  }, 201)).data.item;
  const rA = (await req("POST", `/api/sync-sources/${srcA._id}/run`, undefined, 200)).data;
  const chA = (await req("GET", `/api/sheet-changes?status=Open&limit=200`)).data;
  const listA = Array.isArray(chA) ? chA : (chA.items ?? chA.changes ?? chA.data ?? []);
  const hitA = listA.find((c) => String(c.field_name) === "tc_status" && String(c.location?._id ?? c.location) === String(l10._id));
  ok("QA-666: clearing a TC Status the ERP holds is DETECTED even when the sheet's TC ID is only on a target row - the four rows that silently agreed with a void",
    rA.created >= 1 && !!hitA && hitA.old_value === "Approved" && hitA.new_value === "",
    JSON.stringify({ created: rA.created, status: rA.status, found: !!hitA, old: hitA?.old_value, new: hitA?.new_value }));

  // (2) No centre at all -> the row is REFUSED and NAMED, the same standard the ambiguous-TC-ID
  // branch has held since QA-520. Pre-fix this row produced a SheetChange carrying `location: null`
  // - live held 74 of those, every one Ignored, and the dup check counts Ignored, so not one of
  // them can ever be raised again. An unactionable row is worse than a refused one.
  const uN = await mkUpload(`TC ID,TC Status\n${TCN},Approved\n`, "nocentre.csv");
  const srcN = (await req("POST", "/api/sync-sources", {
    name: "No centre " + s10, source_url: new URL(uN.url, BASE).href,
    field_mappings: { "TC ID": "external_id", "TC Status": "tc_status" },
  }, 201)).data.item;
  const rN = (await req("POST", `/api/sync-sources/${srcN._id}/run`, undefined, 200)).data;
  ok("QA-666: a TC ID NO centre carries makes the run Partial and names the id - it used to return a clean OK",
    rN.status === "Partial" && new RegExp(TCN).test(String(rN.error ?? "")) && /NO centre carries/i.test(String(rN.error ?? "")),
    JSON.stringify({ status: rN.status, created: rN.created, error: String(rN.error ?? "").slice(0, 180) }));

  const chN = (await req("GET", `/api/sheet-changes?limit=500`)).data;
  const listN = Array.isArray(chN) ? chN : (chN.items ?? chN.changes ?? chN.data ?? []);
  const orphans = listN.filter((c) => String(c.sync_source?._id ?? c.sync_source) === String(srcN._id) && !c.location);
  ok("QA-666: that row creates NO change belonging to no centre - the shape that produced 74 unactionable rows on live",
    rN.created === 0 && orphans.length === 0,
    JSON.stringify({ created: rN.created, orphans: orphans.length }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

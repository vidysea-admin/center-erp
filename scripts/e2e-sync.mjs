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
const xlsxMod = await import("file:///D:/erp/center-erp/node_modules/xlsx/xlsx.mjs");
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
  const td = new Date().toISOString().slice(0, 10);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

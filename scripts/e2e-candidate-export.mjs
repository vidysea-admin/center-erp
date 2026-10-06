// R8 + R1b + R1c (QA-2845 / QA-2846 / QA-2847) - the Candidates "Download Excel" door, the visible
// "N columns hidden · Reset" chip, and the Locations "Approval (centre)" column.
//
// Meeting 2026-10-06. Manish: "yahan pe ek download ka option ho ... naam, number, phone, email".
// Umesh: "it should be custom like jo jo column us table mai selected ho vo download ho jaayee".
// Sir: "column 3 hidden kyun aa raha hai?".
//
// ONE FILE, NOT AN EDIT OF e2e-rendered-candidates.mjs: a concurrent unit may hold that file; the
// nearest pattern is e2e-save-feedback.mjs (own file, own fixture, own browser).
//
// ARM NAMES carry the criterion (C1..C6) so a mutant reddens the arm it targets and the verdict can
// quote the line:
//   C1  the button downloads exactly the VISIBLE columns, in order, for every row the filters leave
//       (more rows than one page of the table)
//   C2  the picker offers the optional columns, hidden by default; Aadhaar / APAAR never offered or
//       exported
//   C3  the door: whitelist 400 (never silently dropped), auth, role, one shared column list
//   C4  a Location user scoped to centre A never receives centre B's candidates
//   C5  DataTable: a hidden column shows "N columns hidden · Reset"; Reset restores the defaults
//   C6  Locations: "Approval (centre)" is visible by default
import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ok as okLib, req, login, adminLogin, finish as finishLib, stamp, phone, BASE, ADMIN_PASSWORD } from "./e2e-lib.mjs";

// Every result is also kept here so a real-browser SMOKE can leave a report.json when
// CX_BROWSER_REPORT=<dir> is set (the maker's pre-push smoke; it is not validation).
const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, detail: String(x ?? "").replace(/\s+/g, " ").slice(0, 300) }); okLib(n, c, x); };
const pageErrors = [];
const finish = () => {
  const dir = process.env.CX_BROWSER_REPORT;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const failed = results.filter((r) => !r.pass).length;
      writeFileSync(path.join(dir, "report.json"), JSON.stringify({
        unit: "mtg-a1-candidate-export-and-hidden-cols", date: new Date().toISOString(), base: BASE, kind: "maker smoke, not validation",
        total: results.length, passed: results.length - failed, failed, uncaughtPageErrors: pageErrors.length, pageErrors: pageErrors.slice(0, 10), results,
      }, null, 2));
    } catch { /* the report is a convenience; the run's own exit code still decides */ }
  }
  finishLib();
};

let crashGuardBrowser = null;
const onFatal = async (e) => {
  ok("R8: the candidate-export journey ran to its end without an uncaught error", false,
    `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)} - every arm after this point did not run`);
  try { if (crashGuardBrowser) await crashGuardBrowser.close(); } catch { /* nothing left */ }
  finish();
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, "..", rel), "utf8");
const s = stamp("CX");
const admin = await adminLogin();

// ---- fixture: two centres, so scope can be tested; one programme -------------------------------------
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "CandExport Prog " + s, trainer_skill: "CXSkill" + s }, 201)).data.item;
const mkLoc = async (tag) => (await req(admin, "POST", "/api/locations", { code: tag + s, name: `TEST-CX ${tag} ${s}`, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const locA = await mkLoc("A");
const locB = await mkLoc("B");

// Aadhaar / APAAR values that must NEVER appear in any file. 234123412346 passes the Verhoeff check
// (e2e-blindspot.mjs uses it); the APAAR is the live example from the feature request.
const AADHAAR = "234123412346";
const APAAR = "190305516076";
const GOV_PROBES = [AADHAAR, APAAR];

// 30 candidates at A (more than one 25-row page of the table), 3 at B, 1 archived at A.
const candsA = [];
for (let i = 0; i < 30; i++) {
  const body = { name: `CXA N${String(i).padStart(2, "0")}X ${s}`, phone: phone("7" + String(i % 10)), location: locA._id, program: prog._id,
    email: `cxa${i}.${s.toLowerCase()}@example.test`, gender: i % 2 ? "Female" : "Male", father_name: `Father ${i} ${s}`, district: "Jaipur" };
  if (i === 0) { body.aadhaar_no = AADHAAR; body.apaar_id = APAAR; }
  const r = await req(admin, "POST", "/api/candidates", body);
  if (r.status !== 201) ok(`[precondition] candidate A${i} created`, false, JSON.stringify(r.data).slice(0, 160));
  else candsA.push(r.data.item);
}
const candsB = [];
for (let i = 0; i < 3; i++) {
  const r = await req(admin, "POST", "/api/candidates", { name: `CXB ${i} ${s}`, phone: phone("6" + i), location: locB._id, program: prog._id, email: `cxb${i}.${s.toLowerCase()}@example.test` });
  if (r.status === 201) candsB.push(r.data.item);
}
const archivedA = (await req(admin, "POST", "/api/candidates", { name: `CXA ARCHIVED ${s}`, phone: phone("55"), location: locA._id, program: prog._id }, 201)).data.item;
await req(admin, "POST", "/api/candidates/bulk-archive", { candidate_ids: [archivedA._id], reason: "CX fixture" });
ok("[precondition] fixture: 30 candidates at A, 3 at B, one archived at A", candsA.length === 30 && candsB.length === 3 && !!archivedA?._id,
  JSON.stringify({ a: candsA.length, b: candsB.length }));

// ---- personas ---------------------------------------------------------------------------------------
const PW = "CxPersona9!x";
const mkUser = async (role, scope, tag) => {
  const email = `zzcheck.cx${tag}.${s.toLowerCase()}@vidysea-test.local`;
  const r = await req(admin, "POST", "/api/users", { name: `ZZ CX ${tag}`, email, password: PW, role, location_scope: scope, can_edit: true });
  return { id: r.data?.item?._id, email, cookie: r.status === 201 ? await login(email, PW) : null, status: r.status };
};
const locUser = await mkUser("Location", [locA._id], "loc");
const opsUser = await mkUser("Operations", [], "ops");
const trUser = await mkUser("Trainer", [locA._id], "tr");
ok("[precondition] Location (scoped to A), Operations and Trainer personas can log in", !!(locUser.cookie && opsUser.cookie && trUser.cookie),
  JSON.stringify({ loc: locUser.status, ops: opsUser.status, tr: trUser.status }));

// ---- helpers ----------------------------------------------------------------------------------------
const xlsxOf = (buf) => {
  const wb = XLSX.read(buf, { type: "buffer" });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
  return { header: aoa[0] ?? [], rows: aoa.slice(1), all: JSON.stringify(aoa) };
};
const post = async (cookie, body) => {
  const res = await fetch(BASE + "/api/candidates/export", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const isX = (res.headers.get("content-type") ?? "").includes("spreadsheetml");
  let json = null;
  if (!isX) { try { json = JSON.parse(buf.toString("utf8")); } catch { /* not json */ } }
  return { status: res.status, ct: res.headers.get("content-type") ?? "", file: isX ? xlsxOf(buf) : null, json };
};
const get = async (cookie, qs) => {
  const res = await fetch(BASE + "/api/candidates/export" + qs, { headers: cookie ? { cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  const isX = (res.headers.get("content-type") ?? "").includes("spreadsheetml");
  let json = null;
  if (!isX) { try { json = JSON.parse(buf.toString("utf8")); } catch { /* not json */ } }
  return { status: res.status, file: isX ? xlsxOf(buf) : null, json };
};
const idsOf = (xs) => xs.map((c) => c._id);

// =================================================================================================
// C3 - the door
// =================================================================================================
const okRes = await post(admin, { cols: ["name", "phone"], ids: idsOf(candsA.slice(0, 3)) });
ok("C3: POST /api/candidates/export with valid cols answers 200 and an .xlsx", okRes.status === 200 && okRes.ct.includes("spreadsheetml"), `${okRes.status} ${okRes.ct}`);
const getRes = await get(admin, `?cols=name,phone&ids=${idsOf(candsA.slice(0, 2)).join(",")}`);
ok("C3: GET /api/candidates/export?cols=... answers 200 with the same shape", getRes.status === 200 && getRes.file?.rows.length === 2, JSON.stringify({ s: getRes.status, n: getRes.file?.rows.length }));

for (const bad of ["aadhaar_no", "apaar_id"]) {
  const r = await post(admin, { cols: ["name", bad] });
  ok(`C3: cols including "${bad}" is a 400 (never exported, never silently dropped)`, r.status === 400 && !r.file && String(r.json?.error ?? "").includes(bad), JSON.stringify({ s: r.status, e: r.json?.error }));
  const g = await get(admin, `?cols=name,${bad}`);
  ok(`C3: GET cols including "${bad}" is also a 400`, g.status === 400 && !g.file, String(g.status));
}
const unk = await post(admin, { cols: ["name", "password_hash"] });
ok("C3: an unknown column is a 400 that names it, not a file with the column missing", unk.status === 400 && !unk.file && String(unk.json?.error ?? "").includes("password_hash"), JSON.stringify({ s: unk.status, e: unk.json?.error }));
const none = await post(admin, { cols: [] });
ok("C3: no columns is a 400", none.status === 400 && !none.file, String(none.status));
const missing = await post(admin, {});
ok("C3: a body with no cols is a 400", missing.status === 400, String(missing.status));
const badIds = await post(admin, { cols: ["name"], ids: ["not-an-id"] });
ok("C3: a malformed id is a 400", badIds.status === 400 && !badIds.file, String(badIds.status));
const protoCol = await post(admin, { cols: ["name", "__proto__"] });
ok("C3: a __proto__ / wrong-case column is a 400", protoCol.status === 400 && !protoCol.file, String(protoCol.status));
const caseCol = await post(admin, { cols: ["Name"] });
ok("C3: a column key in the wrong case is a 400, not matched loosely", caseCol.status === 400 && !caseCol.file, String(caseCol.status));
const badLoc = await post(admin, { cols: ["name"], location: { $ne: null } });
ok("C3: a non-string location is a 400, not silently ignored", badLoc.status === 400 && !badLoc.file, String(badLoc.status));
const badBody = await fetch(BASE + "/api/candidates/export", { method: "POST", headers: { "content-type": "application/json", cookie: admin }, body: "{not json" });
ok("C3: an unparseable body is a 400 (readJson), not a 500", badBody.status === 400, String(badBody.status));
const anon = await fetch(BASE + "/api/candidates/export?cols=name");
ok("C3: no session answers 401", anon.status === 401, String(anon.status));
const trRes = await post(trUser.cookie, { cols: ["name"] });
ok("C3: a Trainer is refused 403 (candidates.manage, the same gate as export-sidh)", trRes.status === 403 && !trRes.file, String(trRes.status));

// ---- the column list is ONE list: the page and the route both read lib/candidate-columns.ts ----------
const colsSrc = src("src/lib/candidate-columns.ts");
const pageSrc = src("src/app/(app)/candidates/page.tsx");
const routeSrc = src("src/app/api/candidates/export/route.ts");
ok("C3: the Candidates page builds its table from lib/candidate-columns", /from "@\/lib\/candidate-columns"/.test(pageSrc) && /CANDIDATE_COLUMNS/.test(pageSrc));
ok("C3: the export route validates against lib/candidate-columns and carries no column list of its own",
  /from "@\/lib\/candidate-columns"/.test(routeSrc) && /resolveExportCols/.test(routeSrc) && !/label:\s*"/.test(routeSrc));
const defKeys = [...colsSrc.matchAll(/\{ key: "([a-z_]+)", label:/g)].map((m) => m[1]);
ok("C3: the shared list has the nine table columns and the optional ones (sanity: parsed " + defKeys.length + " keys)", defKeys.length === 17 && defKeys.includes("email") && defKeys.includes("name"), defKeys.join(","));

// =================================================================================================
// C2 - optional columns offered; Aadhaar / APAAR never
// =================================================================================================
ok("C2: no key in the shared column list is a government number (aadhaar / apaar)", !defKeys.some((k) => /aadhaar|apaar/i.test(k)), defKeys.join(","));
const allOptional = ["email", "alt_phone", "gender", "dob", "father_name", "district", "education", "sidh_candidate_id"];
ok("C2: the shared list offers every optional column Manish asked for (email, alt phone, gender, DOB, father name, district, education, SIDH id)",
  allOptional.every((k) => defKeys.includes(k)), allOptional.filter((k) => !defKeys.includes(k)).join(","));
const full = await post(admin, { cols: defKeys, ids: idsOf(candsA.slice(0, 1)) });
ok("C2: every offered column exports", full.status === 200 && full.file?.header.length === defKeys.length, JSON.stringify({ s: full.status, h: full.file?.header }));
ok("C2: the file for the candidate who HAS an Aadhaar and an APAAR carries neither number, in any column",
  full.status === 200 && GOV_PROBES.every((n) => !full.file.all.includes(n)), full.file?.all?.slice(0, 300));
ok("C2: the optional columns carry the record's values (email, gender, father's name, district)",
  full.status === 200 && full.file.rows[0].join("|").includes("cxa0.") && full.file.rows[0].join("|").includes("Father 0") && full.file.rows[0].includes("Jaipur"), JSON.stringify(full.file?.rows?.[0]));

// =================================================================================================
// C1 (server half) - the columns asked for, in the order asked for, for the rows asked for
// =================================================================================================
const pick = candsA.slice(0, 7).reverse(); // a deliberate non-default order
const ordered = await post(admin, { cols: ["email", "name", "phone"], ids: idsOf(pick) });
ok("C1: header is exactly the requested columns in the requested order (Email, Name, Phone)",
  ordered.status === 200 && JSON.stringify(ordered.file.header) === JSON.stringify(["Email", "Name", "Phone"]), JSON.stringify(ordered.file?.header));
ok("C1: only the requested rows come back (7 ids -> 7 rows), not the whole pool", ordered.file?.rows.length === 7, String(ordered.file?.rows.length));
ok("C1: rows keep the order the table showed them in", ordered.file && JSON.stringify(ordered.file.rows.map((r) => r[1])) === JSON.stringify(pick.map((c) => c.name)), JSON.stringify(ordered.file?.rows.map((r) => r[1])));
const noIds = await post(admin, { cols: ["name"], location: locA._id });
ok("C1: with no ids it is every non-archived candidate at that location (30), the archived one excluded",
  noIds.status === 200 && noIds.file.rows.length === 30 && !noIds.file.all.includes("ARCHIVED"), String(noIds.file?.rows.length));
const arch = await post(admin, { cols: ["name"], ids: [archivedA._id] });
ok("C1: an archived candidate never leaves in a file, even when its id is asked for by name", arch.status === 200 && arch.file.rows.length === 0, String(arch.file?.rows.length));
const stage = await post(admin, { cols: ["name", "lifecycle_status", "eligibility", "sidh_status", "location", "program", "source"], ids: idsOf(candsA.slice(0, 1)) });
ok("C1: the derived columns print the words the screen shows (Stage, Eligible, SIDH, Location, Program, Source)",
  stage.status === 200 && stage.file.rows[0][1] === "Fresh Lead" && stage.file.rows[0][3] === "Not Registered" && stage.file.rows[0][4].includes(`CX A ${s}`) && stage.file.rows[0][5].includes("CandExport"),
  JSON.stringify(stage.file?.rows?.[0]));

// =================================================================================================
// C4 - tenancy: a Location user scoped to centre A never receives centre B's candidates
// =================================================================================================
const mixedIds = idsOf([...candsA.slice(0, 2), ...candsB]);
const scoped = await post(locUser.cookie, { cols: ["name", "location"], ids: mixedIds });
ok("C4: a Location user scoped to A, asking for A's and B's ids, gets A's rows only (2), none of B's",
  scoped.status === 200 && scoped.file.rows.length === 2 && !scoped.file.all.includes("CXB"), JSON.stringify({ s: scoped.status, n: scoped.file?.rows.length }));
const scopedAll = await post(locUser.cookie, { cols: ["name"] });
ok("C4: with no ids, the scoped user's file is centre A only (30 candidates, no CXB, no archived)",
  scopedAll.status === 200 && scopedAll.file.rows.length === 30 && !scopedAll.file.all.includes("CXB") && !scopedAll.file.all.includes("ARCHIVED"), JSON.stringify({ s: scopedAll.status, n: scopedAll.file?.rows.length }));
const scopedB = await post(locUser.cookie, { cols: ["name"], location: locB._id });
ok("C4: asking for centre B by ?location is 403 and returns no file (assertLocationInScope)", scopedB.status === 403 && !scopedB.file, String(scopedB.status));
const scopedBGet = await get(locUser.cookie, `?cols=name&location=${locB._id}`);
ok("C4: the same on the GET door", scopedBGet.status === 403 && !scopedBGet.file, String(scopedBGet.status));
const scopedGet = await get(locUser.cookie, `?cols=name&ids=${candsB.map((c) => c._id).join(",")}`);
ok("C4: GET with only B's ids returns an empty file for the scoped user (no row, no error leak)", scopedGet.status === 200 && scopedGet.file.rows.length === 0, JSON.stringify({ s: scopedGet.status, n: scopedGet.file?.rows.length }));
const opsAll = await post(opsUser.cookie, { cols: ["name"], ids: mixedIds });
ok("C4: an Operations user (not scoped) gets every requested row, A and B (5)", opsAll.status === 200 && opsAll.file.rows.length === 5, JSON.stringify({ s: opsAll.status, n: opsAll.file?.rows.length }));

// =================================================================================================
// Browser: C1 (button), C2 (picker), C5 (chip), C6 (Locations)
// =================================================================================================
let browser;
try { browser = await chromium.launch({ headless: true }); crashGuardBrowser = browser; }
catch (e) { ok("[precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200)); finish(); }

const newPage = async (email, password) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => { errors.push(String(e.message).slice(0, 160)); pageErrors.push(String(e.message).slice(0, 160)); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
  if (await emailBox.count()) {
    await emailBox.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
    await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
  }
  page.setDefaultTimeout(20000);
  return { ctx, page, errors };
};
const arm = async (name, page, fn) => {
  try { await fn(); }
  catch (e) { ok(`${name} [arm ran to its end]`, false, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 260)); }
};
const PICK = '[title="Choose which columns are visible"]';
const openPicker = async (page) => {
  await page.locator(PICK).first().click();
  await page.locator("[data-dt-pop]").filter({ hasText: "Visible columns" }).first().waitFor();
};
const closePicker = async (page) => { await page.mouse.click(5, 5); await page.waitForTimeout(150); };
const pickerLabels = async (page) => page.locator("[data-dt-pop]").filter({ hasText: "Visible columns" }).first().locator("label span").allInnerTexts();
const setPick = async (page, label, on) => {
  const row = page.locator("[data-dt-pop]").filter({ hasText: "Visible columns" }).first().locator("label").filter({ has: page.locator(`span:text-is("${label}")`) }).first();
  const box = row.locator('input[type="checkbox"]');
  if ((await box.isChecked()) !== on) await box.click();
};
const headers = async (page) => (await page.locator("table thead th").allInnerTexts()).map((t) => t.replace(/[▲▼↕⏷]/g, "").trim()).filter(Boolean);
const settle = async (page, text) => {
  await page.locator("table tbody tr").first().waitFor();
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 30000 }).catch(() => {});
};

const ui = await newPage("admin@vidysea.com", ADMIN_PASSWORD);
ok("[precondition] the browser is logged in as Admin", !/login/i.test(ui.page.url()), ui.page.url());

await arm("C2/C5/C1 candidates page", ui.page, async () => {
  const page = ui.page;
  // "CXA <stamp>": every token must hit, and only centre A's rows (30) carry "cxa" - centre B's three do not.
  await page.goto(`${BASE}/candidates?q=${encodeURIComponent("CXA " + s)}`, { waitUntil: "domcontentloaded" });
  await settle(page, `CXA N00X ${s}`);
  const h0 = await headers(page);
  ok("C2: Email, Alt phone, Gender, Date of birth, Father's name, District, Education and SIDH candidate ID are NOT columns by default",
    ["Email", "Alt phone", "Gender", "Date of birth", "Father's name", "District", "Education", "SIDH candidate ID"].every((l) => !h0.includes(l)), h0.join(" | "));
  await openPicker(page);
  const labels = await pickerLabels(page);
  const want = ["Email", "Alt phone", "Gender", "Date of birth", "Father's name", "District", "Education", "SIDH candidate ID"];
  ok("C2: the Columns picker OFFERS all eight optional columns", want.every((l) => labels.includes(l)), labels.join(" | "));
  ok("C2: the picker never offers Aadhaar or APAAR", !labels.some((l) => /aadhaar|apaar/i.test(l)), labels.join(" | "));

  // Hide Phone, show Email: the file must follow the TABLE, not a fixed list.
  await setPick(page, "Phone", false);
  await setPick(page, "Email", true);
  await closePicker(page);
  const h1 = await headers(page);
  ok("C1 [setup]: the table now shows Email and no longer shows Phone", h1.includes("Email") && !h1.includes("Phone"), h1.join(" | "));
  const rowsOnScreen = await page.locator("table tbody tr").count();
  ok("C1 [setup]: the table pages - 25 rows on screen of 30 matching, so 'every matching row' is not 'the rows on screen'", rowsOnScreen === 25, String(rowsOnScreen));

  const btn = page.locator("[data-dt-export]").first();
  ok("C1: a Download Excel button is on the Candidates toolbar", (await btn.count()) === 1 && /Download Excel/.test(await btn.innerText()));
  const [dl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  const file = xlsxOf(readFileSync(await dl.path()));
  const expectHeader = h1.filter((t) => ["Name", "Location", "Batch", "Program", "Stage", "Journey status", "Eligible", "SIDH", "Source", "Email"].includes(t));
  ok("C1: the downloaded header is exactly the visible data columns - Email in, Phone out - in the table's order",
    file.header.includes("Email") && !file.header.includes("Phone") && file.header[0] === "Name" && file.header.indexOf("Email") === file.header.length - 1 && file.header.length === expectHeader.length,
    JSON.stringify({ file: file.header, screen: h1 }));
  ok("C1: it carries every row the search left (30 candidates), not the 25 the page shows", file.rows.length === 30, String(file.rows.length));
  ok("C1: filename is a candidates .xlsx", /^candidates-.*\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  ok("C2: the browser's file carries no Aadhaar or APAAR number", GOV_PROBES.every((n) => !file.all.includes(n)));

  // Narrow with the table's own search: the file narrows with it.
  const search = page.getByPlaceholder("Search all columns…");
  await search.fill(`CXA N07X ${s}`);
  await page.waitForTimeout(400);
  const [dl2] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  const f2 = xlsxOf(readFileSync(await dl2.path()));
  ok("C1: after searching the table down to one row, the file is that one row", f2.rows.length === 1 && f2.rows[0].includes(`CXA N07X ${s}`), JSON.stringify(f2.rows));
  await search.fill("");

  // ---- C5 on the same table ----
  const chip = page.locator("[data-dt-hidden-chip]");
  ok("C5: with Phone hidden, a visible chip says '1 column hidden · Reset' beside the table", (await chip.count()) === 1 && /1 column hidden\s*·\s*Reset/.test((await chip.innerText()).replace(/\s+/g, " ")), await chip.allInnerTexts().then((t) => t.join("|")));
  await page.locator("[data-dt-hidden-reset]").click();
  await page.waitForTimeout(250);
  const h2 = await headers(page);
  ok("C5: Reset restores the defaults - Phone is back, Email is gone, the chip is gone", h2.includes("Phone") && !h2.includes("Email") && (await chip.count()) === 0, h2.join(" | "));
  // Picking an OPTIONAL column on is not "hiding" one - no chip.
  await openPicker(page); await setPick(page, "District", true); await closePicker(page);
  ok("C5: showing an optional column does not raise the chip (nothing was hidden)", (await chip.count()) === 0);
  await openPicker(page); await setPick(page, "Phone", false); await setPick(page, "Source", false); await closePicker(page);
  ok("C5: two hidden columns read '2 columns hidden'", /2 columns hidden/.test((await chip.innerText()).replace(/\s+/g, " ")), await chip.allInnerTexts().then((t) => t.join("|")));
  await page.locator("[data-dt-hidden-reset]").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page, `CXA N00X ${s}`);
  ok("C5: Reset persisted (no chip after a reload)", (await page.locator("[data-dt-hidden-chip]").count()) === 0);
  // Archived bucket: no download button (archived rows never leave in a file).
  await page.getByText(/Archived Candidates/).first().click();
  await page.waitForTimeout(400);
  ok("C1: the Archived tab has no Download Excel button (archived rows are never exported)", (await page.locator("[data-dt-export]").count()) === 0);
});

await arm("C6 locations page", ui.page, async () => {
  const page = ui.page;
  await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("dt-cols:")).forEach((k) => localStorage.removeItem(k)); } catch {} });
  await page.goto(`${BASE}/locations`, { waitUntil: "domcontentloaded" });
  await page.locator("table thead th").first().waitFor();
  await page.waitForTimeout(800);
  const h = await headers(page);
  ok("C6: the Locations table shows 'Approval (centre)' by default (fresh browser storage)", h.some((t) => /^Approval \(centre\)/.test(t)), h.join(" | "));
  // C5 on a second table: every DataTable carries the chip.
  await openPicker(page);
  await setPick(page, "Approval (centre)", false);
  await closePicker(page);
  const chip = page.locator("[data-dt-hidden-chip]");
  ok("C5: the chip appears on the Locations table too (it is DataTable-wide)", (await chip.count()) === 1 && /1 column hidden/.test(await chip.innerText()), await chip.allInnerTexts().then((t) => t.join("|")));
  await page.locator("[data-dt-hidden-reset]").click();
  await page.waitForTimeout(250);
  ok("C6: Reset brings 'Approval (centre)' back", (await headers(page)).some((t) => /^Approval \(centre\)/.test(t)));
});

await arm("C5 reports rollup", ui.page, async () => {
  const page = ui.page;
  await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
  const pick = page.locator(PICK).first();
  await pick.waitFor({ timeout: 30000 });
  await pick.click();
  const pop = page.locator("[data-dt-pop]").filter({ hasText: "Visible columns" }).first();
  await pop.waitFor();
  const first = pop.locator('label input[type="checkbox"]').first();
  await first.click(); // hide the first entry in the report's own picker
  await closePicker(page);
  const chip = page.locator("[data-dt-hidden-chip]").first();
  ok("C5: the reports rollup table shows the chip after a column is hidden (every DataTable, reports-rollup included)", (await chip.count()) === 1 && /columns? hidden/.test(await chip.innerText()), await page.locator("[data-dt-hidden-chip]").allInnerTexts().then((t) => t.join("|")));
  await page.locator("[data-dt-hidden-reset]").first().click();
  await page.waitForTimeout(250);
  ok("C5: Reset clears the chip on the reports table", (await page.locator("[data-dt-hidden-chip]").count()) === 0);
});

await arm("persona Location (scoped) in the browser", ui.page, async () => {
  const lu = await newPage(locUser.email, PW);
  try {
    const page = lu.page;
    await page.goto(`${BASE}/candidates?q=${encodeURIComponent(s)}`, { waitUntil: "domcontentloaded" });
    await settle(page, `CXA N00X ${s}`);
    const onScreen = await page.locator("table tbody").innerText();
    ok("C4 [persona Location]: the scoped user's table shows centre A only (no CXB row)", onScreen.includes("CXA") && !onScreen.includes("CXB"), onScreen.slice(0, 120));
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("[data-dt-export]").first().click()]);
    const f = xlsxOf(readFileSync(await dl.path()));
    ok("C4 [persona Location]: the file they download has 30 rows, none from centre B", f.rows.length === 30 && !f.all.includes("CXB"), JSON.stringify({ n: f.rows.length }));
  } finally { await lu.ctx.close(); }
});
await arm("persona Operations in the browser", ui.page, async () => {
  const ou = await newPage(opsUser.email, PW);
  try {
    const page = ou.page;
    await page.goto(`${BASE}/candidates?q=${encodeURIComponent(s)}`, { waitUntil: "domcontentloaded" });
    await settle(page, `CXA N00X ${s}`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("[data-dt-export]").first().click()]);
    const f = xlsxOf(readFileSync(await dl.path()));
    ok("C1 [persona Operations]: an unscoped user's file carries both centres (30 A + 3 B = 33)", f.rows.length === 33 && f.all.includes("CXB"), JSON.stringify({ n: f.rows.length }));
  } finally { await ou.ctx.close(); }
});

ok("browser: no uncaught page error on any screen driven here", ui.errors.length === 0, ui.errors.slice(0, 3).join(" | "));
await browser.close();

// ---- cleanup: the throwaway personas -----------------------------------------------------------------
for (const u of [locUser, opsUser, trUser]) if (u.id) await req(admin, "PATCH", `/api/users/${u.id}`, { active: false });
finish();

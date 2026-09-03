// RENDERED-STATE suite (QA-573). The first suite in this wall that asserts what the SCREEN does
// rather than what a source file spells.
//
// WHY IT EXISTS. QA-1145 shipped live: a summary card opened a list that announced a count and
// rendered zero rows under "No candidates - add or import." - advice to re-create people the centre
// already had. It was found by a person opening the app, never by this wall. Five static pins in
// scripts/check-user-copy.mjs then failed to guard it (QA-1091 -> QA-1127 -> QA-1141 -> QA-1184 ->
// QA-1214), each tightening buying exactly one new hole and one new false red.
//
// CYCLE 2 - the cycle-1 checker broke this suite in two places and both fixes are here:
//   QA-1245  an EMPTY database scored 47/0, the same scoreboard as a seeded run, because the
//            "at least one URL announced > 0" precondition was GLOBAL: the Fresh side satisfied it
//            while the ENROLLED arm - the bucket QA-1145 actually lived in - tested nothing. With
//            the bug reverted on that empty DB it caught 2 failures instead of 8. Fixed two ways:
//            the fixture now builds its own ENROLLED candidate instead of leaning on seed:sample,
//            and the preconditions are PER BUCKET.
//   QA-1243  the active-tab and active-pill detectors keyed on Tailwind classes. A pure restyle of
//            src/components/ui.tsx made the tab detector dead on 17 of 17 URLs and the suite stayed
//            GREEN, noticing nothing. Fixed in the PRODUCT, where it belonged: Tabs() now sets
//            `aria-current` and FilterPills() sets `aria-pressed`, so the selected state is a fact
//            a test, a screen reader and the next restyle all read from the same place. This suite
//            now reads those, and asserts the detector actually detected something.
//   QA-1248  seventeen fixed 6-second sleeps meant a slow runner produced `announced>0, rows=0` -
//            the live defect's own signature - which is how a suite gets called flaky and disabled.
//            Replaced with waitForFunction on the list having actually settled.
//
// SCOPE, stated honestly. QA-573's own `expected` asks for a test that can "open a <details>, close
// it, and read what is visible". That is the /reports block below. REQ-367b - "the warnings stay
// outside the card" - is HALF pinned here: the caveat is always rendered (rules.ts:3748 always sets
// it) so it is asserted hard; the QA-552 "unrecognised status" line only appears when sheet data
// carries an unknown status and needs a fixture this unit does not build. That gap is named in the
// manifest rather than papered over.
import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ok, req, adminLogin, finish, stamp, phone, today, BASE, ADMIN_PASSWORD } from "./e2e-lib.mjs";

const JOURNEY_TAGS = ["Enrollment in progress", "Training Ongoing", "Training Completed", "Result Awaited",
  "Certified", "Dropout", "Failed", "Absent at Assessment"];
const STORED = ["Assigned", "Enrolled", "Completed", "Failed"];
const CONTROLS = ["Dropped", "Fresh Lead", "NotARealValue"];

const s = stamp("RC");
const admin = await adminLogin();

// ---- fixture: this suite owns BOTH buckets. QA-1245: leaning on seed:sample for the Enrolled side
// ---- is what let an empty database score a clean green.
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "RenderedCand Prog " + s, trainer_skill: "RCSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-Rendered Loc " + s, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "CR1", type: "Classroom" }, 201)).data.item;
const trainer = (await req(admin, "POST", "/api/trainers", { name: "TEST-RC Trainer " + s, phone: phone("9"), skills: ["RCSkill" + s] }, 201)).data.item;

const fresh = [];
for (let i = 0; i < 3; i++) {
  fresh.push((await req(admin, "POST", "/api/candidates", { name: `TEST-RC Fresh ${i} ${s}`, phone: phone("7" + i), location: loc._id, program: prog._id }, 201)).data.item);
}
// ...and one walked all the way onto an ACTIVE batch, so the Enrolled bucket has this suite's own row.
const batch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today(), target_size: 1 }, 201)).data.item;  // target_size 1: the Ready gate needs 80% of the roster filled (roster_80pct), and this fixture puts exactly ONE candidate on the batch. At 5 it refused with 409 and the Enrolled arm never existed - which is the same hole QA-1245 named, arriving a second way.
const enrolledCand = (await req(admin, "POST", "/api/candidates", { name: `TEST-RC Enrolled ${s}`, phone: phone("88"), location: loc._id, program: prog._id }, 201)).data.item;
const mem = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: enrolledCand._id }, 201)).data.item;
await req(admin, "PATCH", `/api/members/${mem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (e) {
  // Not a skip. A missing browser means this suite verified NOTHING, and it says so in red.
  ok("[precondition] chromium launches from the `playwright` devDependency", false,
    String(e.message).slice(0, 200) + " -- run `npx playwright install chromium` (CI does this in its own step)");
  finish();
}
const ctx = await browser.newContext({ viewport: { width: 1536, height: 900 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
if (await emailBox.count()) {
  await emailBox.fill("admin@vidysea.com");
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
  await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
}
ok("[precondition] the browser is logged in (not sitting on the login screen)", !/login/i.test(page.url()), page.url());

// QA-1248: wait for the list to have SETTLED, not for a stopwatch. The page fetches limit=2000
// client-side; a fixed sleep on a slow runner produces "announced>0, rows=0" - which is the live
// defect's own signature, and the fastest way to get a real suite dismissed as flaky.
async function settled() {
  await page.waitForFunction(() => {
    const tabbed = /(Fresh|Enrolled) Candidates \(\d+\)/.test(document.body.innerText);
    const hasRow = !!document.querySelector("table tbody tr");
    const empty = /No candidates/i.test(document.body.innerText);
    return tabbed && (hasRow || empty);
  }, undefined, { timeout: 45000 });
}

async function probe(qs, kind) {
  await page.goto(`${BASE}/candidates${qs}`, { waitUntil: "domcontentloaded" });
  let timedOut = false;
  await settled().catch(() => { timedOut = true; });
  const r = await page.evaluate(() => {
    // QA-1243: read the product's OWN accessible state, not our guess at its colours.
    const activeTabEl = document.querySelector('button[aria-current="page"]');
    const pills = [...document.querySelectorAll('button[aria-pressed="true"]')]
      .map((b) => b.innerText.replace(/\s+/g, " ").trim());
    const rows = [...document.querySelectorAll("table")].reduce((a, t) => a + t.querySelectorAll("tbody tr").length, 0);
    const txt = document.body.innerText;
    return {
      activeTab: activeTabEl ? activeTabEl.innerText.replace(/\s+/g, " ").trim() : "(none detected)",
      tabsSeen: [...txt.matchAll(/(Fresh|Enrolled) Candidates \(\d+\)/g)].length,
      activePills: pills,
      rows,
      emptyState: /No candidates/i.test(txt) ? (txt.match(/No candidates[^\n]*/) || [""])[0] : "",
    };
  });
  const pillCount = r.activePills.length ? Number((r.activePills[0].match(/(\d+)\s*$/) || [0, "0"])[1]) : null;
  const tabCount = Number((r.activeTab.match(/\((\d+)\)/) || [0, "0"])[1]);
  const bucket = /^Enrolled/.test(r.activeTab) ? "Enrolled" : /^Fresh/.test(r.activeTab) ? "Fresh" : "(unknown)";
  return { qs, kind, ...r, announced: pillCount === null ? tabCount : pillCount, bucket, timedOut };
}

const results = [];
for (const v of STORED) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "STORED"));
for (const v of JOURNEY_TAGS) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "JOURNEY_TAG"));
for (const v of CONTROLS) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "CONTROL"));
results.push(await probe("?program=null", "CONTROL"));
results.push(await probe("", "CONTROL"));

// ================= THE ANTI-VACUOUS PRECONDITIONS =================
// Each one of these, alone, can make every assertion below pass for the wrong reason. QA-1245 is
// the proof that this is not theoretical: an empty database scored the identical 47/0.
ok("[precondition] no probed URL timed out waiting for the list to settle (a timeout looks exactly like the defect)",
  results.every((r) => !r.timedOut), JSON.stringify(results.filter((r) => r.timedOut).map((r) => r.qs)));
ok("[precondition] the ACTIVE TAB was detected on every URL (QA-1243: a dead detector is silent, not red)",
  results.every((r) => r.activeTab !== "(none detected)"), JSON.stringify(results.filter((r) => r.activeTab === "(none detected)").map((r) => r.qs)));
for (const b of ["Fresh", "Enrolled"]) {
  const inBucket = results.filter((r) => r.bucket === b);
  ok(`[precondition] the ${b} bucket was actually reached by at least one URL`, inBucket.length > 0,
    JSON.stringify(results.map((r) => `${r.qs}->${r.bucket}`)));
  ok(`[precondition] the ${b} bucket ANNOUNCED a count above zero (QA-1245: a global check let the empty Enrolled arm pass)`,
    inBucket.some((r) => r.announced > 0), JSON.stringify(inBucket.map((r) => `${r.qs}=${r.announced}`)));
  ok(`[precondition] the ${b} bucket actually RENDERED rows`,
    inBucket.some((r) => r.rows > 0), JSON.stringify(inBucket.map((r) => `${r.qs}=${r.rows}`)));
}
const seen = (await req(admin, "GET", `/api/candidates?limit=2000`, undefined, 200)).data.items.filter((c) => String(c.name || "").includes(s));
ok("[precondition] this suite's own fixture candidates exist (3 Fresh + 1 Enrolled)", seen.length === fresh.length + 1, `found ${seen.length}`);

// ================= THE INVARIANT =================
for (const r of results) {
  const value = decodeURIComponent((r.qs.split("=")[1] || "(no filter)"));
  const lies = r.announced > 0 && r.rows === 0;
  ok(`[${r.kind}] ${r.qs || "(no filter)"} -> the screen renders rows for the ${r.announced} it announces`,
    !lies, `announced=${r.announced} rows=${r.rows} bucket=${r.bucket} activeTab="${r.activeTab}" pill=${JSON.stringify(r.activePills[0] || null)} empty="${r.emptyState}"`);
  ok(`[${r.kind}] ${r.qs || "(no filter)"} -> does not tell a centre with candidates to "add or import"`,
    !(r.announced > 0 && /add or import/i.test(r.emptyState)), `announced=${r.announced} empty="${r.emptyState}" value="${value}"`);
  if (lies) await page.screenshot({ path: `D:/erp/evidence-24-08/qa-573/${s}${r.qs.replace(/[^a-z0-9]/gi, "-")}.png` }).catch(() => {});
}

// ================= QA-1817: archiving stops being invisible =================
// Umesh tested the shipped Archive feature live and reported it looked like nothing happened
// ("naa hi users archive ho rhe hai"). Root cause: an archived row fell back into whichever of
// Fresh/Enrolled it already belonged to and rendered identically - no badge, no exclusion, and the
// row action still read "Delete" even though QA-1792/QA-1800 made it archive, not erase. Prove the
// real fix from the real browser, on this suite's own fixture candidate, not just via the API.
await page.goto(`${BASE}/candidates`, { waitUntil: "domcontentloaded" });
await settled();
// QA-1245's own lesson, applied to this pin: seed-sample puts 180 Fresh rows ahead of this suite's
// own fixture, the table pages at 25, and default sort is alphabetical - this suite's own candidate
// is not guaranteed to be ON that first page. Use the table's own search box (DataTable, ui.tsx:594,
// "Search all columns...") to surface it, rather than trusting page 1 to contain it - a locator that
// silently finds nothing must not be allowed to make every assertion below vacuously true.
//
// QA-1817 cycle 2 (checker FAIL, cycle 1): the search box is itself conditional - DataTable only
// renders it above 10 rows (ui.tsx:588, `searchable ?? rows.length > 10`), which candidates/page.tsx
// never overrides. The Fresh/Enrolled tabs clear that bar easily; a freshly-archived Archived tab
// does not - it has exactly 1 row, the box never renders, and `.fill()` on a locator matching zero
// elements timed out and crashed the whole suite. Fixed by using the box ONLY when it is present;
// with 10 or fewer rows every row is already on the page, so no search is needed to find one.
async function findRow(name) {
  const box = page.locator('input[placeholder="Search all columns…"]').first();
  if (await box.count()) { await box.fill(name); await page.waitForTimeout(400); }
  return page.locator(`table tbody tr:has-text("${name}")`);
}
await findRow(fresh[0].name);
const preFreshCount = await page.evaluate(() => {
  const m = document.body.innerText.match(/Fresh Candidates \((\d+)\)/);
  return m ? Number(m[1]) : null;
});
const archiveBtn = page.locator(`table tbody tr:has-text("${fresh[0].name}") button:has-text("Archive")`).first();
const archiveBtnVisible = (await archiveBtn.count()) > 0;
ok("[QA-1817] the row action now reads Archive, not the stale Delete label", archiveBtnVisible, `found=${archiveBtnVisible}`);
if (archiveBtnVisible) {
  page.once("dialog", (d) => d.accept("QA-1817 rendered-suite archive"));
  await archiveBtn.click();
  await page.waitForTimeout(1500);
} else {
  await page.screenshot({ path: `D:/erp/evidence-24-08/qa-1817/${s}-search-not-found.png` }).catch(() => {});
}
await page.reload({ waitUntil: "domcontentloaded" });
await settled();
await findRow(fresh[0].name);
const postFreshCount = await page.evaluate(() => {
  const m = document.body.innerText.match(/Fresh Candidates \((\d+)\)/);
  return m ? Number(m[1]) : null;
});
const stillInFresh = await page.locator(`table tbody tr:has-text("${fresh[0].name}")`).count();
ok("[QA-1817] the archived candidate is no longer a row under Fresh (used to stay, indistinguishable from a no-op)",
  stillInFresh === 0, `stillInFresh=${stillInFresh} preFreshTotal=${preFreshCount} postFreshTotal=${postFreshCount}`);
const archivedTabBtn = page.locator('button:has-text("Archived Candidates")').first();
ok("[QA-1817] the Archived tab exists at all", (await archivedTabBtn.count()) > 0, "");
await archivedTabBtn.click();
await page.waitForTimeout(500);
await findRow(fresh[0].name);
const archivedRowVisible = await page.locator(`table tbody tr:has-text("${fresh[0].name}")`).count();
ok("[QA-1817] the archived candidate is actually visible under its own Archived tab, not just uncounted elsewhere",
  archivedRowVisible > 0, `rows=${archivedRowVisible}`);
const archivedRowReason = archivedRowVisible > 0
  ? await page.locator(`table tbody tr:has-text("${fresh[0].name}")`).first().innerText() : "";
ok("[QA-1817] the archived row shows the reason typed into the confirm dialog, not just a bare status",
  /QA-1817 rendered-suite archive/.test(archivedRowReason), archivedRowReason.slice(0, 200));

// ================= candidates-bulk-archive-restore-ux =================
// Umesh's next-round feedback after testing -288 himself: bulk archive/restore, frozen columns
// (lose track of WHICH candidate while scrolling sideways), and a highlight on selected rows.

// -- Restore (single row) --
if (archivedRowVisible > 0) {
  const restoreBtn = page.locator(`table tbody tr:has-text("${fresh[0].name}") button:has-text("Restore")`).first();
  const restoreBtnVisible = (await restoreBtn.count()) > 0;
  ok("[bulk-archive-restore-ux] the archived row offers Restore, not a dead end",
    restoreBtnVisible, `found=${restoreBtnVisible}`);
  if (restoreBtnVisible) {
    await restoreBtn.click();
    await page.waitForTimeout(1000);
    // `bucket` is plain React state, not a URL param - a reload always lands back on the
    // page's default tab (Fresh), never wherever the user last clicked. So the Archived-tab
    // absence has to be checked by explicitly RETURNING to that tab, not assumed from a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await settled();
    const archivedTabAgain = page.locator('button:has-text("Archived Candidates")').first();
    await archivedTabAgain.click();
    await page.waitForTimeout(500);
    await findRow(fresh[0].name);
    const backInFresh = await page.locator(`table tbody tr:has-text("${fresh[0].name}")`).count();
    ok("[bulk-archive-restore-ux] restoring moves the candidate back OFF the Archived tab",
      backInFresh === 0, `stillOnArchivedTab=${backInFresh}`);
    // switch to Fresh and confirm it actually reappears there, not just vanished from Archived
    const freshTabBtn = page.locator('button:has-text("Fresh Candidates")').first();
    await freshTabBtn.click();
    await page.waitForTimeout(500);
    await findRow(fresh[0].name);
    const backInFreshTab = await page.locator(`table tbody tr:has-text("${fresh[0].name}")`).count();
    ok("[bulk-archive-restore-ux] ...and it is genuinely back in Fresh, not merely gone from Archived",
      backInFreshTab > 0, `rows=${backInFreshTab}`);
  }
}

// -- Frozen columns: the Name cell's on-screen X position must not move when the body scrolls --
await page.goto(`${BASE}/candidates`, { waitUntil: "domcontentloaded" });
await settled();
const nameCellBefore = await page.evaluate(() => {
  const cell = document.querySelector("table tbody tr td:nth-child(2)");
  return cell ? cell.getBoundingClientRect().left : null;
});
const scrolled = await page.evaluate(() => {
  const scroller = [...document.querySelectorAll("div")].find((d) => d.scrollWidth > d.clientWidth + 20 && d.querySelector("table"));
  if (!scroller) return false;
  scroller.scrollLeft = 400;
  return scroller.scrollLeft > 0;
});
const nameCellAfter = await page.evaluate(() => {
  const cell = document.querySelector("table tbody tr td:nth-child(2)");
  return cell ? cell.getBoundingClientRect().left : null;
});
ok("[bulk-archive-restore-ux] [precondition] the table body actually scrolled sideways (else the freeze assertion below is vacuous)",
  scrolled === true, `scrolled=${scrolled}`);
ok("[bulk-archive-restore-ux] the Name column stays frozen in place while the table scrolls sideways",
  scrolled === true && nameCellBefore !== null && nameCellAfter === nameCellBefore,
  `before=${nameCellBefore} after=${nameCellAfter}`);

// -- Selected-row highlight: check a row, read its own AND its frozen cell's background --
await page.evaluate(() => { const s = [...document.querySelectorAll("div")].find((d) => d.scrollWidth > d.clientWidth + 20 && d.querySelector("table")); if (s) s.scrollLeft = 0; });
const rowCheckbox = page.locator('table tbody tr').first().locator('input[type="checkbox"]').first();
const rowBgBefore = await page.evaluate(() => {
  const row = document.querySelector("table tbody tr");
  return row ? getComputedStyle(row).backgroundColor : null;
});
await rowCheckbox.click();
await page.waitForTimeout(300);
const rowBgAfter = await page.evaluate(() => {
  const row = document.querySelector("table tbody tr");
  const cells = row ? [...row.querySelectorAll("td")] : [];
  // cell[1] = Name, the frozen column - must match the row's own tint, not stay white, or the
  // row visibly splits in two at the frozen boundary (the exact bug the ui.tsx hover comment
  // already names for the hover case).
  return {
    row: row ? getComputedStyle(row).backgroundColor : null,
    frozenNameCell: cells[1] ? getComputedStyle(cells[1]).backgroundColor : null,
  };
});
const isWhite = (c) => c === "rgb(255, 255, 255)" || c === "rgba(0, 0, 0, 0)";
ok("[bulk-archive-restore-ux] checking a row's box gives it a visible tint (not still plain white)",
  rowBgAfter.row !== null && rowBgAfter.row !== rowBgBefore && !isWhite(rowBgAfter.row),
  `before=${rowBgBefore} after=${JSON.stringify(rowBgAfter)}`);
// getComputedStyle can hand back the browser's native color space (this Chromium prints
// "lab(96.492 -1.146 -5.115)" for Tailwind's bg-blue-50, not "rgb(...)") - and a canvas's
// fillStyle READBACK preserves that same notation rather than normalizing it, so parsing the
// STRING is a dead end either way. Actually drawing one pixel and reading it with getImageData
// is not a string format at all - it is the browser's own rasteriser, which must resolve any
// input notation down to concrete sRGB bytes to put a pixel on screen.
const toRgbChannels = async (color) => page.evaluate((c) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}, color);
const rowRgb = rowBgAfter.row ? await toRgbChannels(rowBgAfter.row) : null;
ok("[bulk-archive-restore-ux] ...and the tint is LIGHT, not \"very dark\" (Umesh's own words) - each RGB channel stays bright",
  !!rowRgb && rowRgb.every((v) => v > 180),
  `row=${rowBgAfter.row} rgb=${JSON.stringify(rowRgb)}`);
ok("[bulk-archive-restore-ux] the frozen Name column matches the row's tint - it does not stay white while the rest of the row highlights",
  rowBgAfter.frozenNameCell !== null && !isWhite(rowBgAfter.frozenNameCell),
  `frozenNameCell=${rowBgAfter.frozenNameCell}`);
await rowCheckbox.click(); // untick, leave the fixture in its normal state

// -- Bulk archive/restore via the real bulk bar, on a second fixture candidate --
await page.locator('input[placeholder="Search all columns…"]').first().fill(fresh[1].name);
await page.waitForTimeout(400);
const bulkRow = page.locator(`table tbody tr:has-text("${fresh[1].name}")`).first();
const bulkRowVisible = (await bulkRow.count()) > 0;
if (bulkRowVisible) {
  await bulkRow.locator('input[type="checkbox"]').first().click();
  await page.waitForTimeout(300);
  const barVisible = await page.locator('text=/1 selected/').count();
  ok("[bulk-archive-restore-ux] the bulk-action bar appears with the right count once a row is checked",
    barVisible > 0, `barVisible=${barVisible}`);
  const archiveSelectedBtn = page.locator('button:has-text("Archive Selected")').first();
  ok("[bulk-archive-restore-ux] Archive Selected is offered on the bulk bar", (await archiveSelectedBtn.count()) > 0, "");
  if (await archiveSelectedBtn.count()) {
    page.once("dialog", (d) => d.accept("QA bulk-archive-restore-ux rendered-suite bulk archive"));
    await archiveSelectedBtn.click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settled();
    const archivedTab2 = page.locator('button:has-text("Archived Candidates")').first();
    await archivedTab2.click();
    await page.waitForTimeout(500);
    await findRow(fresh[1].name);
    const bulkArchivedVisible = await page.locator(`table tbody tr:has-text("${fresh[1].name}")`).count();
    ok("[bulk-archive-restore-ux] Archive Selected genuinely archived the checked candidate",
      bulkArchivedVisible > 0, `rows=${bulkArchivedVisible}`);
    if (bulkArchivedVisible > 0) {
      // `bulkRow` was resolved on the pre-archive/pre-reload page; clicking it again here (on
      // the Archived tab, post-reload) toggled the SAME checkbox back off a moment after this
      // fresh `row2` click checked it, leaving nothing selected. `row2` alone is the row that
      // matters now.
      const row2 = page.locator(`table tbody tr:has-text("${fresh[1].name}")`).first();
      await row2.locator('input[type="checkbox"]').first().click();
      await page.waitForTimeout(300);
      const restoreSelectedBtn = page.locator('button:has-text("Restore Selected")').first();
      ok("[bulk-archive-restore-ux] the Archived tab's bulk bar offers Restore, never Assign to Batch",
        (await restoreSelectedBtn.count()) > 0 && (await page.locator('button:has-text("Assign to Batch")').count()) === 0,
        `restoreBtn=${await restoreSelectedBtn.count()} assignBtn=${await page.locator('button:has-text("Assign to Batch")').count()}`);
      if (await restoreSelectedBtn.count()) {
        await restoreSelectedBtn.click();
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: "domcontentloaded" });
        await settled();
        await archivedTab2.click().catch(() => {});
        await page.waitForTimeout(500);
        await findRow(fresh[1].name);
        const stillArchived = await page.locator(`table tbody tr:has-text("${fresh[1].name}")`).count();
        ok("[bulk-archive-restore-ux] Restore Selected genuinely un-archived the candidate",
          stillArchived === 0, `stillOnArchivedTab=${stillArchived}`);
      }
    }
  }
}

// ================= QA-573's LITERAL ASK, on /reports =================
// "open a <details>, close it, and read what is visible". REQ-367b: the warnings stay OUTSIDE the
// disclosure card and stay visible in BOTH states.
await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => /Where these numbers come from/i.test(document.body.innerText)
  || /No data|nothing to report/i.test(document.body.innerText), undefined, { timeout: 45000 }).catch(() => {});
const card = page.locator("details", { hasText: "Where these numbers come from" }).first();
ok("[REQ-367b] /reports renders the disclosure card this criterion is about", await card.count() > 0);

if (await card.count() > 0) {
  // CYCLE 3 - QA-1280 (S2), and the checker proved it with a GREEN scoreboard on a live violation.
  // It moved the caveat <p>, UNCHANGED, into a SECOND collapsed <details> labelled "Important note",
  // leaving the named card untouched. That is a warning folded behind a click - exactly what
  // REQ-367b forbids ("outside ANY disclosure card and ALWAYS visible") - and all ten assertions
  // still passed, 69/0. Two independent causes, both wrong in the same direction, so neither backed
  // the other up:
  //   1. `caveatInsideCard` asked only about the ONE card matched by "Where these numbers come from".
  //   2. `vis()` was offsetWidth||offsetHeight||getClientRects().length, which CANNOT tell hidden
  //      content inside a closed <details> from visible content - Chromium hides it with
  //      content-visibility, which still yields a layout box. Measured on that build: vis()=TRUE
  //      (offsetWidth 1230) while element.checkVisibility()=FALSE.
  // A criterion held by a check that cannot fail is the QA-1214 disease, and this suite exists to
  // end it. All three fixes are here: a semantic hook instead of a colour, closest("details") instead
  // of one named card, and checkVisibility() instead of a layout-box guess.
  const read = () => page.evaluate(() => {
    const d = [...document.querySelectorAll("details")].find((x) => /Where these numbers come from/i.test(x.innerText));
    // QA-1280: `data-warning` says what this element IS. Keying on `text-amber-800` meant one class
    // rename turned this red with "the caveat is not rendered at all", sending the next reader into
    // rules.ts over a restyle - QA-1243's disease inside the block that guards REQ-367b.
    const caveat = document.querySelector('[data-warning="caveat"]');
    const unrec = document.querySelector('[data-warning="unrecognised-status"]');
    // QA-1280: ANY disclosure card, not just the named one. A second <details> is the third of the
    // three defeats QA-567 already recorded against the old static pin.
    const insideAnyCard = (el) => !!(el && el.closest("details"));
    // QA-1280: checkVisibility() is the API that answers correctly and was one word away.
    const vis = (el) => !!el && (typeof el.checkVisibility === "function"
      ? el.checkVisibility()
      : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    return {
      open: !!d?.open,
      definitionsVisible: /Mobilised|In training/i.test(d?.innerText || "") && !!d?.open,
      // If the browser lacks checkVisibility the guard silently weakens, so say which one answered.
      visApi: typeof document.body.checkVisibility === "function" ? "checkVisibility" : "layout-box-fallback",
      caveatFound: !!caveat, caveatVisible: vis(caveat), caveatInsideCard: insideAnyCard(caveat),
      unrecFound: !!unrec, unrecInsideCard: insideAnyCard(unrec),
    };
  });

  const closed1 = await read();
  // QA-1280: without this the whole REQ-367b block can quietly fall back to the layout-box guess that
  // just let a folded warning score 69/0. A guard that weakens itself in silence is the thing being fixed.
  ok("[precondition] the browser answers element.checkVisibility() (else the visibility half of REQ-367b is a guess)",
    closed1.visApi === "checkVisibility", JSON.stringify({ visApi: closed1.visApi }));
  ok("[REQ-367b] the card starts CLOSED (it is a disclosure, not a wall of text)", closed1.open === false, JSON.stringify(closed1));
  ok("[REQ-367b] the amber caveat is rendered at all (rules.ts always sets it - if this fails the assertions below are vacuous)", closed1.caveatFound);
  ok("[REQ-367b] with the card CLOSED the caveat is still visible", closed1.caveatVisible, JSON.stringify(closed1));
  ok("[REQ-367b] the caveat is outside EVERY disclosure card on the page, not merely visible by luck", closed1.caveatFound && !closed1.caveatInsideCard, JSON.stringify(closed1));

  await card.locator("summary").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("details")].some((x) => /Where these numbers come from/i.test(x.innerText) && x.open), undefined, { timeout: 10000 }).catch(() => {});
  const opened = await read();
  ok("[QA-573] the harness can OPEN a <details> and the DOM actually changed state", opened.open === true, JSON.stringify(opened));
  ok("[QA-573] opening it reveals the definitions that were hidden a moment ago", opened.definitionsVisible, JSON.stringify(opened));
  ok("[REQ-367b] with the card OPEN the caveat is STILL visible and still outside every card", opened.caveatVisible && !opened.caveatInsideCard, JSON.stringify(opened));

  await card.locator("summary").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("details")].some((x) => /Where these numbers come from/i.test(x.innerText) && !x.open), undefined, { timeout: 10000 }).catch(() => {});
  const closed2 = await read();
  ok("[QA-573] the harness can CLOSE it again and the DOM actually changed back", closed2.open === false, JSON.stringify(closed2));
  ok("[REQ-367b] after closing, the caveat is visible in that state too and still outside every card", closed2.caveatVisible && !closed2.caveatInsideCard, JSON.stringify(closed2));
  // Only asserted when the dataset produces it - and SAID so, rather than passing silently.
  if (closed2.unrecFound) {
    ok("[REQ-367b] the 'does not recognise' warning is outside every card as well", !closed2.unrecInsideCard, JSON.stringify(closed2));
  } else {
    console.log("NOTE  [REQ-367b] the QA-552 'does not recognise' line is NOT rendered on this dataset, so its half of the criterion was NOT exercised. It needs sheet data carrying an unknown status; named as an open gap in the manifest, not counted as a pass.");
  }
}

// ---------------------------------------------------------------------------------------------
// QA-1268 (qa-1191 cycle-3 checker). THE IMPORT PREVIEW'S OWN WARNINGS, READ OFF THE SCREEN.
//
// This assertion used to live in scripts/e2e-blindspot.mjs as a SOURCE-TEXT search of
// candidates/page.tsx, and it was blind TWICE IN A ROW. Cycle 2's version matched the fix's own
// COMMENT and passed with the render deleted. Cycle 3 "fixed" that by stripping comments - but only
// LINE-START ones, and page.tsx carries 38 multi-line {/* ... */} blocks. The checker deleted the
// render, left the multi-line comment above it, and the pin still reported PASS 124/0; with a
// one-line comment as control it correctly went RED. The second pin was exactly as blind as the
// first, and its own comment claimed it was not.
//
// The lesson is NOT "strip comments better". A string search over source cannot answer "does this
// render" - it can only approximate it, and every tightening buys one new hole and one new false
// red. QA-1091 -> QA-1127 -> QA-1141 -> QA-1184 -> QA-1214 is that exact ladder, already walked
// once in this repo for a different pin.
//
// So the question moves to the instrument that answers it directly: the DOM. Deleting the render
// fails this. No comment, in any shape, can pass it.
{
  // QA-1701 (checker on qa-446): sidh added alongside interest/edu - same fixture, same round
  // trip, so the new field earns the same "on its own line, not crossed with a sibling" rigor
  // this block already pays for interest/education, at the cost of one extra column, not a
  // second browser flow ("ONE FLOW, CALLED TWICE" below is exactly the discipline this follows).
  const bad = { interest: "maybe later idk", edu: "not-a-level", onlyInterest: "sometime next year", sidh: "not-a-real-sidh-status" };
  const rows = [
    { Name: "TEST-IP " + s + " A", Phone: phone("77"), Interest: "The current batch", Edu: "10th Pass", Sidh: "Registered", AltPhone: "", Junk: "" },
    { Name: "TEST-IP " + s + " B", Phone: phone("77"), Interest: bad.interest, Edu: bad.edu, Sidh: bad.sidh, AltPhone: "", Junk: "" },
    // QA-1366 (checker, cycle 2): row B was the ONLY bad row and it was bad in BOTH columns, so
    // "the interest warning renders" and "it renders only when education's does" were the SAME
    // measurement - QA-1235 returning invisibly. Row C is bad in interest and VALID in education,
    // which is the only shape that can tell the two apart. Sidh stays clean on row C too, so it
    // never rides on interest's warning either.
    { Name: "TEST-IP " + s + " C", Phone: phone("77"), Interest: bad.onlyInterest, Edu: "Graduate", Sidh: "Link Sent", AltPhone: "", Junk: "" },
  ];
  // ONE FLOW, CALLED TWICE - not two copies, and the reason is this file's own history: every
  // guard in this block that went quietly wrong went wrong by drifting away from the thing beside
  // it. Two hand-maintained copies of a thirty-line Playwright flow is that same bet, taken on
  // purpose. The SHEET is the only thing that differs between the two calls, so the sheet is the
  // only thing that is a parameter.
  //
  // tmpdir, NOT the tree. The cycle-3 checker put a temporary path inside the checkout and Turbopack
  // failed the build on it - a self-inflicted error that reads exactly like broken code.
  const previewSheet = async (sheetRows, want, tag) => {
    const xlsx = pjoin(tmpdir(), "erp-import-" + s + "-" + tag + ".xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), "Sheet1");
    wfs(xlsx, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    await page.goto(BASE + "/candidates", { waitUntil: "domcontentloaded" });
    await settled();
    await page.getByRole("button", { name: "Import Excel" }).click();
    // ORDER MATTERS, and getting it wrong is what made this pin RED against a perfectly good
    // screen on its first run: candidates/page.tsx:1167 gates the file input on
    // importState.location && importState.program, so waiting for input[type=file] BEFORE
    // choosing those two waits for something that cannot exist yet. The pin reported the product
    // broken when the harness was. Doubt the instrument first - that is this repo's own rule and
    // I broke it inside the very pin written to stop a blind check.
    const dlg = page.locator("div.fixed").filter({ hasText: "Import candidates from Excel" }).last();
    await dlg.waitFor({ timeout: 15000 });
    // Scoped to the DRAWER, not the page: /candidates carries its own "All locations" filter
    // select, so page.locator("select").nth(0) picks THAT one - which would leave the drawer's
    // Location empty, the file input unrendered, and the failure pointing at the wrong thing.
    const drawerSel = dlg.locator("select");
    await drawerSel.nth(0).selectOption({ index: 1 });
    await drawerSel.nth(1).selectOption({ index: 1 });
    await page.waitForSelector('input[type="file"]', { timeout: 15000 });
    await page.locator('input[type="file"]').last().setInputFiles(xlsx);
    await page.waitForFunction(() => /Interest/.test(document.body.innerText), undefined, { timeout: 20000 });
    // BY INDEX, not by "the first empty one". The mapping selects render in the sheet's own column
    // order (page.tsx:1199 maps over importState.columns), so this is deterministic - and it lets
    // the LAST column be set to Ignore on purpose.
    // QA-1340 (checker, cycle 2): a column left at its DEFAULT is an *unknown* column that never
    // enters Object.entries(mapping) at all. Only ACTIVELY selecting Ignore writes the empty key -
    // and the empty key is the entire subject of the QA-1267 guard below. The old fixture left Junk
    // alone and therefore never created the state it was meant to be testing.
    const sels = page.locator('select:has(option[value="batch_interest"])');
    const nsel = await sels.count();
    for (let i = 0; i < Math.min(nsel, want.length); i++) {
      await sels.nth(i).selectOption(want[i]).catch(() => {});
    }
    await page.getByRole("button", { name: /^Preview/ }).click();
    // WAIT ON A NEUTRAL ANCHOR, not on one of the warnings. page.tsx:1342 always renders
    // "<n> valid, <n> skipped" once a preview exists, whatever the warnings say. Waiting on a
    // warning value instead - which is what cycle 2 did - means that a build where the warning
    // stops rendering produces a TIMEOUT rather than the assertion below firing with the screen
    // in its message. Both are red; only one of them tells you what happened.
    await page.waitForFunction(() => /\d+ valid, \d+ skipped/.test(document.body.innerText), undefined, { timeout: 25000 });
    return await page.locator("body").innerText();
  };

  let text = null;
  try {
    text = await previewSheet(rows, ["name", "phone", "batch_interest", "education", "sidh_status", "alt_phone", ""], "a");
  } catch (e) {
    // NOT a skip. A flow that never reached the preview verified nothing, and says so in red.
    ok("[QA-1268] the import preview was reachable in a browser", false, String((e && e.message) || e).slice(0, 200));
  }

  if (text) {
    // THE CONTROL, and it is what makes the next assertion mean anything. Cycle 1's real defect was
    // that education rendered and batch interest did not - so "the interest value appears" alone
    // would pass on a screen that renders everything, and prove nothing about the fix.
    // QA-1341 (checker, cycle 1). THE THREE ASSERTIONS BELOW USED TO BE INDEPENDENT WHOLE-BODY
    // SUBSTRING TESTS, and the checker showed what that costs: swap the two warning payloads - an
    // ordinary wrong-variable bug - and all four still passed 74/0 while the screen read
    //     "Education values not recognised: maybe later idk"
    //     "Batch interest not recognised: not-a-level"
    // The assertion whose own sentence promises the operator is told WHICH column is wrong was
    // green while the operator was being told the wrong column. Presence on a page is not the
    // claim; PAIRING is. So each value is now asserted on the SAME LINE as its own heading, and
    // the education mirror is asserted too - one line cannot satisfy both.
    const lineWith = (re) => (text.split(String.fromCharCode(10)).find((l) => re.test(l)) || "");
    const iLine = lineWith(/Batch interest not recognised/i);
    const eLine = lineWith(/Education values not recognised/i);
    ok("[QA-1268 control] the preview names an unreadable EDUCATION value ON ITS OWN LINE - proof the drawer renders warnings at all",
      eLine.includes(bad.edu), eLine || "(no education line rendered)");
    ok("[QA-1268] ...and the BATCH INTEREST heading carries the batch-interest value, not education's - read off the DOM, so no comment can fake it",
      iLine.includes(bad.interest) && !iLine.includes(bad.edu), iLine || "(no batch-interest line rendered)");
    ok("[QA-1341] ...and the two are NOT crossed - the education line must not carry the interest value either",
      !eLine.includes(bad.interest), JSON.stringify({ interestLine: iLine.slice(0, 90), eduLine: eLine.slice(0, 90) }));
    // QA-1366: row C is bad in interest and VALID in education. If the interest warning were
    // silently riding on the education one, this value would be missing while row B's still showed.
    ok("[QA-1366] the interest warning stands on its own - a row bad ONLY in interest is named, so this is not education's render wearing another heading",
      iLine.includes(bad.onlyInterest), iLine || "(no batch-interest line rendered)");
    // QA-1340 (same verdict): the guard below was green by ABSENCE - the old fixture rendered no
    // "mapped to" line at all, so "no warning names nothing" was true the way it is true of an
    // empty page. A guard that passes because its subject is missing measures nothing (QA-212).
    // The fixture now maps AltPhone to a REAL destination and leaves it EMPTY, so the lane must
    // speak; and it leaves Junk on Ignore and empty, which is the exact state QA-1267 was about.
    const mapped = text.split(String.fromCharCode(10)).filter((l) => /mapped to/.test(l));
    ok("[QA-1340] the blank-column lane actually SPEAKS on this fixture - otherwise the guard below is green by absence, not by behaviour",
      mapped.some((l) => /mapped to alt_phone/.test(l)), JSON.stringify(mapped.slice(0, 3)));
    // No regex here on purpose. The first version of this line was written through three layers of
    // shell quoting and arrived as /mapped tos*.(s|$)/ - every backslash eaten, so it matched
    // "mapped tos" and nothing it was meant to catch. A guard whose PATTERN is silently corrupt is
    // the same class as a guard that cannot fail, and it is the third escaping casualty in this
    // file today. Plain string arithmetic cannot be mangled that way.
    // QA-1340, cycle 3. My cycle-2 replacement COULD NOT FAIL AT ALL: columnNamed() sliced to the
    // end of the line, and the render always continues past the period ("mapped to alt_phone. Those
    // rows are imported without it..."), so it never returned "". The checker reverted the product
    // guard and this still read 75/0 on a screen literally showing "the column mapped to .".
    //
    // AND THE DIAGNOSIS THAT CAUSED IT WAS WRONG. I deleted a working regex believing three layers
    // of shell quoting had eaten it. They had eaten my EXPERIMENTS, never the regex on disk. I
    // replaced something that worked with something that could not, on a misreading.
    //
    // The template is `...the column mapped to {field}.` - so an empty field renders the literal
    // "mapped to ." and a real one renders "mapped to alt_phone.", which does not contain it. One
    // substring, line-anchored by construction, nothing to escape.
    ok("[QA-1267] ...and no blank-column warning names NOTHING - 'the column mapped to .' is a report lane lying about a column",
      !mapped.some((l) => l.indexOf("mapped to .") >= 0), JSON.stringify(mapped.slice(0, 3)) || "(no blank-column warning at all)");

    // QA-1701 (checker on qa-446): unhandled_fields + sidh_status_unmatched were computed by the
    // route since -154 (QA-426/REQ-379) and rendered nowhere - the same silent-drop shape QA-1268
    // above already caught once for batch_interest_unmatched. QA-446 added the render; this is its
    // first DOM-level coverage, same rigor as the education/interest pair above: on its own line,
    // not crossed with a sibling.
    const sLine = lineWith(/SIDH status values not recognised/i);
    ok("[QA-1701] the preview names an unrecognised SIDH STATUS value ON ITS OWN LINE - the render QA-446 added is not a comment or a dead branch",
      sLine.includes(bad.sidh), sLine || "(no SIDH status line rendered)");
    ok("[QA-1701] ...and it is NOT crossed with education or batch-interest's values - a coupling bug would put the wrong warning's value on this line",
      !sLine.includes(bad.edu) && !sLine.includes(bad.interest), sLine || "(no SIDH status line rendered)");
    ok("[QA-1701] ...and the education/batch-interest lines do not carry the SIDH value either - the crossing check runs both directions",
      !eLine.includes(bad.sidh) && !iLine.includes(bad.sidh), JSON.stringify({ eLine: eLine.slice(0, 90), iLine: iLine.slice(0, 90) }));
    // unhandled_fields has NO regression pin here, on purpose, not by oversight: the import
    // drawer's own mapping <select> only ever offers CANDIDATE_IMPORT_FIELDS options
    // (page.tsx:876), and every one of those is handled by some branch in
    // api/candidates/import/route.ts (TEXT_IMPORT_FIELDS / the explicit per-field ifs) - verified
    // directly, field by field, while building qa-446 and independently re-verified by two
    // separate checkers since. There is no sheet a real user can build, mapped through this real
    // dropdown, that reaches unhandledFields.push(field) at all - it is a defensive check for a
    // FUTURE catalog addition with no handler wired up yet. A DOM pin needs a live path to drive;
    // this one does not exist today. scripts/e2e-blindspot.mjs pins the JSON key directly (a
    // genuine, narrower substitute); qa/QA-ISSUES.jsonl QA-1701 and this comment are where that
    // gap is recorded, not silently skipped.
  }

  // ---------------------------------------------------------------------------------------------
  // QA-1366, CYCLE 3, AND THE THIRD ROW ABOVE DOES NOT CLOSE IT. Writing this down because I
  // believed it did.
  //
  // The checker's arm was one line in page.tsx:1386 - an ordinary wrong-condition bug that makes
  // the batch-interest block render only when the EDUCATION one also has something to say:
  //     {importState.preview?.education_unmatched?.length > 0 && importState.preview?.batch_interest_unmatched?.length > 0 && (
  // That build reads 75/0. On it, a sheet with an unreadable batch interest and a clean education
  // column renders no batch-interest warning at all - which is QA-1235 verbatim, the live defect
  // this entire guard exists for.
  //
  // Cycle 3's first answer was row C: bad in interest, VALID in education. That makes the two
  // COUNTS independent, and it is why row C stays. It does NOT make the two RENDERS independent -
  // row B is still bad in education, so `education_unmatched` is still non-empty on that preview,
  // the coupled condition is still satisfied, and the arm stays green. One sheet cannot answer
  // this, because the question is about what happens when education has NOTHING to say.
  //
  // So: a SECOND preview whose education column is entirely clean. On it, `education_unmatched`
  // is empty and the batch-interest warning has nothing to ride on. If it renders, it is its own.
  const cleanEduRows = [
    { Name: "TEST-IP " + s + " D", Phone: phone("77"), Interest: "The current batch", Edu: "10th Pass" },
    { Name: "TEST-IP " + s + " E", Phone: phone("77"), Interest: bad.onlyInterest, Edu: "Graduate" },
  ];
  let text2 = null;
  try {
    text2 = await previewSheet(cleanEduRows, ["name", "phone", "batch_interest", "education"], "b");
  } catch (e) {
    ok("[QA-1366] the second preview - clean education, bad interest - was reachable in a browser",
      false, String((e && e.message) || e).slice(0, 200));
  }

  if (text2) {
    const lineWith2 = (re) => (text2.split(String.fromCharCode(10)).find((l) => re.test(l)) || "");
    const iLine2 = lineWith2(/Batch interest not recognised/i);
    const eLine2 = lineWith2(/Education values not recognised/i);
    // THE CONTROL, and it runs FIRST because the assertion after it is worthless without it. If
    // this sheet's education column were not actually clean, the next line would be measuring the
    // same coupled state as sheet A all over again and would pass for the old reason.
    ok("[QA-1366 control] this second sheet's education column really is clean - NO education warning on it",
      eLine2 === "", eLine2 || "(no education line - correct)");
    // AND THE ARM. Green on the honest build; RED on the one-line coupling bug, because there
    // `education_unmatched` is empty and the interest block never renders.
    ok("[QA-1366] ...and the batch-interest warning still renders with NOTHING beside it - it is not the education block wearing another heading",
      iLine2.includes(bad.onlyInterest), iLine2 || "(no batch-interest line rendered - the warning is riding on education's)");
  }
}

// ---------------------------------------------------------------------------------------------
// QA-1363 (checker on qa-1290). THE SERVER CLOSED THREE DOORS AND LEFT THEIR BUTTONS ON THE SCREEN.
//
// -253 gated the enrolment doors on `candidates.assign`. Driven as a Trainer in a real browser, the
// batch page still rendered "Bulk (all N pending)" with four enabled buttons and 18 enabled Drop
// buttons - and pressing one printed the permission refusal back at the user. Before -253 those
// presses WORKED, so the fix turned a working control into a dead one. That is the -230 fault this
// project has already shipped once.
//
// TWO ARMS, AND THE ADMIN ARM IS WHY THIS MEANS ANYTHING. The checker's own first UI run scored a
// PASS because the bulk bar was absent - every member happened to be Completed and the bar sits
// behind `pending.length > 0`. That is an absence-based green, true the way it is true of a blank
// page. So this asserts the ADMIN does see the controls on the SAME batch in the SAME run.
{
  const asRole = async (email, pw) => {
    const c = await browser.newContext({ viewport: { width: 1536, height: 900 } });
    const pg = await c.newPage();
    await pg.goto(BASE, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(800);
    const box = pg.locator('input[type="email"], input[name="email"]').first();
    if (await box.count()) {
      await box.fill(email);
      await pg.locator('input[type="password"]').first().fill(pw);
      await pg.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
      await pg.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
    }
    return { c, pg, ok: !/login/i.test(pg.url()) };
  };
  // THE CONTROLS ARE BEHIND TABS, and the page opens on Overview. The first two runs of this pin
  // read the Overview tab and reported that even an Admin saw no enrolment controls - measuring the
  // wrong screen and calling it a permission result. `page.tsx:141-143` mounts Roster under
  // "Candidates" and Enrollment under "Enrollment"; neither exists in the DOM until its tab is
  // selected. So this opens each tab and reads it, and says which tab each number came from.
  const openTab = async (pg, name) => {
    const tab = pg.getByRole("button", { name }).first();
    if (await tab.count()) { await tab.click().catch(() => {}); await pg.waitForTimeout(1200); }
  };
  const readBatch = async (pg, id) => {
    await pg.goto(BASE + "/batches/" + id, { waitUntil: "domcontentloaded" });
    await pg.waitForFunction(() => /Overview|Enrollment|Candidates/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
    await pg.waitForTimeout(800);
    await openTab(pg, /^Enrollment$/);
    const et = await pg.locator("body").innerText();
    const bulk = et.indexOf("Bulk (") >= 0;
    const complete = await pg.getByRole("button", { name: /Complete enrollment/ }).count();
    await openTab(pg, /^Candidates$/);
    await pg.waitForTimeout(600);
    const drops = await pg.getByRole("button", { name: /^Drop$/ }).count();
    return { bulk, complete, drops };
  };

  const tr = await asRole("trainer.jpr03@vidysea.com", "CiOnly@123");
  if (!tr.ok) {
    ok("[QA-1363] the Trainer sample login works - without it this arm verifies nothing", false, tr.pg.url());
  } else {
    const list = await tr.pg.evaluate(async (b) => {
      const r = await fetch(b + "/api/batches?limit=50", { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      return (j.items || []).map((x) => ({ id: x._id, code: x.code, status: x.status }));
    }, BASE);
    const target = list.find((b) => ["Active", "Ready", "Planning"].includes(b.status)) || list[0];
    if (!target) {
      ok("[QA-1363] the Trainer can reach at least one batch page - the fixture must get there", false, JSON.stringify(list).slice(0, 200));
    } else {
      // THE FIXTURE MUST CREATE WHAT IT MEASURES. First run of this pin: the control FAILED because
      // the Admin saw nothing either - JPR03-MATH-FND-01 had no pending member, so the bulk bar
      // (gated on `pending.length > 0`) and the Drop cells were absent for everyone. The control
      // did its job and refused to let the Trainer arm score a green on an empty screen. Picking
      // "some batch the Trainer can see" was never enough; the batch has to HAVE a pending member.
      const seeded = await (async () => {
        try {
          const b = (await req(admin, "GET", `/api/batches/${target.id}`)).data.item;
          const cand = (await req(admin, "POST", "/api/candidates", {
            name: `TEST-Perm ${s}`, phone: phone("76"), location: b.location?._id ?? b.location,
            program: b.program?._id ?? b.program,
          }, 201)).data.item;
          await req(admin, "POST", `/api/batches/${target.id}/members`, { candidate: cand._id }, 201);
          return true;
        } catch { return false; }
      })();
      ok("[QA-1363 fixture] a PENDING member exists on the batch under test - the controls are gated on pending.length > 0, so without one this whole arm is vacuous",
        seeded, `batch=${target.code}`);

      const t = await readBatch(tr.pg, target.id);
      const ad = await asRole("admin@vidysea.com", ADMIN_PASSWORD);
      const a = ad.ok ? await readBatch(ad.pg, target.id) : null;
      ok("[QA-1363 control] an ADMIN sees the enrolment controls on this same batch - otherwise the Trainer arm below is green by ABSENCE, not by permission",
        !!a && (a.bulk || a.drops > 0), JSON.stringify({ admin: a, batch: target.code }));
      if (a && (a.bulk || a.drops > 0)) {
        ok("[QA-1363] ...and the TRAINER is offered no bulk enrolment bar the server would refuse",
          !t.bulk && t.complete === 0, JSON.stringify({ trainer: t, batch: target.code }));
        ok("[QA-1363] ...and no Drop button either - a control that refuses on press is the -230 fault",
          t.drops === 0, JSON.stringify({ trainerDrops: t.drops, adminDrops: a.drops }));
      }
      await ad.c.close().catch(() => {});
    }
  }
  await tr.c.close().catch(() => {});
}

console.log(`\n--- rendered-state summary (${results.length} URLs) ---`);
for (const r of results) {
  console.log(`  ${(decodeURIComponent(r.qs.split("=")[1] || "(none)")).padEnd(24)} | ${r.kind.padEnd(11)} | ${r.bucket.padEnd(9)} | tab ${r.activeTab.padEnd(26)} | pill ${(r.activePills[0] || "-").padEnd(22)} | announced ${String(r.announced).padStart(4)} | rows ${String(r.rows).padStart(4)}`);
}

// ---------------------------------------------------------------------------------------------
// QA-1584 (checker, qa-1575 cycle 2) — THE CARD NOTHING COULD CATCH.
// qa-1575 put the trainer's own documents on Home, and the cycle-2 checker had to open a browser by
// hand to know it rendered. Nothing in this wall would have noticed if it stopped rendering
// tomorrow: the API pins (a)-(j) all pass against a screen that draws nothing at all. That is the
// same shape as QA-1145, the defect this whole suite exists because of — a count announced, no rows
// drawn, found by a person and never by the wall.
//
// So this asserts what the TRAINER sees, signed in as a trainer, using only what the product tells
// them: nothing is pasted in from the fixture beyond creating it.
{
  const ts = stamp("TD");
  const tEmail = `qa1584.${ts}@vidysea.com`;
  const tr = (await req(admin, "POST", "/api/trainers", {
    name: "QA1584 Trainer " + ts, phone: phone("76"), email: tEmail,
    skills: ["RCSkill" + s], day_rate: 500,
  }, 201)).data?.item;
  const TPW = "CiOnly@123";
  const made = tr?._id ? await req(admin, "POST", `/api/trainers/${tr._id}/create-login`, { password: TPW }) : { status: 0 };
  ok("QA-1584 [precondition] a trainer with a linked login exists to render the card for",
    !!tr?._id && (made.status === 200 || made.status === 201),
    JSON.stringify({ tr: !!tr?._id, login: made.status }));

  if (tr?._id && (made.status === 200 || made.status === 201)) {
    await req(admin, "POST", `/api/trainers/${tr._id}/documents`, {
      doc_type: "Teaching Experience", file_url: `/erp/api/files/qa1584-${ts}.pdf`, original_name: `experience-${ts}.pdf`,
    });

    const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const tpage = await tctx.newPage();
    await tpage.goto(BASE, { waitUntil: "domcontentloaded" });
    await tpage.waitForTimeout(1200);
    const box = tpage.locator('input[type="email"], input[name="email"], input[id="email"]').first();
    if (await box.count()) {
      await box.fill(tEmail);
      await tpage.locator('input[type="password"]').first().fill(TPW);
      await tpage.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
      await tpage.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
    }
    ok("QA-1584 [precondition] the trainer's own browser session is signed in",
      !/login/i.test(tpage.url()), tpage.url());

    const drew = await tpage.waitForFunction(
      () => /My documents/i.test(document.body.innerText) && /Teaching Experience/i.test(document.body.innerText),
      undefined, { timeout: 45000 }).then(() => true).catch(() => false);
    ok("QA-1584 (a): a trainer's Home actually RENDERS the My documents card with its doc types",
      drew, drew ? "" : `body did not settle; url=${tpage.url()}`);

    const body = await tpage.innerText("body").catch(() => "");
    ok("QA-1584 (b): ...and the document filed through the API is VISIBLE on it, not an empty card",
      new RegExp(`experience-${ts}`, "i").test(body), body.slice(0, 260));
    // QA-1595 (checker, cycle 1 FAIL): both of these used to read `innerText`, and the checker
    // defeated them on purpose - it built the card with an ICON-ONLY delete (aria-label + title + a
    // glyph) and a leaked other-trainer name in the same build, and the wall went 91 / 0. innerText
    // carries no aria-label, so (c) was blind to every delete control that is not literally the word
    // "Delete"; and (d)'s regex named two e2e-roles.mjs fixtures, so it tested "not these two", not
    // "no other trainer" - and would go vacuous the day that OTHER suite renames them.
    // Both now interrogate the DOM for the thing itself.
    // Two bugs of my own in the first version of this pin, both the very class it exists to catch:
    //   1. the glyph class used a plain 4-hex-digit escape, so it read as U+2715, U+2716, U+1F5D
    //      and the DIGIT 1 - and every Tailwind class carrying a 1 (gap-1.5) matched. The pin went
    //      red on the Help button. It needs the braced form with the u flag.
    //   2. Falling back to document.body when the card was not found turned a MISSING CARD into a
    //      scan of the whole page, nav included. An absent card is a failure, not a wider search.
    // QA-1608 (checker, qa-1581 cycle 3 FAIL): the cycle-2 widening above fixed the SELECTOR
    // half and left the AFFORDANCE half denylisted, so four injected delete controls rendered on a
    // trainer's card while the suite reported 93 passed, 0 failed. Two of them were plain <button>
    // elements the selector DID match: one labelled through aria-labelledby (never resolved) and one
    // whose icon was a CSS background-image (no text at all). Both extracted to the empty string,
    // and the old line FILTERED EMPTY OUT - so an unlabelled control was invisible by construction.
    // The other two were a <span onClick> and a <div role=link onClick>: [onclick] cannot match them
    // because React attaches synthetic handlers and emits no onclick ATTRIBUTE, making that selector
    // term inert in this codebase.
    //
    // A denylist of delete-ish WORDS can only ever catch the spellings someone thought of. This card
    // has a CLOSED control vocabulary - read straight off MyDocuments in src/app/(app)/page.tsx and
    // Section/Notice in src/components/ui.tsx - so the pin is inverted to an ALLOWLIST: enumerate
    // every control the card actually carries and require each one to be a known-safe shape. An
    // unknown control fails whether or not it says "delete", and a control with NO discernible
    // affordance is the loudest failure of all rather than a filtered-out blank.
    const audit = await tpage.evaluate((knownFile) => {
      const card = [...document.querySelectorAll("section,div")]
        .filter((n) => /My documents/i.test(n.textContent || "") && n.querySelector("input[type=file]"))
        .pop();
      if (!card) return { noCard: true, unknown: [], seen: 0 };

      // Only ACTIVATION handlers count. Notice's wrapper carries onMouseEnter/onMouseLeave for its
      // auto-hide pause and is not a control; counting those would red the pin on an error banner.
      const ACTIVATION = ["onClick", "onMouseDown", "onMouseUp", "onPointerDown", "onKeyDown", "onKeyPress", "onDoubleClick", "onTouchStart"];
      const handlers = (el) => {
        const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"));
        const props = k ? (el[k] || {}) : {};
        return ACTIVATION.filter((h) => typeof props[h] === "function");
      };
      const affordance = (el) => {
        const byId = (ids) => (ids || "").split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || "").join(" ");
        const pseudo = ["::before", "::after"]
          .map((q) => { try { return getComputedStyle(el, q).content || ""; } catch { return ""; } })
          .filter((c) => c && c !== "none" && c !== "normal").join(" ");
        const svgTitle = [...el.querySelectorAll("title,desc")].map((n) => n.textContent || "").join(" ");
        return [el.getAttribute("aria-label"), byId(el.getAttribute("aria-labelledby")),
                el.getAttribute("title"), el.getAttribute("name"), el.textContent, svgTitle, pseudo]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      };

      // The closed vocabulary. Each rule is (element, affordance) -> is this exactly a control the
      // card is SUPPOSED to have? Shape is checked as well as text, so <a href="/x">Delete</a> is
      // not admitted by the link rule.
      const ALLOWED = [
        // the eight file pickers: a <label> wrapping the hidden input, reading Upload / Replace /
        // the busy ellipsis / an upload percentage
        (el, t) => el.tagName === "LABEL" && !!el.querySelector('input[type="file"]')
          && (/^(upload|replace|\u2026|\.\.\.)$/i.test(t) || /^\d{1,3}%$/.test(t) || /^.{1,40} \u2014 \d{1,3}%$/.test(t)),
        (el) => el.tagName === "INPUT" && el.getAttribute("type") === "file",
        // the one document link: a real href, and its text is the trainer's OWN file name (or "View")
        (el, t) => el.tagName === "A" && /^(https?:|\/)/.test(el.getAttribute("href") || "")
          && (t === "View" || (!!knownFile && t === knownFile)),
        // ErrorBanner's dismiss, only ever rendered on an error
        (el, t) => el.tagName === "BUTTON" && /^(dismiss|\u00d7|dismiss \u00d7)$/i.test(t),
      ];

      const INTERACTIVE_TAGS = ["BUTTON", "A", "LABEL", "SUMMARY", "INPUT", "SELECT", "TEXTAREA"];
      const isControl = (el) => {
        if (INTERACTIVE_TAGS.includes(el.tagName)) return true;
        if (/^(button|link|menuitem|tab|checkbox|switch|option)$/i.test(el.getAttribute("role") || "")) return true;
        if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
        if (handlers(el).length) return true;
        try { if (getComputedStyle(el).cursor === "pointer") return true; } catch { /* detached */ }
        return false;
      };

      const controls = [...card.querySelectorAll("*")].filter(isControl);
      const unknown = controls.map((el) => {
        const t = affordance(el);
        if (ALLOWED.some((rule) => rule(el, t))) return null;
        return { tag: el.tagName, text: t.slice(0, 60), role: el.getAttribute("role"),
                 aria: el.getAttribute("aria-label"), labelledby: el.getAttribute("aria-labelledby"),
                 title: el.getAttribute("title"), react: handlers(el),
                 cls: String(el.className || "").slice(0, 40) };
      }).filter(Boolean);
      return { noCard: false, unknown, seen: controls.length };
    }, `experience-${ts}.pdf`);

    ok("QA-1584 (c): the card offers the trainer NO delete control - its controls are an ALLOWLIST, so an UNKNOWN control fails even when it is unlabelled or spelled a way nobody predicted",
      !audit.noCard && audit.unknown.length === 0, JSON.stringify(audit).slice(0, 600));
    ok("QA-1608: ...and that allowlist is actually looking at controls, not at an empty card",
      !audit.noCard && audit.seen >= 9, JSON.stringify({ seen: audit.seen, noCard: audit.noCard }));

    // (d) — QA-1603 (checker, qa-1581 cycle 2 FAIL): the previous version of this pin only checked
    // that ONE dynamically-created trainer's name was absent. That closed the VACUOUS-REGEX hole (a
    // hardcoded fixture-name list that would silently stop testing anything if another suite renamed
    // its fixtures) but not the LEAKED-NAME hole it was dispatched to close - a static string that
    // reads as a person's name, sourced from nowhere this suite created, still passed silently. The
    // checker proved it with the exact mutation this test still runs below:
    // `<span>Also on file: Rajesh Kumar Sharma</span>` inside the card stayed GREEN.
    //
    // The robust form (checker's own recommendation): this card has a CLOSED vocabulary. Reading the
    // component directly (src/app/(app)/page.tsx MyDocuments) it renders, per row, only: one of the
    // eight fixed MY_DOC_TYPES labels, a fixed status word ("Verified ✓" / "On file" / "Not
    // uploaded"), a fixed control word ("Replace" / "Upload" / "View" / "…"), the fixed static
    // description line, and — the one piece of real data — the trainer's OWN uploaded file name.
    // Nothing else has any legitimate reason to appear in that subtree. So strip every one of those
    // known tokens plus anything shaped like this trainer's own uploaded file name, and assert
    // NOTHING is left — not "this one known name is absent", but "no unaccounted text survives at
    // all", which catches any leaked name (this suite's own, another suite's fixture, or a
    // hardcoded string that was never a fixture anywhere) without needing to enumerate it.
    const otherName = "QA1584 Other " + ts;
    const otherTr = (await req(admin, "POST", "/api/trainers", {
      name: otherName, phone: phone("75"), email: `qa1584.other.${ts}@vidysea.com`,
      skills: ["RCSkill" + s], day_rate: 500,
    }, 201)).data?.item;
    ok("QA-1584 [precondition] a SECOND trainer exists, so 'names no other trainer' has something to be wrong about",
      !!otherTr?._id, JSON.stringify(otherTr).slice(0, 120));
    await tpage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    // Wait for the card to actually FINISH loading (its upload inputs mounted), not just for the
    // section title to appear - the card renders "Loading…" with no file inputs until its own fetch
    // resolves, and evaluating against it too early is exactly the false-negative shape this whole
    // suite exists to avoid.
    await tpage.waitForFunction(
      () => [...document.querySelectorAll("section,div")]
        .some((n) => /My documents/i.test(n.textContent || "") && n.querySelector("input[type=file]")),
      undefined, { timeout: 45000 }).catch(() => {});

    const DOC_TYPES = ["Educational Qualification", "CITS Certificate", "Industry Experience",
      "Teaching Experience", "Aadhaar", "PAN", "Photo", "CV"];
    const KNOWN_WORDS = ["My documents",
      "Your certificates and IDs. Only you and the office can see these.",
      "Verified ✓", "On file", "Not uploaded", "Replace", "Upload", "View", "…"];
    const leftover = await tpage.evaluate(({ docTypes, knownWords }) => {
      const card = [...document.querySelectorAll("section,div")]
        .filter((n) => /My documents/i.test(n.textContent || "") && n.querySelector("input[type=file]"))
        .pop();
      if (!card) return "__NO_CARD__";
      let text = card.textContent || "";
      for (const t of [...docTypes, ...knownWords]) text = text.split(t).join("");
      // A document's own file name is the one piece of real, legitimate data on this card - strip
      // anything shaped like an uploaded file (any run of non-space characters ending in a known
      // document extension) before judging what's left.
      text = text.replace(/\S*\.(pdf|docx?|jpe?g|png|webp|heic|heif)\b/gi, "");
      return text.replace(/[\s ]+/g, " ").trim();
    }, { docTypes: DOC_TYPES, knownWords: KNOWN_WORDS });
    ok("QA-1584 (d): ...and names no OTHER trainer anywhere on that screen - the card's text is a CLOSED vocabulary, anything left over after stripping every known label/status/control/filename is a leak",
      leftover === "", JSON.stringify(leftover).slice(0, 300));

    await tctx.close();
  }

await browser.close();
}

finish();

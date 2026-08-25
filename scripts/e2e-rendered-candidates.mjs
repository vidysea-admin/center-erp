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
  const bad = { interest: "maybe later idk", edu: "not-a-level" };
  const rows = [
    { Name: "TEST-IP " + s + " A", Phone: phone("77"), Interest: "The current batch", Edu: "10th Pass" },
    { Name: "TEST-IP " + s + " B", Phone: phone("77"), Interest: bad.interest, Edu: bad.edu },
  ];
  // tmpdir, NOT the tree. The cycle-3 checker put a temporary path inside the checkout and Turbopack
  // failed the build on it - a self-inflicted error that reads exactly like broken code.
  const xlsx = pjoin(tmpdir(), "erp-import-" + s + ".xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
  wfs(xlsx, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  let reached = false;
  try {
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
    for (const field of ["name", "phone", "batch_interest", "education"]) {
      const sel = page.locator('select:has(option[value="' + field + '"])');
      const n = await sel.count();
      for (let i = 0; i < n; i++) {
        const cur = await sel.nth(i).inputValue().catch(() => "x");
        if (!cur) { await sel.nth(i).selectOption(field).catch(() => {}); break; }
      }
    }
    await page.getByRole("button", { name: /^Preview/ }).click();
    await page.waitForFunction((e) => document.body.innerText.includes(e), bad.edu, { timeout: 25000 });
    reached = true;
  } catch (e) {
    // NOT a skip. A flow that never reached the preview verified nothing, and says so in red.
    ok("[QA-1268] the import preview was reachable in a browser", false, String((e && e.message) || e).slice(0, 200));
  }

  if (reached) {
    const text = await page.locator("body").innerText();
    // THE CONTROL, and it is what makes the next assertion mean anything. Cycle 1's real defect was
    // that education rendered and batch interest did not - so "the interest value appears" alone
    // would pass on a screen that renders everything, and prove nothing about the fix.
    ok("[QA-1268 control] the preview names an unreadable EDUCATION value - proof the drawer renders warnings at all",
      text.includes(bad.edu), text.slice(0, 200));
    ok("[QA-1268] ...and it names the unreadable BATCH INTEREST value too - read off the DOM, so no comment can fake it",
      text.includes(bad.interest), (text.match(/Batch interest[^\n]*/) || ["(no batch-interest line rendered)"])[0]);
    ok("[QA-1268] ...under its own heading, so the operator is told WHICH column is wrong",
      /Batch interest not recognised/i.test(text), (text.match(/Batch interest[^\n]*/) || ["(heading absent)"])[0]);
    // QA-1267's regression guard, on the screen where it was found: a mapping entry whose
    // destination is the empty string - what the drawer's own "Ignore" writes - must never produce a
    // warning that names no column at all.
    ok("[QA-1267] no blank-column warning names NOTHING - 'the column mapped to .' is a report lane lying about a column",
      !/mapped to\s*\.(\s|$)/m.test(text),
      (text.match(/[^\n]*mapped to[^\n]*/) || ["(no blank-column warning at all)"])[0]);
  }
}

console.log(`\n--- rendered-state summary (${results.length} URLs) ---`);
for (const r of results) {
  console.log(`  ${(decodeURIComponent(r.qs.split("=")[1] || "(none)")).padEnd(24)} | ${r.kind.padEnd(11)} | ${r.bucket.padEnd(9)} | tab ${r.activeTab.padEnd(26)} | pill ${(r.activePills[0] || "-").padEnd(22)} | announced ${String(r.announced).padStart(4)} | rows ${String(r.rows).padStart(4)}`);
}

await browser.close();
finish();

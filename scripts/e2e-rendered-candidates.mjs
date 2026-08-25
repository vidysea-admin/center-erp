// RENDERED-STATE suite (QA-573). The first suite in this wall that asserts what the SCREEN does
// rather than what a source file spells.
//
// WHY IT EXISTS. QA-1145 shipped live: a summary card opened a list that announced a count and
// rendered zero rows under "No candidates - add or import." - advice to re-create people the centre
// already had. It was found by a person opening the app, never by this wall. Three cycles of static
// pins in scripts/check-user-copy.mjs then failed to guard the fix: QA-1091 -> QA-1127 -> QA-1141 ->
// QA-1184 -> QA-1214, and every tightening bought exactly one new hole and one new false red. Two
// checkers proved a rendered harness was buildable on this machine, and Umesh approved making it
// real (2026-08-25). This file is that harness, with the machine-specific paths removed: `playwright`
// is a devDependency now and chromium resolves from the package, not from an npx cache.
//
// WHAT IT ASSERTS - one invariant, in the operator's terms:
//     A screen that announces a count above zero must render rows.
//     "No candidates - add or import." must never print on a screen claiming it has candidates.
//
// THE ANTI-VACUOUS RULE, and it is load-bearing. Every failure mode of this suite - browser missing,
// login refused, page not rendering, fixture empty - makes every screen show zero counts AND zero
// rows, which satisfies the invariant trivially. A suite that cannot fail is worse than no suite
// (QA-1214 is exactly that shape). So the preconditions below are ASSERTIONS, never skips: if this
// suite cannot do its job it goes RED, loudly, and says which precondition died.
import { chromium } from "playwright";
import { ok, req, adminLogin, finish, stamp, phone, today, BASE, ADMIN_PASSWORD } from "./e2e-lib.mjs";

// Journey labels (src/lib/candidate-journey.ts JOURNEY_TAGS) and the STORED lifecycle_status values
// a summary-card href can carry. They are DIFFERENT vocabularies - that difference is the defect.
const JOURNEY_TAGS = ["Enrollment in progress", "Training Ongoing", "Training Completed", "Result Awaited",
  "Certified", "Dropout", "Failed", "Absent at Assessment"];
const STORED = ["Assigned", "Enrolled", "Completed", "Failed"];
const CONTROLS = ["Dropped", "Fresh Lead", "NotARealValue"];
const PILL_RE = "^(All|Fresh Lead|Portal Link Sent|Registered on Portal|Dropped|Enrollment in progress|"
  + "Training Ongoing|Training Completed|Result Awaited|Certified|Dropout|Failed|Absent at Assessment|"
  + "No programme|Multi-interest|Future interested)\\b";

const s = stamp("RC");
const admin = await adminLogin();

// ---- fixture: a centre with candidates of its own, so this suite never depends on seed:sample ----
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "RenderedCand Prog " + s, trainer_skill: "RCSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-Rendered Loc " + s, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const made = [];
for (let i = 0; i < 4; i++) {
  made.push((await req(admin, "POST", "/api/candidates", { name: `TEST-RC Cand ${i} ${s}`, phone: phone("7" + i), location: loc._id, program: prog._id }, 201)).data.item);
}

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

// ---- log in through the UI, exactly as an operator does ----
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
if (await emailBox.count()) {
  await emailBox.fill("admin@vidysea.com");
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
  await page.waitForTimeout(4500);
}
ok("[precondition] the browser is logged in (not sitting on the login screen)", !/login/i.test(page.url()), page.url());

async function probe(qs, kind) {
  await page.goto(`${BASE}/candidates${qs}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000); // the list fetches limit=2000 client-side
  const r = await page.evaluate((pillSrc) => {
    const txt = document.body.innerText;
    // ui.tsx Tabs(): EVERY tab carries `border-b-2`; only the ACTIVE one carries `border-blue-600`.
    // A looser match reported "Fresh" for every URL on the cycle-1 checker's first run.
    const activeTabEl = [...document.querySelectorAll("button")].find((b) =>
      /^(Fresh|Enrolled) Candidates \(\d+\)/.test(b.innerText.trim()) && /border-blue-600/.test(b.className));
    const pills = [...document.querySelectorAll("button")]
      .filter((b) => new RegExp(pillSrc).test(b.innerText.trim()))
      .map((b) => ({
        label: b.innerText.replace(/\s+/g, " ").trim(),
        active: b.getAttribute("aria-pressed") === "true" || /bg-(blue|slate-900|black)|text-white/.test(b.className),
      }));
    const rows = [...document.querySelectorAll("table")].reduce((a, t) => a + t.querySelectorAll("tbody tr").length, 0);
    return {
      activeTab: activeTabEl ? activeTabEl.innerText.replace(/\s+/g, " ").trim() : "(none detected)",
      tabsSeen: [...txt.matchAll(/(Fresh|Enrolled) Candidates \(\d+\)/g)].length,
      activePills: pills.filter((p) => p.active).map((p) => p.label),
      rows,
      emptyState: /No candidates/i.test(txt) ? (txt.match(/No candidates[^\n]*/) || [""])[0] : "",
    };
  }, PILL_RE);
  // The announced count is the ACTIVE PILL's number when a pill is selected, else the ACTIVE TAB's.
  const pillCount = r.activePills.length ? Number((r.activePills[0].match(/(\d+)\s*$/) || [0, "0"])[1]) : null;
  const tabCount = Number((r.activeTab.match(/\((\d+)\)/) || [0, "0"])[1]);
  const announced = pillCount === null ? tabCount : pillCount;
  return { qs, kind, ...r, announced };
}

const results = [];
for (const v of STORED) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "STORED"));
for (const v of JOURNEY_TAGS) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "JOURNEY_TAG"));
for (const v of CONTROLS) results.push(await probe(`?lifecycle_status=${encodeURIComponent(v)}`, "CONTROL"));
results.push(await probe("?program=null", "CONTROL"));
results.push(await probe("", "CONTROL"));

// ---- THE ANTI-VACUOUS PRECONDITIONS. Each one, alone, can make every assertion below pass for the
// ---- wrong reason. They are asserted BEFORE the invariant so a dead harness reads as dead.
ok("[precondition] the candidates screen rendered its tabs on every URL probed",
  results.every((r) => r.tabsSeen >= 2), JSON.stringify(results.filter((r) => r.tabsSeen < 2).map((r) => r.qs)));
ok("[precondition] at least one probed URL ANNOUNCED a count above zero (else the invariant is vacuous)",
  results.some((r) => r.announced > 0), JSON.stringify(results.map((r) => `${r.qs}=${r.announced}`)));
ok("[precondition] at least one probed URL actually RENDERED rows (else the page never loaded)",
  results.some((r) => r.rows > 0), JSON.stringify(results.map((r) => `${r.qs}=${r.rows}`)));
ok("[precondition] this suite's own fixture candidates exist and are visible to the API",
  (await req(admin, "GET", `/api/candidates?limit=2000`, undefined, 200)).data.items
    .filter((c) => String(c.name || "").includes(s)).length === made.length, `expected ${made.length}`);

// ---- THE INVARIANT, one assertion per URL, named the way an operator would describe the damage ----
for (const r of results) {
  const value = decodeURIComponent((r.qs.split("=")[1] || "(no filter)"));
  const lies = r.announced > 0 && r.rows === 0;
  ok(`[${r.kind}] ${r.qs || "(no filter)"} -> the screen renders rows for the ${r.announced} it announces`,
    !lies,
    `announced=${r.announced} rows=${r.rows} activeTab="${r.activeTab}" activePill=${JSON.stringify(r.activePills[0] || null)} empty="${r.emptyState}"`);
  ok(`[${r.kind}] ${r.qs || "(no filter)"} -> does not tell a centre with candidates to "add or import"`,
    !(r.announced > 0 && /add or import/i.test(r.emptyState)),
    `announced=${r.announced} empty="${r.emptyState}" value="${value}"`);
  if (lies) {
    await page.screenshot({ path: `D:/erp/evidence-24-08/qa-573/${s}${r.qs.replace(/[^a-z0-9]/gi, "-")}.png` }).catch(() => {});
  }
}

console.log(`\n--- rendered-state summary (${results.length} URLs) ---`);
for (const r of results) {
  console.log(`  ${(decodeURIComponent(r.qs.split("=")[1] || "(none)")).padEnd(24)} | ${r.kind.padEnd(11)} | tab ${r.activeTab.padEnd(26)} | pill ${(r.activePills[0] || "-").padEnd(22)} | announced ${String(r.announced).padStart(4)} | rows ${String(r.rows).padStart(4)}`);
}

await browser.close();
finish();

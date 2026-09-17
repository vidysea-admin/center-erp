// QA-2761 + QA-2763 - rendered-state suite for save-button feedback.
//
// Umesh, 2026-09-17: "jo iska save button hai seems not very functional ya click mai user ko pta hi nhi
// chal rha ki click ho gyaa hai ya kya hua, ye saare save buttons mai ui k issue hai , atleast there
// should some check mark come or slight color change and after any kinda change this active button
// appears again".
//
// WHY A NEW FILE. The nearest home is e2e-rendered-candidates.mjs, but that file is locked by another
// unit's uncommitted work while this one is built (qa-2761 dispatch brief), so it is run, not edited.
//
// WHAT IT PINS, per arm (each arm's name is what a mutant is expected to redden):
//   [Btn] pending: a held save disables the button, shows an aria-hidden spinner, and a same-tick
//         double click sends ONE request
//   [Btn] success: a check mark (aria-hidden) and a green tint, the accessible name unchanged
//   [Btn] reset: editing a field returns the button to active
//   [Btn] error: a forced 500 shows the error state, no check mark, and the error text; then active
//   [Btn] sync: a synchronous onClick never enters a state
//   [QA-2763 1] transition() rethrows: "Record it" and the exam-held confirmation stay open on failure
//   [QA-2763 2] plan patch() rethrows: the inline Add editor stays open with its typed row
//   [QA-2763 3] saveContacts rethrows: "Add contact" keeps the typed name on failure
//   [QA-2763 4] RoundDrawer / LogEditDrawer stay open and show the error on failure
//   [QA-2763 5] DefaultsTab.save rethrows (the [Btn] arms above run on it)
//   [QA-2763 6] a queued success is a green status notice, not the red alert banner
//   [Btn] resolved false: a handler that resolves false (nothing to save) goes back to active, no check
// Faults are injected with page.route on THIS browser only; nothing here changes server behaviour.
import { chromium } from "playwright";
import { ok, req, adminLogin, finish, stamp, phone, today, BASE, ADMIN_PASSWORD } from "./e2e-lib.mjs";

let crashGuardBrowser = null;
const onFatal = async (e) => {
  ok("QA-2761: the save-feedback journey ran to its end without an uncaught error", false,
    `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)} - every arm after this point did not run`);
  try { if (crashGuardBrowser) await crashGuardBrowser.close(); } catch { /* nothing left */ }
  finish();
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const s = stamp("SF");
const admin = await adminLogin();
// Lower-case on purpose and compared lower-cased: plain() (ui.tsx ErrorBanner) capitalises the first
// letter, so an exact-case match reads a correctly shown error as a missing one.
const FAIL_MSG = "save-feedback forced failure";
const daysFromToday = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---- fixture ----
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "SaveFeedback Prog " + s, trainer_skill: "SFSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-SaveFeedback Loc " + s, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const roomA = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "SF-A", type: "Classroom" }, 201)).data.item;
const trainerA = (await req(admin, "POST", "/api/trainers", { name: "TEST-SF Trainer " + s, phone: phone("9"), skills: ["SFSkill" + s] }, 201)).data.item;
// Batch A: ACTIVE, one enrolled member, one daily log - the exam-held drawer, LogEditDrawer, RoundDrawer.
const batchA = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainerA._id, room: roomA._id, planned_start: today(), target_size: 1 }, 201)).data.item;
const candA = (await req(admin, "POST", "/api/candidates", { name: `TEST-SF Member ${s}`, phone: phone("81"), location: loc._id, program: prog._id }, 201)).data.item;
const memA = (await req(admin, "POST", `/api/batches/${batchA._id}/members`, { candidate: candA._id }, 201)).data.item;
await req(admin, "PATCH", `/api/members/${memA._id}`, { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${batchA._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${batchA._id}/transition`, { target: "Active" }, 200);
const logRes = await req(admin, "POST", `/api/batches/${batchA._id}/logs`, { log_date: today(), present_member_ids: [], trainer_present: true, actual_topic: "SF day " + s }, 201);
const logA = logRes.data.item;
ok("[precondition] batch A is Active with a daily log", !!logA?._id, JSON.stringify(logRes.data).slice(0, 200));
// Batch B: PLANNING, planned start in the past, no room - "Record it", the room notice, the plan editor.
const batchBRes = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: daysFromToday(-10), target_size: 5 }, 201);
const batchB = batchBRes.data.item;
ok("[precondition] batch B (Planning, started 10 days ago, no room) exists", !!batchB?._id, JSON.stringify(batchBRes.data).slice(0, 200));
const planRes = await req(admin, "PATCH", `/api/batches/${batchB._id}/milestones`, { create: true });
ok("[precondition] batch B has a backward plan", planRes.status < 300, JSON.stringify(planRes).slice(0, 200));
const defaultsBefore = (await req(admin, "GET", "/api/defaults")).data.item;

// ---- browser ----
let browser;
try { browser = await chromium.launch({ headless: true }); crashGuardBrowser = browser; }
catch (e) {
  ok("[precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200));
  finish();
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
if (await emailBox.count()) {
  await emailBox.fill("admin@vidysea.com");
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
  await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
}
ok("[precondition] the browser is logged in", !/login/i.test(page.url()), page.url());

const stateOf = (loc) => loc.getAttribute("data-save-state", { timeout: 1000 }).catch(() => null);
const waitState = async (loc, want, ms = 15000) => {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await stateOf(loc);
    if (last === want) return true;
    await page.waitForTimeout(50);
  }
  return false;
};
const iconOf = async (loc, kind) => loc.locator(`svg[data-btn-icon="${kind}"]`).count();
const iconHidden = async (loc, kind) => (await loc.locator(`svg[data-btn-icon="${kind}"]`).getAttribute("aria-hidden", { timeout: 1000 }).catch(() => null)) === "true";
const snap = (loc) => loc.ariaSnapshot().catch((e) => "ariaSnapshot failed: " + e.message);
const card = (title) => page.getByRole("heading", { name: title, exact: true }).locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
const alertText = async () => (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | ");
const eventually = async (fn, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await page.waitForTimeout(100); }
  return false;
};
const fail500 = (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: FAIL_MSG }) });


// Each section is an ARM: a thrown locator timeout inside one (which is exactly what a mutant that
// removes an element produces) is recorded as that arm's failure and the next arm still runs, so a
// mutant reddens the arm it targets and nothing downstream by accident.
page.setDefaultTimeout(15000);
const arm = async (name, fn) => {
  try { await fn(); }
  catch (e) { ok(`${name} [arm ran to its end]`, false, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 240)); }
  finally { await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); }
};
const transitionPath = (id) => (u) => new URL(u).pathname.endsWith(`/api/batches/${id}/transition`);
const drawerOf = (heading) => heading.locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");

// =================================================================================================
// [Btn] + [QA-2763 5] on Admin -> Defaults, "Planning defaults (§8)" Save
// =================================================================================================
const original = Number(defaultsBefore?.batch_size ?? 30);
await arm("Defaults", async () => {
  await page.goto(`${BASE}/admin?tab=Defaults`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Default batch size").waitFor({ timeout: 30000 });
  const planningCard = card("Planning defaults (§8)");
  const dSave = planningCard.getByRole("button", { name: "Save", exact: true });
  const batchSizeInput = page.getByLabel("Default batch size");
  const v1 = original + 7;
  ok("[precondition] Defaults Save starts idle and enabled", (await stateOf(dSave)) === "idle" && await dSave.isEnabled(), String(await stateOf(dSave)));

  let heldPuts = 0; let releasePut; const held = new Promise((r) => { releasePut = r; });
  const defaultsPath = (u) => new URL(u).pathname.endsWith("/api/defaults");
  await page.route(defaultsPath, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    heldPuts++; await held; await route.continue().catch(() => {});
  });
  await batchSizeInput.fill(String(v1));
  await dSave.evaluate((el) => { el.click(); el.click(); });
  const sawPending = await waitState(dSave, "pending");
  await page.waitForTimeout(400); // give a second, unguarded request time to leave the page
  const pendingState = {
    sawPending, puts: heldPuts, disabled: await dSave.isDisabled(),
    spinner: await iconOf(dSave, "spinner"), spinnerHidden: await iconHidden(dSave, "spinner"),
    ariaBusy: await dSave.getAttribute("aria-busy", { timeout: 1000 }).catch(() => null),
  };
  ok("[Btn] pending: a held save disables the button and shows an aria-hidden spinner",
    pendingState.sawPending && pendingState.disabled && pendingState.spinner === 1 && pendingState.spinnerHidden && pendingState.ariaBusy === "true",
    JSON.stringify(pendingState));
  ok("[Btn] pending: a same-tick double click sends exactly ONE request", heldPuts === 1, JSON.stringify(pendingState));
  releasePut();
  const sawSuccess = await waitState(dSave, "success");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const successState = {
    sawSuccess, check: await iconOf(dSave, "check"), checkHidden: await iconHidden(dSave, "check"),
    green: /\bbg-green-600\b/.test(await dSave.getAttribute("class") ?? ""), enabled: await dSave.isEnabled(),
    text: (await dSave.textContent())?.trim(), aria: await snap(dSave),
  };
  const stored = (await req(admin, "GET", "/api/defaults")).data.item?.batch_size;
  ok("[Btn] success: a check mark (aria-hidden) and a green tint after the save resolves, and the value was really stored",
    successState.sawSuccess && successState.check === 1 && successState.checkHidden && successState.green && stored === v1,
    JSON.stringify({ ...successState, stored, v1 }));
  ok("[Btn] success: the accessible name and the text are still exactly \"Save\"",
    successState.text === "Save" && /^- button "Save"\s*$/.test(String(successState.aria)) && await planningCard.getByRole("button", { name: "Save", exact: true }).count() === 1,
    JSON.stringify(successState));
  const otherSave = card("Candidate eligibility (2026-08-11)").getByRole("button", { name: "Save", exact: true });
  ok("[Btn] success is per button: a neighbouring Save that was not pressed stays idle", (await stateOf(otherSave)) === "idle", String(await stateOf(otherSave)));
  await page.waitForTimeout(1200);
  ok("[Btn] success is HELD while nothing changes (no timer takes the check mark away)", (await stateOf(dSave)) === "success", String(await stateOf(dSave)));
  const heldBeforeEdit = (await stateOf(dSave)) === "success";
  await batchSizeInput.fill(String(v1 + 1));
  ok("[Btn] reset: editing a field returns the button to active",
    heldBeforeEdit && await waitState(dSave, "idle", 5000) && await dSave.isEnabled(),
    JSON.stringify({ heldBeforeEdit, now: await stateOf(dSave) }));

  await page.route(defaultsPath, (route) => (route.request().method() === "PUT" ? fail500(route) : route.continue()));
  await dSave.click();
  const sawError = await waitState(dSave, "error");
  const errorState = {
    sawError, check: await iconOf(dSave, "check"), red: /\bbg-red-600\b/.test(await dSave.getAttribute("class") ?? ""),
    alert: await alertText(), inputKept: await batchSizeInput.inputValue(),
  };
  await page.unrouteAll({ behavior: "ignoreErrors" });
  ok("[Btn] error / [QA-2763 5]: a forced 500 on Defaults Save shows the error state, NO check mark, and the error text; the typed value stays",
    errorState.sawError && errorState.check === 0 && errorState.red && errorState.alert.toLowerCase().includes(FAIL_MSG) && errorState.inputKept === String(v1 + 1),
    JSON.stringify(errorState));
  ok("[Btn] error: the button returns to active on its own",
    sawError ? await waitState(dSave, "idle", 6000) && await dSave.isEnabled() : false,
    "precondition for this arm is the error state; state now " + String(await stateOf(dSave)));
});
await req(admin, "PUT", "/api/defaults", { batch_size: original }, 200);

// =================================================================================================
// [QA-2763 3] locations/[id] "Add contact"; success check mark then reset on typing
// =================================================================================================
await arm("Contacts", async () => {
  await page.goto(`${BASE}/locations/${loc._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Contacts & Notes", exact: true }).click();
  const contactCard = card("Contact persons");
  const contactName = contactCard.getByLabel("Name");
  const addContact = contactCard.getByRole("button", { name: "Add contact", exact: true });
  await contactName.waitFor({ timeout: 30000 });
  const locPath = (u) => new URL(u).pathname.endsWith(`/api/locations/${loc._id}`);
  await page.route(locPath, (route) => (route.request().method() === "PATCH" ? fail500(route) : route.continue()));
  await contactName.fill("SF Contact " + s);
  await addContact.click();
  const contactErr = await waitState(addContact, "error");
  const contactFail = { contactErr, kept: await contactName.inputValue(), alert: await alertText(), check: await iconOf(addContact, "check") };
  await page.unrouteAll({ behavior: "ignoreErrors" });
  ok("[QA-2763 3] a refused contact save keeps the typed name, shows the error, and the button shows error with no check mark",
    contactFail.contactErr && contactFail.kept === "SF Contact " + s && contactFail.alert.toLowerCase().includes(FAIL_MSG) && contactFail.check === 0,
    JSON.stringify(contactFail));
  await page.waitForTimeout(2800);
  await contactName.fill("SF Contact " + s); // a no-op when the name survived; a retype when it did not
  await addContact.click();
  const contactOk = await waitState(addContact, "success");
  const contactSaved = { contactOk, cleared: await contactName.inputValue(), row: await contactCard.getByText("SF Contact " + s).count() };
  ok("[Btn] success on a form that clears itself: the check mark shows and the saved row appears",
    contactSaved.contactOk && contactSaved.cleared === "" && contactSaved.row > 0, JSON.stringify(contactSaved));
  const contactHeld = (await stateOf(addContact)) === "success";
  await contactName.fill("x");
  ok("[Btn] reset: typing into the cleared form returns Add contact to active",
    contactHeld && await waitState(addContact, "idle", 5000), JSON.stringify({ contactHeld, now: await stateOf(addContact) }));
});

// =================================================================================================
// [QA-2763 6] targets "sent for approval" is a green status notice, not the red alert
// =================================================================================================
await arm("Targets notice", async () => {
  await page.goto(`${BASE}/locations/${loc._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Capacity & Target", exact: true }).click();
  const targetCard = card("Set / update target");
  await targetCard.getByLabel("Program").waitFor({ timeout: 30000 });
  await targetCard.getByLabel("Program").selectOption(prog._id);
  const targetsPath = (u) => new URL(u).pathname.endsWith(`/api/locations/${loc._id}/targets`);
  await page.route(targetsPath, (route) => (route.request().method() === "PUT"
    ? route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ queued: true }) })
    : route.continue()));
  await targetCard.getByRole("button", { name: "Save target", exact: true }).click();
  const queuedText = "Sent to the Admin for approval";
  const notice = await eventually(async () => (await page.getByRole("status").filter({ hasText: queuedText }).count()) > 0, 8000);
  const inAlert = (await alertText()).includes(queuedText);
  ok("[QA-2763 6] a queued target save is announced as a status notice and NOT in the red alert banner", notice && !inAlert, JSON.stringify({ notice, inAlert }));
});

// =================================================================================================
// [QA-2763 2] plan: inline Add editor stays open on failure; sync "+ Add row" never enters a state
// =================================================================================================
await arm("Plan editor", async () => {
  await page.goto(`${BASE}/batches/${batchB._id}/plan`, { waitUntil: "domcontentloaded" });
  const addRow = page.getByRole("button", { name: "+ Add row", exact: true });
  await addRow.waitFor({ timeout: 30000 });
  await addRow.click();
  ok("[Btn] sync: a synchronous onClick leaves the button idle and enabled", (await stateOf(addRow)) === "idle" && await addRow.isEnabled(), String(await stateOf(addRow)));
  const msLabel = page.getByLabel("Milestone");
  await msLabel.fill("SF milestone " + s);
  await page.getByLabel("Due date").fill(daysFromToday(20));
  const planPath = (u) => new URL(u).pathname.endsWith(`/api/batches/${batchB._id}/milestones`);
  await page.route(planPath, (route) => (route.request().method() === "PATCH" ? fail500(route) : route.continue()));
  const planAdd = msLabel.locator("xpath=ancestor::div[contains(@class, 'bg-blue-50')][1]").getByRole("button", { name: "Add", exact: true });
  await planAdd.click();
  const planErr = await waitState(planAdd, "error", 8000);
  const planFail = { planErr, editorOpen: await page.getByLabel("Milestone").count(), kept: await msLabel.inputValue({ timeout: 1000 }).catch(() => null), alert: await alertText() };
  await page.unrouteAll({ behavior: "ignoreErrors" });
  ok("[QA-2763 2] a refused milestone Add keeps its editor open with the typed row and shows the error",
    planFail.planErr && planFail.editorOpen === 1 && planFail.kept === "SF milestone " + s && planFail.alert.toLowerCase().includes(FAIL_MSG), JSON.stringify(planFail));
  await page.waitForTimeout(2800);
  await planAdd.click();
  const planClosed = await eventually(async () => (await page.getByLabel("Milestone").count()) === 0);
  ok("[QA-2763 2] ...and the same Add succeeds on retry, closing the editor with the row on the plan",
    planClosed && (await page.getByText("SF milestone " + s).count()) > 0, JSON.stringify({ planClosed }));
});

// =================================================================================================
// [QA-2763 6] batch Overview: a queued room suggestion is a status notice, not an alert
// =================================================================================================
await arm("Room notice", async () => {
  await page.goto(`${BASE}/batches/${batchB._id}`, { waitUntil: "domcontentloaded" });
  const addRoomLink = page.getByRole("button", { name: "+ Add room at this centre", exact: true });
  await addRoomLink.waitFor({ timeout: 30000 });
  await addRoomLink.click();
  await page.getByPlaceholder("Room name").fill("SF-Queued");
  const roomsPath = (u) => new URL(u).pathname.endsWith(`/api/locations/${loc._id}/rooms`);
  await page.route(roomsPath, (route) => (route.request().method() === "POST"
    ? route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ queued: true }) })
    : route.continue()));
  await page.getByRole("button", { name: "Add & assign", exact: true }).click();
  const roomText = "Room suggestion sent for approval";
  const roomNotice = await eventually(async () => (await page.getByRole("status").filter({ hasText: roomText }).count()) > 0, 8000);
  const roomInAlert = (await alertText()).includes(roomText);
  ok("[QA-2763 6] a queued room suggestion is announced as a status notice and NOT in the red alert banner", roomNotice && !roomInAlert, JSON.stringify({ roomNotice, roomInAlert }));
});

// =================================================================================================
// [QA-2763 1] "Record it" stays open on a refused transition
// =================================================================================================
await arm("Record it", async () => {
  await page.goto(`${BASE}/batches/${batchB._id}`, { waitUntil: "domcontentloaded" });
  const recordStart = page.getByRole("button", { name: "Record start from that date", exact: true });
  await recordStart.waitFor({ timeout: 30000 });
  await recordStart.click();
  const recordIt = page.getByRole("button", { name: "Record it", exact: true });
  await recordIt.waitFor({ timeout: 15000 });
  await page.route(transitionPath(batchB._id), (route) => (route.request().method() === "POST" ? fail500(route) : route.continue()));
  await recordIt.click();
  const recErr = await waitState(recordIt, "error", 8000);
  const recFail = { recErr, drawerOpen: await recordIt.count(), check: await iconOf(recordIt, "check"), alert: await alertText() };
  ok("[QA-2763 1] a refused \"Record it\" keeps its confirmation open with the error, and no check mark",
    recFail.recErr && recFail.drawerOpen === 1 && recFail.check === 0 && recFail.alert.toLowerCase().includes(FAIL_MSG), JSON.stringify(recFail));
});

// =================================================================================================
// [Btn] resolved-false: a handler that resolves `false` (nothing to do) returns to active, no check
// =================================================================================================
await arm("Resolved false", async () => {
  // Add contact with an EMPTY name: addContact() shows its own validation message and resolves false
  // before any request. The message is what proves the handler actually ran (a button whose onClick
  // was disconnected would also be idle with no check mark - review finding on cycle 1's first arm).
  await page.goto(`${BASE}/locations/${loc._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Contacts & Notes", exact: true }).click();
  const contactCard = card("Contact persons");
  const addContact = contactCard.getByRole("button", { name: "Add contact", exact: true });
  await contactCard.getByLabel("Name").waitFor({ timeout: 30000 });
  await contactCard.getByLabel("Name").fill("");
  let patches = 0;
  await page.route((u) => new URL(u).pathname.endsWith(`/api/locations/${loc._id}`), (route) => { if (route.request().method() === "PATCH") patches++; return route.continue(); });
  await addContact.click();
  const ran = await eventually(async () => /contact name is required/i.test(await alertText()), 8000);
  await page.waitForTimeout(800);
  const falseState = { ran, state: await stateOf(addContact), check: await iconOf(addContact, "check"), patches, enabled: await addContact.isEnabled() };
  ok("[Btn] resolved false: a handler that refused before saving (its own message shown) leaves the button active with NO check mark",
    falseState.ran && falseState.state === "idle" && falseState.check === 0 && falseState.patches === 0 && falseState.enabled, JSON.stringify(falseState));
});

// =================================================================================================
// [QA-2761 review] a PARKED contact save (202 "sent for approval", no item) is not a check mark
// =================================================================================================
await arm("Parked contact", async () => {
  await page.goto(`${BASE}/locations/${loc._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Contacts & Notes", exact: true }).click();
  const contactCard = card("Contact persons");
  const addContact = contactCard.getByRole("button", { name: "Add contact", exact: true });
  await contactCard.getByLabel("Name").waitFor({ timeout: 30000 });
  await contactCard.getByLabel("Name").fill("SF Parked " + s);
  await page.route((u) => new URL(u).pathname.endsWith(`/api/locations/${loc._id}`), (route) => (route.request().method() === "PATCH"
    ? route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ error: "parked for admin approval sf" }) })
    : route.continue()));
  await addContact.click();
  const shown = await eventually(async () => /parked for admin approval sf/i.test(await alertText()), 8000);
  await page.waitForTimeout(800);
  const parked = { shown, state: await stateOf(addContact), check: await iconOf(addContact, "check") };
  ok("[QA-2761 review] a contact save parked for approval shows its message and does NOT show a check mark",
    parked.shown && parked.state === "idle" && parked.check === 0, JSON.stringify(parked));
});

// =================================================================================================
// [QA-2763 1] exam-held confirmation (batch A, Active)
// =================================================================================================
await arm("Exam held", async () => {
  await page.goto(`${BASE}/batches/${batchA._id}`, { waitUntil: "domcontentloaded" });
  const examOpen = page.getByRole("button", { name: /^Assessment done →/ });
  await examOpen.waitFor({ timeout: 30000 });
  await examOpen.click();
  const examYes = page.getByRole("button", { name: "Yes — the assessment was held", exact: true });
  await examYes.waitFor({ timeout: 15000 });
  await page.route(transitionPath(batchA._id), (route) => (route.request().method() === "POST" ? fail500(route) : route.continue()));
  await examYes.click();
  const examErr = await waitState(examYes, "error", 8000);
  const examFail = { examErr, drawerOpen: await examYes.count(), check: await iconOf(examYes, "check"), alert: await alertText() };
  ok("[QA-2763 1] a refused \"the assessment was held\" keeps its confirmation open with the error, and no check mark",
    examFail.examErr && examFail.drawerOpen === 1 && examFail.check === 0 && examFail.alert.toLowerCase().includes(FAIL_MSG), JSON.stringify(examFail));
  const batchAfter = (await req(admin, "GET", `/api/batches/${batchA._id}`)).data;
  ok("[precondition] the forced exam-held failure changed nothing on the server (batch A still Active)", (batchAfter.item ?? batchAfter)?.status === "Active", JSON.stringify(batchAfter).slice(0, 160));
});

// =================================================================================================
// [QA-2763 4] LogEditDrawer and RoundDrawer. Fresh page per arm, and the alert is read INSIDE the
// drawer, so a banner left by an earlier arm cannot satisfy "shows the error".
// =================================================================================================
await arm("LogEditDrawer", async () => {
  await page.goto(`${BASE}/batches/${batchA._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Daily Execution", exact: true }).click();
  const logPath = (u) => new URL(u).pathname.endsWith(`/api/logs/${logA._id}`);
  const editBtn = page.getByRole("button", { name: "Edit", exact: true }).first();
  await editBtn.waitFor({ timeout: 30000 });
  await editBtn.click();
  const saveChanges = page.getByRole("button", { name: "Save changes", exact: true });
  await saveChanges.waitFor({ timeout: 15000 });
  await page.route(logPath, (route) => (route.request().method() === "PATCH" ? fail500(route) : route.continue()));
  await saveChanges.click();
  const editErr = await waitState(saveChanges, "error", 8000);
  const editHeading = page.getByRole("heading", { name: /^Edit log —/ });
  const editFail = { editErr, drawerOpen: await editHeading.count(), alert: (await drawerOf(editHeading).getByRole("alert").allInnerTexts({ timeout: 1000 }).catch(() => [])).join(" | ") };
  ok("[QA-2763 4] a refused log edit keeps LogEditDrawer open and shows the error in it",
    editFail.editErr && editFail.drawerOpen === 1 && editFail.alert.toLowerCase().includes(FAIL_MSG), JSON.stringify(editFail));
});

await arm("RoundDrawer", async () => {
  await page.goto(`${BASE}/batches/${batchA._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Daily Execution", exact: true }).click();
  const roundBtn = page.getByRole("button", { name: "+ Round", exact: true }).first();
  await roundBtn.waitFor({ timeout: 30000 });
  await roundBtn.click();
  const roundHeading = page.getByRole("heading", { name: /^Marking round —/ });
  await roundHeading.waitFor({ timeout: 15000 });
  const drawerPanel = drawerOf(roundHeading);
  await drawerPanel.getByRole("button", { name: new RegExp(`TEST-SF Member ${s}`) }).first().click();
  const saveRound = drawerPanel.getByRole("button", { name: /^Save round/ });
  const sessionsPath = (u) => new URL(u).pathname.endsWith(`/api/logs/${logA._id}/sessions`);
  await page.route(sessionsPath, (route) => (route.request().method() === "POST" ? fail500(route) : route.continue()));
  await saveRound.click();
  const roundErr = await waitState(saveRound, "error", 8000);
  const roundFail = { roundErr, drawerOpen: await roundHeading.count(), alert: (await drawerPanel.getByRole("alert").allInnerTexts({ timeout: 1000 }).catch(() => [])).join(" | ") };
  ok("[QA-2763 4] a refused marking round keeps RoundDrawer open and shows the error in it",
    roundFail.roundErr && roundFail.drawerOpen === 1 && roundFail.alert.toLowerCase().includes(FAIL_MSG), JSON.stringify(roundFail));
});

await browser.close();
finish();

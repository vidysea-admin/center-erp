// Batch photos & videos by day + ZIP download (qa-batch-media-zip, field ask 2026-10-24 via Umesh).
// The field team could not see the day-wise photos/videos of a batch once it left Active: the
// Daily Execution tab returned "Daily logs open once the batch is Active." for every other status,
// though every file was still in storage. They asked for: one folder per date (folder name = the
// date), one button per date that downloads that day as a ZIP, one button for all days (15 class
// days = 15 folders), photos AND videos, nothing else.
//   [M1] a batch that is no longer Active shows its day folders (browser)
//   [M2] the per-day ZIP holds exactly that day's photos + videos under <date>/ (bytes identical)
//   [M3] the all-days ZIP has one folder per day that has media, and no folder for a day without
//   [M4] a Center Manager of ANOTHER centre (and an anonymous caller) is refused
//   [M5] a file the log names but storage no longer has is listed in MISSING.txt, never dropped silently
//   [M6] on an Active batch the daily-log form is unchanged and the day folders show under it
// Run: node scripts/e2e-batch-media-zip.mjs   (server on BASE_URL, MONGODB_DB=center_erp_ci*)
import { chromium } from "playwright";
import { ok, req, login, adminLogin, finish, stamp as mkStamp, BASE } from "./e2e-lib.mjs";

const istDay = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + offsetDays * 86400000));
const D0 = istDay(-3), D1 = istDay(-2), D2 = istDay(-1), D3 = istDay(0);
const BASE_PATH = new URL(BASE).pathname.replace(/\/$/, "");

const admin = await adminLogin();
ok("[precondition] admin login", !!admin);
const s = mkStamp("MZ");
const PW = "CiOnly@123";

// ---- fixture: a batch that really began on D0, with one enrolled candidate ----
const loc = (await req(admin, "POST", "/api/locations", {
  code: "L" + s, name: "Govt. ITI " + s, state: "UP", district: "Basti",
  tc_id: "TC" + s, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const locOther = (await req(admin, "POST", "/api/locations", {
  code: "LX" + s, name: "Govt. ITI Other " + s, state: "UP", district: "Gonda",
  tc_id: "TCX" + s, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const prog = (await req(admin, "POST", "/api/programs", {
  code: "P" + s, name: "RPL Programme " + s, trainer_skill: "SK" + s, scheme: "RPL-AVPL", qp_code: "ASC/Q" + s.slice(-4), scheme_priority: 1,
}, 201)).data.item;
const tr = (await req(admin, "POST", "/api/trainers", {
  name: "Media Trainer " + s, phone: "9" + Date.now().toString().slice(-9), email: `mediatrainer.${s}@example.com`.toLowerCase(),
  skills: [prog.trainer_skill], home_location: loc._id, pipeline_status: "Fresh Lead",
}, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "Room " + s, type: "Classroom" }, 201)).data.item;
const batch = (await req(admin, "POST", "/api/batches", {
  code: "B" + s, location: loc._id, program: prog._id, trainer: tr._id, room: room._id, target_size: 1, planned_start: D0, planned_end: D3,
}, 201)).data.item;
// The server assigns the batch code (the posted one is not kept) - the ZIP is named after the real one.
const CODE = String(batch.code).replace(/[^A-Za-z0-9._-]+/g, "_");
const cand = (await req(admin, "POST", "/api/candidates", { name: "Media Candidate " + s, phone: "7" + Date.now().toString().slice(-9), location: loc._id, program: prog._id }, 201)).data.item;
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cand._id }, 201);
const mem = (await req(admin, "GET", `/api/batches/${batch._id}/members`)).data.items[0];
await req(admin, "PATCH", `/api/members/${mem._id}`, { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active", actual_start: D0 }, 200);

// ---- uploads: real files through the one upload door (StoredFile rows + bytes in storage) ----
// A 1x1 PNG (the upload door may re-encode it; the ZIP must carry what storage serves, so the
// assertions below compare against GET /api/files/<name>, never against these input bytes).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function upload(bytes, filename, type) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type }), filename);
  const r = await req(admin, "POST", "/api/upload", fd);
  ok(`[precondition] upload ${filename} → 200`, r.status === 200 && !!r.data.url, JSON.stringify(r.data).slice(0, 160));
  return r.data.url;
}
const p1 = await upload(PNG, "class.png", "image/png");
const v1 = await upload(Buffer.from("not-really-a-video-" + s), "clip.mp4", "video/mp4");
const p2 = await upload(PNG, "class.png", "image/png");
const p3 = await upload(PNG, "class.png", "image/png"); // same original name on the same day → must not overwrite p2
const missing = `${BASE_PATH}/api/files/${"0".repeat(31)}f.jpg`; // named by the log, never stored
const sheet = await upload(PNG, "register.png", "image/png"); // attendance sheet: NOT a photo, stays out

await req(admin, "POST", `/api/batches/${batch._id}/logs`, { log_date: D1, present_member_ids: [mem._id], trainer_present: true, photos: [p1], videos: [v1] }, 201);
await req(admin, "POST", `/api/batches/${batch._id}/logs`, { log_date: D2, present_member_ids: [mem._id], trainer_present: true, attendance_sheet: [sheet] }, 201);
await req(admin, "POST", `/api/batches/${batch._id}/logs`, { log_date: D3, present_member_ids: [mem._id], trainer_present: true, photos: [p2, p3, missing] }, 201);

const nameOf = (u) => /([a-f0-9]{32}\.[a-z0-9]+)$/.exec(u)?.[1];
async function served(u) {
  const r = await fetch(BASE + "/api/files/" + nameOf(u), { headers: { cookie: admin } });
  return Buffer.from(await r.arrayBuffer());
}

// ---- a minimal ZIP reader (central directory; STORE and DEFLATE-free by design) ----
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    entries.push({ name, method, data: buf.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}
async function getZip(cookie, query) {
  const res = await fetch(`${BASE}/api/batches/${batch._id}/logs/media-zip${query}`, { headers: cookie ? { cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), disp: res.headers.get("content-disposition") ?? "", buf };
}
const folderOf = (e) => e.name.split("/")[0];

// ---- [M2] per-day ZIP ----
const z1 = await getZip(admin, `?date=${D1}`);
ok("[M2] GET media-zip?date=<day> → 200 application/zip", z1.status === 200 && /application\/zip/.test(z1.type ?? ""), `${z1.status} ${z1.type} ${z1.buf.toString("utf8", 0, 160)}`);
ok("[M2] ...downloads as <BATCHCODE>_<date>.zip", z1.disp.includes(`attachment`) && z1.disp.includes(`${CODE}_${D1}.zip`), z1.disp);
let e1 = [];
try { e1 = readZip(z1.buf); } catch (e) { ok("[M2] the body is a readable ZIP", false, String(e.message)); }
ok("[M2] ...holds exactly that day's photo and video, both under the <date>/ folder",
  e1.length === 2 && e1.every((e) => folderOf(e) === D1) && e1.some((e) => /\.mp4$/.test(e.name)) && e1.some((e) => /^.+\/class\.[a-z]+$/.test(e.name)),
  JSON.stringify(e1.map((e) => e.name)));
ok("[M2] ...stored, not compressed (method 0: photos/videos are already compressed)", e1.length > 0 && e1.every((e) => e.method === 0), JSON.stringify(e1.map((e) => e.method)));
const bytesP1 = await served(p1), bytesV1 = await served(v1);
ok("[M2] ...and each entry is byte-identical to what /api/files serves for that file",
  e1.some((e) => /\.mp4$/.test(e.name) && e.data.equals(bytesV1)) && e1.some((e) => /class\./.test(e.name) && e.data.equals(bytesP1)),
  JSON.stringify(e1.map((e) => [e.name, e.data.length])) + ` p1=${bytesP1.length} v1=${bytesV1.length}`);
ok("[M2] a day that has attendance sheets but no photos/videos → 404 (the sheet is not media)", (await getZip(admin, `?date=${D2}`)).status === 404);
ok("[M2] a malformed date → 400", (await getZip(admin, `?date=24-10-2026`)).status === 400);

// ---- [M3] + [M5] all-days ZIP ----
const za = await getZip(admin, "");
ok("[M3] GET media-zip (no date) → 200, named <BATCHCODE>_all-days.zip", za.status === 200 && za.disp.includes(`${CODE}_all-days.zip`), `${za.status} ${za.disp}`);
let ea = [];
try { ea = readZip(za.buf); } catch (e) { ok("[M3] the body is a readable ZIP", false, String(e.message)); }
const folders = [...new Set(ea.filter((e) => e.name.includes("/")).map(folderOf))].sort();
ok("[M3] ...one folder per day that has media (D1, D3), none for the attendance-only day", JSON.stringify(folders) === JSON.stringify([D1, D3]), JSON.stringify(ea.map((e) => e.name)));
const d3 = ea.filter((e) => folderOf(e) === D3);
ok("[M3] ...two photos with the same original name on one day are BOTH kept, under different names",
  d3.length === 2 && new Set(d3.map((e) => e.name)).size === 2, JSON.stringify(d3.map((e) => e.name)));
ok("[M3] ...the attendance sheet is not in the ZIP", !ea.some((e) => /register/.test(e.name)), JSON.stringify(ea.map((e) => e.name)));
const miss = ea.find((e) => e.name === "MISSING.txt");
ok("[M5] a file the log names but storage does not have is listed in MISSING.txt (with its day), not dropped silently",
  !!miss && miss.data.toString("utf8").includes(D3) && miss.data.toString("utf8").includes(nameOf(missing)), miss ? miss.data.toString("utf8") : JSON.stringify(ea.map((e) => e.name)));
ok("[M5] ...and a day with nothing missing carries no MISSING.txt", !e1.some((e) => e.name === "MISSING.txt"));

// ---- [M4] scope ----
const otherCm = `cm.media.${s}@vidysea-test.local`.toLowerCase();
await req(admin, "POST", "/api/users", { name: "CM media " + s, email: otherCm, password: PW, can_edit: true, role: "Center Manager", location_scope: [locOther._id] }, 201);
const ownCm = `cm.mediaown.${s}@vidysea-test.local`.toLowerCase();
await req(admin, "POST", "/api/users", { name: "CM media own " + s, email: ownCm, password: PW, can_edit: true, role: "Center Manager", location_scope: [loc._id] }, 201);
const otherCookie = await login(otherCm, PW), ownCookie = await login(ownCm, PW);
ok("[precondition] both Center Managers can sign in", !!otherCookie && !!ownCookie);
const zo = await getZip(otherCookie, "");
ok("[M4] a Center Manager of ANOTHER centre is refused (403/404), and gets no ZIP bytes",
  (zo.status === 403 || zo.status === 404) && zo.buf.readUInt32LE(0) !== 0x04034b50, `${zo.status} ${zo.type}`);
ok("[M4] ...the same refusal on the per-day door", [403, 404].includes((await getZip(otherCookie, `?date=${D1}`)).status));
ok("[M4] an anonymous caller is refused (401)", (await getZip(null, "")).status === 401);
ok("[M4] the Center Manager of THIS centre gets the ZIP (the gate is scope, not role)", (await getZip(ownCookie, `?date=${D1}`)).status === 200);

// ---- browser: [M6] Active, then [M1] after the batch leaves Active ----
const browser = await chromium.launch({ headless: true });
async function openDaily() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const host = new URL(BASE).hostname;
  await ctx.addCookies(admin.split("; ").map((c) => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1), domain: host, path: "/" }; }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(`${BASE}/batches/${batch._id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Daily Execution", exact: true }).first().click();
  await page.getByText("Photos & videos by day").first().waitFor({ timeout: 20000 }).catch(() => {});
  // The heading renders while the logs are still loading; wait for the rows (absent rows still fail below).
  await page.locator("[data-media-day]").first().waitFor({ timeout: 20000 }).catch(() => {});
  return { page, ctx, errors };
}
const zipHref = (q) => `${BASE_PATH}/api/batches/${batch._id}/logs/media-zip${q}`;
try {
  {
    const { page, ctx, errors } = await openDaily();
    ok("[M6] Active: the daily-log entry form still renders", await page.getByText("Trainer present today").first().isVisible().catch(() => false));
    ok("[M6] ...and the day folders show under it", await page.getByText("Photos & videos by day").first().isVisible().catch(() => false));
    ok("[M6] no page error", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // planned_end is recomputed from the programme length on create; delivery must have ended to leave Active.
  await req(admin, "PATCH", `/api/batches/${batch._id}`, { planned_end: D3 }, 200);
  await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Assessment Awaited" }, 200);
  {
    const { page, ctx, errors } = await openDaily();
    ok("[M1] after Active: the 'opens once Active' dead end is gone", !(await page.getByText("Daily logs open once the batch is Active.").first().isVisible().catch(() => false)));
    ok("[M1] ...the 'Photos & videos by day' section shows", await page.getByText("Photos & videos by day").first().isVisible().catch(() => false));
    const hrefs = await page.locator('a[href*="/logs/media-zip"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    ok("[M1] ...one Download ZIP per day with media (D1, D3) plus one Download all, and none for the attendance-only day",
      hrefs.includes(zipHref(`?date=${D1}`)) && hrefs.includes(zipHref(`?date=${D3}`)) && hrefs.includes(zipHref("")) && !hrefs.includes(zipHref(`?date=${D2}`)) && hrefs.length === 3,
      JSON.stringify(hrefs));
    const shown = await page.locator('[data-media-day]').evaluateAll((els) => els.map((e) => e.getAttribute("data-media-day")));
    ok("[M1] ...the folders are the dates, newest first", JSON.stringify(shown) === JSON.stringify([D3, D1]), JSON.stringify(shown));
    ok("[M1] ...the photos render as thumbnails (img tags point at /api/files)", (await page.locator('[data-media-day] img[src*="/api/files/"]').count()) === 4);
    ok("[M1] no page error", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
finish();

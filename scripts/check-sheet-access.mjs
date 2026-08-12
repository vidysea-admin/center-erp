// Can THIS machine reach the client's OneDrive workbook?
// Run it on the app server before (or after) setting up Sheet Watch:
//     node scripts/check-sheet-access.mjs
//     node scripts/check-sheet-access.mjs "<share url>"
// No credentials, no database — it only proves outbound network access and that the
// workbook parses. Prints every tab it can see.
import * as XLSX from "xlsx";

const SHARE = process.argv[2] ||
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const APP_ID = "5cbed6ac-a083-4e14-b191-b4ba07653de2";

const step = (n, msg) => console.log(`${n}. ${msg}`);
const fail = (msg, hint) => { console.error(`\n❌ ${msg}\n   ${hint}`); process.exit(1); };

console.log("Checking OneDrive workbook access from this machine…\n");

step(1, "Requesting an anonymous token from api-badgerp.svc.ms …");
let token;
try {
  const res = await fetch("https://api-badgerp.svc.ms/v1.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ appId: APP_ID }),
  });
  if (!res.ok) fail(`Token request returned HTTP ${res.status}`, "The server cannot reach api-badgerp.svc.ms — allow outbound HTTPS to it (proxy/firewall).");
  token = (await res.json())?.token;
  if (!token) fail("Token response had no token field", "Microsoft may have changed the endpoint — report this.");
  console.log("   ✓ token received");
} catch (e) {
  fail(`Could not reach api-badgerp.svc.ms: ${e.message}`, "This is an outbound-network problem, not a permissions problem.");
}

step(2, "Looking up the shared file on my.microsoftpersonalcontent.com …");
const clean = SHARE.split("?")[0];
const b64 = Buffer.from(clean, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
let item;
try {
  const res = await fetch(
    `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/u!${b64}/driveitem?%24select=name,size,lastModifiedDateTime,%40content.downloadUrl`,
    { headers: { Authorization: `Badger ${token}`, Prefer: "autoredeem", "User-Agent": UA } },
  );
  if (res.status === 401 || res.status === 403) {
    fail(`Share lookup returned HTTP ${res.status}`, "The link is no longer 'anyone with the link can view', or it was replaced. Ask the client for a fresh view link.");
  }
  if (!res.ok) fail(`Share lookup returned HTTP ${res.status}`, "Check outbound access to my.microsoftpersonalcontent.com.");
  item = await res.json();
  console.log(`   ✓ ${item.name} · ${item.size} bytes · last modified ${item.lastModifiedDateTime}`);
} catch (e) {
  fail(`Could not reach my.microsoftpersonalcontent.com: ${e.message}`, "Allow outbound HTTPS to that host.");
}

step(3, "Downloading and parsing the workbook …");
let wb;
try {
  const res = await fetch(item["@content.downloadUrl"], { headers: { "User-Agent": UA } });
  if (!res.ok) fail(`Download returned HTTP ${res.status}`, "Allow outbound HTTPS to *.sharepoint.com / *.live.com download hosts.");
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    fail("Got an HTML page instead of a spreadsheet", "Usually means the link now demands a login. Ask the client for an 'anyone with the link' view link.");
  }
  wb = XLSX.read(buf, { type: "buffer" });
} catch (e) {
  fail(`Download or parse failed: ${e.message}`, "See the hint above.");
}

console.log(`\n✅ ACCESS OK — this machine can read the client's workbook with no credentials.\n`);
console.log(`Tabs found (${wb.SheetNames.length}):`);
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
  const widest = rows.reduce((m, r) => Math.max(m, r.filter((c) => String(c).trim() !== "").length), 0);
  console.log(`   • ${name} — ${Math.max(0, rows.length - 1)} data rows, up to ${widest} columns`);
}
console.log(`\nEvery tab above is snapshotted and diffed on each poll. Tabs added or removed later are picked up automatically.`);

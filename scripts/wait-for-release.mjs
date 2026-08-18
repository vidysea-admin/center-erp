// QA-124: wait until production is REALLY on a release, then say so once.
//
// Why this exists. ECS replaces tasks one at a time, so for a minute or two after every deploy the
// live site serves BOTH builds at once. A check fired the moment a release "lands" therefore
// straddles two versions, and the results are internally contradictory in ways that look exactly
// like defects: on 2026.08.14-53 /api/public/version still answered -52 while -53 features were
// already responding, two upload formats were accepted and two refused although the note listed all
// four, and five deletes returned 200/404/404/200/404. Every one of those would have been a defect
// report about a product that was fine.
//
// The fix is not cleverness, it is patience with a number attached: keep reading the public build
// marker until it has answered with the SAME release N times in a row. Anything less and you are
// measuring the rollout, not the build.
//
// This was hand-rolled four times in one day (-127 … -130) before anyone wrote it down, which is
// its own argument for a file.
//
//   node scripts/wait-for-release.mjs 2026.08.14-130
//   node scripts/wait-for-release.mjs 2026.08.14-130 --settle=6 --interval=10 --timeout=900
//   node scripts/wait-for-release.mjs --any            # just report what is live, no waiting
//
// Exit 0 once settled (and prints the note length + whether the archive leaked). Exit 1 on timeout,
// which is a real answer: the deploy did not land.
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const a = args.find((x) => x.startsWith(`--${flag}=`));
  return a ? Number(a.split("=")[1]) : dflt;
};
const want = args.find((a) => !a.startsWith("--"));
const ANY = args.includes("--any");
const SETTLE = num("settle", 6);            // consecutive agreeing reads
const INTERVAL = num("interval", 10) * 1000;
const TIMEOUT = num("timeout", 900) * 1000; // 15 min — a CodePipeline deploy is 4–10
const URL = process.env.ERP_VERSION_URL || "https://www.vidysea.com/erp/api/public/version";

if (!want && !ANY) {
  console.error("usage: node scripts/wait-for-release.mjs <release>   (or --any to just report)");
  process.exit(2);
}

const read = async () => {
  try {
    const r = await fetch(URL, { cache: "no-store" });
    return await r.json();
  } catch { return null; }
};

if (ANY) {
  const j = await read();
  console.log(j ? `live: ${j.release} · note ${String(j.note ?? "").length} chars · storage ${j.evidence_storage}` : "unreachable");
  process.exit(j ? 0 : 1);
}

// process.exit() from inside the poll loop trips a libuv assertion on Windows while a keep-alive
// socket is still closing. Set the code and break; the process ends on its own.
const started = Date.now();
let run = 0, last = "", flips = 0;
console.log(`waiting for ${want} · ${SETTLE} agreeing reads · every ${INTERVAL / 1000}s · giving up after ${TIMEOUT / 60000}m`);
for (;;) {
  if (Date.now() - started > TIMEOUT) {
    console.log(`\nNOT SETTLED after ${Math.round((Date.now() - started) / 60000)}m — last seen ${last || "(nothing)"}`);
    process.exitCode = 1;
    break;
  }
  const j = await read();
  const rel = j?.release ?? "?";
  // A flip back to the old build is the rollout in progress; it RESETS the run, which is the whole
  // point. Counting "6 reads that were mostly right" would defeat the exercise.
  if (rel !== last) { if (last) flips++; console.log(`${new Date().toISOString().slice(11, 19)}  ${rel}`); }
  run = rel === want && rel === last ? run + 1 : (rel === want ? 1 : 0);
  last = rel;
  if (run >= SETTLE) {
    const note = String(j.note ?? "");
    console.log(`\nSETTLED on ${rel} after ${flips} flip(s) during rollout`);
    console.log(`note: ${note.length} chars · mentions ${want.split("-").pop()}: ${note.includes("-" + want.split("-").pop())}`);
    console.log(`commit: ${j.commit ?? "(not set)"} · evidence storage: ${j.evidence_storage}`);
    process.exitCode = 0;
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}

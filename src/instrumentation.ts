// Runs once on server boot. Two background jobs:
//   1. the daily external-sheet crawl (RPL M2)
//   2. the alert engine (RPL M22)
// Both take a short-lived DB lock first, so running more than one app container never
// double-fires them. The lock uses the same `counters` collection pattern as batch codes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { dbConnect } = await import("@/lib/db");
  const { SyncSource, mongoose } = await import("@/models");
  const { runSync } = await import("@/lib/sync");
  const { runWatch, sourceAllowed } = await import("@/lib/workbook");
  const { evaluateAlerts } = await import("@/lib/alerts");

  // Identifies this container for lock ownership; uniqueness per boot is all that matters.
  const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // Returns true only for the instance that wins the lock for this window.
  async function takeLock(job: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const res = await mongoose.connection.db!.collection("job_locks").findOneAndUpdate(
      { _id: job as any, $or: [{ expires_at: { $lt: now } }, { expires_at: { $exists: false } }] },
      { $set: { holder: INSTANCE, expires_at: new Date(now.getTime() + ttlMs) } },
      { upsert: true, returnDocument: "after" },
    ).catch(() => null); // upsert races throw a duplicate key — that instance simply lost
    return !!res && (res as any).holder === INSTANCE;
  }

  const syncTick = async () => {
    try {
      await dbConnect();
      if (!(await takeLock("sync", 5 * 60_000))) return;
      const now = new Date();
      // -100 (QA-168, checker): this read the CONTAINER clock, which is UTC on Fargate — an admin
      // who set "Daily 07:00" got the sync at 12:30 IST. Everyone who types a time here means IST.
      const hhmm = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
      const sources = await SyncSource.find({ frequency: "Daily", mode: { $ne: "watch" }, active: { $ne: false } }).lean<any[]>();
      for (const s of sources) {
        if (!s.sync_time) continue;
        // -100: a row that is not the client workbook never runs, however it got into Mongo.
        if (!sourceAllowed(String(s.source_url)).ok) { console.log(`[sync-scheduler] skipping ${s.name}: not the client workbook`); continue; }
        const due = s.sync_time.slice(0, 5) <= hhmm;
        const doneToday = s.last_synced_at && new Date(s.last_synced_at).toDateString() === now.toDateString();
        if (due && !doneToday) {
          console.log(`[sync-scheduler] running daily sync: ${s.name}`);
          const res = await runSync(String(s._id)).catch((e) => ({ status: "Failed", error: String(e), created: 0 }));
          console.log(`[sync-scheduler] ${s.name}: ${res.status}, ${res.created} changes`);
        }
      }
      // Watch-mode sources (2026-08-11): poll every interval_minutes, not once a day.
      const watches = await SyncSource.find({ mode: "watch", active: { $ne: false } }).lean<any[]>();
      for (const s of watches) {
        // -100: the same gate on the watch side — this is the loop that kept polling our OWN
        // Google sheets every 5 minutes after a setup script re-armed them (checker QA-166).
        if (!sourceAllowed(String(s.source_url)).ok) { console.log(`[workbook-watch] skipping ${s.name}: not the client workbook`); continue; }
        const intervalMs = Math.max(5, s.interval_minutes ?? 30) * 60_000;
        if (s.last_synced_at && now.getTime() - new Date(s.last_synced_at).getTime() < intervalMs) continue;
        const res = await runWatch(String(s._id)).catch((e) => ({ status: "Failed", tabs: 0, changes: 0, error: String(e) }));
        console.log(`[workbook-watch] ${s.name}: ${res.status}, ${res.changes} change(s) across ${res.tabs} tab(s)${res.error ? " — " + res.error : ""}`);
      }
    } catch (e) {
      console.error("[sync-scheduler] tick failed:", e);
    }
  };

  const alertTick = async () => {
    try {
      await dbConnect();
      if (!(await takeLock("alerts", 9 * 60_000))) return;
      const { raised, checked } = await evaluateAlerts();
      if (raised) console.log(`[alerts] ${raised} new alert(s) across ${checked.length} rules`);
    } catch (e) {
      console.error("[alerts] tick failed:", e);
    }
  };

  // -108 follow-up (checker, 17/08): the certificate mapping preview stages file bytes so an
  // operator does not have to re-pick thirty files after correcting one mapping. The first cut only
  // cleaned those up when somebody previewed on the SAME batch again — so a preview opened once and
  // abandoned left its bytes in the bucket forever. That is the exact shape -101 closed three times
  // over, and "less often" is not "closed". This sweep does not depend on anyone coming back: any
  // staged certificate past its expiry is discarded wherever it is.
  const stagedSweep = async () => {
    try {
      await dbConnect();
      if (!(await takeLock("staged-certificates", 9 * 60_000))) return;
      const { StoredFile, CandidateResult } = await import("@/models");
      const { removeStoredFile } = await import("@/lib/storage");
      const { BASE_PATH } = await import("@/lib/base-path");
      const stale = await StoredFile.find({
        staged_certificate: true, status: "ready", expires_at: { $lt: new Date() },
      }).select("name entity_id").limit(500).lean<any[]>();
      let gone = 0;
      for (const f of stale) {
        const url = `${BASE_PATH}/api/files/` + f.name;
        // Belt and braces: never discard something a record ended up pointing at.
        if (await CandidateResult.exists({ certificate_file: url })) {
          await StoredFile.updateOne({ name: f.name }, { $set: { staged_certificate: false }, $unset: { expires_at: "" } });
          continue;
        }
        await removeStoredFile(url, null).catch(() => null);
        gone++;
      }
      if (gone) console.log(`[staged-certificates] discarded ${gone} certificate(s) staged for mapping and never attached`);
    } catch (e) {
      console.error("[staged-certificates] sweep failed:", e);
    }
  };

  setInterval(syncTick, 60_000);
  setInterval(alertTick, 10 * 60_000);
  setInterval(stagedSweep, 30 * 60_000);
  setTimeout(alertTick, 15_000); // one pass shortly after boot
  setTimeout(stagedSweep, 45_000);
  console.log("[scheduler] registered — sheet sync every minute, alerts every 10 minutes, staged-certificate sweep every 30");
}

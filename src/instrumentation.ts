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
  const { runWatch } = await import("@/lib/workbook");
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
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const sources = await SyncSource.find({ frequency: "Daily", mode: { $ne: "watch" } }).lean<any[]>();
      for (const s of sources) {
        if (!s.sync_time) continue;
        const due = s.sync_time.slice(0, 5) <= hhmm;
        const doneToday = s.last_synced_at && new Date(s.last_synced_at).toDateString() === now.toDateString();
        if (due && !doneToday) {
          console.log(`[sync-scheduler] running daily sync: ${s.name}`);
          const res = await runSync(String(s._id)).catch((e) => ({ status: "Failed", error: String(e), created: 0 }));
          console.log(`[sync-scheduler] ${s.name}: ${res.status}, ${res.created} changes`);
        }
      }
      // Watch-mode sources (2026-08-11): poll every interval_minutes, not once a day.
      const watches = await SyncSource.find({ mode: "watch" }).lean<any[]>();
      for (const s of watches) {
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

  setInterval(syncTick, 60_000);
  setInterval(alertTick, 10 * 60_000);
  setTimeout(alertTick, 15_000); // one pass shortly after boot
  console.log("[scheduler] registered — sheet sync every minute, alerts every 10 minutes");
}

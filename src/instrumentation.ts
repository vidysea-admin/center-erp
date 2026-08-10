// Runs once on server boot. Schedules the daily sheet crawl: every minute, any SyncSource
// with frequency "Daily" whose sync_time (HH:MM) has arrived and which hasn't synced today
// gets run. Failures are recorded on the source itself (last_status / last_error).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { dbConnect } = await import("@/lib/db");
  const { SyncSource } = await import("@/models");
  const { runSync } = await import("@/lib/sync");

  const tick = async () => {
    try {
      await dbConnect();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const sources = await SyncSource.find({ frequency: "Daily" }).lean<any[]>();
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
    } catch (e) {
      console.error("[sync-scheduler] tick failed:", e);
    }
  };

  setInterval(tick, 60_000);
  console.log("[sync-scheduler] registered — checking Daily sources every minute");
}

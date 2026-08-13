// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-4";
export const RELEASE_NOTE =
  "Table-UX cycle (Umesh live-usage feedback): every table gets built-in all-column search, " +
  "per-column value filters (header funnel with counts) and drag-to-resize columns — built into " +
  "the shared DataTable so all 22 tables behave the same. Self-registration link now lands in a " +
  "selectable panel instead of a browser alert; every copy button flashes Copied ✓. Timestamps " +
  "(Sheet Watch Detected, sync, imports, notifications) render as IST am/pm — '13 Aug 2026, 2:45 pm'. " +
  "Drawer multi-selects full-width with hover titles (no more clipped centre names). " +
  "Server: ?q= regex-escaped (q=( was a 500); candidate search covers alt phone, source, CAN_ id.";

// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-11";
export const RELEASE_NOTE =
  "Umesh's screenshot round: the sheet's MERGED Institution cells are now resolved, so the " +
  "two dropped Basti rows are back — the dashboard says 31 approved job-role rows exactly " +
  "like the sheet's own count (Excel Count 32 = header + 31). Placeholder text ('Pending') " +
  "typed into TC ID/password cells is blanked, never stored as an identifier. Counts are " +
  "labelled so rows-vs-centres can never read as a contradiction. One 'Sheet Sync' nav " +
  "entry hosts Sheet Watch + Sync Inbox as tabs. Every drill-down page has a Back button. " +
  "OPERATIONS.md gains the post-deploy live-smoke checklist (run after every merge).";

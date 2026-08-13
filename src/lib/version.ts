// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-3";
export const RELEASE_NOTE =
  "Sheet-grain locations + visible scrolling (Umesh): the locations list now uses the " +
  "workbook's own grain — one row per centre × job-role, merged-cell style (repeated " +
  "centre cells dim to a ditto mark), so nothing is clubbed and every sheet row is a " +
  "table row. Every wide table also gets a synced TOP scrollbar plus always-visible " +
  "scrollbar styling — no more discovering sideways scroll at the very bottom of the page."; the signup page now routes candidates to " +
  "their portal and trainers to /p/trainer-apply. Trainers apply THEMSELVES: a public " +
  "Hinglish form (fresh, rate-limited, honeypot) or Divya's Quick-invite — naam+phone se " +
  "single-use link bana, WhatsApp se bhejo, trainer khud qualification/experience/skills " +
  "bhare, profile pipeline mein Applied pe aati hai. Applicants can never touch pay, TR " +
  "ID, or pipeline stage.";

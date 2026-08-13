// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-6";
export const RELEASE_NOTE =
  "Evening bundle: candidate portal (/p/me — registered mobile (+DOB when on file) opens the " +
  "candidate's own My Training page: centre, trainer, dates, SIDH registration, attendance + " +
  "eligibility, exam date, result & certificate; pool candidates see their registration " +
  "status). Tables get a min-width floor (wide tables scroll instead of crushing columns; " +
  "Sheet Watch/Sync diffs get room; cells top-align). Home KPIs carry paired counts (active+" +
  "completed, approved+pending, enrolled of pool, open+fulfilled). Program funnels always-on. " +
  "Rule 38: scoped users now see only trainers tied to their centres.";

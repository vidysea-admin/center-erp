// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.12-8";
export const RELEASE_NOTE =
  "Sign-in restored (AUTH_URL with a path was refusing every auth action). Audit remediation: " +
  "location scope can no longer be widened by a query parameter; assessment and certification " +
  "require evidence before an invoice can be raised; a password/email is treated as a privilege; " +
  "a rejected certificate no longer strands a batch; a same-day drop no longer locks that day's " +
  "attendance; attendance dates are timezone-independent; Rule 39 applies to every write route; " +
  "the audit trail is location-scoped; demotion and deactivation reach live sessions; sheet sync " +
  "rejects malformed targets and truncated rows, defers a close while batches run, and honours " +
  "the approval matrix";

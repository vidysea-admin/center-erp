// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-50";
export const RELEASE_NOTE =
  "Team feedback round 2 (Umesh 15/08): pipeline BYPASS as a grantable " +
  "right - an admin (or anyone granted pipeline.bypass) can set any trainer " +
  "status directly, double-confirmed in the UI, signed on the profile and " +
  "in the audit log; the docs/NSDC/TOT gates deliberately do not run. " +
  "Candidate fees are OFF for this programme (drawer fields and the Fee " +
  "Paid stage removed; the Rule 54 toggle stays dormant for the day fees " +
  "return). Email is now mandatory alongside phone on candidate " +
  "self-registration and the public trainer application - the mail " +
  "pipeline is coming and every new contact must carry an address. Also: " +
  "the app-side upload size cap is GONE (Umesh: no cap, space is not a " +
  "constraint) - the only remaining limit is the proxy's multipart body " +
  "cap, which devops is raising.";

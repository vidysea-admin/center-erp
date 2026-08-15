// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-67";
export const RELEASE_NOTE =
  "QA-126/127 (+QA-037/128 riders): the user manual is rewritten for " +
  "the product that actually shipped - the CEO-vocabulary pipeline " +
  "stages, journey buckets, the truthful trainer dropdown, TR ID " +
  "flags, the delete verb, Activity tabs, the OTP enrolment path, " +
  "three-level rights, the mail panel, masters and institution IDs. " +
  "It is role-filtered now: the Help button passes the reader's role " +
  "and the manual hides screens that role cannot open (display " +
  "filtering only, never a gate; ?role= empty shows everything). The " +
  "roles table tells the truth about Operations - the stale sheet-" +
  "sync claims are gone and the ledgers are named as the Admin's. " +
  "English-only, e2e-pinned (no Devanagari).";

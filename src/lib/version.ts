// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-52";
export const RELEASE_NOTE =
  "QA-114 (S1, checker 15/08): the white page that locked Trainer, SPOC " +
  "and Enrollment out of the product is fixed. Root cause: the lean Home " +
  "payload (QA-096 trim) omits the org-wide queue keys, and the client " +
  "read .length on the absent follow_ups key - one undefined killed the " +
  "whole React tree. Queue sections now render on KEY PRESENCE (absent = " +
  "not for this role = hidden), and a proper error boundary means no " +
  "future client exception can ever white-screen the app again. Also " +
  "SEC-01: credentials scrubbed from the repository (OPERATIONS/SECURITY " +
  "no longer carry any real password; the CI test password is its own " +
  "throwaway with no relation to production).";

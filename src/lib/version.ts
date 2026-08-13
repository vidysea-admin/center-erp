// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-10";
export const RELEASE_NOTE =
  "CEO round-2, Cycle G — the role matrix Umesh specified: a principal/SPOC (Location role) " +
  "is admin-like WITHIN their centre — can add/edit trainers and candidates and upload " +
  "certificates — but attendance is the trainer's alone (no daily-log entry, no govt import), " +
  "batch status moves are Operations/Admin's, and accounts stay invisible. Trainer logins " +
  "keep exactly their own batch's daily log. UI now matches the server: no Costs tab, no " +
  "transition buttons, read-only attendance view for principals; govt-attendance nav is " +
  "Admin/Ops only. Sample logins gain trainer.jpr03 and a separate view-only reviewer.";

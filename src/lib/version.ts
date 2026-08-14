// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-51";
export const RELEASE_NOTE =
  "Team feedback round 2, part 3 (Umesh 15/08): user DROP - soft delete " +
  "with a plain-words confirm. The row stays so the logs and everything " +
  "the person created keep their names, the login dies immediately, and " +
  "the email address is freed so a fresh account can be made (drop then " +
  "recreate). Dropped accounts are terminal - no edits, no revival - and " +
  "hidden behind a Show-dropped toggle on the Users tab. And custom " +
  "columns on every bulk upload: a column the ERP does not recognise is " +
  "named in the preview and, accepted (the default), each row's values " +
  "are stored under the sheet's own column name and shown as 'Extra " +
  "columns (from import)' on the candidate, trainer and batch - new " +
  "columns are never restricted away.";

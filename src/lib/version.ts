// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-26";
export const RELEASE_NOTE =
  "A batch with no students now says so, loudly and undismissably: upload the " +
  "roster, import candidates, or (Admin) delete the empty shell. DELETE " +
  "/api/batches/[id] is Admin-only and proves emptiness itself - a batch " +
  "carrying members, results, costs, logs, closure, attendance or an invoice is " +
  "refused BY NAME and must be cancelled instead, never deleted (Umesh, 14/08: " +
  "'agar data ka koi source nahi hai toh remove that').";

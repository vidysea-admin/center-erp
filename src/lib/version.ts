// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-63";
export const RELEASE_NOTE =
  "QA-131/140/138/139/132: money and honesty. The scheme master's " +
  "amount_received - the one field the CEO called admin-only - was " +
  "readable by every signed-in role; now only Admin sees it (hours " +
  "stay open) and the lazy seed is Admin-only too. The invoice book " +
  "gets the same R-E guard the cost ledger has - Operations raises " +
  "work, Admin reads the book. The batch form's slot rule now runs " +
  "while you type (same function the API blocks with - slot-rules.ts, " +
  "one source), and an ignored earliest-possible-start warns at save " +
  "on both client and API (never blocks). Mail attempts get an Admin " +
  "panel that tells the truth: 'sent' means SES accepted it, delivery " +
  "is not confirmed.";

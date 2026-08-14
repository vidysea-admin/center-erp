// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-62";
export const RELEASE_NOTE =
  "QA-136/137: the audit trail becomes visible. It was ALWAYS written - " +
  "every create/patch through the generic layer logs entity, field, " +
  "old->new and the actor - but only batches and locations had a " +
  "surface. Now: Activity tab on the trainer detail (scoped via the " +
  "same QA-125 nomination/home/capable union as the list), and an " +
  "Admin-only per-user activity view (/api/audit/by-user + an Activity " +
  "drawer on Users & Access, dropped accounts included) - 'what did " +
  "this person do' finally has an answer. Scoped roles are refused the " +
  "per-user view by design: a cross-centre trail would be a Rule 38 " +
  "back door.";

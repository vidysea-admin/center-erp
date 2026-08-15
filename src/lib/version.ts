// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-94";
export const RELEASE_NOTE =
  "-93 rider: the storage health now says WHO this container is on AWS - a signed " +
  "STS GetCallerIdentity with the same credentials the WIF exchange uses, ARN " +
  "only - so the pool binding (roles/iam.workloadIdentityUser for that " +
  "principal) can be made without asking devops for the task role ARN. Prod " +
  "already reports: WIF file present, region ap-south-1, ECS credential " +
  "endpoint present, AWS_ECS_FARGATE - the exact case the resolver was built " +
  "for. Missing now: the bucket name (GCS_BUCKET / DEFAULT_GCS_BUCKET) and " +
  "Umesh's IAM (bucket + objectAdmin + workloadIdentityUser).";

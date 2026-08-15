// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-93";
export const RELEASE_NOTE =
  "GCS via Workload Identity Federation - no secret in the container. Umesh's " +
  "external_account config (no private key) is baked into the image at " +
  "config/gcs-wif.json; the container proves who it is with its AWS task role " +
  "and Google returns a token for the impersonated service account. The " +
  "file's own credential_source points at EC2 IMDS, which ECS/Fargate does " +
  "not have - so AWS credentials come from the AWS SDK's default provider " +
  "chain (ECS task role, EC2 instance role, env) via google-auth-library's " +
  "aws_security_credentials_supplier. Only the bucket name is needed " +
  "(GCS_BUCKET env or the DEFAULT_GCS_BUCKET constant). Health/diagnostic " +
  "name the WIF identity, the AWS environment, and the probe classifies a " +
  "failure as STS trust / impersonation / bucket IAM / no AWS creds so the " +
  "console fix is obvious. Signed URLs are not used anywhere (server-opened " +
  "resumable sessions + proxied reads), so no signBlob rights are needed.";

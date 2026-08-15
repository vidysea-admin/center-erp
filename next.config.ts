import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/erp", // keep in sync with src/lib/base-path.ts
  output: "standalone", // small self-contained server bundle for Docker
  // -93: the storage adapter requires these lazily; keep them as runtime node modules (traced into
  // the standalone bundle) instead of letting Turbopack bundle the AWS SDK's IMDS provider into
  // every graph — it panicked doing so for the edge instrumentation build.
  serverExternalPackages: ["@google-cloud/storage", "google-auth-library", "googleapis", "sharp"],
  // QA-099 (checker): the app sent NO security headers — it could be framed from any
  // site (an ERP full of Aadhaar/PAN data), and nothing pinned HTTPS. CSP is deliberately
  // Report-Only for now: Next inlines scripts/styles, and a blocking policy needs its own
  // verification round — the frame/sniff/HSTS floor must not wait for that.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy-Report-Only",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

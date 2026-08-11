import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/erp", // keep in sync with src/lib/base-path.ts
  output: "standalone", // small self-contained server bundle for Docker
};

export default nextConfig;

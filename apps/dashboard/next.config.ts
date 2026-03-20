import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  transpilePackages: ["@opendum/shared"],
  outputFileTracingIncludes: {
    "/**": ["../../packages/shared/models/**/*.toml"],
  },
};

export default nextConfig;

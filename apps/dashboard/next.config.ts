import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@opendum/shared"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  outputFileTracingIncludes: {
    "/**": ["../../packages/shared/models/**/*.toml"],
  },
};

export default nextConfig;

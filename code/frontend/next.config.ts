import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // The shared API contract is a TS-source workspace package; Next must transpile it.
  transpilePackages: ["@extensions/contract"],
};

export default nextConfig;

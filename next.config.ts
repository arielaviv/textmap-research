import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Bundle the OSM slice into the repr-eval API functions so the runtime fs read
  // resolves on Vercel (untraced data files are otherwise dropped from the bundle).
  outputFileTracingIncludes: {
    "/api/experiments/repr-eval/**": ["./data/osm/**"],
  },
};

export default nextConfig;

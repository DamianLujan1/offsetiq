import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Screen mode's agent (agent/server.py) runs in this same deployment as a Python Function,
  // api/screening.py. Off Vercel it runs separately: python3 -m agent.server (npm run agent).
  async rewrites() {
    return [{
      source: "/api/agent/:path*",
      destination: process.env.VERCEL ? "/api/screening"
        : `${process.env.OFFSETIQ_AGENT_URL ?? "http://127.0.0.1:8765"}/api/agent/:path*`,
    }];
  },
  async headers() {
    return [
      {
        source: "/data/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }],
      },
    ];
  },
};

export default nextConfig;

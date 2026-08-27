import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` resolves its optional native/edge helpers at runtime, which the
  // bundler can't follow. Leaving it external keeps those requires intact.
  serverExternalPackages: ["pg"],
  experimental: {
    serverActions: {
      // The profile page uploads documents through a Server Action, and the
      // default 1MB cap rejects an ordinary scanned PDF. The headroom above
      // covers multipart boundary and header overhead.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;

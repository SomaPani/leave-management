import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

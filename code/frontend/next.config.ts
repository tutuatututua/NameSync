import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  async redirects() {
    return [
      { source: '/delete-confirm', destination: '/history', permanent: false },
      { source: '/history-empty', destination: '/history', permanent: false },
      { source: '/save-modal', destination: '/history', permanent: false },
      { source: '/process-merge', destination: '/', permanent: false },
      { source: '/upload-continue', destination: '/', permanent: false },
      { source: '/upload-selected', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;

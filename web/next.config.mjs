// The browser always calls relative /api/v1/... In production the app and API share team07.xtradot.co.
// For local development (or if the API runs as a separate in-cluster service) set API_BASE_URL.
const apiBase = process.env.API_BASE_URL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    if (!apiBase) return [];
    return [{ source: '/api/v1/:path*', destination: `${apiBase}/api/v1/:path*` }];
  },
};

export default nextConfig;

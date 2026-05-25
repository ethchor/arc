// Security headers (docs/12 §12.1, docs/16). 'unsafe-eval' is dev-only (React Refresh);
// production should tighten script-src further with a nonce-based CSP via middleware.
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  "connect-src 'self' http://localhost:3001",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@arc-vault/sdk", "@arc-vault/crypto"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;

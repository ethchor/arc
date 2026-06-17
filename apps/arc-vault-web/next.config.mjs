// Security headers (docs/12 §12.1, docs/16). 'unsafe-eval' is dev-only (React Refresh);
// production should tighten script-src further with a nonce-based CSP via middleware.
const isDev = process.env.NODE_ENV !== "production";
// Static export for the Tauri desktop frontend (NEXT_OUTPUT=export). Standalone web builds
// leave this unset and keep SSR + the CSP response headers below.
const isExport = process.env.NEXT_OUTPUT === "export";

const csp = [
  "default-src 'self'",
  // api.pwnedpasswords.com: the opt-in HIBP breach check (k-anonymity — only the first 5
  // chars of a password's SHA-1 are ever sent; see lib/breach.ts). The single permitted
  // third-party egress; everything else stays same-origin.
  "connect-src 'self' http://localhost:3001 https://api.pwnedpasswords.com",
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
  transpilePackages: ["@arc/sdk", "@arc/crypto", "@arc/workflows"],
  // Desktop: static export; CSP is served by the Tauri shell (tauri.conf.json app.security.csp).
  // Standalone web: SSR with the CSP/security response headers below.
  ...(isExport
    ? { output: "export" }
    : {
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
      }),
};

export default nextConfig;

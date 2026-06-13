import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

// PWA metadata. `manifest` links the install spec (`public/manifest.json`).
// Apple-specific tags survive iOS Safari's "Add to Home Screen": they pin
// the status-bar style and force standalone launch.
export const metadata: Metadata = {
  title: "arc — secrets vault",
  description: "Zero-knowledge end-to-end-encrypted vault. Passwords, passkeys, TOTP, notes, sharing — all client-encrypted; the server stores ciphertext only.",
  applicationName: "arc",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "arc",
  },
  formatDetection: { telephone: false, email: false, address: false },
};

// `viewport-fit=cover` lets the layout extend under the iOS notch / Android
// gesture bar so the page can paint a true full-bleed PWA experience.
// Theme colour matched per-scheme so the iOS status bar tint stays sensible
// in either appearance.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7ff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0a1a" },
  ],
};

// Service-worker bootstrap. Lives inline (the CSP already allows
// 'unsafe-inline' for scripts) so the worker registers without an extra
// network round-trip. `load` defer keeps it off the critical path.
const SW_REGISTER = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* opt-out: never break the page if SW fails */ });
  });
}
`.trim();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
        <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
      </body>
    </html>
  );
}

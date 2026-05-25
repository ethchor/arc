import type { ReactNode } from "react";

export const metadata = {
  title: "arc-vault",
  description: "Zero-knowledge encrypted vault",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

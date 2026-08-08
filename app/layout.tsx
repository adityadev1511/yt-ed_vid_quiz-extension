import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "YT Quiz Tool — Phase 0",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

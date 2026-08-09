import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Watching isn't learning.",
  description:
    "Paste a video transcript and get a quiz that tests whether you can apply the concepts to new situations — not whether you remember the examples.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}

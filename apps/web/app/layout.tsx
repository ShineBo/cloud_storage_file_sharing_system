import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cloud Storage",
  description: "A private workspace to organize work files and share them with approved colleagues and groups.",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f6f8f5",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

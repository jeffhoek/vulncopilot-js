import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "VulnCopilot",
  description: "RAG chatbot over CISA KEV + NIST NVD vulnerability data.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

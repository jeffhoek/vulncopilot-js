import type { ReactNode } from "react";

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

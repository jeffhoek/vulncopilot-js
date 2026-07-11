import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "VulnCopilot",
  description: "RAG chatbot over CISA KEV + NIST NVD vulnerability data.",
};

// Resolve the theme before first paint so there's no flash of the wrong palette:
// an explicit user choice in localStorage wins, otherwise follow the OS preference.
// This runs before React hydrates, hence suppressHydrationWarning on <html> below.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
      </body>
    </html>
  );
}

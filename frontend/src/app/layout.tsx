import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppShell } from "@/components/layout/AppShell";

export const metadata: Metadata = {
  title: "Minfy MiMo AI Hub",
  description: "Minfy's interview and meeting intelligence hub",
  icons: {
    icon: "/minfy-ai-logo.png",
    shortcut: "/minfy-ai-logo.png",
    apple: "/minfy-ai-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="antialiased"
      style={{
        ['--font-geist-sans' as string]: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        ['--font-geist-mono' as string]: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
      }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            const saved = localStorage.getItem('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDarkMode = saved ? saved === 'dark' : true;
            if (isDarkMode) document.documentElement.classList.add('dark');
          })()
        ` }} />
      </head>
      <body>
        <AuthProvider>
          <AppShell>
            {children}
          </AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}

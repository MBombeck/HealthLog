import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AuthShell } from "@/components/layout/auth-shell";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "HealthLog",
  description: "Personal health tracking — weight, blood pressure, medications",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#282a36",
};

// Inline script to apply theme before first paint (prevents FOUC)
const themeScript = `(function(){try{var t=localStorage.getItem("healthlog-theme");var c=(t==="light"||t==="dark")?t:(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");document.documentElement.classList.add(c)}catch(e){document.documentElement.classList.add("dark")}})()`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? "";

  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Providers>
          <AuthShell>{children}</AuthShell>
        </Providers>
      </body>
    </html>
  );
}

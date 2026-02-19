import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { BottomNav } from "@/components/layout/bottom-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { TopBar } from "@/components/layout/top-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HealthLog",
  description: "Personal health tracking — weight, blood pressure, medications",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#282a36",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>
          <div className="flex h-dvh flex-col md:flex-row">
            <SidebarNav />
            <div className="flex min-h-0 flex-1 flex-col">
              <TopBar />
              <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
                <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                  {children}
                </div>
              </main>
            </div>
            <BottomNav />
          </div>
        </Providers>
      </body>
    </html>
  );
}

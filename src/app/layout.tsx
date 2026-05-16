import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers, cookies } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AuthShell } from "@/components/layout/auth-shell";
import { MonitoringBootstrap } from "@/components/monitoring/bootstrap";
import { WebVitalsReporter } from "@/components/monitoring/web-vitals-reporter";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";

async function resolveInitialLocale(): Promise<Locale> {
  // Both cookies() and headers() can throw (DynamicServerError, etc.) —
  // fall back to the default so a locale hiccup never crashes the root
  // layout into global-error.tsx.
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get("healthlog-locale")?.value;
    if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
      return cookieLocale as Locale;
    }
    const headerList = await headers();
    return parseLocaleFromAcceptLanguage(headerList.get("accept-language"));
  } catch {
    return "en";
  }
}

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "HealthLog",
  description:
    "Personal health tracking — weight, blood pressure, pulse, mood, medication compliance",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.svg",
    apple: "/logo-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HealthLog",
  },
  openGraph: {
    title: "HealthLog",
    description:
      "Personal health tracking — weight, blood pressure, pulse, mood, medication compliance",
    type: "website",
    locale: "en_US",
    alternateLocale: ["de_DE", "fr_FR", "es_ES", "it_IT", "pl_PL"],
    siteName: "HealthLog",
  },
  twitter: {
    card: "summary",
    title: "HealthLog",
    description:
      "Personal health tracking — weight, blood pressure, pulse, mood, medication compliance",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#282a36",
};

// Inline script to apply theme before first paint (prevents FOUC)
const themeScript = `(function(){try{var t=localStorage.getItem("healthlog-theme");var c=(t==="light"||t==="dark")?t:(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");document.documentElement.classList.add(c)}catch(e){document.documentElement.classList.add("dark")}})()`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce =
    process.env.NODE_ENV === "production"
      ? ((await headers()).get("x-nonce") ?? undefined)
      : undefined;

  const initialLocale = await resolveInitialLocale();

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <head>
        <script
          suppressHydrationWarning
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Providers initialLocale={initialLocale}>
          <MonitoringBootstrap />
          <WebVitalsReporter />
          <AuthShell>{children}</AuthShell>
        </Providers>
      </body>
    </html>
  );
}

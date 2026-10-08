import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AuthShell } from "@/components/layout/auth-shell";
import { MonitoringBootstrap } from "@/components/monitoring/bootstrap";
import { WebVitalsReporter } from "@/components/monitoring/web-vitals-reporter";
import { resolveInitialLocale } from "@/lib/i18n/resolve-initial-locale";
import { isKeyMismatch } from "@/lib/boot/key-mismatch-state";
import { THEME_BOOT_SCRIPT, THEME_COLOR } from "@/lib/pwa/theme-color";
import { KeyMismatchPage } from "./key-mismatch-page";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "HealthLog",
  description:
    "Self-hosted health tracker — weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync, transparent derived wellness metrics, AI Insights you own.",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.svg",
    // Pre-flattened 180×180 on the app background — Safari ignores PNG
    // alpha in favourites/home-screen tiles and would render the
    // transparent logo on a white slab otherwise.
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HealthLog",
  },
  openGraph: {
    title: "HealthLog",
    description:
      "Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own.",
    type: "website",
    locale: "en_US",
    alternateLocale: ["de_DE", "fr_FR", "es_ES", "it_IT", "pl_PL"],
    siteName: "HealthLog",
    // Drop-in OG asset. Replace with a 1200×630 dashboard-screenshot
    // capture when an official one ships; the logo render keeps the
    // unfurl from rendering a blank tile in the meantime.
    images: [
      {
        url: "/logo-readme.png",
        width: 1000,
        height: 1000,
        alt: "HealthLog — your health data, your server",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "HealthLog",
    description:
      "Self-hosted health tracker. Weight, blood pressure, glucose, mood, medications. Withings + Apple Health sync. AI Insights you own.",
    images: ["/logo-readme.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Match the browser chrome (Android URL bar, iOS PWA status bar) to
  // the active palette. The hex values are the resolved background of
  // `--background` from `app/globals.css` for each theme so the bar
  // edge never seams against the page on cold paint.
  // The client rewrites both to the app's own theme once it is known
  // (`applyThemeColor`), since that need not be the operating system's.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

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
          // Applies the theme (and its status-bar colour) before
          // first paint, so neither flashes the wrong theme.
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
        {/*
          Locale-catalog boot script (generated into public/i18n/ by
          scripts/generate-i18n-boot.mjs, a prebuild/predev step).
          Replaces the former RSC-prop handoff that inlined the whole
          active catalog into every document's flight payload (392 KB of a
          505 KB dashboard HTML). Served as a static asset: ETag
          revalidation (304 on repeat loads) + SW cache-first on the
          versioned URL replace the per-document payload.

          `beforeInteractive` is load-bearing, not a preference. The
          catalog has to be in hand when the client bundle takes its FIRST
          render, or `t()` resolves raw keys against an empty bundle while
          the server HTML carries real text — React tears the tree down
          with hydration error #418 and the user watches a frame of
          `nav.skipToContent` before the provider's backfill lands. A plain
          `<script defer>` cannot promise that: Next emits its own chunks
          as `async` tags AHEAD of this element in `<head>`, and an `async`
          script runs the moment its fetch settles, so the 370 KB catalog
          was simply racing the app bundle — and lost about a third of the
          time on a cold load. `beforeInteractive` hands the URL to Next's
          own bootstrap, which awaits it before requiring a single app
          module (`next/dist/client/app-bootstrap.js`), and pairs it with a
          `<link rel=preload>` so the download still starts with the
          document rather than after it.
        */}
        <Script
          id="healthlog-i18n-boot"
          strategy="beforeInteractive"
          nonce={nonce}
          src={`/i18n/${initialLocale}.js?v=${process.env.NEXT_PUBLIC_APP_VERSION || "dev"}`}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {isKeyMismatch() ? (
          // The boot key check refused this process: no app shell, no data
          // reads, one page that names the fix.
          <KeyMismatchPage locale={initialLocale} />
        ) : (
          <Providers initialLocale={initialLocale}>
            <MonitoringBootstrap />
            <WebVitalsReporter />
            {/* `DEMO_MODE` is a server-only env var; the proxy uses it to
              block mutations. Resolve it here (server component) and
              thread the boolean into the client shell so the demo
              banner can render without a client-side detection path. */}
            <AuthShell demoMode={process.env.DEMO_MODE === "true"}>
              {children}
            </AuthShell>
          </Providers>
        )}
      </body>
    </html>
  );
}

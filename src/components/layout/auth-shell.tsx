"use client";

import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AchievementUnlockNotifier } from "@/components/gamification/achievement-unlock-notifier";
import { MaintainershipBanner } from "@/components/i18n/maintainership-banner";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { BottomNav } from "./bottom-nav";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

// v1.4.27 MB6 — `/about` joins the public-path list so the GeoLite2
// CC BY-SA 4.0 attribution stays reachable for unauthenticated
// visitors. The `/about` route is already registered in `proxy.ts`
// PUBLIC_PATHS; this constant gates the client-side auth shell, and
// both lists must agree or the route round-trips through the
// sign-in redirect.
const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/register",
  "/privacy",
  "/about",
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { t } = useTranslations();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  // v1.4.26 — `/privacy` is a long-form legal page that brings its own
  // header + footer. Centering it inside the public-page wrapper would
  // squash a 3000-word policy into a "login card" layout, so we let it
  // render edge-to-edge while still resolving as a public page for the
  // auth gate above.
  // v1.4.27 MB6 — `/about` follows the same shape (own header, own
  // footer, full-width body), so it joins the standalone list.
  const isStandalonePublicPage =
    pathname.startsWith("/privacy") || pathname.startsWith("/about");
  const isAdminPage = pathname.startsWith("/admin");
  const isOnboardingPage = pathname === "/onboarding";
  const showUnlockNotifier = isAuthenticated && !isPublicPage && !!user?.id;

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicPage) {
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, isPublicPage, router]);

  // Redirect non-admins away from /admin
  useEffect(() => {
    if (
      !isLoading &&
      isAuthenticated &&
      isAdminPage &&
      user?.role !== "ADMIN"
    ) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, isAdminPage, user?.role, router]);

  // v1.4.22 C4 — onboarding redirect moved to proxy.ts so it lands on
  // the first server response instead of post-hydration. The proxy
  // reads the `hl_onboarding` cookie (mirrored from the DB by the auth
  // routes) and 307s to /onboarding before this shell ever paints. The
  // previous `useEffect`-based redirect caused a brief dashboard flash
  // for users with `onboardingCompletedAt === null`.

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  // Public pages (login, register) — render without any nav
  if (isPublicPage) {
    // Long-form legal pages render edge-to-edge with their own chrome.
    if (isStandalonePublicPage) {
      return <>{children}</>;
    }
    return (
      <div className="flex h-dvh flex-col">
        <MaintainershipBanner />
        <main
          id="main-content"
          className="flex flex-1 items-center justify-center px-4"
        >
          {children}
        </main>
      </div>
    );
  }

  // Not authenticated, waiting for redirect
  if (!isAuthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  // Onboarding page — minimal shell, no sidebar/nav
  if (isOnboardingPage) {
    return (
      <>
        {showUnlockNotifier && user?.id ? (
          <AchievementUnlockNotifier userId={user.id} />
        ) : null}
        <div className="flex min-h-dvh flex-col">
          <MaintainershipBanner />
          <div className="flex flex-1 items-center justify-center px-4 py-8">
            {children}
          </div>
        </div>
      </>
    );
  }

  // Authenticated — full app shell
  return (
    <>
      {showUnlockNotifier && user?.id ? (
        <AchievementUnlockNotifier userId={user.id} />
      ) : null}
      {/*
        Keyboard-only skip link. The non-focused state has both
        `pointer-events-none` (so a mouse click in the top-left corner
        passes through to the logo behind it) AND `-translate-y-full`
        (so even an accidental tap with stylus / touch can't activate
        it). Focus restores both — the element jumps back into the
        viewport and becomes clickable.
      */}
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground pointer-events-none fixed top-2 left-2 z-[100] -translate-y-full rounded-md px-4 py-2 text-sm font-medium opacity-0 transition-transform focus:pointer-events-auto focus:translate-y-0 focus:opacity-100"
      >
        {t("nav.skipToContent")}
      </a>
      <div className="flex h-dvh flex-col md:flex-row">
        <SidebarNav />
        <div className="flex min-h-0 flex-1 flex-col">
          <MaintainershipBanner />
          <TopBar />
          <main
            id="main-content"
            className="flex-1 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0"
          >
            {/*
              v1.4.33 IW9 — container normalised on `max-w-screen-xl`
              (1280 px) so dashboard / settings / admin / bugreport all
              hit the same content frame. Pre-v1.4.33 the dashboard
              shell capped at `max-w-[76.8rem]` (1228 px) while the
              settings/admin shells used `max-w-screen-xl`, producing a
              52 px lateral wobble on every route switch. Same audit
              note in `.planning/round-v1433-audit-polish.md` §4.2.
            */}
            <div className="mx-auto max-w-screen-xl px-4 py-6 md:px-6">
              {children}
            </div>
          </main>
        </div>
        <BottomNav />
      </div>
    </>
  );
}

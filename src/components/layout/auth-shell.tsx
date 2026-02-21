"use client";

import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AchievementUnlockNotifier } from "@/components/gamification/achievement-unlock-notifier";
import { useAuth } from "@/hooks/use-auth";
import { BottomNav } from "./bottom-nav";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

const PUBLIC_PATHS = ["/auth/login", "/auth/register"];

export function AuthShell({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
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

  // Redirect to onboarding if not completed
  useEffect(() => {
    if (
      !isLoading &&
      isAuthenticated &&
      !isOnboardingPage &&
      !isPublicPage &&
      user &&
      !user.onboardingCompletedAt
    ) {
      router.replace("/onboarding");
    }
  }, [
    isLoading,
    isAuthenticated,
    isOnboardingPage,
    isPublicPage,
    user,
    router,
  ]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  // Public pages (login, register) — render without any nav
  if (isPublicPage) {
    return (
      <div className="flex h-dvh items-center justify-center px-4">
        {children}
      </div>
    );
  }

  // Not authenticated, waiting for redirect
  if (!isAuthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
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
        <div className="flex min-h-dvh items-center justify-center px-4 py-8">
          {children}
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
      <div className="flex h-dvh flex-col md:flex-row">
        <SidebarNav />
        <div className="flex min-h-0 flex-1 flex-col">
          <TopBar />
          <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
            <div className="mx-auto max-w-[76.8rem] px-4 py-6 md:px-6">
              {children}
            </div>
          </main>
        </div>
        <BottomNav />
      </div>
    </>
  );
}

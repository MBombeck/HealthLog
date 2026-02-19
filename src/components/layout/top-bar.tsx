"use client";

import { Heart, LogIn, LogOut, User } from "lucide-react";
import Link from "next/link";
import { useAuth, useLogout } from "@/hooks/use-auth";

export function TopBar() {
  const { user, isLoading } = useAuth();
  const logout = useLogout();

  return (
    <header className="bg-card/80 border-border sticky top-0 z-40 flex h-16 items-center justify-between border-b px-4 backdrop-blur-md md:px-6">
      {/* Mobile logo */}
      <div className="flex items-center gap-2 md:hidden">
        <Heart className="text-primary h-5 w-5" />
        <span className="font-bold tracking-tight">HealthLog</span>
      </div>

      {/* Desktop: page context area */}
      <div className="hidden md:block" />

      {/* Auth section */}
      <div className="flex items-center gap-3">
        {isLoading ? (
          <div className="bg-muted h-4 w-20 animate-pulse rounded" />
        ) : user ? (
          <>
            <Link
              href="/settings"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
            >
              <User className="h-4 w-4" />
              <span className="hidden sm:inline">{user.username}</span>
            </Link>
            <button
              onClick={() => logout.mutate()}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
              title="Abmelden"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </>
        ) : (
          <Link
            href="/auth/login"
            className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">Anmelden</span>
          </Link>
        )}
      </div>
    </header>
  );
}

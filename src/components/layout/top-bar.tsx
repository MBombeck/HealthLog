"use client";

import {
  Bell,
  ChevronDown,
  Info,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  User,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useTheme } from "@/components/providers";
import { useTranslations } from "@/lib/i18n/context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TopBar() {
  const { user, isLoading } = useAuth();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();

  const themeIcon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  return (
    <header
      className="bg-card/80 border-border sticky top-0 z-40 flex h-16 items-center justify-between border-b px-4 backdrop-blur-md md:px-6"
      // iOS PWA on notched iPhones overlays the status bar onto the
      // sticky header unless we reserve the safe-area inset. The
      // inline style adds `safe-area-inset-top` as padding-top on
      // devices that report one and is a no-op on every other
      // platform; the inner h-16 content area stays nominally 64 px.
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* Mobile logo */}
      <Link href="/" className="flex items-center gap-2 md:hidden">
        <Logo className="text-primary" size={20} />
        <span className="font-bold tracking-tight">HealthLog</span>
      </Link>

      {/* Desktop: empty spacer (user controls are in sidebar) */}
      <div className="hidden md:block" />

      {/* Mobile-only auth section (desktop uses sidebar user section) */}
      <div className="flex items-center gap-2 md:hidden">
        {isLoading ? (
          <div className="bg-muted h-4 w-20 animate-pulse rounded motion-reduce:animate-none" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("nav.userMenu")}
              // v1.4.25 W8 — hit the WCAG 2.5.5 44 px touch-target floor on
              // mobile. The text-only py-1.5 was previously ~30 px tall.
              //
              // v1.4.34 IW-G — keyboard users get a visible ring on
              // focus-visible. The previous `focus:outline-none` killed
              // the focus indicator without replacing it.
              className="text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <User className="h-4 w-4" />
              <span className="hidden sm:inline">{user.username}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <Link href="/settings/account" className="cursor-pointer">
                  <Settings className="mr-2 h-4 w-4" />
                  {t("nav.settings")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/notifications" className="cursor-pointer">
                  <Bell className="mr-2 h-4 w-4" />
                  {t("nav.notifications")}
                </Link>
              </DropdownMenuItem>
              {/* v1.4.33 IW7 — "About" folded out of Settings into the
                  user-card dropdown; mobile dropdown mirrors the
                  desktop sidebar so the entry shows up here too. */}
              <DropdownMenuItem asChild>
                <Link href="/settings/about" className="cursor-pointer">
                  <Info className="mr-2 h-4 w-4" />
                  {t("nav.about")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {themeIcon}
                  <span className="ml-2">{t("nav.theme")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => setTheme("system")}>
                    <Monitor className="mr-2 h-4 w-4" />
                    {t("nav.themeSystem")}
                    {theme === "system" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("dark")}>
                    <Moon className="mr-2 h-4 w-4" />
                    {t("nav.themeDark")}
                    {theme === "dark" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("light")}>
                    <Sun className="mr-2 h-4 w-4" />
                    {t("nav.themeLight")}
                    {theme === "light" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => logout.mutate()}
                className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                {t("nav.logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link
            href="/auth/login"
            // v1.4.25 W8 — match the WCAG 2.5.5 44 px touch-target floor.
            className="text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 items-center gap-2 rounded-md px-2 text-sm transition-colors"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">{t("nav.login")}</span>
          </Link>
        )}
      </div>
    </header>
  );
}

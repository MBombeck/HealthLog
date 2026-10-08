"use client";

import {
  ChevronDown,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Shield,
  Sun,
} from "lucide-react";
import { AccountSwitcherMenuItems } from "@/components/layout/account-switcher-menu";
import {
  isSettingsUtilityDestination,
  visibleUtilityDestinations,
} from "@/components/layout/nav-model";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import {
  TopBarActionsOutlet,
  TopBarContextOutlet,
} from "@/components/layout/top-bar-actions";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
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

function getInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function TopBar() {
  const { user, isLoading } = useAuth();
  // v1.36.0 — acting on somebody else's record; see the menu below. Read from
  // the capability hook, as the sidebar does, so a refused or pending switch
  // counts as switched here too and both bars offer the same utilities.
  const {
    inSharedRecord: sharedRecord,
    recordKind,
    level,
  } = useRecordCapabilities();
  const utilityItems = visibleUtilityDestinations({
    record: sharedRecord
      ? {
          recordKind,
          level,
          manageableDomains:
            user?.accountAccess?.active?.manageableDomains ?? [],
        }
      : null,
  });
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  const avatarUrl = user?.avatarUrl ?? null;
  const isAdmin = user?.role === "ADMIN";

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
      data-slot="top-bar"
      // Height + bottom border come from `SHELL_HEADER_BAND`, which the
      // sidebar logo band reads too, so the two borders draw one
      // continuous line. Never restate a height here.
      className={cn(
        "bg-card/80 border-border sticky top-0 z-40 flex items-center justify-between px-4 backdrop-blur-md md:px-6",
        SHELL_HEADER_BAND,
      )}
      // The status-bar inset of the installed app is the shell's
      // (`shell-safe-area` in `auth-shell.tsx`), not this band's: padded
      // inside its own 4rem, a 59 px inset left the bar a 5 px content box.
    >
      {/* Mobile logo */}
      <Link href="/" className="flex min-h-11 items-center gap-2 md:hidden">
        <Logo className="text-primary" size={20} />
        <span className="font-bold tracking-tight">HealthLog</span>
      </Link>

      {/* Desktop: the page's context, where a page gives one (the Coach's
          trail); otherwise an empty spacer. User controls are in the
          sidebar. */}
      <TopBarContextOutlet className="hidden min-w-0 flex-1 items-center md:flex" />

      {/* Page-owned actions (the Coach's conversations toggle). `ml-auto`
          keeps them at the trailing edge, right before the mobile avatar
          menu; `empty:hidden` takes the slot out of the row on every page
          that leaves it empty, so the header lays out exactly as before. */}
      {/* On desktop the last action sits 12 px from the bar's trailing edge
          (`md:-mr-3` against `md:px-6`), so a panel toggle stands against the
          panel it controls. */}
      <TopBarActionsOutlet className="ml-auto flex shrink-0 items-center gap-1 empty:hidden md:-mr-3" />

      {/* Mobile-only auth section (desktop uses sidebar user section) */}
      <div className="flex items-center gap-2 md:hidden">
        {isLoading ? (
          <Skeleton className="bg-muted h-4 w-20 rounded" />
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
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <Avatar className="size-7">
                {avatarUrl && (
                  <AvatarImage src={avatarUrl} alt={user.username} />
                )}
                <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
                  {getInitials(user.username)}
                </AvatarFallback>
              </Avatar>
              <span className="hidden sm:inline">{user.username}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {/* The account utilities come from the list the desktop sidebar
                  reads. Inside somebody else's record Notifications and Admin
                  drop out — every route behind them refuses under a switch —
                  and Settings stays only where the record has Settings pages,
                  pointing at the first one the shell opens. The switcher
                  below is how the person gets back. */}
              {utilityItems.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem key={item.href} asChild>
                    <Link
                      href={item.href}
                      className="cursor-pointer"
                      data-slot={
                        isSettingsUtilityDestination(item)
                          ? "nav-settings-link"
                          : undefined
                      }
                    >
                      <Icon className="mr-2 h-4 w-4" />
                      {t(item.tKey)}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
              {!sharedRecord && isAdmin && (
                <DropdownMenuItem asChild>
                  <Link href="/admin" className="cursor-pointer">
                    <Shield className="mr-2 h-4 w-4" />
                    {t("nav.admin")}
                  </Link>
                </DropdownMenuItem>
              )}
              {/* v1.4.36 W4e — About moved into the Admin Console
                  (`/admin/about`). The dropdown entry was redundant
                  for the small audience that still reaches it (admins
                  only, on the order of once or twice a year). */}
              <DropdownMenuSub>
                {/* v1.22.1 — the shared sub-trigger ships `py-1.5` and no
                    min-height, while every sibling `DropdownMenuItem` carries
                    `min-h-11 py-2`. Left as-is the Theme row sits a few pixels
                    shorter than the rows around it and the menu reads as
                    unevenly spaced. Match the item height here (instance-level
                    override, so no other dropdown's sub-trigger is touched). */}
                <DropdownMenuSubTrigger className="min-h-11 py-2">
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
              {/* v1.36.0 — the same switcher slice the desktop sidebar menu
                  mounts. One component in both menus: a switcher a person can
                  reach on their laptop and not on their phone is a record they
                  can enter and cannot leave. */}
              <AccountSwitcherMenuItems />
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

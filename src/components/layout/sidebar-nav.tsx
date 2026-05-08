"use client";

import { useState } from "react";
import {
  Activity,
  Bell,
  Bug,
  ChevronsLeft,
  ChevronsRight,
  Home,
  Lightbulb,
  LogOut,
  Monitor,
  Moon,
  MoreVertical,
  Pill,
  Settings,
  Sun,
  Target,
  Trophy,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useTheme } from "@/components/providers";
import { useTranslations } from "@/lib/i18n/context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

const STORAGE_KEY = "healthlog-sidebar-collapsed";

const navItems = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/measurements", tKey: "nav.measurements", icon: Activity },
  { href: "/mood", tKey: "nav.mood", icon: Waves },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
  { href: "/targets", tKey: "nav.targets", icon: Target },
  { href: "/achievements", tKey: "nav.achievements", icon: Trophy },
];

function getInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

function SidebarUserSection({ collapsed }: { collapsed: boolean }) {
  const { user } = useAuth();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  const gravatarUrl = user?.gravatarUrl ?? null;

  if (!user) return null;

  const themeIcon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  const dropdownContent = (
    <DropdownMenuContent
      side="right"
      align="end"
      className="w-56"
      sideOffset={8}
    >
      <div className="flex items-center gap-3 px-2 py-2">
        <Avatar className="h-9 w-9 shrink-0">
          {gravatarUrl && <AvatarImage src={gravatarUrl} alt={user.username} />}
          <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
            {getInitials(user.username)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{user.username}</p>
          {user.email && (
            <p className="text-muted-foreground truncate text-xs">
              {user.email}
            </p>
          )}
        </div>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/notifications" className="cursor-pointer">
          <Bell className="mr-2 h-4 w-4" />
          {t("nav.notifications")}
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
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("dark")}>
            <Moon className="mr-2 h-4 w-4" />
            {t("nav.themeDark")}
            {theme === "dark" && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("light")}>
            <Sun className="mr-2 h-4 w-4" />
            {t("nav.themeLight")}
            {theme === "light" && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
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
  );

  if (collapsed) {
    return (
      <div className="border-sidebar-border border-t p-3">
        <div className="flex items-center justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("nav.userMenu")}
              className="hover:bg-accent focus-visible:ring-ring/50 shrink-0 rounded-md p-1.5 transition-colors focus:outline-none focus-visible:ring-[3px]"
            >
              <Avatar className="h-8 w-8">
                {gravatarUrl && (
                  <AvatarImage src={gravatarUrl} alt={user.username} />
                )}
                <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
                  {getInitials(user.username)}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            {dropdownContent}
          </DropdownMenu>
        </div>
      </div>
    );
  }

  return (
    <div className="border-sidebar-border border-t p-3">
      <div className="flex items-center gap-3 px-2 py-1">
        <Avatar className="h-8 w-8 shrink-0">
          {gravatarUrl && <AvatarImage src={gravatarUrl} alt={user.username} />}
          <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
            {getInitials(user.username)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.username}</p>
          {user.email && (
            <p className="text-muted-foreground truncate text-xs">
              {user.email}
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("nav.userMenu")}
            className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 shrink-0 rounded-md p-1.5 transition-colors focus:outline-none focus-visible:ring-[3px]"
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          {dropdownContent}
        </DropdownMenu>
      </div>
    </div>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }

  function renderCollapseToggle(className?: string) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleCollapsed}
            className={cn(
              "text-muted-foreground/80 hover:text-foreground hover:bg-accent z-20 rounded-md p-1 transition-colors",
              className,
            )}
            aria-label={t("nav.collapseSidebar")}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronsRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronsLeft className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {t("nav.collapseSidebar")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        aria-label={t("nav.sidebar")}
        className={cn(
          "bg-sidebar border-sidebar-border relative hidden h-full flex-shrink-0 border-r transition-[width] duration-200 md:flex md:flex-col",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "border-sidebar-border border-b",
            collapsed ? "px-3" : "px-6",
          )}
        >
          <Link
            href="/"
            className={cn(
              "flex h-16 items-center",
              collapsed ? "justify-center px-0" : "gap-2",
            )}
          >
            <Logo className="text-primary shrink-0" size={24} />
            {!collapsed && (
              <span className="text-lg font-bold tracking-tight">
                HealthLog
              </span>
            )}
          </Link>
        </div>

        <nav
          aria-label={t("nav.mainNavigation")}
          className={cn("flex-1 overflow-y-auto", collapsed ? "p-1.5" : "p-3")}
        >
          {collapsed ? (
            <div className="mb-1 flex justify-center">
              {renderCollapseToggle()}
            </div>
          ) : (
            <div className="relative mb-1">
              <p className="text-foreground/75 px-3 text-xs font-semibold tracking-wider uppercase">
                {t("nav.home")}
              </p>
              <div className="absolute top-1/2 -right-1 -translate-y-1/2">
                {renderCollapseToggle()}
              </div>
            </div>
          )}
          <div className="space-y-1">
            {navItems.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              const label = t(item.tKey);

              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-accent",
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {label}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Bottom utility links */}
        <div className={cn("space-y-1 pb-1", collapsed ? "px-1.5" : "px-3")}>
          {collapsed ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href="/bugreport"
                    aria-current={
                      pathname === "/bugreport" ? "page" : undefined
                    }
                    className={cn(
                      "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                      pathname === "/bugreport"
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-accent",
                    )}
                  >
                    <Bug className="h-4 w-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {t("nav.bugreport")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href="/settings/account"
                    aria-current={
                      pathname.startsWith("/settings") ? "page" : undefined
                    }
                    className={cn(
                      "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                      pathname.startsWith("/settings")
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-accent",
                    )}
                  >
                    <Settings className="h-4 w-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {t("nav.settings")}
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <Link
                href="/bugreport"
                aria-current={pathname === "/bugreport" ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  pathname === "/bugreport"
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-accent",
                )}
              >
                <Bug className="h-4 w-4" />
                {t("nav.bugreport")}
              </Link>
              <Link
                href="/settings/account"
                aria-current={
                  pathname.startsWith("/settings") ? "page" : undefined
                }
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  pathname.startsWith("/settings")
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-accent",
                )}
              >
                <Settings className="h-4 w-4" />
                {t("nav.settings")}
              </Link>
            </>
          )}
        </div>

        <SidebarUserSection collapsed={collapsed} />
      </aside>
    </TooltipProvider>
  );
}

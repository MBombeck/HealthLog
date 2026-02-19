"use client";

import {
  ChevronDown,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Shield,
  Sun,
  User,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useTheme } from "@/components/providers";
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

  const themeIcon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  return (
    <header className="bg-card/80 border-border sticky top-0 z-40 flex h-16 items-center justify-between border-b px-4 backdrop-blur-md md:px-6">
      {/* Mobile logo */}
      <Link href="/" className="flex items-center gap-2 md:hidden">
        <Logo className="text-primary" size={20} />
        <span className="font-bold tracking-tight">HealthLog</span>
      </Link>

      {/* Desktop: page context area */}
      <div className="hidden md:block" />

      {/* Auth section */}
      <div className="flex items-center gap-2">
        {isLoading ? (
          <div className="bg-muted h-4 w-20 animate-pulse rounded" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus:outline-none">
              <User className="h-4 w-4" />
              <span className="hidden sm:inline">{user.username}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <Link href="/settings" className="cursor-pointer">
                  <Settings className="mr-2 h-4 w-4" />
                  Einstellungen
                </Link>
              </DropdownMenuItem>
              {user.role === "ADMIN" && (
                <DropdownMenuItem asChild>
                  <Link href="/admin" className="cursor-pointer">
                    <Shield className="mr-2 h-4 w-4" />
                    Admin-Konsole
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {themeIcon}
                  <span className="ml-2">Theme</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => setTheme("system")}>
                    <Monitor className="mr-2 h-4 w-4" />
                    System
                    {theme === "system" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("dark")}>
                    <Moon className="mr-2 h-4 w-4" />
                    Dunkel
                    {theme === "dark" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("light")}>
                    <Sun className="mr-2 h-4 w-4" />
                    Hell
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
                Abmelden
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

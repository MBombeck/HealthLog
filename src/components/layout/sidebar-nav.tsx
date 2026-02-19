"use client";

import { Activity, BarChart3, Heart, Home, Pill, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/measurements", label: "Messungen", icon: Activity },
  { href: "/medications", label: "Medikamente", icon: Pill },
  { href: "/charts", label: "Charts", icon: BarChart3 },
  { href: "/settings", label: "Einstellungen", icon: Settings },
] as const;

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="bg-sidebar border-sidebar-border hidden w-64 flex-shrink-0 border-r md:flex md:flex-col">
      <div className="border-sidebar-border flex h-16 items-center gap-2 border-b px-6">
        <Heart className="text-primary h-6 w-6" />
        <span className="text-lg font-bold tracking-tight">HealthLog</span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="text-muted-foreground border-sidebar-border border-t p-4 text-xs">
        HealthLog v0.1.0
      </div>
    </aside>
  );
}

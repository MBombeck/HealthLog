"use client";

import {
  Activity,
  BarChart3,
  Home,
  Lightbulb,
  Pill,
  Target,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";

const navItems = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/measurements", label: "Messungen", icon: Activity },
  { href: "/medications", label: "Medikamente", icon: Pill },
  { href: "/charts", label: "Verlauf", icon: BarChart3 },
  { href: "/insights", label: "Insights", icon: Lightbulb },
  { href: "/zielwerte", label: "Zielwerte", icon: Target },
];

export function SidebarNav() {
  const pathname = usePathname();

  const items = navItems;

  return (
    <aside className="bg-sidebar border-sidebar-border hidden w-64 flex-shrink-0 border-r md:flex md:flex-col">
      <div className="border-sidebar-border border-b px-6">
        <Link href="/" className="flex h-16 items-center gap-2">
          <Logo className="text-primary" size={24} />
          <span className="text-lg font-bold tracking-tight">HealthLog</span>
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {items.map((item) => {
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
    </aside>
  );
}

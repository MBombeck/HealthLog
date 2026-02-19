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

const navItems = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/measurements", label: "Messungen", icon: Activity },
  { href: "/medications", label: "Medikamente", icon: Pill },
  { href: "/charts", label: "Verlauf", icon: BarChart3 },
  { href: "/insights", label: "Insights", icon: Lightbulb },
  { href: "/zielwerte", label: "Zielwerte", icon: Target },
];

export function BottomNav() {
  const pathname = usePathname();

  const items = navItems;

  return (
    <nav className="bg-card/80 border-border fixed bottom-0 left-0 z-50 w-full border-t backdrop-blur-md md:hidden">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around px-2">
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
                "flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-xs transition-colors",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="h-5 w-5" />
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

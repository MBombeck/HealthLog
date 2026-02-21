"use client";

import {
  Activity,
  Home,
  Lightbulb,
  Pill,
  Target,
  Trophy,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

const navItems = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/measurements", tKey: "nav.measurements", icon: Activity },
  { href: "/stimmung", tKey: "nav.mood", icon: Waves },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
  { href: "/zielwerte", tKey: "nav.targets", icon: Target },
  { href: "/achievements", tKey: "nav.achievements", icon: Trophy },
];

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();

  const items = navItems;

  return (
    <nav className="bg-card/80 border-border fixed bottom-0 left-0 z-50 w-full border-t backdrop-blur-md md:hidden">
      <div className="mx-auto flex h-14 max-w-lg items-center justify-around px-2">
        {items.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={t(item.tKey)}
              className={cn(
                "relative flex items-center justify-center rounded-lg p-2.5 transition-colors",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="h-5 w-5" />
              {isActive && (
                <span className="bg-primary absolute -bottom-1 h-1 w-1 rounded-full" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

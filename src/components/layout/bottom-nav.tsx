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
  { href: "/mood", tKey: "nav.mood", icon: Waves },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
  { href: "/targets", tKey: "nav.targets", icon: Target },
  { href: "/achievements", tKey: "nav.achievements", icon: Trophy },
];

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();

  const items = navItems;

  return (
    <nav
      aria-label={t("nav.mobileNavigation")}
      className="bg-card/80 border-border fixed bottom-0 left-0 z-50 w-full border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <div className="mx-auto flex h-16 max-w-lg items-stretch justify-around px-1">
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
              aria-current={isActive ? "page" : undefined}
              // Touch target sized to WCAG 2.5.5 minimum (44×44 CSS px). The
              // outer min-h-11 min-w-11 is the actual hit area; the icon
              // stays visually centered at 20px so the design doesn't shift.
              className={cn(
                "relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="h-5 w-5" />
              {isActive && (
                <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

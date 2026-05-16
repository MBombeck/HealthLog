"use client";

import {
  Activity,
  Home,
  Lightbulb,
  MoreHorizontal,
  Pill,
  Target,
  Trophy,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

interface NavLink {
  href: string;
  tKey: string;
  icon: typeof Home;
}

// v1.4.16 Wave-C MED — bottom-nav was rendering all 7 destinations
// edge-to-edge on a 375 px viewport, which collapsed each touch
// target to ~50 px wide and made the WCAG 2.5.5 44 px floor only
// just-pass on iPhone-13-mini-class screens. The mobile audit
// recommended 5+More — so the four most-used surfaces stay in the
// strip (Home, Measurements, Mood, Medications) plus Insights as
// the fifth, and Targets + Achievements move into a "More" sheet.
//
// Order is preserved relative to the v1.4.15 bottom-nav so muscle
// memory keeps working for the four core actions.
const PRIMARY: ReadonlyArray<NavLink> = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/measurements", tKey: "nav.measurements", icon: Activity },
  { href: "/mood", tKey: "nav.mood", icon: Waves },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
];

const OVERFLOW: ReadonlyArray<NavLink> = [
  { href: "/targets", tKey: "nav.targets", icon: Target },
  { href: "/achievements", tKey: "nav.achievements", icon: Trophy },
];

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const [moreOpen, setMoreOpen] = useState(false);

  function isActiveLink(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  // The "More" entry is treated as active when any of its children
  // is the current page — gives the user a clue that they've drilled
  // into a sub-route via overflow.
  const overflowActive = OVERFLOW.some((item) => isActiveLink(item.href));

  return (
    <>
      {/* v1.4.33 F14 — bar height and safe-area defence so the bar can
          never overlap the last viewport line of scrollable page content.
          - `min-h-16` floors the bar at 64px even if the inner flex row
            collapses (e.g. a future variant without one of the icons).
          - `pb-[env(safe-area-inset-bottom)]` reserves the home-indicator
            inset on iOS / iPadOS PWA installs.
          - `bg-card` (solid, not the previous `bg-card/80`) plus
            `border-t` give the bar a clean visual edge so any page
            content that scrolls under the bar is properly occluded
            rather than bleeding through a translucent surface. Page-
            level pb-* padding owners (auth-shell + per-page shells)
            still reserve room above the bar; this change hardens the
            bar itself so the visual contract holds even when a page
            shell forgets the bottom-padding contract.
        */}
      <nav
        aria-label={t("nav.mobileNavigation")}
        className="bg-card border-border fixed bottom-0 left-0 z-50 min-h-16 w-full border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch justify-around px-1">
          {PRIMARY.map((item) => {
            const isActive = isActiveLink(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={t(item.tKey)}
                aria-current={isActive ? "page" : undefined}
                // Touch target sized to WCAG 2.5.5 (44×44 CSS px). The
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
          <button
            type="button"
            aria-label={t("nav.more")}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={overflowActive ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={cn(
              "relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors",
              overflowActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="bottom-nav-more"
          >
            <MoreHorizontal className="h-5 w-5" />
            {overflowActive && (
              <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
            )}
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          // The sheet auto-sizes to its content; padding-bottom respects
          // the iOS safe area so the inner buttons stay reachable above
          // the home-indicator on iPhone-X-class devices.
          className="rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+1rem)] md:hidden"
          data-testid="bottom-nav-more-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("nav.moreSheetTitle")}</SheetTitle>
            <SheetDescription>{t("nav.moreSheetDescription")}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-1 gap-2 px-4 pb-4">
            {OVERFLOW.map((item) => {
              const isActive = isActiveLink(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "border-border flex min-h-11 items-center gap-3 rounded-lg border px-4 py-3 transition-colors",
                    isActive
                      ? "text-primary bg-primary/5"
                      : "text-foreground hover:bg-accent/40",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium">{t(item.tKey)}</span>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

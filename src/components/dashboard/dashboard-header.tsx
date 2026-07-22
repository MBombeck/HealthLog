"use client";

/**
 * Dashboard page header: title, the greeting line, the customize
 * shortcut, and the quick-add dropdown that opens the quick-entry
 * sheets. The greeting sits under the title on every dashboard mount —
 * the promoted Today hero renders separately above the tile strip and
 * carries its own read, so the header greeting is unconditional.
 *
 * Extracted from the dashboard page; the page owns the open-state the
 * dropdown items set via `onQuickEntry`.
 */
import { useMemo } from "react";
import Link from "next/link";
import { Activity, GlassWater, Pill, Plus, Waves, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { getHourForTimeZone } from "@/components/dashboard/range-display";
import type { QuickEntryDialog } from "@/components/dashboard/quick-entry-sheets";

export function DashboardHeader({
  onQuickEntry,
}: {
  onQuickEntry: (dialog: NonNullable<QuickEntryDialog>) => void;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const mounted = useMounted();
  const nutrientsEnabled = useModuleEnabled("nutrients");

  // The pre-hero greeting derivation, kept hydration-safe: `user` comes
  // from the auth query, which can resolve before this boundary
  // hydrates — the text must match the name-less SSR output during
  // hydration (React #418) and may only personalise from the first
  // client re-render.
  const userTimezone = mounted ? user?.timezone : undefined;
  const hour = useMemo(
    () => (userTimezone ? getHourForTimeZone(userTimezone) : null),
    [userTimezone],
  );
  const timeGreeting =
    hour == null
      ? t("dashboard.greeting.day")
      : hour >= 5 && hour < 12
        ? t("dashboard.greeting.morning")
        : hour >= 12 && hour < 18
          ? t("dashboard.greeting.day")
          : t("dashboard.greeting.evening");
  const welcomeText =
    mounted && user?.username && user.username.trim().length > 0
      ? t("dashboard.welcomeBackWithName", {
          greeting: timeGreeting,
          name: user.username,
        })
      : t("dashboard.welcomeBack", { greeting: timeGreeting });

  return (
    <PageHeader
      title={t("dashboard.title")}
      description={
        /* `min-h-5` reserves the greeting's line box from the SSR
           pass on: the text personalises (name appended) on the first
           client re-render after hydration, and the reserved line
           keeps the header from collapsing/growing around that swap. */
        <span
          data-slot="dashboard-header-greeting"
          className="block min-h-5 truncate"
        >
          {welcomeText}
        </span>
      }
      actions={
        <>
          {/* Customize shortcut to the dashboard-customization settings
              (the tile/layout editor at /settings/dashboard). Sits to
              the left of the add button as a monochrome ghost icon, with
              a `min-h-11 min-w-11` mobile floor so it meets the 44 px
              touch-target contract the add button also honours, shrinking
              back to the 40 px icon footprint on sm+. */}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            data-testid="dashboard-customize-shortcut"
          >
            <Link
              href="/settings/layout/dashboard"
              aria-label={t("dashboard.customizeDashboard")}
              title={t("dashboard.customizeDashboard")}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* v1.4.33 maintainer-item-7 — restore proportional sizing
                  across viewports. The v1.4.27 fix pinned a `size="sm"
                  min-h-11` combo to hit WCAG 2.5.5's 44 px touch-target
                  contract on mobile, but `size="sm"` is h-8 (32 px) and
                  the `min-h-11` override stretched the cap vertically
                  while keeping the small horizontal padding — the
                  button read as klobig on Pixel 5. Switch to
                  `size="default"` (h-10 = 40 px) on mobile with a
                  responsive `min-h-11 sm:min-h-9` so the button is
                  44 px tall under finger pressure and shrinks back to
                  the desktop-friendly 36 px on `sm:` upwards. The icon
                  + label keep the same visual contract. */}
              <Button
                size="default"
                className="min-h-11 sm:min-h-9"
                data-tour-id="dashboard-quick-add"
              >
                <Plus className="h-4 w-4" />
                {t("common.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-w-[calc(100vw-2rem)]"
            >
              {/* Menu items must each carry a self-contained verb-phrase
                  ("Log measurement", "Log mood") — the trigger above already
                  says "Add", and the icon is `aria-hidden`, so the visible
                  text is the only thing distinguishing the rows. v1.4.15
                  phase-A3 fix #1 hardened this with a unit guard at
                  `src/app/__tests__/quick-add-labels.test.ts` — both labels
                  must differ from each other AND from `common.add`. */}
              <DropdownMenuItem onClick={() => onQuickEntry("measurement")}>
                <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMeasurement")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onQuickEntry("mood")}>
                <Waves className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMood")}
              </DropdownMenuItem>
              {/* v1.4.37 W7b — third quick-add row: medication intake.
                  Same Sheet-on-mobile / Dialog-on-desktop primitive as
                  the other two; the menu label is a self-contained
                  verb-phrase so it doesn't collide with the trigger or
                  the sibling rows (cf. quick-add-labels.test.ts). */}
              <DropdownMenuItem
                onClick={() => onQuickEntry("medicationIntake")}
              >
                <Pill className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMedicationIntake")}
              </DropdownMenuItem>
              {nutrientsEnabled && (
                <DropdownMenuItem onClick={() => onQuickEntry("water")}>
                  <GlassWater className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t("dashboard.quickAddWater")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}

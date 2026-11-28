"use client";

/**
 * Dashboard page header: the title, the customize shortcut and, on a wide
 * screen, the quick-add dropdown that opens the quick-entry sheets. No line
 * under the title: a greeting said nothing a person needs (UI standards
 * §17), and on a phone the bottom bar's plus is the one way to add.
 *
 * Extracted from the dashboard page; the page owns the open-state the
 * dropdown items set via `onQuickEntry`.
 */
import Link from "next/link";
import {
  Activity,
  BrainCircuit,
  Flag,
  Footprints,
  Pill,
  Plus,
  Stethoscope,
  Waves,
  Wrench,
} from "lucide-react";
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
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  CAPTURE_KIND_ORDER,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import type { QuickEntryDialog } from "@/components/dashboard/quick-entry-sheets";

export function DashboardHeader({
  onQuickEntry,
}: {
  onQuickEntry: (dialog: NonNullable<QuickEntryDialog>) => void;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // The quick-add offers four kinds, and each one is asked about its own
  // section: a reading under `measurements`, a dose under `medications`, a
  // mood entry under `mind`, a workout in one's own record only. The coarse `canAdd` this used to gate the whole
  // menu on carries the grant's LEVEL and no scope, so it answered true for a
  // grant that opens neither of the two sections the menu never asked about.
  // The customize shortcut points at a settings page sharing does not cover at
  // all.
  const capabilities = useRecordCapabilities();
  const { inSharedRecord } = capabilities;
  // The same answer the bottom bar's capture picker renders from: per kind,
  // the record's section (a delegated grant) AND the kind's module
  // (`capture:<kind>`). Asking the picker's own function is what keeps the two
  // menus from disagreeing — this one used to check the section alone, so a
  // switched-off mood module still offered "Log mood" here.
  const offered = visibleCaptureKinds(
    capabilities,
    CAPTURE_KIND_ORDER,
    user?.modules,
  );
  const canAddMeasurement = offered.includes("measurement");
  const canAddIntake = offered.includes("medication");
  const canAddMood = offered.includes("mood");
  const canAddSymptom = offered.includes("symptom");
  const canAddWorkout = offered.includes("workout");
  const canAddLifeEvent = offered.includes("lifeEvent");
  const canAddAnything = offered.length > 0;

  return (
    <PageHeader
      title={t("dashboard.title")}
      actions={
        <>
          {/* Customize shortcut to the dashboard-customization settings
              (the tile/layout editor at /settings/dashboard). Sits to
              the left of the add button as a monochrome ghost icon, with
              a `min-h-11 min-w-11` mobile floor so it meets the 44 px
              touch-target contract the add button also honours, shrinking
              back to the 40 px icon footprint on sm+. */}
          {!inSharedRecord && (
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
          )}
          {/* Desktop only: on the phone shell the bottom bar's plus opens
              the same capture picker, so the header carries no second
              "Add" (it was a filled button right above the asks card). */}
          {canAddAnything && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* v1.4.33 — restore proportional sizing
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
                  className="shell-mobile:hidden min-h-11 sm:min-h-9"
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
                  hardened this with a unit guard at
                  `src/app/__tests__/quick-add-labels.test.ts` — both labels
                  must differ from each other AND from `common.add`. */}
                {canAddMeasurement && (
                  <DropdownMenuItem onClick={() => onQuickEntry("measurement")}>
                    <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddMeasurement")}
                  </DropdownMenuItem>
                )}
                {/* v1.4.37 — medication intake. The menu label is a
                  self-contained verb phrase so it doesn't collide with
                  the trigger or its siblings (quick-add-labels.test.ts). */}
                {canAddIntake && (
                  <DropdownMenuItem
                    onClick={() => onQuickEntry("medicationIntake")}
                  >
                    <Pill className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddMedicationIntake")}
                  </DropdownMenuItem>
                )}
                {canAddMood && (
                  <DropdownMenuItem onClick={() => onQuickEntry("mood")}>
                    <Waves className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddMood")}
                  </DropdownMenuItem>
                )}
                {canAddSymptom && (
                  <DropdownMenuItem onClick={() => onQuickEntry("symptom")}>
                    <Stethoscope className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddSymptom")}
                  </DropdownMenuItem>
                )}
                {offered.includes("seizure") && <LogSeizureItem />}
                {canAddWorkout && (
                  <DropdownMenuItem onClick={() => onQuickEntry("workout")}>
                    <Footprints className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddWorkout")}
                  </DropdownMenuItem>
                )}
                {canAddLifeEvent && (
                  <DropdownMenuItem onClick={() => onQuickEntry("lifeEvent")}>
                    <Flag className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("dashboard.quickAddLifeEvent")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  );
}

/** The diary's timer outlives any sheet, so "Log seizure" opens the diary. */
function LogSeizureItem() {
  const { t } = useTranslations();
  return (
    <DropdownMenuItem asChild>
      <Link href="/seizures">
        <BrainCircuit className="mr-2 h-4 w-4" aria-hidden="true" />
        {t("dashboard.quickAddSeizure")}
      </Link>
    </DropdownMenuItem>
  );
}

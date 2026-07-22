"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { MedicationWizardDialog } from "@/components/medications/wizard/medication-wizard-dialog";
import { MedicationCard } from "@/components/medications/medication-card";
import { Glp1MedicationCard } from "@/components/medications/glp1-medication-card";
import { LogIntakeDialog } from "@/components/medications/log-intake-dialog";
import { TakeAllDueDialog } from "@/components/medications/take-all-due-dialog";
import { deriveDueMedications } from "@/components/medications/take-all-due";
import {
  MedicationTable,
  MedicationTableSkeleton,
} from "@/components/medications/medication-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCheck,
  CheckCircle2,
  Loader2,
  Pill,
  Plus,
  Wrench,
} from "lucide-react";
import { apiGet } from "@/lib/api/api-fetch";
import { useMedicationComplianceSummaryAll } from "@/lib/queries/use-medication-compliance-summary";
import { useMedicationListLayout } from "@/lib/queries/use-medication-list-layout";
import { applyMedicationOrder } from "@/lib/medications/medication-order";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  /** v1.5 — first-class times-of-day. */
  timesOfDay?: string[];
  /** v1.5 — RFC 5545 RRULE string for calendar-anchored cadences. */
  rrule?: string | null;
  /** v1.5 — flexible-rolling interval in days. */
  rollingIntervalDays?: number | null;
  /** v1.5 — reminder grace window in minutes. */
  reminderGraceMinutes?: number | null;
  /** v1.16.1 — explicit per-dose on-time windows (band model). */
  doseWindows?: { timeOfDay: string; start: string; end: string }[] | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /** v1.4.25 W4d — Prisma treatment class (GENERIC | GLP1). */
  treatmentClass?: string;
  /** v1.4.25 W4d — doses per pen/vial for inventory math. */
  dosesPerUnit?: number | null;
  /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
  deliveryForm?: string;
  /** v1.8.5 — per-medication injection-site tracking opt-in. */
  trackInjectionSites?: boolean;
  /** v1.8.5 — per-medication allowed / preferred injection sites. */
  allowedInjectionSites?: string[];
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  /** List-only count of today's ACTIONED intake events (taken/skipped). */
  todayEventCount?: number;
  /**
   * v1.8.4 — server-computed next due instant (canonical recurrence
   * engine). Threaded straight through to both card variants, which render
   * it instead of re-deriving the timestamp client-side.
   */
  nextDueAt?: string | null;
  /** v1.16.4 — true when `nextDueAt` is an OPEN overdue slot. */
  nextDueOverdue?: boolean;
  /** v1.5 — medication-level course start date (ISO string). */
  startsOn?: string | null;
  /** v1.5 — medication-level course end date (ISO string). */
  endsOn?: string | null;
  /** v1.5 — single-administration medication. */
  oneShot?: boolean;
  /** v1.16.11 (#316) — as-needed (PRN): no schedules, never due. */
  asNeeded?: boolean;
  /** v1.9.0 — optional WHO ATC classification code for the FHIR export. */
  atcCode?: string | null;
  /** v1.9.0 — optional RxNorm RxCUI (secondary FHIR coding). */
  rxNormCode?: string | null;
  /**
   * v1.16.10 — usable inventory units left across the medication's
   * containers (ACTIVE / IN_USE with units remaining). Null = inventory
   * tracking off (no items ever registered).
   */
  stockUnitsRemaining?: number | null;
  /** v1.16.10 — dose-derived stock (`stockUnitsRemaining / unitsPerDose`). */
  stockDosesRemaining?: number | null;
  schedules: Schedule[];
}

/**
 * v1.11.3 C4 — loading placeholder for one medication card. Renders the
 * real `Card`/`CardContent` shell (so padding, radius and gap match the
 * loaded card exactly) with the shared `Skeleton` primitive standing in
 * for each populated slot: header title + dose, status pill, next / last
 * line, the two compliance bars and the action row. Replacing the bare
 * centred spinner with a grid of these stops the layout jump when the
 * cards resolve.
 */
function MedicationCardSkeleton() {
  return (
    <Card className="h-full" aria-hidden="true">
      <div className="flex items-start justify-between gap-2 px-4 md:px-6">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <Skeleton className="size-8 rounded-md" />
      </div>
      <CardContent className="flex flex-col space-y-3.5">
        <Skeleton className="h-6 w-40 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-36" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
        </div>
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 flex-1" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function MedicationsPageClient() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  // v1.18.1 (D3) — medications is an opt-out module. When the account has it
  // turned off the whole page disappears (the nav entry is hidden by the same
  // gate) and the list query never fires (the API would 403 anyway).
  // Default-on: an absent key reads as enabled, so the page only hides on an
  // explicit `false`.
  const medicationsEnabled = user?.modules?.medications !== false;
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // v1.5.4 — the retired `/medications/new` route redirects here with
  // `?new=1`, so legacy bookmarks keep landing on the create wizard.
  // The initial open state reads the query param synchronously so the
  // dialog opens on the very first render; a follow-up effect strips
  // the param from the URL so a manual close + refresh stays closed.
  const shouldOpenFromUrl = searchParams?.get("new") === "1";
  const [dialogOpen, setDialogOpen] = useState(shouldOpenFromUrl);
  // v1.29.x — the Today digest's "Log dose" action deep-links straight to
  // the overdue medication (`/medications?highlight=<id>`) instead of the
  // bare list. Read once on mount; a scroll effect below (once the list
  // resolves) brings the target card into view and rings it briefly, then
  // clears the state so the ring doesn't linger indefinitely.
  const [highlightId, setHighlightId] = useState<string | null>(
    () => searchParams?.get("highlight") ?? null,
  );
  // v1.14.0 — the medications-page "Add" choice. The top button now offers
  // two paths: log an intake (incl. a backdated one) against an existing
  // medication, or create a new medication (the existing wizard).
  const [logIntakeOpen, setLogIntakeOpen] = useState(false);
  // v1.16.11 (#316) — "Alle fälligen einnehmen" confirm dialog. The header
  // button earns its slot only while ≥ 2 medications are currently due.
  const [takeAllOpen, setTakeAllOpen] = useState(false);

  // v1.16.10 — the persisted list presentation: cards vs table plus the
  // manual medication order, server-side per user
  // (`GET`/`PUT /api/medications/layout`). The toggle writes
  // optimistically; the order editor lives at /settings/medications.
  const { layout, isLayoutLoading } = useMedicationListLayout(isAuthenticated);

  useEffect(() => {
    if (!shouldOpenFromUrl) return;

    // Child effects may run before the App Router installs its native-history
    // integration, while the responsive sheet also settles its first client
    // layout. Wait until the following painted frame so replaceState preserves
    // Next's internals and synchronizes useSearchParams without starting a
    // router navigation that can remount the open wizard and discard fields.
    let cleanupFrame: number | undefined;
    const layoutFrame = window.requestAnimationFrame(() => {
      cleanupFrame = window.requestAnimationFrame(() => {
        window.history.replaceState(null, "", "/medications");
      });
    });

    return () => {
      window.cancelAnimationFrame(layoutFrame);
      if (cleanupFrame !== undefined) {
        window.cancelAnimationFrame(cleanupFrame);
      }
    };
  }, [shouldOpenFromUrl]);

  const {
    data: medications,
    isLoading,
    isError,
    refetch: refetchMedications,
  } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet<Medication[]>("/api/medications");
    },
    enabled: isAuthenticated && medicationsEnabled,
    // v1.16.12 (#316) — refetch on every mount, even inside the global
    // staleTime window. App Router unmounts this page on navigation away
    // and remounts it on return; without this, a return within 5 min
    // serves the cached list and shows nothing the user changed on
    // another surface (the iOS app, a Withings sync, a second tab) — the
    // client cache can't know to invalidate a cross-device write. "always"
    // makes a return-visit fetch fresh; the per-user server cache keeps it
    // cheap. Mutation-driven invalidation still covers same-tab writes.
    refetchOnMount: "always",
  });

  // v1.30.1 M12 — pull-to-refresh parity with labs/checkups/mood/measurements.
  // Medications is one of the sharpest PWA-resume-staleness surfaces (a
  // background-refreshed take/skip from a notification, or a cross-device
  // write, wouldn't otherwise show up until the 5-min staleTime lapses or a
  // full remount re-triggers `refetchOnMount: "always"` above).
  const refreshMedications = useCallback(
    () => invalidateKeys(queryClient, medicationDependentKeys),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refreshMedications });

  // v1.29.x — once the highlighted card is in the DOM, scroll it into view
  // and clear the highlight state after a few seconds so the ring is a
  // one-time "you tapped here" cue, not a permanent tint (mirrors the
  // vault's upload-duplicate flash-highlight, `HIGHLIGHT_MS` in
  // `use-document-upload.ts`).
  useEffect(() => {
    if (!highlightId || !medications?.length) return;
    const card = document.querySelector(
      `[data-medication-id="${highlightId}"]`,
    );
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightId(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightId, medications]);

  // v1.16.11 — the same reminder-thresholds read the cards make (shared
  // key + cache), so the header's due-set derivation tiers late /
  // very_late exactly like the card pills. Null on failure keeps the
  // derivation on the 120/240 defaults the cards also fall back to.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
          lowStockRunwayDays: number | null;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  // v1.16.11 — the SAME batched compliance rows the cards / table read
  // (shared key + cache, no extra round trip). The due-set derivation
  // needs each medication's compliance dose status so an escalated
  // (overdue / missed past its band tail) medication — which still
  // renders an active take button on its red card — joins the
  // take-all-due set.
  const { data: complianceRows } = useMedicationComplianceSummaryAll();

  function openCreate() {
    setDialogOpen(true);
  }

  // v1.15.20 — seed the detail page's query from the list row before
  // navigating. The list response is a superset of the detail GET
  // (`{...medication, category, nextDueAt}` plus the list-only
  // `lastTakenAt` / `todayEventCount`), so the detail shell paints
  // instantly from the seeded cache while its own un-gated query
  // refetches the authoritative row in the background.
  function seedDetail(med: Medication) {
    queryClient.setQueryData(queryKeys.medicationDetail(med.id), med);
  }

  // v1.16.1 — the kebab's Edit lands on the detail page's Übersicht tab,
  // exactly like tapping the medication name. Every everyday edit lives
  // inline in the tabs there; the structural wizard is reachable via
  // Erweitert → Lebenszyklus (and still answers `?edit=1` deep-links).
  // History still lands on the Verlauf tab.
  function openEdit(med: Medication) {
    seedDetail(med);
    router.push(`/medications/${med.id}`);
  }

  function openHistory(med: Medication) {
    seedDetail(med);
    router.push(`/medications/${med.id}?tab=verlauf`);
  }

  function closeDialog() {
    setDialogOpen(false);
  }

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  // Module off ⇒ the surface disappears entirely. The nav entry is hidden by
  // the same gate, so a direct hit renders nothing rather than an orphaned
  // shell.
  if (isAuthenticated && !medicationsEnabled) {
    return null;
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("medications.loginRequired")}
          </p>
        </div>
      </div>
    );
  }

  // Defensive against stale service-worker responses or any future API
  // shape change: only filter when we actually have an array.
  const medsArray = Array.isArray(medications) ? medications : [];
  // v1.16.10 — the user-defined manual order applies to BOTH views
  // (cards and table). Medications not in the saved order keep the
  // alphabetical default, appended after the ordered block.
  const activeMeds = applyMedicationOrder(
    medsArray.filter((m) => m.active),
    layout.order,
  );
  const inactiveMeds = applyMedicationOrder(
    medsArray.filter((m) => !m.active),
    layout.order,
  );
  const tableView = layout.view === "table";

  // v1.16.11 (#316) — the currently-due set, derived from the list payload
  // the page already holds via the SAME pipeline a card's pill runs (band
  // model + server display-due gate + taken-early downgrade), plus the
  // batched compliance dose status so escalated (overdue / missed)
  // medications past their band tail stay takeable from the batch. Page
  // order is preserved so the confirm dialog lists medications as rendered.
  const dueMeds = deriveDueMedications(activeMeds, {
    tz: user?.timezone || "Europe/Berlin",
    thresholds: thresholds ?? undefined,
    doseStatusById: new Map(
      (complianceRows ?? []).map((row) => [
        row.medicationId,
        row.complianceDisplay?.currentDose.status ?? "upcoming",
      ]),
    ),
  });

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1
            data-tour-id="medications-hero"
            className="text-2xl font-bold tracking-tight"
          >
            {t("medications.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle stays visible on mobile so the
              H1 isn't an unframed label. */}
          <p className="text-muted-foreground truncate text-xs sm:text-sm">
            {t("medications.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* v1.16.11 (#316) — "Alle fälligen einnehmen". Contextual, not a
              permanent fixture: it renders only while at least TWO
              medications are currently due (a single due dose is the
              card's own one-tap job). Calm outline variant so the primary
              Add button keeps the visual lead; same responsive 44-px
              mobile tap floor as its neighbours. */}
          {dueMeds.length >= 2 && (
            <Button
              variant="outline"
              onClick={() => setTakeAllOpen(true)}
              className="min-h-11 sm:min-h-9"
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
              {t("medications.takeAllDue.button")}
            </Button>
          )}
          {/* v1.16.11 — the wrench is the one customize entry point:
              it links to /settings/medications, which owns the view
              preference (cards ⇄ table) and the manual-order editor.
              Same glyph, slot (left of the add button) and responsive
              44-px mobile tap floor as the dashboard and insights
              headers. */}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          >
            <Link
              href="/settings/layout/medications"
              aria-label={t("medications.customize")}
              title={t("medications.customize")}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          {/* v1.14.0 — the "Add" button is now a choice: log an intake
              (incl. a backdated one) against an existing medication, or
              create a new medication. v1.12.2 — match the dashboard Add
              button's responsive tap-target floor (`min-h-11 sm:min-h-9`) so
              both primary "add" entry points clear the WCAG 2.5.5 44px mobile
              minimum identically. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="min-h-11 sm:min-h-9">
                <Plus className="h-4 w-4" />
                {t("medications.addMedication")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setLogIntakeOpen(true)}
                disabled={activeMeds.length === 0}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {t("medications.addChoice.logIntake")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openCreate}>
                <Pill className="mr-2 h-4 w-4" />
                {t("medications.addChoice.newMedication")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isLoading || isLayoutLoading ? (
        // v1.11.3 C4 — skeletons instead of a bare centred spinner so the
        // page reserves the loaded layout and does not jump when the
        // medications resolve. v1.16.10 — the skeleton follows the
        // persisted view (table rows vs card grid) so resolving the data
        // never swaps the footprint; while the view preference itself is
        // still loading the default cards skeleton stands in.
        <div role="status" aria-busy="true" aria-label={t("medications.title")}>
          {tableView && !isLayoutLoading ? (
            <MedicationTableSkeleton />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <MedicationCardSkeleton key={i} />
              ))}
            </div>
          )}
        </div>
      ) : isError ? (
        <QueryErrorCard
          description={t("medications.loadFailed")}
          retryLabel={t("medications.retryLoad")}
          onRetry={() => void refetchMedications()}
        />
      ) : !medications?.length ? (
        // v1.4.15 phase-C5: refactor the inline icon+text+button block
        // to the shared EmptyState primitive so the empty path matches
        // every other list page in the app (role=status, dashed
        // border, consistent icon-bubble + spacing).
        <EmptyState
          icon={<Pill className="size-6" />}
          title={t("medications.emptyTitle")}
          description={t("medications.emptyDescription")}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              {t("medications.firstMedication")}
            </Button>
          }
        />
      ) : tableView ? (
        // v1.16.10 — the compact table view. Same payloads, same status
        // gating, same mutation hooks as the cards; one row per
        // medication, inactive rows pinned after the active block.
        <MedicationTable
          activeMedications={activeMeds}
          inactiveMedications={inactiveMeds}
          highlightId={highlightId}
        />
      ) : (
        <div className="space-y-6">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-3.5">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) =>
                  // v1.16.11 — an as-needed medication always renders the
                  // generic card: the GLP-1 variant is built around the
                  // rolling injection cadence an as-needed med doesn't have.
                  med.treatmentClass === "GLP1" && !med.asNeeded ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      highlighted={highlightId === med.id}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      highlighted={highlightId === med.id}
                    />
                  ),
                )}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3.5">
              <h2 className="text-muted-foreground text-sm font-medium">
                {t("common.inactive")} ({inactiveMeds.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {inactiveMeds.map((med) =>
                  med.treatmentClass === "GLP1" && !med.asNeeded ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      highlighted={highlightId === med.id}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      highlighted={highlightId === med.id}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* v1.5.5 — the per-card kebab triggers used to open inline
          IntakeImportDialog / ApiEndpointDialog mounts here, but both
          state slots were only ever set from inside the dialogs
          themselves (never from a list-card prop) so the inline
          mounts were dead code. v1.5.5 retires both on the list page:
          the import dialog lives in the detail-page intake-history
          header (see `src/components/medications/intake-import-dialog.tsx`),
          the API endpoint moves to the detail-page Settings → Externe
          Integration sub-row. */}

      {/* v1.15.18 — create-only wizard mount. Editing an existing
          medication now navigates to the detail page's tabs (the hero's
          "Vollständig bearbeiten" reopens the wizard in edit mode from
          there); the list page wizard only ever creates. The wizard owns
          its own ResponsiveSheet shell with the sticky footer. */}
      <MedicationWizardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode="create"
        onSuccess={closeDialog}
      />

      {/* v1.14.0 — log-intake path of the "Add" choice. Lists the active
          medications, lets the user pin a schedule slot, and picks a
          date+time that supports backdating. Submits to the existing
          per-medication intake route (same slot upsert as a live "Taken"
          tap) so the one-row-per-dose-slot invariant holds. */}
      {/* v1.16.11 (#316) — confirm-all dialog for the due set. Records
          through the per-medication intake route in a loop (slot
          attribution + inventory consumption identical to N individual
          taps — see take-all-due.ts); failed medications stay due. */}
      {takeAllOpen && (
        <TakeAllDueDialog
          open={takeAllOpen}
          onOpenChange={setTakeAllOpen}
          dueMedications={dueMeds}
        />
      )}

      {logIntakeOpen && (
        <LogIntakeDialog
          open={logIntakeOpen}
          onOpenChange={setLogIntakeOpen}
          medications={activeMeds.map((m) => ({
            id: m.id,
            name: m.name,
            dose: m.dose,
            active: m.active,
            lastTakenAt: m.lastTakenAt,
            todayEventCount: m.todayEventCount ?? 0,
            nextDueAt: m.nextDueAt,
            nextDueOverdue: m.nextDueOverdue,
            schedules: m.schedules.map((s) => ({
              windowStart: s.windowStart,
              windowEnd: s.windowEnd,
              daysOfWeek: s.daysOfWeek,
              label: s.label,
              dose: s.dose,
              timesOfDay: s.timesOfDay,
              doseWindows: s.doseWindows,
            })),
          }))}
        />
      )}
    </div>
  );
}

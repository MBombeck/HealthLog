"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B4 — pure presentational body for `<CoachDrawer>`.
 *
 * The drawer's outer Radix `<Sheet>` does not surface in SSR (its
 * portal is client-only), so the unit suite couldn't pin the
 * mobile-only rail-tray triggers via the `<CoachDrawer>` itself.
 * Lifting the body grid + chevron triggers + composer slot up here
 * gives the test a node-renderable surface; the `<CoachDrawer>`
 * itself stays the integrating shell that owns state + the trays.
 *
 * The component is stateless: the parent owns `historyTrayOpen` /
 * `sourcesTrayOpen` and passes the open-toggles + slot content. This
 * keeps the trigger logic + the desktop rail layout in one place
 * while delegating the actual side-sheet to the parent.
 */
export interface CoachDrawerBodyProps {
  historyRail: React.ReactNode;
  sourcesRail: React.ReactNode;
  thread: React.ReactNode;
  composer: React.ReactNode;
  onOpenHistoryTray: () => void;
  onOpenSourcesTray: () => void;
}

export function CoachDrawerBody({
  historyRail,
  sourcesRail,
  thread,
  composer,
  onOpenHistoryTray,
  onOpenSourcesTray,
}: CoachDrawerBodyProps) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="coach-drawer-body"
      // v1.4.20 phase D reconcile — narrower drawer cap at lg means the
      // sources rail no longer fits inline below xl. lg gets the
      // history rail + thread (sources surface via the chevron tray);
      // xl+ restores the full three-column layout.
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr] xl:grid-cols-[260px_1fr_280px]"
    >
      {/* History rail — desktop only. Mobile users summon it via the
          tray trigger inside the thread column. */}
      <aside
        data-slot="coach-drawer-history"
        className="border-border/70 hidden h-full min-h-0 border-r lg:flex lg:flex-col"
      >
        {historyRail}
      </aside>

      {/* Centre — message thread. */}
      <main
        data-slot="coach-drawer-thread"
        className="flex h-full min-h-0 flex-col"
      >
        {/* v1.4.27 R3d MB2 — rail-tray triggers lifted out of the
            absolute overlay into a sub-header strip so the chevrons
            sit at a 44 px tap target and never overlay the first
            message bubble. Hidden on `>=xl` because both rails are
            inline at that breakpoint. The history trigger remains
            visible up to lg-1 (rail is inline at lg+); the sources
            trigger remains visible up to xl-1 (rail is inline at
            xl+). */}
        <div
          data-slot="coach-drawer-rail-tray-strip"
          className="border-border/70 flex items-center justify-between gap-2 border-b px-3 py-2 xl:hidden"
        >
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenHistoryTray}
            data-slot="coach-drawer-history-tray-trigger"
            aria-label={t("insights.coach.historyTitle")}
            className="min-h-11 gap-1.5 text-xs lg:hidden"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
            {t("insights.coach.historyTitle")}
          </Button>
          {/* Sources tray trigger stays visible up to xl since the
              inline sources rail is xl+ only. The empty `<span>` to
              the left keeps the right-aligned button placement when
              the history trigger hides at lg+. */}
          <span aria-hidden="true" className="hidden lg:block" />
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSourcesTray}
            data-slot="coach-drawer-sources-tray-trigger"
            aria-label={t("insights.coach.sourcesTitle")}
            className="min-h-11 gap-1.5 text-xs"
          >
            {t("insights.coach.sourcesTitle")}
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1">{thread}</div>
        {/* Composer pinned to the bottom. */}
        <div
          data-slot="coach-drawer-composer"
          className="border-border/70 border-t p-3 sm:p-4"
        >
          {composer}
        </div>
      </main>

      {/* Sources rail — xl+ only. lg viewports surface it via the
          mobile chevron tray to keep the underlying /insights column
          readable behind the narrowed drawer cap. */}
      <aside
        data-slot="coach-drawer-sources"
        className="border-border/70 hidden h-full min-h-0 border-l xl:flex xl:flex-col"
      >
        {sourcesRail}
      </aside>
    </div>
  );
}

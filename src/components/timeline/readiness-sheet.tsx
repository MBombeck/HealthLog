"use client";

/**
 * The readiness sheet (v1.42, #613): opens right after the timeline module
 * is switched on in Settings, and again from "Data coverage" on the
 * timeline. It blocks nothing: "Later" closes it, "Open timeline" goes
 * there, and every gap link goes straight to where that gap is closed.
 *
 * Loaded on demand (`readiness-sheet.lazy.tsx`), so Settings carries none of
 * the timeline's code until the switch is flipped.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { ReadinessInventory, VerdictMeter } from "./readiness-inventory";
import { useTimelineReadiness } from "./use-timeline";

export function TimelineReadinessSheet({
  open,
  onOpenChange,
  showOpenTimeline = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False on the timeline itself, where "open" would go nowhere. */
  showOpenTimeline?: boolean;
}) {
  const { t } = useTranslations();
  const readiness = useTimelineReadiness(open);
  const close = () => onOpenChange(false);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("timeline.readiness.title")}
      description={t("timeline.readiness.subtitle")}
      contentWidth="lg"
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={close}
            data-slot="timeline-readiness-later"
          >
            {t("timeline.readiness.later")}
          </Button>
          {showOpenTimeline && (
            <Button asChild size="sm" className="min-h-11 sm:min-h-9">
              <Link
                href="/timeline"
                onClick={close}
                data-slot="timeline-readiness-open"
              >
                {t("timeline.readiness.open")}
              </Link>
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-slot="timeline-readiness-sheet">
        {readiness.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        ) : readiness.isError ? (
          <QueryErrorRow
            message={t("timeline.readiness.loadFailed")}
            onRetry={() => void readiness.refetch()}
          />
        ) : (
          <>
            <VerdictMeter readiness={readiness.data} />
            <ReadinessInventory readiness={readiness.data} onNavigate={close} />
            <p className="text-muted-foreground text-xs">
              {t("timeline.readiness.hint")}
            </p>
          </>
        )}
      </div>
    </ResponsiveSheet>
  );
}

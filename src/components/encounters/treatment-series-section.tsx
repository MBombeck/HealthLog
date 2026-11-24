"use client";

/**
 * The treatment series, above the visits they are made of (Care, Visits tab).
 *
 * A series can exist before its first session is booked, so this block stands
 * outside the visit list's own loading and empty states. It owns the series
 * read, its sheet and the `?series=<id>` link; the visit form stays with the
 * visits section, which this block asks to open for a new or an existing
 * session.
 */
import { Plus, Repeat } from "lucide-react";
import { useState } from "react";

import { InlineAction } from "@/components/ui/inline-action";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDeepLinkedRecord } from "@/hooks/use-deep-linked-record";
import type { Encounter } from "@/hooks/use-encounters";
import {
  useTreatmentSeriesList,
  type TreatmentSeries,
} from "@/hooks/use-treatment-series";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import { TreatmentSeriesCard } from "./treatment-series-card";
import { TreatmentSeriesSheet } from "./treatment-series-sheet";

/** One series by id, for a link to a series the list does not hold. */
function fetchSeries(id: string): Promise<TreatmentSeries | null> {
  return apiGet<TreatmentSeries>(
    `/api/treatment-series/${encodeURIComponent(id)}`,
  ).catch(() => null);
}

export function TreatmentSeriesSection({
  enabled,
  canAdd,
  canManage,
  onAddSession,
  onOpenSession,
}: {
  enabled: boolean;
  /** `POST` is WRITE under the profile section, edit and delete MANAGE. */
  canAdd: boolean;
  canManage: boolean;
  onAddSession: (series: TreatmentSeries) => void;
  onOpenSession: (visit: Encounter) => void;
}) {
  const { t } = useTranslations();
  const list = useTreatmentSeriesList(enabled);
  const series = list.data ?? [];

  // `null` closed, `"new"` create, a row opens it.
  const [open, setOpen] = useState<TreatmentSeries | "new" | null>(null);
  const [session, setSession] = useState(0);
  const openSheet = (target: TreatmentSeries | "new") => {
    setOpen(target);
    setSession((n) => n + 1);
  };
  useDeepLinkedRecord({
    param: "series",
    records: list.data,
    anchorAttribute: "data-series-id",
    open: canManage ? openSheet : undefined,
    resolve: fetchSeries,
  });

  if (!canAdd && series.length === 0) return null;

  return (
    <div className="space-y-2" data-slot="treatment-series-list">
      <SectionHeading
        icon={Repeat}
        title={t("treatmentSeries.heading")}
        action={
          canAdd ? (
            <InlineAction
              type="button"
              tone="primary"
              size="sm"
              data-slot="treatment-series-add"
              onClick={() => openSheet("new")}
            >
              <Plus aria-hidden />
              {t("treatmentSeries.add")}
            </InlineAction>
          ) : null
        }
      />
      {series.map((row) => (
        <TreatmentSeriesCard
          key={row.id}
          series={row}
          onOpen={canManage ? openSheet : undefined}
        />
      ))}

      {/* Remounted on every open (`key`), so the draft starts fresh. */}
      <TreatmentSeriesSheet
        key={session}
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        series={open === "new" ? null : open}
        onAddSession={
          canAdd
            ? (row) => {
                setOpen(null);
                onAddSession(row);
              }
            : undefined
        }
        onOpenSession={
          canManage
            ? (visit) => {
                setOpen(null);
                onOpenSession(visit);
              }
            : undefined
        }
      />
    </div>
  );
}

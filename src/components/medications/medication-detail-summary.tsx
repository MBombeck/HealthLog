"use client";

/**
 * v1.7.2 W3 — compact, non-editable medication-detail header.
 *
 * Supersedes the v1.7.0 `<MedicationDetailHeader>` (Edit / History /
 * Advanced action row) and the `<CadenceSummaryRow>` "Rhythmus" block.
 * The detail page is now history-centric: editing and advanced settings
 * are reached from the medications-list card kebab only, so this header
 * carries NO action buttons. It is a read-only summary line:
 *
 *   name (H1) → dose (muted) → status pill → plain-language cadence line
 *
 * One-shot medications render `Einmalig am …` in place of the cadence
 * summary; a pending one-shot falls back to the pending copy.
 */

import { Badge } from "@/components/ui/badge";
import {
  hydrateWizardPayload,
  summariseCadence,
  type MedicationPayload,
} from "@/components/medications/wizard/wizard-payload";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

export interface MedicationDetailSummaryProps {
  name: string;
  dose: string;
  active: boolean;
  endsOn?: string | null;
  /** Wizard payload used to derive the plain-language cadence line. */
  payload: MedicationPayload;
  oneShot: boolean;
  startsOn?: string | null;
}

type Status = "active" | "paused" | "ended";

function resolveStatus(active: boolean, endsOn?: string | null): Status {
  if (endsOn) {
    const end = new Date(endsOn);
    if (!Number.isNaN(end.getTime()) && end.getTime() <= Date.now()) {
      return "ended";
    }
  }
  return active ? "active" : "paused";
}

export function MedicationDetailSummary({
  name,
  dose,
  active,
  endsOn,
  payload,
  oneShot,
  startsOn,
}: MedicationDetailSummaryProps) {
  const { t } = useTranslations();
  const formatters = useFormatters();
  const status = resolveStatus(active, endsOn);

  const statusLabel =
    status === "active"
      ? t("medications.detail.status.active")
      : status === "paused"
        ? t("medications.detail.status.paused")
        : t("medications.detail.status.ended");

  const dotClass =
    status === "active"
      ? "bg-[hsl(var(--success))]"
      : status === "paused"
        ? "bg-[hsl(var(--warning))]"
        : "bg-muted-foreground";

  const cadenceLine = oneShot
    ? startsOn
      ? t("medications.detail.cadence.oneShotOn", {
          date: formatters.dateTime(startsOn),
        })
      : t("medications.detail.cadence.oneShotPending")
    : summariseCadence(hydrateWizardPayload(payload), t);

  return (
    <div className="space-y-1.5" data-slot="medication-detail-summary">
      <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
      <p className="text-muted-foreground text-sm">{dose}</p>
      <div
        className="text-muted-foreground flex items-center gap-2 text-xs"
        data-slot="medication-detail-status-row"
      >
        <Badge variant="secondary" className="gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${dotClass}`}
          />
          {statusLabel}
        </Badge>
      </div>
      <p
        className="text-muted-foreground text-sm"
        data-slot="medication-detail-cadence-line"
      >
        {cadenceLine}
      </p>
    </div>
  );
}

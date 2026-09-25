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
import {
  useTranslations,
  useFormatters,
  useDateFormatPreference,
} from "@/lib/i18n/context";
import { formatDate as formatCalendarDate } from "@/lib/date-format";

export interface MedicationDetailSummaryProps {
  name: string;
  dose: string;
  active: boolean;
  endsOn?: string | null;
  /** Wizard payload used to derive the plain-language cadence line. */
  payload: MedicationPayload;
  oneShot: boolean;
  /** v1.16.11 — as-needed (PRN): the cadence line reads "Bei Bedarf". */
  asNeeded?: boolean;
  startsOn?: string | null;
  /** v1.39.1 (#1033) — intake tracking off: a "Record only" badge. */
  recordOnly?: boolean;
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
  asNeeded = false,
  startsOn,
  recordOnly = false,
}: MedicationDetailSummaryProps) {
  const { t, locale } = useTranslations();
  const formatters = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  const status = resolveStatus(active, endsOn);

  const statusLabel =
    status === "active"
      ? t("medications.detail.status.active")
      : status === "paused"
        ? t("medications.detail.status.paused")
        : t("medications.detail.status.ended");

  // v1.12.2 — use the semantic `bg-success` / `bg-warning` utilities (each a
  // straight alias over the same colour the raw `hsl(var(--…))` resolved to)
  // so the detail status dot speaks the same token vocabulary as the card
  // status pill and streak instead of the raw HSL var form.
  const dotClass =
    status === "active"
      ? "bg-success"
      : status === "paused"
        ? "bg-warning"
        : "bg-muted-foreground";

  // Issue #490 — `Medication.startsOn` is a `@db.Date` calendar date
  // (serialised as UTC midnight). The old `formatters.dateTime(startsOn)`
  // re-read that instant in the display zone: it invented a meaningless
  // clock time and shifted the day for zones west of UTC. A calendar date
  // renders UTC-pinned (date only), correct in every zone.
  const cadenceLine = oneShot
    ? startsOn
      ? t("medications.detail.cadence.oneShotOn", {
          date: formatCalendarDate(new Date(startsOn), dateFormatPref, locale),
        })
      : t("medications.detail.cadence.oneShotPending")
    : asNeeded
      ? t("medications.detail.cadence.asNeeded")
      : summariseCadence(hydrateWizardPayload(payload), t, formatters.date);

  return (
    <div className="space-y-1.5" data-slot="medication-detail-summary">
      <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
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
        {recordOnly && (
          <Badge
            variant="secondary"
            data-slot="medication-detail-record-only-badge"
          >
            {t("medications.recordOnlyBadge")}
          </Badge>
        )}
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

"use client";

/**
 * The medication detail page's header, in one line: the name, the status
 * chip, the dose and the cadence, with the page's menu on the right. On a
 * phone the dose and cadence wrap under the name.
 *
 * The course window (start, end) and the person's note moved into the plan
 * card on the overview; the header names the medication and how it is taken,
 * nothing more. One-shot medications read "Einmalig am …" in place of the
 * cadence; as-needed ones read "Bei Bedarf".
 */

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  cadenceLineFor,
  hydrateWizardPayload,
  sortTimes,
  type MedicationPayload,
  type WizardPayload,
} from "@/components/medications/wizard/wizard-payload";
import {
  useTranslations,
  useFormatters,
  useDateFormatPreference,
} from "@/lib/i18n/context";
import { formatDate as formatCalendarDate } from "@/lib/date-format";
import { PageHeader } from "@/components/ui/page-header";

export interface MedicationDetailSummaryProps {
  name: string;
  dose: string;
  active: boolean;
  /**
   * v1.39.4 (#1040) — the server's course position. "Ended" follows it, so
   * the last course day reads as active on the user's clock instead of
   * flipping at UTC midnight of the end date.
   */
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  /** Wizard payload used to derive the plain-language cadence line. */
  payload: MedicationPayload;
  oneShot: boolean;
  /** v1.16.11 — as-needed (PRN): the cadence line reads "Bei Bedarf". */
  asNeeded?: boolean;
  startsOn?: string | null;
  /** v1.39.1 (#1033) — intake tracking off: a "Record only" badge. */
  recordOnly?: boolean;
  /** The page menu (edit, pause, end), right of the line. */
  menu?: ReactNode;
}

type Status = "active" | "paused" | "ended";

function resolveStatus(
  active: boolean,
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED",
): Status {
  if (courseStatus === "ENDED") return "ended";
  return active ? "active" : "paused";
}

/**
 * The cadence and its times without the course window ("Jeden Tag, um 08:00
 * und 20:00"): the start and end dates live in the plan below the header.
 */
export function summariseCadenceShort(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
  wallTime: (hhmm: string) => string,
  joinTimes: (times: string[]) => string,
): string {
  const cadenceLine = cadenceLineFor(payload, t);
  const timesPhrase =
    payload.mode !== "oneShot" &&
    payload.mode !== "asNeeded" &&
    payload.timesOfDay.length > 0
      ? t("medications.wizard.summary.times", {
          times: joinTimes(sortTimes(payload.timesOfDay).map(wallTime)),
        })
      : "";
  return [cadenceLine, timesPhrase].filter(Boolean).join(", ");
}

/** Clock times as a list in the reader's language: "08:00 und 20:00". */
export function useJoinTimes(): (times: string[]) => string {
  const { locale } = useTranslations();
  return (times) => {
    try {
      return new Intl.ListFormat(locale, {
        style: "long",
        type: "conjunction",
      }).format(times);
    } catch {
      return times.join(", ");
    }
  };
}

/** The cadence in one line, as the header says it. */
export function useCadenceLine({
  payload,
  oneShot,
  asNeeded,
  startsOn,
}: {
  payload: MedicationPayload;
  oneShot: boolean;
  asNeeded: boolean;
  startsOn?: string | null;
}): string {
  const { t, locale } = useTranslations();
  const formatters = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  const joinTimes = useJoinTimes();
  // Issue #490 — `startsOn` is a calendar date: rendered UTC-pinned.
  return oneShot
    ? startsOn
      ? t("medications.detail.cadence.oneShotOn", {
          date: formatCalendarDate(new Date(startsOn), dateFormatPref, locale),
        })
      : t("medications.detail.cadence.oneShotPending")
    : asNeeded
      ? t("medications.detail.cadence.asNeeded")
      : summariseCadenceShort(
          hydrateWizardPayload(payload),
          t,
          formatters.wallTime,
          joinTimes,
        );
}

export function MedicationDetailSummary({
  name,
  dose,
  active,
  courseStatus,
  payload,
  oneShot,
  asNeeded = false,
  startsOn,
  recordOnly = false,
  menu,
}: MedicationDetailSummaryProps) {
  const { t } = useTranslations();
  const status = resolveStatus(active, courseStatus);
  const cadenceLine = useCadenceLine({ payload, oneShot, asNeeded, startsOn });

  const statusLabel =
    status === "active"
      ? t("medications.detail.status.active")
      : status === "paused"
        ? t("medications.detail.status.paused")
        : t("medications.detail.status.ended");

  const dotClass =
    status === "active"
      ? "bg-success"
      : status === "paused"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <div data-slot="medication-detail-summary">
      <PageHeader
        title={name}
        actions={menu}
        titleAccessory={
          <>
            <Badge
              variant="secondary"
              className="gap-1.5"
              data-slot="medication-detail-status"
            >
              <span
                aria-hidden="true"
                className={`inline-block size-2 rounded-full ${dotClass}`}
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
            <p
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm max-sm:basis-full"
              data-slot="medication-detail-cadence-line"
            >
              {dose && (
                <span className="text-foreground font-semibold">{dose}</span>
              )}
              <span className="text-muted-foreground">{cadenceLine}</span>
            </p>
          </>
        }
      />
    </div>
  );
}

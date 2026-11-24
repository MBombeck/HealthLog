"use client";

import { type ComponentProps, type ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import {
  MedicationComplianceBars,
  MedicationComplianceError,
  MedicationComplianceNotApplicable,
  MedicationComplianceSkeleton,
} from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationCycleStatus } from "@/components/medications/card-parts/medication-cycle-status";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { MedicationNextLastSlot } from "@/components/medications/card-parts/medication-next-last-slot";
import { MedicationNote } from "@/components/medications/medication-note";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { CurrentCycle } from "@/lib/analytics/compliance";
import type { DoseState } from "@/lib/medications/dose-state/resolve";
import type { MedicationWindowStatus } from "@/lib/medications/dose-state/pill";

/**
 * v1.15.9 — the ONE shared medication-card body.
 *
 * Both the generic `<MedicationCard>` and the `<Glp1MedicationCard>` render
 * THIS component for their entire card shell + body, so structure, vertical
 * rhythm, spacing tokens, section order and labels are byte-identical by
 * construction — they cannot drift. The variants own only the data and the
 * VALUE content of the next/last lines (a daily med shows a clock time, a
 * weekly GLP-1 shows the liked "Samstag 13.7. (in 7 Tagen)" relative-day
 * phrasing); everything structural lives here.
 *
 * This closes the recurring "the two cards look subtly different" failure.
 * The Ramipril-vs-Mounjaro bottom-spacing mismatch in particular is fixed by
 * sharing this single `CardContent` (`flex h-full flex-col space-y-3.5`) and
 * the single `mt-auto pt-0` action wrapper — there is no per-variant spacing
 * left to diverge.
 *
 * State-driven presentation:
 *   - The card surface itself is a CONSTANT neutral surface — dose status
 *     never tints the card background or border. A whole card washing green
 *     reads as "take it now everywhere" and drowns the page; status is shown
 *     ONLY through the discreet top line / pill below.
 *   - `due` → the discreet "Take now" pill (success-toned text +
 *     glyph), no card wash.
 *   - `overdue` → a calm top status line; `missed` (at / past the miss
 *     cutoff) escalates to "Stark überfällig" in the destructive tone — both
 *     are a single text line with an icon, not a surface tint.
 *   - `pending` / `taken` / `taken_late` / `skipped` → no escalation; the
 *     card stays calm.
 */
export interface MedicationCardBodyProps {
  /**
   * Medication id. Rendered as `data-medication-id` so a deep-link (e.g. the
   * Today digest's "Log dose" action, `/medications?highlight=<id>`) can
   * locate + scroll to the right card.
   */
  id: string;
  /** Medication name shown on the header's line 1. */
  name: string;
  /** Dose shown beside the name on line 1. */
  dose: string;
  /**
   * #1371 — the person's own note ("30 to 60 minutes before food"), shown
   * inside the bottom-pinned block directly above the take / skip actions,
   * so it is in view when a dose is logged. The block only grows upward into
   * the free space, so the rows above (next / last, bars) keep their
   * baseline across a grid row. Null or empty renders nothing.
   */
  note?: string | null;
  /** Localised category label for the header badge. */
  categoryLabel: string;
  /** Whether the medication is active (greys out + hides the action row). */
  active: boolean;
  /** Detail-page link target for the header region. */
  href: string;
  /** Accessible label for the navigating header link. */
  linkLabel: string;
  /** State badges (without-notification / paused) for the header. */
  stateBadges: ReactNode;
  /** Overflow kebab for the header. */
  headerActions: ReactNode;

  /** Current take-window status pill props, or null when no window is open. */
  windowStatus: {
    status: Exclude<MedicationWindowStatus, null>;
    windowStart: string;
    windowEnd: string;
  } | null;

  /**
   * The open dose's server-resolved state at render time (`liveDoseState`),
   * null when there is none. Drives the overdue / missed top line.
   */
  doseState: DoseState | null;

  /** Upcoming-intake line value, or null when there is nothing to show. */
  nextLine: ReactNode | null;
  /** Last-intake line value, or null when the med has never been taken. */
  lastLine: ReactNode | null;

  /**
   * The resolved compliance block, or null while the per-card query is in
   * flight (the body then renders the constant-height skeleton).
   */
  compliance: {
    rate7: number | null;
    rate30: number | null;
    streak: number;
    shortDays: number;
    longDays: number;
  } | null;

  /**
   * True when the batched compliance query FAILED (post-retry). The body
   * then renders the quiet same-footprint error fallback instead of the
   * skeleton — a permanent skeleton reads as "still loading" forever,
   * while a failed read needs a visible (but calm) retry affordance.
   */
  complianceError?: boolean;
  /**
   * Settled not-applicable state for a scheduled medication with no local
   * schedule. This state must win over the loading skeleton.
   */
  complianceNotApplicable?: boolean;
  /** Refetch the shared compliance query (the error fallback's retry). */
  onRetryCompliance?: () => void;

  /** The open-cycle descriptor, or null when the display block is absent. */
  currentCycle: CurrentCycle | null;

  /**
   * v1.16.11 (#316) — as-needed (PRN) medication. True suppresses the
   * compliance block entirely (no bars, no skeleton, no error fallback —
   * the batched compliance read excludes as-needed medications, so a
   * skeleton would spin forever) and the open-cycle slot. The next/last
   * lines carry the "Bei Bedarf" + last-taken presentation instead.
   */
  asNeeded?: boolean;

  /**
   * v1.39.1 (#1033) — intake tracking off. The medication is shown as a
   * record: no compliance block (the batched read excludes it, so a
   * skeleton would spin forever), no open-cycle slot, and no take / skip
   * actions, because nothing is due and doses are not logged from here.
   */
  recordOnly?: boolean;

  /**
   * v1.39.4 (#1040) — the server's `intakeActionable`: false once the course
   * has ended (or before it starts), so the card offers no take / skip and
   * raises no overdue escalation for a dose that is no longer part of it.
   */
  intakeActionable?: boolean;

  /**
   * v1.16.11 — projected supply runway in whole days, set ONLY while it
   * sits below the user's low-stock threshold (the variants gate it).
   * Non-null renders the muted warning-toned "Vorrat: ≈ N Tage" notice on
   * the compliance bars' meta row (beside the streak flame); null keeps the
   * card free of stock noise. Never set for as-needed medications (no
   * consuming schedule, no runway). v1.16.12 moved it off the standalone
   * line above the bars onto the reserved meta row to stop it shifting the
   * two-bar baseline across a grid row.
   */
  lowStockRunwayDays?: number | null;

  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /** Record the displayed dose (the card binds the slot instant). */
  onRecordIntake: (skipped: boolean) => void;
  /** The slot the take records, named on the button (`cardTakeSlot`). */
  takeSlot?: ComponentProps<typeof MedicationIntakeActions>["slot"];
  /** The card's "Remind me later" and snoozed state (`useDoseSnooze`). */
  snooze?: ComponentProps<typeof MedicationIntakeActions>["snooze"];

  /** GLP-1 variant mounts its post-dose injection-site dialog here. */
  children?: ReactNode;

  /**
   * v1.29.x — briefly ringed when this card is the Today digest's
   * "Log dose" deep-link target (`/medications?highlight=<id>`), mirroring
   * the vault's `<DocumentCard highlighted>` treatment. Transient — the
   * page clears it a few seconds after scrolling the card into view.
   */
  highlighted?: boolean;
}

export function MedicationCardBody({
  id,
  name,
  dose,
  note = null,
  categoryLabel,
  active,
  href,
  linkLabel,
  stateBadges,
  headerActions,
  windowStatus,
  doseState,
  nextLine,
  lastLine,
  compliance,
  complianceError = false,
  complianceNotApplicable = false,
  onRetryCompliance,
  currentCycle,
  asNeeded = false,
  recordOnly = false,
  intakeActionable = true,
  lowStockRunwayDays = null,
  intakeLoading,
  onRecordIntake,
  takeSlot = null,
  snooze = null,
  children,
  highlighted = false,
}: MedicationCardBodyProps) {
  const { t } = useTranslations();

  // Escalation of the open dose past its on-time window, in the shared
  // vocabulary: "Overdue" while the late window runs, "Missed" past the miss
  // cutoff. A missed dose still counts (late) when taken now, and the card
  // says so under the row, so "missed" and the Take button beside it never
  // contradict each other. Suppressed on an inactive med.
  const canAct = active && intakeActionable;
  const escalation: "missed" | "overdue" | null =
    canAct && doseState === "missed"
      ? "missed"
      : canAct && doseState === "overdue"
        ? "overdue"
        : null;

  const nextValueOverride = (
    <NextDoseValue
      windowStatus={windowStatus}
      escalation={escalation}
      nextLine={nextLine}
    />
  );

  return (
    <Card
      data-medication-id={id}
      // The card surface is a constant neutral surface — dose status is never
      // expressed as a background / border tint (the maintainer, recurring): only the
      // discreet status line / pill below communicates take-now / overdue.
      //
      // v1.16.12 — the shadcn card primitive's airy `gap-4 md:gap-6` between
      // header and content read as a wide gulf below the category badge before
      // the first content line; tightened to a uniform `gap-3` here so the
      // name / class / next-intake block reads as one tight stack without
      // touching the shared primitive.
      //
      // v1.29.x — `highlighted` adds a transient ring (mirrors
      // `<DocumentCard highlighted>`) for the Today digest's deep-link
      // target. Never a persistent tint — the neutral-card rule above still
      // holds for dose STATUS; this is a one-time "you tapped here" cue.
      className={cn(
        "h-full gap-3 md:gap-3",
        active ? "" : "opacity-60",
        highlighted && "ring-primary ring-2",
      )}
    >
      <MedicationCardHeader
        name={name}
        dose={dose}
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
        href={href}
        linkLabel={linkLabel}
      />

      <CardContent className="flex h-full flex-col space-y-3.5">
        {/* Next / last intake — the two decisive lines, each shown once.
            The dose state (take-now / overdue / taken-early) IS the
            next-intake value when present; the schedule value fills the
            row otherwise. */}
        <MedicationNextLastSlot
          next={
            hasNextDoseValue(windowStatus, escalation)
              ? nextValueOverride
              : nextLine
          }
          last={lastLine}
        />
        {escalation === "missed" && !recordOnly && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="medication-missed-still-counts"
          >
            {t("medications.dose.state.missedStillCounts")}
          </p>
        )}

        {/* Compliance bars — always two rows; constant-height skeleton holds
            the slot while the query is in flight so the grid row stays even.
            A FAILED query swaps the skeleton for the same-footprint quiet
            error fallback (no bars, one notice line + retry) instead of
            sitting on the skeleton forever.

            v1.16.12 — the low-stock runway notice rides the bars' always-
            mounted meta row (beside the streak flame, flush right) rather
            than a standalone line above the bars. The former line inserted
            a conditional flow row only on low-supply cards, pushing their
            bars down and breaking the two-bar baseline across a grid row;
            the meta row is reserved on every card in every state, so the
            notice now costs zero layout shift. */}
        {active &&
          !asNeeded &&
          !recordOnly &&
          (complianceNotApplicable ? (
            <MedicationComplianceNotApplicable
              lowStockRunwayDays={lowStockRunwayDays}
            />
          ) : compliance ? (
            <MedicationComplianceBars
              rate7={compliance.rate7}
              rate30={compliance.rate30}
              streak={compliance.streak}
              shortDays={compliance.shortDays}
              longDays={compliance.longDays}
              lowStockRunwayDays={lowStockRunwayDays}
            />
          ) : complianceError && onRetryCompliance ? (
            <MedicationComplianceError
              onRetry={onRetryCompliance}
              lowStockRunwayDays={lowStockRunwayDays}
            />
          ) : (
            <MedicationComplianceSkeleton
              lowStockRunwayDays={lowStockRunwayDays}
            />
          ))}

        {/* Open-cycle status line — calm, rate-decoupled. The slot reserves
            one xs text line on every active card: the descriptor rides the
            compliance query, and a line appearing after the fetch resolved
            used to grow the card and shift the grid row (CLS). */}
        {active && !asNeeded && !recordOnly && (
          <div className="min-h-4">
            {currentCycle && <MedicationCycleStatus cycle={currentCycle} />}
          </div>
        )}

        {/* Quick actions — bottom-pinned so the action rows align across a
            grid row regardless of how much content sits above. */}
        {canAct && !recordOnly && (
          <div className="mt-auto space-y-2 pt-0">
            <MedicationNote note={note} slot="medication-card-note" clamp />
            <MedicationIntakeActions
              intakeLoading={intakeLoading}
              onRecordIntake={onRecordIntake}
              slot={takeSlot}
              snooze={snooze}
            />
          </div>
        )}
      </CardContent>

      {children}
    </Card>
  );
}

/** Whether the next-intake row shows the dose state instead of the schedule. */
function hasNextDoseValue(
  windowStatus: MedicationCardBodyProps["windowStatus"],
  escalation: "missed" | "overdue" | null,
): boolean {
  return escalation !== null || windowStatus !== null;
}

/**
 * The "next intake" row's value when a dose state rides it (v1.16.11): the
 * due pill inside the window, the escalation past it. The former standalone
 * status line above the slot reserved a blank row on every settled card and
 * broke the label/value grammar. Taken-early (the v1.16.9 double-dose
 * guard) suppresses every prompt: the row falls back to the schedule and the
 * "last intake" line below names the recent dose. The escalation keeps the
 * due time beside it: the matched window while one is open, else the card's
 * own next-intake value (the overdue slot time).
 */
function NextDoseValue({
  windowStatus,
  escalation,
  nextLine,
}: {
  windowStatus: MedicationCardBodyProps["windowStatus"];
  escalation: "missed" | "overdue" | null;
  nextLine: ReactNode | null;
}) {
  const { locale } = useTranslations();
  const fmt = useFormatters();
  if (escalation) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
        <DoseStateLabel state={escalation} emphasis />
        {windowStatus !== null ? (
          <span className="text-muted-foreground">
            {formatTimeWindowRange(
              windowStatus.windowStart,
              windowStatus.windowEnd,
              locale,
              fmt.wallTime,
            )}
          </span>
        ) : nextLine !== null ? (
          <span className="text-muted-foreground">{nextLine}</span>
        ) : null}
      </span>
    );
  }
  if (windowStatus === null) return null;
  return (
    <MedicationStatusPill
      status={windowStatus.status}
      windowStart={windowStatus.windowStart}
      windowEnd={windowStatus.windowEnd}
      inline
    />
  );
}

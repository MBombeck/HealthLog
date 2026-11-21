import { BellRing, Check, Loader2, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { DOSE_ACTION_TERM } from "@/lib/medications/dose-state/terms";
import type { TakeSlot } from "@/lib/medications/dose-state/pill";
import { userDayKey } from "@/lib/tz/format";

interface MedicationIntakeActionsProps {
  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /**
   * Record the displayed dose. The card binds the second `scheduledFor`
   * argument to the slot it is currently showing (v1.12.3), so the buttons
   * here just forward the skip flag.
   */
  onRecordIntake: (skipped: boolean) => void;
  /**
   * The slot the take records (`cardTakeSlot`): named on the button, so a
   * tap says which dose it answers, with an "early" line under the buttons
   * while that dose's window has not opened. Null keeps the plain label.
   */
  slot?: TakeSlot | null;
  /**
   * The card's snooze ("Remind me later (30 min)") and its snoozed state,
   * from {@link useDoseSnooze}. Omitted where a snooze means nothing.
   */
  snooze?: {
    minutes: number;
    snoozedUntil: string | null;
    canSnooze: boolean;
    busy: boolean;
    snooze: () => void;
  } | null;
}

/**
 * Shared primary take / skip action row for the medication cards. These are
 * the most-tapped controls in HealthLog, so they keep the full default
 * button height (`min-h-11`) to clear the WCAG 44-px tap-target floor.
 *
 * Extracted from the generic and GLP-1 cards so the action row is shared
 * structurally rather than kept byte-equivalent by hand.
 *
 * Both buttons carry a `data-slot`. They are the only controls on the card
 * that write, and their labels are translated copy — an e2e journey
 * addressing them by text would be asserting the translation, not the
 * control.
 */
export function MedicationIntakeActions({
  intakeLoading,
  onRecordIntake,
  slot = null,
  snooze = null,
}: MedicationIntakeActionsProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const tz = useDisplayTimezone();
  // v1.36.x — marking a dose taken or skipped is the verb the delegation was
  // written for. A read-only delegate sees the card and its schedule and no
  // action row; the card is otherwise unchanged.
  const { canWriteDomain } = useRecordCapabilities();
  const canRecordIntake = canWriteDomain("medications");
  if (!canRecordIntake) return null;

  // The slot's clock time, with its day when it is not today.
  const slotLabel = slot
    ? userDayKey(slot.at, tz) === userDayKey(new Date(), tz)
      ? fmt.time(slot.at)
      : `${fmt.dateShortSmart(slot.at)}, ${fmt.time(slot.at)}`
    : null;
  const earlyHint = slot?.earlyFrom ? (
    <p
      className="text-muted-foreground text-xs"
      data-slot="medication-intake-early"
    >
      {t("medications.dose.earlyHint", { time: fmt.time(slot.earlyFrom) })}
    </p>
  ) : null;

  const buttons = (
    <div className="flex gap-2">
      <Button
        data-slot="medication-intake-take"
        className="min-h-11 flex-1"
        onClick={() => onRecordIntake(false)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "take" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Check className="h-4 w-4" />
        )}
        {slotLabel
          ? t("medications.dose.action.takeSlot", { time: slotLabel })
          : t(DOSE_ACTION_TERM.take)}
      </Button>
      <Button
        data-slot="medication-intake-skip"
        variant="outline"
        className="min-h-11"
        onClick={() => onRecordIntake(true)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "skip" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <SkipForward className="h-4 w-4" />
        )}
        {t(DOSE_ACTION_TERM.skip)}
      </Button>
    </div>
  );

  if (!snooze || (!snooze.canSnooze && !snooze.snoozedUntil)) {
    return earlyHint ? (
      <div className="space-y-1">
        {buttons}
        {earlyHint}
      </div>
    ) : (
      buttons
    );
  }

  return (
    <div className="space-y-1">
      {buttons}
      {earlyHint}
      {/* The snooze rides under the two buttons: one length for every
          surface, named in the label, and the held state in its place once
          set, so a card never hides that the reminder was pushed back. */}
      {snooze.snoozedUntil ? (
        <p
          className="text-muted-foreground flex min-h-11 items-center gap-1.5 text-xs sm:min-h-9"
          data-slot="medication-snoozed"
        >
          <BellRing className="size-3.5 shrink-0" aria-hidden="true" />
          {t("medications.dose.state.snoozedUntil", {
            time: fmt.time(snooze.snoozedUntil),
          })}
        </p>
      ) : (
        <InlineAction
          tone="muted"
          size="xs"
          onClick={snooze.snooze}
          disabled={snooze.busy || !!intakeLoading}
          data-slot="medication-intake-snooze"
        >
          <BellRing className="size-3.5" aria-hidden="true" />
          {t(DOSE_ACTION_TERM.snooze, { minutes: snooze.minutes })}
        </InlineAction>
      )}
    </div>
  );
}

import {
  AlertCircle,
  AlertTriangle,
  CircleCheck,
  Clock,
  SkipForward,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { DoseState } from "@/lib/medications/dose-state/resolve";
import { DOSE_STATE_TERM } from "@/lib/medications/dose-state/terms";

/**
 * Colour and glyph of each dose state. A clock means the dose is still ahead
 * or due; a check means it was taken (late or not, the tone says which).
 * Colour never carries the meaning alone: glyph and word ride with it
 * (WCAG 1.4.1).
 */
export const DOSE_STATE_LOOK: Record<
  DoseState,
  { icon: LucideIcon; tone: string }
> = {
  pending: { icon: Clock, tone: "text-muted-foreground" },
  due: { icon: Clock, tone: "text-success" },
  overdue: { icon: AlertCircle, tone: "text-warning" },
  missed: { icon: AlertTriangle, tone: "text-destructive" },
  taken: { icon: CircleCheck, tone: "text-success" },
  taken_late: { icon: CircleCheck, tone: "text-warning" },
  skipped: { icon: SkipForward, tone: "text-muted-foreground" },
};

/**
 * One dose state as glyph + word, in the state's tone. Every surface that
 * names a dose state renders it through this, so the card, the table and the
 * history read the same word with the same glyph.
 */
export function DoseStateLabel({
  state,
  className,
  emphasis = false,
  slot = "dose-state",
}: {
  state: DoseState;
  className?: string;
  /** The `data-slot` the label carries (a surface's own selector). */
  slot?: string;
  /**
   * The urgent tone for an overdue dose late in its window (the card's
   * escalation); the word stays "Overdue".
   */
  emphasis?: boolean;
}) {
  const { t } = useTranslations();
  const look = DOSE_STATE_LOOK[state];
  const Icon = emphasis && state === "overdue" ? AlertTriangle : look.icon;
  const tone = emphasis && state === "overdue" ? "text-destructive" : look.tone;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        tone,
        className,
      )}
      data-slot={slot}
      data-state={state}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {t(DOSE_STATE_TERM[state])}
    </span>
  );
}

/**
 * An open slot past its on-time window, on the card's "next intake" row and
 * the table's next cell: the shared "Overdue" label and the slot's time. It
 * replaces "Overdue since {slot time}, can still be taken", which named the
 * slot time as the moment the dose turned overdue.
 */
export function OverdueSlotValue({ at }: { at: string | number | Date }) {
  const fmt = useFormatters();
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1 text-sm"
      data-slot="medication-overdue-slot"
    >
      <DoseStateLabel state="overdue" />
      <span className="text-muted-foreground">{fmt.time(new Date(at))}</span>
    </span>
  );
}

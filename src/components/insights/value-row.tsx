import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { InfoPopover } from "@/components/ui/info-popover";
import { cn } from "@/lib/utils";

/** One read-out: a name, its value and, under it, one short note. */
export interface ValueRowItem {
  key: string;
  label: string;
  /** The figure, or a dash when there is none. */
  value: ReactNode;
  unit?: string;
  /** One short note under the value ("today 119", an icon, a status). */
  note?: ReactNode;
  /** Shown on hover and read by assistive tech, e.g. why a value is a dash. */
  title?: string;
  /** The read-out a control on the card has chosen (a part of the day). */
  selected?: boolean;
}

const COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

/**
 * A row of compact read-outs inside a metric card: the usual range per
 * series, blood pressure by part of the day, the values derived from a
 * reading. Same cell as the stat strip above the chart (a small caps name,
 * the figure in `text-base` semibold, the unit muted beside it), so every
 * number on a metric page reads in one hand. What a value means goes behind
 * the card's (i), never into a sentence beside it.
 */
export function ValueRow({
  items,
  slot,
  className,
}: {
  items: ValueRowItem[];
  slot?: string;
  className?: string;
}) {
  return (
    <dl
      data-slot={slot ?? "value-row"}
      className={cn(
        "grid gap-x-3 gap-y-2",
        COLS[items.length] ?? COLS[4],
        className,
      )}
    >
      {items.map((item) => (
        <div
          key={item.key}
          data-key={item.key}
          data-selected={item.selected ? "true" : undefined}
          title={item.title}
          className={cn(
            // The chosen read-out wears the selection tint; the padding is
            // given back by the negative margin so the columns do not move.
            "-mx-2 -my-1 min-w-0 space-y-0.5 rounded-md px-2 py-1",
            item.selected && "bg-primary/10 ring-primary/30 ring-1",
          )}
        >
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {item.label}
          </dt>
          <dd className="flex items-baseline gap-1 text-base font-semibold tabular-nums">
            <span>{item.value}</span>
            {item.unit ? (
              <span className="text-muted-foreground text-xs font-normal">
                {item.unit}
              </span>
            ) : null}
          </dd>
          {item.note ? (
            <dd className="text-muted-foreground flex items-center gap-1 text-xs">
              {item.note}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * A card of its own for values a page derives from a reading (blood
 * pressure's pulse pressure and mean pressure): the values in one row, and
 * what they mean behind the (i) at its end.
 */
export function DerivedValuesCard({
  items,
  about,
  slot,
}: {
  items: ValueRowItem[];
  /** What the values mean, read in the (i) popover. */
  about: string;
  slot?: string;
}) {
  return (
    <Card data-slot={slot ?? "derived-values"} density="compact">
      <CardContent className="flex items-start gap-3">
        <ValueRow items={items} className="flex-1" />
        <InfoPopover content={about} />
      </CardContent>
    </Card>
  );
}

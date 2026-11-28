"use client";

import { useState } from "react";
import { Info, type LucideIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** A plain external citation link rendered under the popover body. */
export interface InfoPopoverLink {
  /** Display name of the cited source (e.g. "WHO BMI classification"). */
  name: string;
  /** Absolute URL, rendered as a plain `<a>`, never HTML. */
  url: string;
}

/**
 * The app's one (i) info-affordance. Replaces the bare `title=` attribute
 * (which never surfaces on touch) and, since v1.28.17, the earlier
 * two-primitive split: a click-opened `Popover` — not a hover `Tooltip` —
 * because most of this app's use is on touch, where a hover-only tooltip
 * never opens reliably on tap. `v1.29.2`'s `VitalsInfoTip` made exactly
 * this argument for the vitals grid; the same reasoning applies to every
 * other (i) trigger in the tree, so the two primitives merge into this one.
 *
 * The trigger is a real button with an accessible name, so keyboard and
 * screen-reader users reach the same content a pointer user gets on tap.
 *
 * The trigger carries `data-slot="hint"`: it is the sanctioned place for an
 * explanation, and the per-route explainer budget in
 * `e2e/text-budgets.json` counts every visible one. `data-hint` names which
 * hint it is, for a test that needs to find one in particular.
 */
export interface InfoPopoverProps {
  /** Body content — plain text or a short mix of text nodes. */
  content: React.ReactNode;
  /** Optional cited source, rendered as a plain external link. */
  link?: InfoPopoverLink;
  /**
   * Accessible name of the trigger button. Defaults to the generic
   * "More information" — pass a more specific label (e.g. "How is this
   * calculated?") where the caller wants that framing.
   */
  label?: string;
  className?: string;
  /**
   * Trigger glyph. Defaults to `Info` (h-3.5 w-3.5); the compliance-tip
   * wrapper passes `HelpCircle` at `h-3 w-3` to keep its pre-merge look.
   */
  icon?: LucideIcon;
  iconClassName?: string;
  /** Popover alignment relative to the trigger. Defaults to `"end"`. */
  align?: "start" | "center" | "end";
  /** Which hint this is, as `data-hint` on the trigger. */
  triggerDataSlot?: string;
  /** `data-slot` override for the popover body. */
  bodyDataSlot?: string;
}

export function InfoPopover({
  content,
  link,
  label,
  className,
  icon: Icon = Info,
  iconClassName = "h-3.5 w-3.5",
  align = "end",
  triggerDataSlot = "info-popover",
  bodyDataSlot = "info-popover-body",
}: InfoPopoverProps) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="hint"
          data-hint={triggerDataSlot}
          aria-label={label ?? t("common.moreInfo")}
          aria-expanded={open}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
            "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
            "-mx-2 -my-3",
            "transition-colors focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <Icon className={iconClassName} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot={bodyDataSlot}
        align={align}
        sideOffset={6}
        className="max-w-xs space-y-1.5"
      >
        <p className="text-muted-foreground text-xs leading-snug">{content}</p>
        {link ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary block text-xs leading-snug hover:underline"
          >
            {link.name}
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

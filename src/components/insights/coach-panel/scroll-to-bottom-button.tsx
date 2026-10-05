"use client";

/**
 * The round "jump to latest" button over the bottom of the Coach thread.
 *
 * It fades in once the reader has scrolled away from the end and fades out
 * at the end. While hidden it stays mounted (so the fade has something to
 * run on) but leaves the accessibility tree and the tab order and takes no
 * pointer events. With reduced motion it switches without a transition.
 */
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({
  visible,
  onClick,
}: ScrollToBottomButtonProps) {
  const { t } = useTranslations();
  const label = t("insights.coach.answer.scrollToBottom");
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      data-slot="coach-scroll-to-bottom"
      data-visible={visible ? "true" : "false"}
      aria-label={label}
      title={label}
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      onClick={onClick}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 size-11 -translate-x-1/2 rounded-full shadow-md sm:size-9",
        // Opaque in both themes: it floats over prose, which must not show
        // through (the outline variant's dark fill is translucent).
        "bg-background dark:bg-background dark:hover:bg-accent",
        "transition-[opacity,translate] duration-200 motion-reduce:transition-none",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ArrowDown className="size-4" aria-hidden="true" />
    </Button>
  );
}

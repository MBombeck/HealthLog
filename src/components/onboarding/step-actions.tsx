"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The action row every setup screen ends on: back on the left, skip and the
 * primary on the right. One shape, so the buttons sit in the same place on
 * every screen and a keyboard user's tab order never changes between them.
 *
 * Back is a link (a plain navigation to a screen that already has its
 * answer), skip and next are buttons (they persist something first). Each
 * one is optional: the welcome screen has no back, the confirm screen has no
 * skip, the done screen has only the primary.
 */
export function StepActions({
  backHref,
  onSkip,
  onNext,
  nextLabel,
  nextDisabled = false,
  pending = false,
}: {
  backHref?: string;
  onSkip?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  pending?: boolean;
}) {
  const { t } = useTranslations();

  return (
    <div
      // `flex-wrap` on both rows: a locale whose labels run 30% longer must
      // drop the action group to its own line at 390 px, not push it past
      // the viewport (the string-headroom sweep measures exactly this).
      className="flex flex-wrap items-center justify-between gap-2 pt-2"
      data-slot="onboarding-step-actions"
    >
      {backHref ? (
        <Button asChild variant="ghost" className="min-h-11 min-w-11">
          <Link href={backHref} data-slot="onboarding-back">
            {t("onboarding.shell.back")}
          </Link>
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {onSkip ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            disabled={pending}
            className="min-h-11 min-w-11"
            data-slot="onboarding-skip"
          >
            {t("onboarding.shell.skip")}
          </Button>
        ) : null}
        {onNext ? (
          <Button
            type="button"
            onClick={onNext}
            disabled={pending || nextDisabled}
            className="min-h-11 min-w-11"
            data-slot="onboarding-next"
          >
            {pending ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {nextLabel ?? t("onboarding.shell.next")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The action row every setup screen ends on (1.50): at most two buttons, of
 * equal width, the primary on the right. Back and "Finish later" live in the
 * frame's top row, so this row is only ever the step's own pair: "Skip" or
 * "Not now" beside "Continue", "No" beside "Yes", "Later" beside "Add a
 * passkey".
 *
 * On a phone the row holds the bottom edge, split into two halves (one
 * button takes the whole width); from `md` it sits right under the content,
 * right-aligned, both buttons as wide as the longer label.
 *
 * A consent with two answers ("No" / "Yes") is the pair itself.
 */
export interface StepAction {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  /** Submit the form the row sits in, instead of `onClick`. */
  submit?: boolean;
  /** `data-slot` for tests; defaults per position. */
  slot?: string;
}

export function StepActions({
  secondary,
  primary,
  pending = false,
  describedBy,
}: {
  secondary?: StepAction;
  primary?: StepAction;
  /** A write is in flight: both buttons wait, the primary spins. */
  pending?: boolean;
  /** Id of a line that says why the primary is disabled. */
  describedBy?: string;
}) {
  const actions = [secondary, primary].filter(
    (action): action is StepAction => action !== undefined,
  );
  if (actions.length === 0) return null;
  return (
    <div
      data-slot="onboarding-step-actions"
      className={cn(
        // Phone: held at the bottom edge, above the home indicator.
        "bg-background sticky bottom-0 z-10 -mx-4 mt-auto px-4 pt-3 pb-[max(var(--safe-area-bottom),1rem)]",
        // Wide: right under the content.
        "md:static md:mx-0 md:mt-8 md:bg-transparent md:p-0",
      )}
    >
      <div
        className={cn(
          "grid gap-2",
          actions.length === 2 ? "grid-cols-2" : "grid-cols-1",
          "md:ml-auto md:w-fit",
        )}
      >
        {secondary ? (
          <ActionButton
            action={secondary}
            variant="outline"
            slot={secondary.slot ?? "onboarding-skip"}
            pending={pending}
          />
        ) : null}
        {primary ? (
          <ActionButton
            action={primary}
            variant="default"
            slot={primary.slot ?? "onboarding-next"}
            pending={pending}
            spinner
            describedBy={describedBy}
          />
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  variant,
  slot,
  pending,
  spinner = false,
  describedBy,
}: {
  action: StepAction;
  variant: "default" | "outline";
  slot: string;
  pending: boolean;
  spinner?: boolean;
  describedBy?: string;
}) {
  const className = "min-h-11 w-full md:min-w-32 md:px-6";
  if (action.href) {
    return (
      <Link
        href={action.href}
        data-slot={slot}
        className={cn(buttonVariants({ variant }), className)}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      type={action.submit ? "submit" : "button"}
      variant={variant}
      onClick={action.onClick}
      disabled={pending || action.disabled}
      aria-busy={(pending && spinner) || undefined}
      aria-describedby={describedBy}
      data-slot={slot}
      className={className}
    >
      {pending && spinner ? (
        <Loader2
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
      ) : null}
      {action.label}
    </Button>
  );
}

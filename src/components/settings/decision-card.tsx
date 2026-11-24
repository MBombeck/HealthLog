"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";

/** One answer of a decision card: a button, or a link to where it goes on. */
export type DecisionAnswer = {
  label: string;
  slot?: string;
} & ({ onClick: () => void; href?: never } | { href: string; onClick?: never });

/**
 * A question an admin or a person answers once, shown where they land until
 * it is answered: the relay question, the server setup notice.
 *
 * One shape for all of them, so a one-time question reads the same wherever
 * it appears: a headline, at most one sentence under it, the details behind
 * one "Learn more" at the end of that sentence, and the two answers in the
 * card's action row, the one that goes ahead as the primary action on the
 * right and the one that declines as the secondary beside it (design
 * standards §12). `note` is a line the answer itself produced (a refusal to
 * act on), shown above the row.
 */
export function DecisionCard({
  icon,
  title,
  body,
  learnMore,
  note,
  accept,
  decline,
  pending = false,
  children,
  ...props
}: Omit<ComponentProps<typeof SettingsCard>, "title" | "children"> & {
  icon: LucideIcon;
  title: string;
  body: string;
  learnMore?: { href: string; label: string };
  note?: ReactNode;
  accept: DecisionAnswer;
  decline: DecisionAnswer;
  pending?: boolean;
  /** What the answer opens (a confirmation dialog), outside the layout. */
  children?: ReactNode;
}) {
  return (
    <SettingsCard data-decision-card="" {...props}>
      <SettingsCardHeader icon={icon} title={title} />
      <p className="text-sm">
        {body}
        {learnMore ? (
          <>
            {" "}
            <InlineAction asChild tone="muted" size="sm">
              <a href={learnMore.href} target="_blank" rel="noreferrer">
                {learnMore.label}
              </a>
            </InlineAction>
          </>
        ) : null}
      </p>
      {note}
      <SettingsCardActions>
        <AnswerButton answer={decline} variant="outline" pending={pending} />
        <AnswerButton answer={accept} variant="default" pending={pending} />
      </SettingsCardActions>
      {children}
    </SettingsCard>
  );
}

function AnswerButton({
  answer,
  variant,
  pending,
}: {
  answer: DecisionAnswer;
  variant: "default" | "outline";
  pending: boolean;
}) {
  if (answer.href !== undefined) {
    return (
      <Button asChild variant={variant} size="sm">
        <Link href={answer.href} data-slot={answer.slot}>
          {answer.label}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={pending}
      onClick={answer.onClick}
      data-slot={answer.slot}
    >
      {answer.label}
    </Button>
  );
}

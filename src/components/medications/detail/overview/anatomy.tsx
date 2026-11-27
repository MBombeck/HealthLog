"use client";

/**
 * The anatomy every overview card shares: a header with an icon, a title and
 * a chip; one sentence; one figure or a short list; and a pair of
 * equal-width buttons at the foot, the secondary left, the primary right.
 * The cards sit in one row on a wide screen and stretch to the same height,
 * so the button pairs line up.
 */

import type { ComponentType, ReactNode } from "react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TagChip } from "@/components/ui/tag-chip";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

export interface OverviewCompliance {
  applicable: boolean;
  notApplicableReason: "NO_LOCAL_SCHEDULE" | "INTAKE_NOT_TRACKED" | null;
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
  complianceDisplay: ComplianceDisplay | null;
}

/** One overview card: header with chip, a sentence, a body, a button pair. */
export function OverviewCard({
  icon,
  title,
  chip,
  sentence,
  children,
  actions,
  slot,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  chip?: ReactNode;
  sentence: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  slot: string;
}) {
  return (
    <Card className="h-full" data-slot={slot}>
      <CardHeader>
        <TileHeader
          icon={icon}
          title={title}
          titleAs="h2"
          right={chip ? <TagChip className="shrink-0">{chip}</TagChip> : null}
        />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-foreground text-sm" data-slot={`${slot}-sentence`}>
          {sentence}
        </p>
        {children}
        {actions && <div className="mt-auto">{actions}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Two equal-width framed buttons: the secondary left, the filled primary
 * right. A missing secondary leaves its half empty, so the primary stays in
 * the same place on every card.
 */
export function ActionPair({
  secondary,
  primary,
}: {
  secondary?: ReactNode;
  primary: ReactNode;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" data-slot="overview-action-pair">
      {secondary ?? <span aria-hidden="true" />}
      {primary}
    </div>
  );
}

export const PAIR_BUTTON = "min-h-11 w-full sm:min-h-9";

"use client";

import { type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { CardHeader, CardTitle } from "@/components/ui/card";

/**
 * v1.4.28 FB-G1 — shared medication-list row header.
 *
 * The generic `<MedicationCard>` and the `<Glp1MedicationCard>` carry
 * the same two-line row shape on the medications list page. Both rows
 * route their title + dose + drug class through this primitive so the
 * surface stays one consistent shape:
 *
 *   Line 1: `{name} {dose}` — bold, `text-lg`
 *   Line 2: `{categoryLabel}` outline badge + optional state badges
 *
 * The trailing `actions` slot carries the icon-button cluster (history +
 * edit) on the right of the row. State badges (without-notification,
 * paused-since, inactive) ride on line 2 alongside the class label so a
 * narrow viewport keeps a single inline run.
 *
 * The GLP-1 row previously surfaced a `<Syringe>` glyph + middle-dot
 * separator on line 1 and demoted the dose to a muted inline span. This
 * primitive folds it into the canonical two-line shape; the syringe icon
 * and the dot separator are gone from the list row.
 */
export interface MedicationCardHeaderProps {
  name: string;
  dose: string;
  categoryLabel: string;
  stateBadges?: ReactNode;
  actions?: ReactNode;
}

export function MedicationCardHeader({
  name,
  dose,
  categoryLabel,
  stateBadges,
  actions,
}: MedicationCardHeaderProps) {
  return (
    <CardHeader className="pb-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-lg">
            {name} {dose}
          </CardTitle>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="text-xs">
              {categoryLabel}
            </Badge>
            {stateBadges}
          </div>
        </div>
        {actions ? (
          <div className="flex items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
    </CardHeader>
  );
}

"use client";

import { type ReactNode } from "react";
import Link from "next/link";

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
 * The trailing `actions` slot carries the overflow kebab on the right of
 * the row. State badges (without-notification, paused-since, inactive)
 * ride on line 2 alongside the class label so a narrow viewport keeps a
 * single inline run.
 *
 * v1.7.2 W3 — when `href` is set the name + dose + category region
 * becomes a Link to the medication detail page (the former chevron
 * target). The kebab in `actions` is a sibling outside the Link so
 * opening the menu never also navigates.
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
  /**
   * v1.7.2 W3 — when set, the name + dose + category region links to the
   * medication detail page so the card body is tappable/navigable. The
   * `actions` kebab stays a sibling outside the Link.
   */
  href?: string;
  /** Accessible name for the navigating Link region. */
  linkLabel?: string;
}

export function MedicationCardHeader({
  name,
  dose,
  categoryLabel,
  stateBadges,
  actions,
  href,
  linkLabel,
}: MedicationCardHeaderProps) {
  const body = (
    <>
      <CardTitle className="text-lg">
        {name} {dose}
      </CardTitle>
      {/* D-H6 — state badges (without-notification, paused-since,
          inactive) used to share line 2 with the category badge
          via `flex flex-wrap`. At 320 px any state badge pushed
          the row to three lines and broke the FB-G1 "two-line,
          no exceptions" contract for ~20 % of configured drugs.
          State badges now ride their own row below the category
          badge so the canonical row stays two lines on narrow
          viewports. */}
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Badge variant="outline" className="text-xs">
          {categoryLabel}
        </Badge>
      </div>
      {stateBadges ? (
        <div
          data-slot="medication-card-header-state-badges"
          className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm"
        >
          {stateBadges}
        </div>
      ) : null}
    </>
  );

  return (
    <CardHeader className="pb-2.5">
      <div className="flex items-start justify-between gap-2">
        {href ? (
          <Link
            href={href}
            aria-label={linkLabel}
            data-slot="medication-card-header-link"
            className="-m-1 min-w-0 space-y-1 rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {body}
          </Link>
        ) : (
          <div className="min-w-0 space-y-1">{body}</div>
        )}
        {actions ? (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
    </CardHeader>
  );
}

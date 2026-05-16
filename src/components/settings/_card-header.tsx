"use client";

/**
 * `<SettingsCardHeader>` — v1.4.33 IW4 polish primitive.
 *
 * Every Settings card paints the same shape: a primary icon, a title,
 * an optional status surface (badge / pill / inline switch), and an
 * optional short description below the title. Before this primitive
 * the codebase carried five different `flex flex-wrap items-start
 * justify-between` permutations across `account-section.tsx`,
 * `integrations-section.tsx`, `notification-status-card.tsx`,
 * `telegram-card.tsx`, `ntfy-card.tsx`, `web-push-card.tsx`,
 * `api-section.tsx`, and `advanced-section.tsx`. The audit's mechanical
 * drift report (`.planning/round-v1433-audit-settings.md` §2.5) listed
 * one card with `mb-4 flex items-center gap-2`, the next with
 * `flex flex-col gap-3 sm:flex-row sm:justify-between`, another with
 * `flex flex-wrap items-start justify-between`, etc.
 *
 * The primitive consolidates the contract:
 *   - Icon left, title right of it (`gap-2` between them).
 *   - Optional status slot lives top-right; on `<sm` it falls below the
 *     title block so the action surface keeps its 44 px tap target.
 *   - Description is muted text, sits below the title row.
 *
 * Call sites can still wire their own action surfaces inside the body
 * of the card — the primitive only owns the *header* slice, not the
 * footer or the form rows.
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SettingsCardHeaderProps {
  /** Lucide icon component; rendered as `text-primary h-5 w-5`. */
  icon: LucideIcon;
  /** Card title — rendered as `<h2 class="text-lg font-semibold">`. */
  title: string;
  /** Optional id for the `<h2>` so an outer `aria-labelledby`
   *  attribute on the card itself can reference it. */
  titleId?: string;
  /** Optional short description rendered as muted text below the
   *  title row. Either a string (paragraph) or arbitrary node
   *  (links, badges, etc.). */
  description?: React.ReactNode;
  /** Optional right-aligned status surface — typically an
   *  `<IntegrationStatusPill>` or a wrapper around badges. */
  status?: React.ReactNode;
  /** Optional extra classes applied to the outer wrapper. */
  className?: string;
}

export function SettingsCardHeader({
  icon: Icon,
  title,
  titleId,
  description,
  status,
  className,
}: SettingsCardHeaderProps) {
  return (
    <header className={cn("space-y-1", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="text-primary h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
      </div>
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
    </header>
  );
}

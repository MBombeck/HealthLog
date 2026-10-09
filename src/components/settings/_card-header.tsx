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
  /** Lucide icon component; rendered as `text-muted-foreground h-5 w-5`.
   *  Neutral by design — primary/purple stays reserved for actions and
   *  highlight states, never for section-header iconography. */
  icon: LucideIcon;
  /** Card title — rendered as `<h2 class="text-lg font-semibold">`.
   *  Accepts a node so a card can wrap the title in a link. */
  title: React.ReactNode;
  /** Optional id for the `<h2>` so an outer `aria-labelledby`
   *  attribute on the card itself can reference it. */
  titleId?: string;
  /** Optional inline accessory rendered in the title row, immediately
   *  after the title (e.g. a tag chip + experimental badge). The title
   *  row wraps so the accessories reflow below on a narrow viewport. */
  titleAccessory?: React.ReactNode;
  /** Optional description rendered as muted text below the title row.
   *  Exactly ONE sentence, guideline ≤ 120 characters (design standards
   *  §3). A node is accepted so the sentence can carry an inline link,
   *  not so it can carry a second paragraph — the slot owns no vertical
   *  rhythm, so a stack of `<p>`s collapses into one run and reads
   *  broken. Multi-sentence prose goes in the body as
   *  `<p className="text-sm">` (foreground). */
  description?: React.ReactNode;
  /** Optional deep-link anchor: the header carries it as its `id` (with the
   *  shell's `scroll-mt-28`), so `/settings/<section>#<anchor>` lands on this
   *  card. The command palette links every card it lists this way; the
   *  anchors it relies on are pinned in `src/lib/command-palette/
   *  settings-cards.ts`. */
  anchor?: string;
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
  titleAccessory,
  description,
  status,
  anchor,
  className,
}: SettingsCardHeaderProps) {
  return (
    <header
      id={anchor}
      className={cn(
        "flex items-start gap-2",
        anchor && "scroll-mt-28",
        className,
      )}
    >
      <Icon
        className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
        aria-hidden="true"
      />
      {/* Title + description share one column to the RIGHT of the icon, so the
          description left-aligns with the title rather than slipping back under
          the icon gutter. */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {titleAccessory}
          </div>
          {status ? (
            // `max-w-full` caps the slot at the row once it wraps under the
            // title, so a status line longer than a phone row wraps inside
            // the card instead of widening the page.
            <div className="flex max-w-full shrink-0 items-center gap-2">
              {status}
            </div>
          ) : null}
        </div>
        {/* One sentence, one text run. This slot deliberately carries no
            `space-y-*`: the vertical rhythm was the licence call sites used
            to stack explainer paragraphs into a muted `text-xs` slot.
            The `data-slot` is what a browser test targets — asserting the
            sentence's bytes couples the suite to wording, and a text diet
            then breaks specs that were never about the words. */}
        {description ? (
          <div
            data-slot="settings-card-description"
            className="text-muted-foreground text-xs"
          >
            {description}
          </div>
        ) : null}
      </div>
    </header>
  );
}

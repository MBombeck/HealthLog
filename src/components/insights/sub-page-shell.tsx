"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W4 — common visual frame for each metric sub-page.
 *
 * Each sub-page renders:
 *   - a calm header (title + optional status badge),
 *   - the canonical chart for the metric (passed in as `chart` so the
 *     page can wire the right `chartKey`, target zones, value bands, …),
 *   - secondary slot for related cards (correlation cards, per-medication
 *     lists, …).
 *
 * The shell handles focus restoration on route change — a screen-reader
 * user landing here from a tab click hears the page heading
 * automatically because we mount an `id="insights-subpage-title"`
 * h1 with `tabIndex={-1}` and focus it on mount. Sighted users get a
 * `scrollTo({ top: 0 })` so deep-scroll position from the previous
 * sub-page doesn't leak in.
 */

export interface SubPageShellProps {
  title: string;
  /** Optional accent badge (status, dataset coverage, …). */
  badge?: ReactNode;
  /**
   * Optional short paragraph beneath the title, mirroring the Apple-Health
   * convention of a one-line scaffold on every metric page. The mother
   * page does not pass it; sub-pages use it to anchor the surface.
   */
  description?: string;
  /**
   * v1.4.27 MB7 / CF-35 — opt-in programmatic focus on mount.
   *
   * The legacy default-on `focus()` call moved screen-reader focus to
   * the heading but on mobile it also fought the soft-keyboard: a
   * sub-page navigation that landed while a form was open dismissed
   * the keyboard mid-typing. Default is now `false`; sub-pages that
   * actually want the screen-reader landing (today: none; the routed
   * sub-pages do not auto-focus anything) opt in explicitly.
   *
   * The `scrollTo({ top: 0 })` still fires unconditionally because
   * the deep-scroll reset between routed sub-pages is a sighted-user
   * affordance, not an a11y one.
   */
  focusOnMount?: boolean;
  children: ReactNode;
}

export function SubPageShell({
  title,
  badge,
  description,
  focusOnMount = false,
  children,
}: SubPageShellProps) {
  // a11y: focus the heading on mount so a tab-strip navigation actually
  // moves screen-reader focus into the sub-page body. v1.4.27 MB7 /
  // CF-35 made the call opt-in via `focusOnMount` — the default-on
  // version was stealing focus from soft-keyboards on mobile and
  // breaking mid-flow form entries. The `scrollTo` still fires
  // unconditionally; both honour `prefers-reduced-motion: reduce`
  // implicitly because `scrollTo({ behavior: "auto" })` does not
  // animate, and the focus call is a single discrete event.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    if (focusOnMount) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [focusOnMount]);

  return (
    <div data-slot="insights-subpage" className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1
            ref={headingRef}
            id="insights-subpage-title"
            tabIndex={-1}
            className={cn(
              "text-xl font-semibold sm:text-2xl",
              // a11y: sighted-keyboard users (e.g. "Skip to content")
              // need a visible focus indicator on the programmatic
              // `headingRef.focus()` call below. Match the focus ring
              // vocabulary used on insights pills + Coach affordances.
              "rounded-sm focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
            )}
          >
            {title}
          </h1>
          {badge ? (
            <Badge variant="outline" className="border text-xs">
              {badge}
            </Badge>
          ) : null}
        </div>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </header>
      {children}
    </div>
  );
}

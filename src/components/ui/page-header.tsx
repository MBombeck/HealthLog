import type { ReactNode } from "react";

import { BackLink } from "@/components/ui/back-link";
import { cn } from "@/lib/utils";

/**
 * The one canonical page header. Every module surface renders its title
 * through this so the header vocabulary reads identically app-wide: the H1
 * is always `text-2xl font-bold tracking-tight`, the explainer under it is
 * always `text-muted-foreground text-sm` (heading in foreground, one-line
 * explainer in muted — the app-wide convention the design standards pin for
 * `CardDescription`, `PageHeader`, and `SettingsCardHeader` alike), and no
 * icon sits beside the H1. An optional back-link rides above the title, and
 * an `actions` slot holds the page's primary buttons to the right of the
 * title block.
 *
 * The explainer never truncates. A page that clipped it mid-word to hold one
 * line on a phone was trading a readable sentence for a fixed height; the
 * fixed height now comes from every header being built the same way, and a
 * sentence too long for one line is a text problem, fixed in the string.
 *
 * `headingAs="div"` renders the title as `role="heading" aria-level={1}`
 * instead of an `<h1>`. The Settings and Admin shells paint their heading
 * twice — once above the mobile section strip, once inside the desktop grid
 * row — and only one of the two may be a real `<h1>`. Without this the two
 * shells hand-rolled the whole block to get the second copy, which is how
 * they drifted apart from every module page in the first place.
 */
/**
 * A long one-word German title (the illness page was once
 * "Krankheitstagebuch") is wider than the column a phone leaves beside the
 * actions, and without a break opportunity it ran underneath them. `hyphens-auto` breaks it by the page's `lang`; the
 * `wrap-break-word` floor covers a word the hyphenation dictionary does not.
 */
const HEADING_CLASS =
  "min-w-0 text-2xl font-bold tracking-tight hyphens-auto wrap-break-word";

export function PageHeader({
  title,
  titleId,
  description,
  headingAs = "h1",
  backLink,
  topSlot,
  actions,
  stackActionsOnPhone = false,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  headingAs?: "h1" | "div";
  backLink?: { href: string; label: string; dataSlot?: string };
  /** Optional block above the title (e.g. a hub back-link the shell owns). */
  topSlot?: ReactNode;
  actions?: ReactNode;
  /**
   * Below `sm`, move the actions onto their own row under the description.
   * For text-labelled actions (two outline links, say): beside the title they
   * left the H1 a column narrower than its own word. Icon actions fit beside
   * the title and leave this off.
   */
  stackActionsOnPhone?: boolean;
  className?: string;
}) {
  const heading =
    headingAs === "div" ? (
      <div id={titleId} role="heading" aria-level={1} className={HEADING_CLASS}>
        {title}
      </div>
    ) : (
      <h1 id={titleId} className={HEADING_CLASS}>
        {title}
      </h1>
    );

  // Title, description and actions share one grid. On a phone the
  // description spans the full row under the title + actions: a header with
  // three or four icon actions otherwise left the sentence a ~130 px column
  // that wrapped five or six times. From `sm` up the actions span both rows,
  // so the description sits beside them exactly as before.
  return (
    <div className={cn("space-y-1.5", className)}>
      {backLink ? <BackLink {...backLink} /> : null}
      {topSlot}
      <div
        data-slot="page-header-row"
        className={cn(
          "grid items-start gap-x-3 gap-y-1.5",
          actions ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
          actions && stackActionsOnPhone && "max-sm:grid-cols-1",
        )}
      >
        {heading}
        {actions ? (
          <div
            className={cn(
              "col-start-2 row-start-1 flex shrink-0 items-center gap-2",
              description && "sm:row-span-2",
              stackActionsOnPhone &&
                "max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-3 max-sm:flex-wrap",
            )}
          >
            {actions}
          </div>
        ) : null}
        {description ? (
          <p
            className={cn(
              "text-muted-foreground text-sm",
              actions && "col-span-full sm:col-span-1",
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

import type { ReactNode, Ref } from "react";
import dynamic from "next/dynamic";
import { Info } from "lucide-react";

import { BackLink } from "@/components/ui/back-link";
import { cn } from "@/lib/utils";

/**
 * The (i) loads with the first page that has one: most headers carry none,
 * and the popover would otherwise ride along in every page's first load.
 * Until it arrives, the same glyph holds its place, so the title does not
 * move when it does.
 */
const InfoPopover = dynamic(
  () => import("@/components/ui/info-popover").then((m) => m.InfoPopover),
  {
    loading: () => (
      <span
        aria-hidden="true"
        data-slot="hint"
        data-hint="page-header-info"
        className="text-muted-foreground -mx-2 -my-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center"
      >
        <Info className="h-3.5 w-3.5" />
      </span>
    ),
  },
);
/**
 * The one canonical page header. Every module surface renders its title
 * through this so the header vocabulary reads identically app-wide: the H1
 * is always `text-2xl font-bold tracking-tight` and no icon sits beside it.
 * An optional back-link rides above the title, and an `actions` slot holds
 * the page's primary buttons to the right of the title block.
 *
 * There is no subtitle. About eighty pages carried a sentence under the
 * title, and almost every one said the title again in sentence form ("Your
 * medications, their schedules and every dose"). What a page has to explain
 * and the surface works without goes behind `info`, the (i) beside the
 * title; what it must say (safety, consent) belongs to the card it concerns,
 * not to the page head.
 *
 * `meta` is the one meta line of a detail page (pattern B): a fact of the
 * record such as a dose or a shared link's label, never copy that describes
 * the page. `page-header-no-subtitle.test.ts` refuses a translated string in
 * it.
 *
 * `headingAs="div"` renders the title as `role="heading" aria-level={1}`
 * instead of an `<h1>`. The Settings and Admin shells paint their heading
 * twice — once above the mobile section strip, once inside the desktop grid
 * row — and only one of the two may be a real `<h1>`. Without this the two
 * shells hand-rolled the whole block to get the second copy, which is how
 * they drifted apart from every module page in the first place.
 *
 * `focusable` makes the H1 a programmatic focus target (`tabIndex={-1}`
 * with a visible ring) and `headingRef` hands the caller the element: a
 * sub-page or a result screen moves focus to its title after a client
 * navigation. `titleAccessory` sits beside the H1 and
 * wraps with it (a nudge glyph, a badge) without becoming part of the
 * heading's accessible name. Both exist so the insights sub-page shell and
 * the check-in screens stop hand-rolling their own heading.
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
  info,
  meta,
  headingAs = "h1",
  backLink,
  topSlot,
  actions,
  stackActionsOnPhone = false,
  headingRef,
  focusable = false,
  titleAccessory,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  /** The (i) beside the title: what the page is, for those who ask. */
  info?: ReactNode;
  /** One meta line of record data under the title (pattern B only). */
  meta?: ReactNode;
  headingAs?: "h1" | "div";
  backLink?: { href: string; label: string; dataSlot?: string };
  /** Optional block above the title (e.g. a hub back-link the shell owns). */
  topSlot?: ReactNode;
  actions?: ReactNode;
  /**
   * Below `sm`, move the actions onto their own row under the title.
   * For text-labelled actions (two outline links, say): beside the title they
   * left the H1 a column narrower than its own word. Icon actions fit beside
   * the title and leave this off.
   */
  stackActionsOnPhone?: boolean;
  /** The H1 element, for a caller that moves focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Makes the H1 a programmatic focus target with a visible ring. */
  focusable?: boolean;
  /** Beside the H1, outside its accessible name (a nudge glyph, a badge). */
  titleAccessory?: ReactNode;
  className?: string;
}) {
  const heading =
    headingAs === "div" ? (
      <div id={titleId} role="heading" aria-level={1} className={HEADING_CLASS}>
        {title}
      </div>
    ) : (
      <h1
        ref={headingRef}
        id={titleId}
        tabIndex={focusable ? -1 : undefined}
        className={cn(
          HEADING_CLASS,
          focusable &&
            "focus-visible:ring-ring/50 rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        )}
      >
        {title}
      </h1>
    );
  const accessory =
    info || titleAccessory ? (
      <>
        {info ? (
          <InfoPopover
            content={info}
            align="start"
            triggerDataSlot="page-header-info"
          />
        ) : null}
        {titleAccessory}
      </>
    ) : null;
  const titleBlock = accessory ? (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {heading}
      {accessory}
    </div>
  ) : (
    heading
  );

  // Title, meta line and actions share one grid. On a phone the meta line
  // spans the full row under the title + actions; from `sm` up the actions
  // span both rows, so the meta line sits beside them.
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
        {titleBlock}
        {actions ? (
          <div
            className={cn(
              "col-start-2 row-start-1 flex shrink-0 items-center gap-2",
              meta && "sm:row-span-2",
              stackActionsOnPhone &&
                "max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-3 max-sm:flex-wrap",
            )}
          >
            {actions}
          </div>
        ) : null}
        {meta ? (
          <p
            data-slot="page-header-meta"
            className={cn(
              "text-muted-foreground truncate text-sm",
              actions && "col-span-full sm:col-span-1",
            )}
          >
            {meta}
          </p>
        ) : null}
      </div>
    </div>
  );
}

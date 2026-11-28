import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The bordered row box: one record as a card of its own. Lists are moving to
 * `ListGroup` + `ListItem` below (one card per group, a line between rows),
 * because a card per record is what made a page of 25 readings 2600 px tall
 * on a phone. New lists use those; this stays until the last stack migrates.
 *
 * v1.18.7 — shared list-row primitive.
 *
 * Before this, every list-row "mini-card" (a bordered row sitting inside
 * a section or a `<Card>`) invented its own padding + radius: the
 * Vorsorge dashboard card used `rounded-md p-2.5`, the daily-briefing
 * rows `rounded-md p-3`, the measurement-list mobile row a bespoke
 * `rounded-lg p-3` div. Three surfaces, three shapes for one visual
 * concept. `ListRow` pins the canonical shape — `rounded-lg border p-3`
 * — so the rows read as one language across the app.
 *
 * It owns ONLY the box shape (radius + border + padding). Layout
 * (flex direction, alignment, gap), colour overrides, and interaction
 * state stay with the caller via `className`, so migrating a bespoke row
 * is purely dropping the radius/border/padding literals and keeping the
 * rest.
 *
 * `asChild` renders the row as its single child (e.g. a `<Link>` or
 * `<li>`) while still applying the shared classes, matching the shadcn
 * primitive convention used elsewhere in `ui/`.
 */
function ListRow({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="list-row"
      className={cn("rounded-lg border p-3", className)}
      {...props}
    />
  );
}

/**
 * One group of records: a single card, its rows separated by a line. The
 * group's heading (`SectionHeading`, or a plain heading with a count) stands
 * above it, outside the card. UI standards §20.
 *
 * An empty group is not a dashed box with a button in it: pass `empty` and
 * the card holds one row that adds the first record ("+ Add a custom
 * metric"), the same height as the rows it will hold.
 */
function ListGroup({
  className,
  children,
  empty,
  ...props
}: React.ComponentProps<"ul"> & {
  /** The one row an empty group shows: what adding the first record says. */
  empty?: { label: string; onSelect?: () => void; href?: string };
}) {
  const hasRows = React.Children.toArray(children).length > 0;
  if (!hasRows && !empty) return null;
  return (
    <ul
      // `data-list-group` stays when a call site names the group its own
      // `data-slot`: it is the measure point of `e2e/row-geometry.spec.ts`.
      data-list-group=""
      data-slot="list-group"
      data-empty={hasRows ? undefined : "true"}
      className={cn(
        "bg-card text-card-foreground divide-border/70 divide-y overflow-hidden rounded-xl border shadow-sm",
        className,
      )}
      {...props}
    >
      {hasRows ? (
        children
      ) : empty ? (
        <ListItem
          data-slot="list-group-add"
          icon={
            <span className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
              <Plus className="size-4" aria-hidden />
            </span>
          }
          title={empty.label}
          {...(empty.href
            ? { href: empty.href }
            : empty.onSelect
              ? { onSelect: empty.onSelect }
              : {})}
          chevron={false}
        />
      ) : null}
    </ul>
  );
}

/**
 * One record in a `ListGroup`: at most 64 px on a phone.
 *
 * Left to right: an optional `leading` control (a selection checkbox), the
 * `icon`, the `title` over one `meta` line (both cut to one line), the
 * `trailing` value or chip, and a chevron when the row opens something and
 * shows no value. A row with a value never carries a chevron, whatever the
 * caller asks: the space goes to the value and its unit, which stay on one
 * line, and hover and focus show that the row is tappable. A row without a
 * value that leads somewhere ("Stock ›") keeps its chevron. UI standards §20.
 * The whole row is the tap target (`href` or `onSelect`): the title carries
 * the control and stretches it over the row, so the row needs no edit or
 * delete buttons of its own; those live where the row leads (the edit
 * sheet's "⋯"). A link or button inside `leading`, `icon` or `meta` stays
 * tappable on its own, above the stretched control.
 *
 * `expanded` turns the row into a disclosure (chevron down, `aria-expanded`)
 * and `children` is what it discloses, under the row inside the same item.
 */
function ListItem({
  icon,
  leading,
  title,
  meta,
  trailing,
  href,
  onSelect,
  expanded,
  controls,
  actionLabel,
  chevron = true,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "title"> & {
  /** Where the row leads; wins over `onSelect`. */
  href?: string;
  /** What a tap on the row does. */
  onSelect?: () => void;
  icon?: React.ReactNode;
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  /** A disclosure row: open or closed. */
  expanded?: boolean;
  /** The id of what a disclosure row opens. */
  controls?: string;
  /** Accessible name of the row's control, when the title alone is not. */
  actionLabel?: string;
  /**
   * Show the chevron of an interactive row; off while a row selects. A row
   * with a `trailing` value never shows one.
   */
  chevron?: boolean;
}) {
  const interactive = href !== undefined || onSelect !== undefined;
  const actionClass =
    "block w-full truncate text-left text-sm font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none";
  const titleNode = href ? (
    <Link
      href={href}
      data-slot="list-item-action"
      aria-label={actionLabel}
      className={actionClass}
    >
      {title}
    </Link>
  ) : onSelect ? (
    <button
      type="button"
      data-slot="list-item-action"
      onClick={onSelect}
      aria-label={actionLabel}
      aria-expanded={expanded}
      aria-controls={controls}
      className={actionClass}
    >
      {title}
    </button>
  ) : (
    <p className="truncate text-sm font-medium">{title}</p>
  );
  const Chevron = expanded === undefined ? ChevronRight : ChevronDown;
  return (
    <li data-slot="list-item" className={className} {...props}>
      {/* Measure points for `e2e/row-geometry.spec.ts`: the row box (its
          type is whether it carries a meta line), the icon, the text column,
          the trailing value and the glyph. Every row of a group must line
          up on them. */}
      <div
        data-slot="list-item-row"
        data-row-type={meta ? "meta" : "single"}
        className={cn(
          "relative flex min-h-14 items-center gap-2.5 px-4 py-2",
          interactive &&
            "hover:bg-muted/40 has-[[data-slot=list-item-action]:focus-visible]:ring-ring/50 transition-colors has-[[data-slot=list-item-action]:focus-visible]:ring-[3px] has-[[data-slot=list-item-action]:focus-visible]:ring-inset",
        )}
      >
        {leading ? (
          <div className="relative z-10 flex shrink-0 items-center">
            {leading}
          </div>
        ) : null}
        {icon ? (
          <div
            data-slot="list-item-icon"
            className="relative z-10 flex shrink-0 items-center"
          >
            {icon}
          </div>
        ) : null}
        <div data-slot="list-item-text" className="min-w-0 flex-1">
          {titleNode}
          {meta ? (
            <div
              data-slot="list-item-meta"
              className="text-muted-foreground truncate text-xs [&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10"
            >
              {meta}
            </div>
          ) : null}
        </div>
        {trailing ? (
          <div
            data-slot="list-item-trailing"
            className="flex shrink-0 items-center text-sm font-semibold whitespace-nowrap tabular-nums"
          >
            {trailing}
          </div>
        ) : null}
        {interactive && chevron && !trailing ? (
          <Chevron
            aria-hidden
            data-slot="list-item-glyph"
            className={cn(
              // Tucked against the value: the row's gap is for content.
              "text-muted-foreground -ml-1 size-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </div>
      {children}
    </li>
  );
}

/**
 * The heading row above a group (domain page template, zone 4): the group's
 * name and its count on the left, the one filter control on the right. The
 * count appears here and nowhere else on the page.
 */
function ListHeading({
  title,
  count,
  action,
  className,
  id,
}: {
  title: React.ReactNode;
  count?: React.ReactNode;
  /** The one filter control (`MenuSelect`, or a "Filter" button). */
  action?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      data-slot="list-heading"
      className={cn(
        "flex min-h-9 items-center justify-between gap-3",
        className,
      )}
    >
      <h2 id={id} className="min-w-0 truncate text-base font-semibold">
        {title}
        {count !== undefined ? (
          <span
            data-slot="list-heading-count"
            className="text-muted-foreground ml-2 font-normal tabular-nums"
          >
            {count}
          </span>
        ) : null}
      </h2>
      {action ? (
        <div className="flex shrink-0 items-center">{action}</div>
      ) : null}
    </div>
  );
}

/**
 * Columns of a row on a wide screen: the same row gains them, it does not
 * become a table of its own. Each cell is a fixed width, right-aligned, so a
 * group's cells and its `ListHead` stand on the same lines. Hidden on a
 * phone, where the row keeps its one trailing value.
 */
function ListColumns({
  cells,
  className,
}: {
  cells: ReadonlyArray<{
    key: string;
    content: React.ReactNode;
    strong?: boolean;
  }>;
  className?: string;
}) {
  return (
    <div
      data-slot="list-columns"
      className={cn("hidden items-center md:flex", className)}
    >
      {cells.map((cell) => (
        <span
          key={cell.key}
          data-column={cell.key}
          className={cn(
            "w-28 truncate text-right text-sm whitespace-nowrap tabular-nums",
            cell.strong
              ? "text-foreground font-semibold"
              : "text-muted-foreground font-normal",
          )}
        >
          {cell.content}
        </span>
      ))}
    </div>
  );
}

/**
 * The quiet column head of a group on a wide screen: the title column's name
 * over the row titles, then one name per `ListColumns` cell.
 */
function ListHead({
  title,
  columns,
  withIcon = true,
}: {
  title: React.ReactNode;
  columns: ReadonlyArray<{ key: string; label: React.ReactNode }>;
  /** Whether the rows carry an icon tile the title column starts after. */
  withIcon?: boolean;
}) {
  return (
    <li
      data-slot="list-head"
      aria-hidden="true"
      className="text-muted-foreground hidden min-h-11 items-center gap-2.5 px-4 text-xs md:flex"
    >
      {withIcon ? <span className="size-8 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="flex items-center">
        {columns.map((column) => (
          <span key={column.key} className="w-28 truncate text-right">
            {column.label}
          </span>
        ))}
      </span>
    </li>
  );
}

/**
 * The last row of a group that shows only part of its records: "Weitere n
 * zeigen". No pagination bar.
 */
function ListMoreRow({
  label,
  onSelect,
  busy = false,
  error,
}: {
  label: string;
  onSelect: () => void;
  busy?: boolean;
  /** Said in the row when the last attempt failed; the row retries. */
  error?: string;
}) {
  return (
    <li data-slot="list-more">
      <button
        type="button"
        onClick={onSelect}
        disabled={busy}
        aria-busy={busy || undefined}
        className="text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:ring-ring/50 flex min-h-12 w-full items-center justify-center px-4 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none focus-visible:ring-inset disabled:opacity-60"
      >
        {error ?? label}
      </button>
    </li>
  );
}

export {
  ListColumns,
  ListGroup,
  ListHead,
  ListHeading,
  ListItem,
  ListMoreRow,
  ListRow,
};

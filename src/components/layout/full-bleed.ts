/**
 * Whether the shell renders a page edge to edge.
 *
 * The Coach page is the one full-bleed route: its conversations panel sits
 * flush against the right edge of the viewport and the page owns every
 * scroll area inside it. The shell then drops its centred container and
 * padding, and `<main>` drops its reserved scrollbar gutter, which would
 * otherwise paint a dead strip to the right of the panel on
 * classic-scrollbar platforms.
 *
 * Exactly `/coach`: its sub-pages (plans, conversations) are ordinary pages
 * in the padded frame. A refusal on `/coach` (outside a shared record, or
 * the module switched off) renders a card, so it keeps the padded frame too.
 */
const FULL_BLEED_PATH = "/coach";

export function isFullBleedPage(args: {
  pathname: string;
  outsideSharedRecord: boolean;
  moduleOff: boolean;
}): boolean {
  return (
    args.pathname === FULL_BLEED_PATH &&
    !args.outsideSharedRecord &&
    !args.moduleOff
  );
}

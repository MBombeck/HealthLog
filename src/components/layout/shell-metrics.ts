/**
 * Shared scroll-floor for the two-column sub-shells (Settings, Admin).
 *
 * Scroll height is shell-owned (over-scroll class, #154 lineage): only
 * `AuthShell` owns the scroll container's height and bottom padding — the
 * `<main>` clears the mobile bottom-nav and its wrapper clears the Coach FAB.
 * A sub-shell must NEVER re-declare a bottom gutter (`pb-*`) or a viewport
 * reserve (`min-h-[calc(100dvh-…)]`) on its own content column: a nested
 * reserve stacks on the shell budget and scrolls past the last card.
 *
 * The one sanctioned reserve is this loading-jump floor, applied to the
 * sub-shell GRID (not to a column): it keeps the page height stable while a
 * freshly-navigated section is still fetching, without over-shooting the
 * viewport on a short section. The `<main>`/cards column is the grid's `1fr`
 * row, so it stretches to fill exactly and never over-scrolls.
 *
 * Both sub-shells derive the floor from THIS single constant so the two can
 * never drift — Admin previously carried a stale, all-breakpoint
 * `min-h-[calc(100dvh-12rem)]` column reserve that this de-duplication retires.
 *
 * Budget: top bar 4rem + the AuthShell wrapper's `pt-6` (1.5rem) + its bottom
 * padding: `pb-20` (5rem) = 10.5rem in the phone shell, `pb-24` (6rem) =
 * 11.5rem in the desktop shell (the page frame in `auth-shell.tsx`). Retune here —
 * and only here — if those shell paddings change. (Latent follow-up: this constant assumes zero banners above `<main>`;
 * a locale/offline/demo banner or an iOS PWA safe-area inset makes it
 * over-reserve. A fully self-accounting `min-h-full` chain would need the
 * AuthShell content wrapper to pass a definite height through, which is out of
 * scope for the shell-only over-scroll fix.)
 */
export const SUB_SHELL_GRID_FLOOR =
  "md:min-h-[calc(100dvh-10.5rem)] shell-desktop:min-h-[calc(100dvh-11.5rem)]";

/**
 * The authenticated shell's outer box. It takes the window's edges
 * (`absolute inset-0` against the initial containing block) rather than
 * `h-dvh`, and the top and side safe-area insets (`shell-safe-area`,
 * globals.css); the bottom inset belongs to whatever owns the bottom edge in
 * each shell.
 *
 * Not a viewport unit: `h-dvh` is the browser's idea of the visible height,
 * and on iPadOS Safari that idea and the area it lays out disagree after a
 * rotation and under the floating toolbars. A short value left a strip of
 * page colour under the shell with the last card cut off above it; a tall one
 * made the document scroll by the difference, and that document scroll took
 * the swipes meant for `<main>`. The initial containing block is the layout
 * itself, recomputed with every rotation and resize, and the document never
 * scrolls (`data-scroll="shell"`, `document-scroll-mode.ts`), so the box
 * cannot drift from the window either.
 *
 * Not `fixed`: a fixed box gets a compositing layer of its own, which
 * re-rasterised the text of every page (the antialiasing moved on every
 * screen), and forms a stacking context that would trap the bottom bar's
 * z-index under the Coach button and the toasts.
 */
export const SHELL_ROOT_CLASS =
  "shell-safe-area absolute inset-0 flex flex-col";

/**
 * `<main>`, the shell's one vertical scroller. Phone shell: it clears the
 * bottom nav and the home indicator. Desktop shell: there is no bar, and it
 * clears the home indicator of an installed app on a tablet (zero in a
 * browser tab), so the last line never sits under it.
 */
export const MAIN_SCROLL_CLASS =
  "relative flex-1 overflow-y-auto pb-[calc(4rem+var(--safe-area-bottom))] shell-desktop:pb-(--safe-area-bottom)";

/**
 * The app-chrome header band: one 4rem strip whose bottom border draws the
 * single horizontal line across the top of the app.
 *
 * Two elements paint that line. The top bar (`top-bar.tsx`) draws it over the
 * content column, the sidebar logo band (`sidebar-nav.tsx`) draws it over the
 * rail, and the two live in different columns of the shell flex row, so
 * nothing in the layout makes them agree. Each used to declare `h-16` on its
 * own, and the two lines still landed a pixel apart: every box in the app is
 * `border-box`, so `h-16 border-b` on ONE element puts the line inside the
 * 4rem (63 to 64 px) while `h-16` on a child of a `border-b` wrapper puts it
 * after the 4rem (64 to 65 px). Same number, different line.
 *
 * The height and the border therefore travel together, from here. The element
 * that carries this class IS the band; neither call site restates a height,
 * and anything nested inside stretches with `h-full`.
 *
 * Border COLOUR stays per-surface (`border-border` on the top bar,
 * `border-sidebar-border` on the rail): the two chrome surfaces are tinted
 * apart by design and only the geometry has to match.
 *
 * Guards: `chrome-header-seam.test.tsx` asserts both elements render this
 * exact class and declare no height of their own;
 * `e2e/chrome-header-seam.spec.ts` measures the two painted borders at four
 * widths in both the expanded and the collapsed rail.
 */
export const SHELL_HEADER_BAND = "h-16 border-b";

/**
 * The rail's account band, the bottom counterpart of its logo band: the same
 * height, the border on the other side, the avatar centred in it. Padded on
 * its own (`p-3`, `p-2` on short windows) it came out 61 to 69 px tall with
 * 18 px above the avatar and more below, and its divider sat at no height
 * the logo band shares. The home-indicator inset stays under the band (the
 * rail's `pb-(--safe-area-bottom)`), so the band itself never shifts.
 */
export const RAIL_ACCOUNT_BAND = "h-16 shrink-0 border-t";

/**
 * The rail's width, collapsed (4rem) and expanded (16rem), plus the window's
 * left inset. The rail runs to the window's left edge and takes that inset as
 * padding inside its own background (`pl-(--safe-area-left)` on the
 * `<aside>`), so its content keeps the 4rem / 16rem it was laid out for and
 * stays clear of the inset. The shell leaves the left side to the rail
 * (`.shell-safe-area`, globals.css): an iPad in a Safari tab laid the shell
 * out 10 px in from the left, and that strip showed the page colour beside
 * the rail. Zero inset: exactly `w-16` / `w-64`.
 */
export const RAIL_WIDTH_COLLAPSED = "w-[calc(4rem+var(--safe-area-left))]";
export const RAIL_WIDTH_EXPANDED = "w-[calc(16rem+var(--safe-area-left))]";

/**
 * A rail band that draws a border across the rail (the logo band, the footer
 * group's scroll edge, the account band) reaches back over the left inset, so
 * its line runs to the window's edge like the top bar's does, and adds the
 * inset to its own left padding, so its content stays where it was.
 */
const RAIL_BAND_BLEED = "-ml-(--safe-area-left)";

/** The logo band's and the footer group's horizontal padding, inset included. */
export const RAIL_BAND_INSET = {
  header: {
    collapsed: `${RAIL_BAND_BLEED} pr-3 pl-[calc(0.75rem+var(--safe-area-left))]`,
    expanded: `${RAIL_BAND_BLEED} pr-6 pl-[calc(1.5rem+var(--safe-area-left))]`,
  },
  footer: {
    collapsed: `${RAIL_BAND_BLEED} pr-1.5 pl-[calc(0.375rem+var(--safe-area-left))]`,
    expanded: `${RAIL_BAND_BLEED} pr-3 pl-[calc(0.75rem+var(--safe-area-left))]`,
  },
} as const;

/** The account band, collapsed (the avatar centred) and expanded. */
export const RAIL_ACCOUNT_BAND_CLASS = {
  collapsed: `${RAIL_ACCOUNT_BAND} ${RAIL_BAND_BLEED} border-sidebar-border flex items-center justify-center pl-(--safe-area-left)`,
  expanded: `${RAIL_ACCOUNT_BAND} ${RAIL_BAND_BLEED} border-sidebar-border flex items-center pr-3 pl-[calc(0.75rem+var(--safe-area-left))]`,
} as const;

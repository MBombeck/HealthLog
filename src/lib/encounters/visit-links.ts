/**
 * Where a visit lives in the app, spelled once.
 *
 * Visits have no page of their own: they are the second tab of `/care`,
 * beside the preventive-care list that opens by default. A bare `/care`
 * therefore lands on the checkups, which is the wrong half of the page for an
 * appointment, and every surface that hand-spelled that path for a visit (the
 * dashboard's next-appointment line, the Today rail, the Today overview, the
 * appointment's push) sent the person to the list the appointment is not on.
 *
 * Every link to one visit or to the visits list is built here, in two
 * spellings: the wire one for what leaves the server, the web one for links
 * the browser renders itself (see below). The page reads both
 * parameters: `visit` opens that visit on the visits tab
 * (`src/hooks/use-deep-linked-record.ts`), `view` picks a tab.
 * `visit-link-guard.test.ts` refuses a hand-spelled copy elsewhere.
 *
 * Pure and client-safe: no server imports.
 */

/** The tabs of the checkups page, as the `view` parameter names them. */
export const CHECKUPS_VIEWS = [
  "vorsorge",
  "visits",
  "procedures",
  "body-sites",
] as const;

export type CheckupsView = (typeof CHECKUPS_VIEWS)[number];

/** The tab a `view` parameter names, or null for anything else. */
export function parseCheckupsView(
  value: string | null | undefined,
): CheckupsView | null {
  return (CHECKUPS_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as CheckupsView)
    : null;
}

/*
 * Two spellings of the page's address, each spelled once.
 *
 * The wire one, `CARE_WIRE_PATH`, is what the server sends to a client: push,
 * ntfy, Telegram, email and webhook targets, and every `href` / `path` in an
 * API response. It stays `/checkups` because iOS builds before 1.7 parse only
 * the `/checkups` shapes. Switch it to `/care` once iOS 1.7 has been in the
 * App Store for one release cycle; that is this one line. The browser follows
 * the permanent redirect from `/checkups` to `/care` in `next.config.ts`,
 * which stays after the switch for old bookmarks and old notifications.
 * `care-wire-paths.test.ts` refuses a copy of either spelling elsewhere in the
 * server code.
 *
 * The web one, `CARE_WEB_PATH`, is for links and routes the browser renders
 * itself.
 */

/** The page on the wire: what a push target or an API link names. */
export const CARE_WIRE_PATH = "/checkups";

/** The page in the web app. */
export const CARE_WEB_PATH = "/care";

/** The visits list on the wire: the page opened on its visits tab. */
export const VISITS_PATH = `${CARE_WIRE_PATH}?view=visits`;

/** One visit on the wire: the visits tab, scrolled to the visit and opened. */
export function visitPath(id: string): string {
  return `${CARE_WIRE_PATH}?visit=${encodeURIComponent(id)}`;
}

/** The visits list, as a link the web app renders itself. */
export const CARE_VISITS_PATH = `${CARE_WEB_PATH}?view=visits`;

/** One visit, as a link the web app renders itself. */
export function careVisitPath(id: string): string {
  return `${CARE_WEB_PATH}?visit=${encodeURIComponent(id)}`;
}

/**
 * Where a group of visits leads: the visit itself when there is one, the
 * visits list when several share one line (a day with two appointments).
 */
export function visitsPath(ids: readonly string[]): string {
  return ids.length === 1 ? visitPath(ids[0]) : VISITS_PATH;
}

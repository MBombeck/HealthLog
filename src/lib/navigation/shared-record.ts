import {
  ENTIRE_RECORD,
  SHARE_DOMAINS,
  type ShareDomain,
  type ShareScope,
} from "@/lib/sharing/scope";

/**
 * The browser route families a scoped grant can present.
 *
 * This is deliberately a presentation inventory, not an authorization table.
 * `sections` arrives here as the server-resolved value from `accountAccess`;
 * the request handler still evaluates the active grant for every read and
 * mutation. Keeping the browser's route families closed lets a new domain
 * fail closed in chrome until it has been intentionally classified.
 */
export const SHARED_RECORD_DOMAIN_ROUTE_FAMILIES = {
  // `/checkups` carries content from two domains and is listed under both.
  // The preventive-care list has always been a `measurements` read
  // (`/api/measurement-reminders` declares it), and the page was in neither
  // list — under a whole-record grant it painted anyway, because a null
  // section set admits everything, so the omission stayed invisible for as
  // long as a scoped grant had no reason to open it. The visits section makes
  // it visible: a delegate scoped to `profile` is granted the visit data by
  // the API and would be denied the only page that shows it. The table is
  // built by a flatMap over (domain, href) pairs, so one href under two
  // domains means a grant naming either presents the page — and the handler
  // still evaluates the grant on every read, because this is a presentation
  // inventory and not an authorization table.
  measurements: ["/measurements", "/checkups"],
  medications: ["/medications"],
  labs: ["/labs"],
  // `/vaccinations` joins `profile`: an immunization history is health
  // background in the same sense as the visits already listed here, so a
  // delegate scoped to `profile` must be able to present the page the API
  // already lets them read — without this line the grant reads the data and
  // the chrome hides the only page that shows it.
  profile: ["/profile", "/checkups", "/vaccinations"],
  illness: ["/illness"],
  mind: ["/mood", "/mental-wellbeing"],
  cycle: ["/cycle"],
  documents: ["/documents"],
} as const satisfies Record<ShareDomain, readonly `/${string}`[]>;

/**
 * Routes whose reads span multiple domains. A selected-domain grant never
 * opens these, even when it happens to name every currently known domain.
 */
const WHOLE_RECORD_ROUTE_FAMILIES = [
  "/",
  "/achievements",
  // v1.42 — the timeline lays every section side by side.
  "/timeline",
] as const;

interface RouteFamily {
  href: string;
  scope: ShareScope;
}

const SHARED_RECORD_ROUTE_FAMILIES: readonly RouteFamily[] = [
  ...WHOLE_RECORD_ROUTE_FAMILIES.map((href): RouteFamily => ({
    href,
    scope: ENTIRE_RECORD,
  })),
  ...SHARE_DOMAINS.flatMap((domain): RouteFamily[] =>
    SHARED_RECORD_DOMAIN_ROUTE_FAMILIES[domain].map((href): RouteFamily => ({
      href,
      scope: domain,
    })),
  ),
];

function matchesRouteFamily(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function includesScope(
  sections: readonly ShareDomain[] | null,
  scope: ShareScope,
): boolean {
  if (sections === null) return true;
  return scope !== ENTIRE_RECORD && sections.includes(scope);
}

/**
 * Server-resolved navigation paint for the active shared record.
 *
 * The return value never makes an authorization decision. It only prevents a
 * known-unavailable page from mounting its reads after the server has already
 * said which record sections the browser is inside.
 */
export function resolveSharedRecordNavigation(
  sections: readonly ShareDomain[] | null,
) {
  const routeFamilies = SHARED_RECORD_ROUTE_FAMILIES.filter((family) =>
    includesScope(sections, family.scope),
  );

  return {
    // Deduplicated: an href listed under two domains is one destination, and a
    // grant holding both would otherwise offer it twice — and make
    // `sharedRecordLandingHref` count a page as two doorways.
    destinationHrefs: [...new Set(routeFamilies.map((family) => family.href))],
    allowsPath(pathname: string): boolean {
      return routeFamilies.some((family) =>
        matchesRouteFamily(pathname, family.href),
      );
    },
  };
}

/** The first scope-presentable location to load after a record switch. */
export function sharedRecordLandingHref(
  sections: readonly ShareDomain[] | null,
): string {
  return resolveSharedRecordNavigation(sections).destinationHrefs[0] ?? "/";
}

/**
 * Does the server-resolved scope make this browser route presentable?
 *
 * This helper is intentionally named for presentation. It must never be used
 * by a route handler or to choose an API request's target record.
 */
export function isSharedRecordPathPresentable(
  pathname: string,
  sections: readonly ShareDomain[] | null,
): boolean {
  return resolveSharedRecordNavigation(sections).allowsPath(pathname);
}

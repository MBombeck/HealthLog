/**
 * Which pages a switched browser may paint, stated as the guard rule of the
 * routes behind them.
 *
 * A page that reads a section of the record is presentable by the section
 * table in `@/lib/navigation/shared-record`. A few pages are not about one
 * section: the emergency card belongs to the profile a guardian administers,
 * the health-record page carries the doctor report, the report schedule, the
 * care calendar and the clinician links side by side, and each of those
 * answers to its own guard. Before this file the page gate and the routes
 * disagreed: the routes admitted a guardian through `requireGuardianAuth()`
 * and the web shut both pages with "not part of shared access".
 *
 * Here each such page names its parts, the routes each part calls, and the
 * rule those routes resolve the caller with. The browser evaluates the rule
 * from the server-resolved record context, so the page gate, the Settings
 * listing, the navigation and every card read one answer, and
 * `record-page-surfaces.test.ts` reads each route file and fails when its
 * guard call is not the rule written here. The same test fails when a route
 * that admits a guardian is claimed by no page, which is how the emergency
 * card's routes went unanswered.
 *
 * Paint only. Every route refuses on its own; this decides what the browser
 * offers so nobody is handed a page that answers 403.
 */
import {
  ENTIRE_RECORD,
  type ShareDomain,
  type ShareScope,
} from "@/lib/sharing/scope";

/** The guard a part's routes resolve the caller with. */
export type RecordRouteRule =
  /** `requireAuth()`: one's own account only, never inside another record. */
  | { readonly guard: "owner" }
  /**
   * `requireGuardianAuth()`: the owner, or the guardian of a managed profile
   * (a MANAGE grant on a record carrying the managed-profile marker).
   */
  | { readonly guard: "guardian" }
  /** `requireRecordAuth(level, scope)`: a grant at that level over that scope. */
  | {
      readonly guard: "record";
      readonly level: "read" | "write" | "manage";
      readonly scope: ShareScope;
    };

export const OWNER_RULE = { guard: "owner" } as const;
export const GUARDIAN_RULE = { guard: "guardian" } as const;

/** The record on screen, as the server resolved it for this session. */
export interface RecordViewer {
  inSharedRecord: boolean;
  recordKind: "self" | "shared" | "managed";
  level: "read" | "write" | "manage" | null;
  /** The grant's sections; null for a whole-record grant or one's own. */
  sections: readonly ShareDomain[] | null;
}

export interface RecordSurfacePart {
  readonly rule: RecordRouteRule;
  /** Route files under `src/app/api`, without the trailing `/route.ts`. */
  readonly routes: readonly string[];
}

const LEVEL_ORDER = { read: 0, write: 1, manage: 2 } as const;

/**
 * Does this rule admit the viewer. One's own record admits every rule; the
 * three arms are the three resolvers' admission tests, read off the same two
 * facts the server reads (the grant's level and the record's kind) plus the
 * grant's sections.
 */
export function recordRuleAdmits(
  rule: RecordRouteRule,
  viewer: RecordViewer,
): boolean {
  if (!viewer.inSharedRecord) return true;
  switch (rule.guard) {
    case "owner":
      return false;
    case "guardian":
      return viewer.recordKind === "managed" && viewer.level === "manage";
    case "record": {
      if (viewer.level === null) return false;
      if (LEVEL_ORDER[viewer.level] < LEVEL_ORDER[rule.level]) return false;
      if (viewer.sections === null) return true;
      return (
        rule.scope !== ENTIRE_RECORD && viewer.sections.includes(rule.scope)
      );
    }
  }
}

/**
 * The pages with parts, and the parts. A page listed here is presentable in a
 * switched record when any of its parts admits the viewer; a part renders only
 * when it admits. Keys are browser paths, part ids are stable and read by the
 * page that renders them (`useRecordSurfacePart`).
 */
export const RECORD_PAGE_SURFACES = {
  "/emergency-card": {
    card: {
      rule: GUARDIAN_RULE,
      routes: [
        "emergency-card",
        "emergency-card/link",
        "emergency-card/wallet",
        "emergency-card/wallet/apple",
        "emergency-card/wallet/apple/pass",
        "emergency-card/wallet/apple/relay-hint",
        "emergency-card/offline",
      ],
    },
  },
  "/settings/health-record": {
    doctorReport: {
      rule: { guard: "record", level: "manage", scope: ENTIRE_RECORD },
      routes: ["export/health-record"],
    },
    reportSchedule: {
      rule: GUARDIAN_RULE,
      routes: ["settings/report-schedule"],
    },
    careCalendar: {
      rule: GUARDIAN_RULE,
      routes: ["care/feed-subscription"],
    },
    shareLinks: {
      rule: OWNER_RULE,
      routes: ["share-links"],
    },
  },
  "/cycle": {
    calendarFeed: {
      rule: GUARDIAN_RULE,
      routes: ["cycle/feed-subscription", "cycle/feed-subscription/rotate"],
    },
  },
} as const satisfies Record<string, Record<string, RecordSurfacePart>>;

export type RecordSurfacePage = keyof typeof RECORD_PAGE_SURFACES;
export type RecordSurfacePartId<P extends RecordSurfacePage> =
  keyof (typeof RECORD_PAGE_SURFACES)[P] & string;

/**
 * Routes that admit a guardian and are served by a page that is not listed
 * above, each with the page that calls it. The test holds every
 * `requireGuardianAuth()` route to one of the two lists.
 */
export const GUARDIAN_ROUTES_SERVED_ELSEWHERE: Readonly<
  Record<string, string>
> = {
  "onboarding/extras":
    "The getting-started checklist's optional group on the dashboard (`getting-started-extras.tsx`): presence and counts only, for the owner or the guardian inside the profile.",
  "record-settings":
    "The managed-profile Settings sections (`record-settings-section-gate.tsx`), listed by `SETTINGS_DESTINATION_INVENTORY`.",
  "record-settings/[family]":
    "The managed-profile Settings sections (`record-settings-section-gate.tsx`), listed by `SETTINGS_DESTINATION_INVENTORY`.",
  "record-settings/integrations":
    "Settings > Integrations in a managed profile (`managed-integration-status.tsx`).",
  "record-settings/integrations/[provider]/connect":
    "Settings > Integrations in a managed profile (`managed-integration-status.tsx`).",
  "record-settings/integrations/[provider]/disconnect":
    "Settings > Integrations in a managed profile (`managed-integration-status.tsx`).",
};

function partsOf(path: string): readonly RecordSurfacePart[] | null {
  const parts = (
    RECORD_PAGE_SURFACES as Record<string, Record<string, RecordSurfacePart>>
  )[path];
  return parts ? Object.values(parts) : null;
}

/** The listed page a browser path belongs to, if any. */
export function recordSurfacePageOf(pathname: string): string | null {
  for (const page of Object.keys(RECORD_PAGE_SURFACES)) {
    if (pathname === page || pathname.startsWith(`${page}/`)) return page;
  }
  return null;
}

/**
 * Whether a listed page is presentable to this viewer: at least one of its
 * parts admits them. A path that is not listed answers `false`; the section
 * table answers for those.
 */
export function isRecordSurfacePagePresentable(
  pathname: string,
  viewer: RecordViewer,
): boolean {
  const page = recordSurfacePageOf(pathname);
  if (page === null) return false;
  return (partsOf(page) ?? []).some((part) =>
    recordRuleAdmits(part.rule, viewer),
  );
}

/** Whether one part of a listed page renders for this viewer. */
export function isRecordSurfacePartPresentable<P extends RecordSurfacePage>(
  page: P,
  part: RecordSurfacePartId<P>,
  viewer: RecordViewer,
): boolean {
  const entry = (
    RECORD_PAGE_SURFACES[page] as Record<string, RecordSurfacePart>
  )[part];
  return entry !== undefined && recordRuleAdmits(entry.rule, viewer);
}

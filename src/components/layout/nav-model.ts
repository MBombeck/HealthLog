import {
  Activity,
  Bell,
  Brain,
  ClipboardList,
  Droplets,
  FileScan,
  FlaskConical,
  Home,
  Lightbulb,
  MessagesSquare,
  Pill,
  Settings,
  Stethoscope,
  Syringe,
  Thermometer,
  Trophy,
  Waves,
  type LucideIcon,
} from "lucide-react";

import type { ModuleKey } from "@/lib/modules/registry";
import { isSharedRecordPathPresentable } from "@/lib/navigation/shared-record";
import type { ShareDomain } from "@/lib/sharing/scope";

/**
 * v1.17.1 — the single navigation information-model.
 *
 * Before this module the desktop sidebar and the mobile bottom-nav each
 * hand-curated their own destination list, and the two had drifted: the
 * sidebar listed Measurements / Mood inline but hid Workouts; the bottom
 * bar buried Measurements / Mood in "More" but promoted Workouts — and
 * the Coach, the stated differentiator, had no nav home on either. A user
 * who learned the product on one platform re-learned it on the other.
 *
 * This list is the ONE ordered destination model. Both bars render it:
 * the sidebar shows every entry in order; the bottom bar keeps its 5-slot
 * ergonomic shape (Home · Meds · capture · Insights · More) and derives
 * its "More" hub from the SAME list (every destination not already a
 * primary slot), so the two bars are re-skins of one story rather than
 * two curated lists that drift.
 */
export interface NavDestination {
  href: string;
  /** i18n key under the `nav.*` namespace. */
  tKey: string;
  icon: LucideIcon;
  /**
   * Stable onboarding-tour anchor. Matches `data-tour-id` lookups in the
   * spotlight tour — renaming silently breaks the cutout for that step.
   */
  tourId?: string;
  /**
   * v1.18.0 — gate the entry on a per-user module toggle. When set, the
   * entry is dropped unless the account's resolved module map (from
   * `GET /api/auth/me`'s `modules`) has the key enabled. Core destinations
   * (weight / BP / pulse + always-on pages) carry no key and always render.
   * `cycle` and `coach` are delegated keys (cycle → gender +
   * opt-in, coach → operator flag + per-user opt-out); the auth/me map
   * already reflects that delegation, so reading them here is correct and
   * not a re-derivation.
   */
  requiresModule?: ModuleKey;
  /**
   * v1.36.0 — is this destination part of what account sharing covers.
   *
   * `false` (the default, so the omission is the safe answer) means the entry
   * disappears while the browser is acting on somebody else's record. It is
   * PAINT and nothing else: the server refuses every non-delegable route under
   * a switch on its own, from a frozen allowlist that this file cannot reach
   * and does not mirror. Hiding the entry only spares a delegate a click that
   * ends in a refusal — both ends, always, and this is the cosmetic end.
   *
   * The line the flag draws is the design's (§4, §6): a delegate reads the
   * health RECORD, and never the account around it. So the tracking surfaces
   * are marked, and everything that configures, connects, exports, or asks an
   * AI about the account is not. AI is the one that looks arbitrary and is
   * not: server-managed LLM egress of the owner's data rides a consent the
   * owner gave for their own use, so those surfaces stay owner-only in v1.
   */
  sharedRecord?: boolean;
  /** A record-only view, intentionally absent from the actor's own nav. */
  sharedRecordOnly?: boolean;
}

/**
 * The canonical ordered destination list. Cycle sits where it always has
 * (after Medications) and is filtered out when the account gate is off;
 * the order is otherwise identical for both surfaces.
 */
// v1.19.1 (S4) — the clinical/insight spine below the dashboard/measurements/
// mood/cycle head follows one fixed sequence, each entry directly below the
// previous: Medications → Vorsorge → Labs → Illness → Insights → Coach →
// Achievements. A disabled module simply drops out; the rest keep this order.
export const NAV_DESTINATIONS: ReadonlyArray<NavDestination> = [
  {
    href: "/",
    sharedRecord: true,
    tKey: "nav.dashboard",
    icon: Home,
    tourId: "nav-dashboard",
  },
  {
    href: "/measurements",
    sharedRecord: true,
    tKey: "nav.measurements",
    icon: Activity,
    tourId: "nav-measurements",
  },
  {
    href: "/mood",
    sharedRecord: true,
    tKey: "nav.mood",
    icon: Waves,
    tourId: "nav-mood",
    requiresModule: "mood",
  },
  // v1.25.0 — opt-in mental-health screeners (PHQ-9 / GAD-7), beside mood.
  // Born-gated: `requiresModule: "mentalHealth"` reads the opt-in (default-off)
  // key from the resolved module map, so the entry is absent until the account
  // turns the module on from the Modules hub. The destination is the dedicated
  // top-level `/mental-wellbeing` check-in surface (its own module page — it
  // no longer borrows the Insights tab strip / layout shell).
  {
    href: "/mental-wellbeing",
    sharedRecord: true,
    tKey: "nav.mentalWellbeing",
    icon: Brain,
    tourId: "nav-mental-wellbeing",
    requiresModule: "mentalHealth",
  },
  {
    href: "/cycle",
    sharedRecord: true,
    tKey: "nav.cycle",
    icon: Droplets,
    tourId: "nav-cycle",
    requiresModule: "cycle",
  },
  {
    href: "/medications",
    sharedRecord: true,
    tKey: "nav.medications",
    icon: Pill,
    tourId: "nav-medications",
    // v1.18.1 (D3) — medications graduated from a CORE domain to a toggleable
    // module; the nav entry now drops when the account turns the module off.
    requiresModule: "medications",
  },
  // v1.17.1 — Vorsorge (preventive-care) gets a top-level nav home in the
  // clinical spine. It is a first-class tracking surface ("wann muss ich was
  // wo machen"), not pure configuration, so it belongs in the model both bars
  // render — not buried three taps deep under Settings → Reminders. The
  // Reminders hub still links to it; this is the direct front door.
  {
    href: "/checkups",
    sharedRecord: true,
    tKey: "nav.vorsorge",
    icon: Stethoscope,
    tourId: "nav-vorsorge",
    // v1.18.1 — deliberately NOT module-gated (no `requiresModule`). Unlike
    // labs / illness / cycle (opt-in clinical-spine verticals born off by
    // default), preventive-care reminders are a CORE surface available to
    // every account from birth: a reminder can target core vitals
    // (weight / BP / pulse) that are never behind a module toggle, and a
    // free-text "Großes Blutbild" reminder belongs to no module at all.
    // Gating the entry would orphan reminders the user can still create.
  },
  {
    href: "/labs",
    sharedRecord: true,
    tKey: "nav.labs",
    icon: FlaskConical,
    tourId: "nav-labs",
    requiresModule: "labs",
  },
  {
    href: "/profile",
    sharedRecord: true,
    sharedRecordOnly: true,
    tKey: "nav.profile",
    icon: ClipboardList,
    tourId: "nav-profile",
  },
  // v1.18.1 — the illness/condition journal sits in the clinical spine
  // next to Labs. Born-gated: `requiresModule: "illness"` reads the
  // opt-in `illness` key from the resolved module map, so the entry is
  // absent until the account turns the module on from the Modules hub.
  {
    href: "/illness",
    sharedRecord: true,
    tKey: "nav.illness",
    icon: Thermometer,
    tourId: "nav-illness",
    requiresModule: "illness",
  },
  // v1.37.3: the immunization log sits in the clinical spine beside Illness.
  // Born-gated: `requiresModule: "vaccinations"` reads the resolved module map,
  // so the entry is absent until the account keeps the module on (default-on —
  // it drops only when a user turns it off). SURFACE-gated: the `/api/vaccinations*`
  // data routes stay reachable so a restore / import keeps working and
  // re-enabling finds every dose intact.
  {
    href: "/vaccinations",
    sharedRecord: true,
    tKey: "nav.vaccinations",
    icon: Syringe,
    tourId: "nav-vaccinations",
    requiresModule: "vaccinations",
  },
  // v1.18.0 — Workouts and Recovery both left the left-nav: each already
  // surfaces as an Insights tab-strip pill (`/insights/workouts` gated on
  // a workout row, `/insights/recovery` always present), so neither is a
  // top-level `NAV_DESTINATIONS` entry any more.
  // v1.25.0 (W-DOCS-IN) — inbound clinical documents sit in the clinical
  // spine after Illness. Born-gated: `requiresModule: "inboundDocuments"`
  // reads the opt-in key from the resolved module map, so the entry is absent
  // until the account turns the module on from the Modules hub.
  {
    href: "/documents",
    sharedRecord: true,
    tKey: "nav.documents",
    icon: FileScan,
    tourId: "nav-documents",
    requiresModule: "inboundDocuments",
  },
  // Insights and the Coach carry no `sharedRecord` flag, so they drop out
  // under a switch. The reason has changed since v1.36.0 and the old wording
  // ("non-delegable, server-side and here") is no longer true of the tiles:
  // twenty-seven `/api/insights/*` reads plus `/api/dashboard/summary` and
  // `/api/export/health-record` declare `("manage", "record")`, and the
  // AI-egress objection they were closed for is answered by construction —
  // the record resolver stamps `setDelegatedGenerationSuppressed`, so a
  // delegate reads what the owner's own account generated and causes no
  // egress.
  //
  // What keeps the door shut is the OVERVIEW's own reads rather than the
  // tiles': `/api/insights/layout` (`insights/layout/route.ts`) and
  // `/api/insights/generate` (`insights/generate/route.ts`) both resolve
  // `requireAuth()`, which refuses any switch at any level. Opening the entry
  // without deciding what those two mean for a delegate — whose saved layout,
  // and whether the briefing reads or regenerates — would hand a MANAGE
  // delegate a page whose chrome 403s while its tiles answer. That is a
  // decision about two more routes, not a flag on this one.
  //
  // The Coach stays closed on the original argument, unchanged:
  // `/api/insights/chat` is genuinely not delegable, and the page is a
  // generation surface rather than a read of one.
  {
    href: "/insights",
    tKey: "nav.insights",
    icon: Lightbulb,
    tourId: "nav-insights",
    requiresModule: "insights",
  },
  // v1.17.1 (F-3) — the Coach finally gets a single labeled nav home. It
  // was reachable from seven scattered entry points (FAB, hero CTA, empty
  // states, per-metric icons …) but nowhere in the nav, so a new user
  // could miss the differentiator entirely. The other entry points stay.
  {
    href: "/coach",
    tKey: "nav.coach",
    icon: MessagesSquare,
    tourId: "nav-coach",
    requiresModule: "coach",
  },
  {
    href: "/achievements",
    sharedRecord: true,
    tKey: "nav.achievements",
    icon: Trophy,
    tourId: "nav-achievements",
    requiresModule: "achievements",
  },
];

/**
 * v1.17.1 (F-1 residue) — the shared UTILITY tail.
 *
 * Settings and Notifications are reachable on both bars but are not feature
 * destinations: on desktop they live in the sidebar footer + avatar menu, on
 * mobile at the tail of the "More" hub. They used to be a second hand-curated
 * list on each bar — the exact drift the one-model contract above set out to
 * kill, just pushed down a level. This list is the single source both bars
 * consume for the tail, so the two surfaces can no longer disagree on which
 * utility links exist or in which order.
 *
 * Order is the footer/hub order: Settings → Notifications.
 *
 * Admin is intentionally NOT here: it is a role-gated, desktop-sidebar-only
 * surface (the mobile bar never exposes it), so it is not a shared tail
 * destination and stays local to the sidebar.
 */
export interface NavUtilityDestination {
  href: string;
  /** i18n key under the `nav.*` namespace. */
  tKey: string;
  icon: LucideIcon;
}

export const NAV_UTILITY_DESTINATIONS: ReadonlyArray<NavUtilityDestination> = [
  { href: "/settings/account", tKey: "nav.settings", icon: Settings },
  { href: "/notifications", tKey: "nav.notifications", icon: Bell },
];

/**
 * The utility tail visible to this account. Both bars consume this for their
 * tail (the sidebar footer + avatar menu, the bottom-nav More hub) so the two
 * surfaces share one definition of the utility links.
 */
export function visibleUtilityDestinations(
  opts: { sharedRecord?: boolean } = {},
): NavUtilityDestination[] {
  // v1.36.0 — the utility tail is account configuration by definition:
  // Settings holds credentials, integrations, notification channels and grant
  // management, and Notifications is the delegate's own device business. Every
  // route behind both refuses under a switch; the tail simply stops being
  // offered so nobody walks into the refusal.
  if (opts.sharedRecord) return [];
  return [...NAV_UTILITY_DESTINATIONS];
}

/**
 * A partial map of `ModuleKey → enabled`. This is the `modules` field
 * `GET /api/auth/me` returns (resolved server-side, with cycle + coach
 * already delegated). A `false` value hides the gated entry; a missing
 * key, an `undefined` map (auth not yet loaded), or `true` keeps it —
 * fail-open, mirroring the gate's default-on contract so a stale /me
 * payload never blanks the nav.
 */
export type ModuleVisibilityMap = Partial<Record<ModuleKey, boolean>>;

/**
 * Whether a destination is visible under the given module map. Core
 * destinations (no `requiresModule`) always pass; a gated entry passes
 * unless its module resolves to an explicit `false`.
 *
 * `mounted` (default `true`) is the hydration gate the nav bars thread in.
 * The resolved module map rides the client-only `/api/auth/me` query, which
 * can still be unresolved on SSR and the first client paint. Reading the map
 * then would fail OPEN and flicker a disabled module's entry in for one frame
 * before the query lands and filters it out (the #418-class SSR/client
 * divergence). So before mount a gated entry is treated as hidden —
 * fail-CLOSED — making SSR and first paint identical (core-only); once
 * mounted the real map applies. The default keeps the pure helper fail-open
 * for non-component callers that pass a settled map.
 */
function isNavDestinationVisible(
  d: NavDestination,
  modules: ModuleVisibilityMap | undefined,
  mounted = true,
  sharedRecord = false,
  sections: readonly ShareDomain[] | null = null,
): boolean {
  if (
    sharedRecord &&
    (d.sharedRecord !== true ||
      !isSharedRecordPathPresentable(d.href, sections))
  ) {
    return false;
  }
  // The inverse marker: a destination that exists ONLY inside somebody else's
  // record (the read-only profile summary). Guarded on `!sharedRecord` rather
  // than reached only through the shared arm, which is what it relied on
  // before the module gate below started applying to a shared record too.
  if (!sharedRecord && d.sharedRecordOnly) return false;
  if (!d.requiresModule) return true;
  if (!mounted) return false;
  // The module map, and whose it is, is the whole point. A shared record used
  // to skip this line: the grant's scope decided which doors existed, and the
  // module map was the ACTOR's, which describes their own dashboard and must
  // not hide a domain the record granted. `GET /api/auth/me` now resolves the
  // map for the RECORD the session is inside (#939), so the objection is gone
  // and the line is the one that makes a guardian's toggle visible — without
  // it, turning Cycle off for a profile left the Cycle door standing in that
  // profile's own navigation. Scope decides which doors the grant opens;
  // this decides which of them the record tracks at all.
  return modules?.[d.requiresModule] !== false;
}

/**
 * v1.36.0 — is this path part of what account sharing covers?
 *
 * Answers from the one destination list rather than from a second literal, so
 * the mobile bar's fixed slots, the sidebar and the shell's deep-link guard
 * cannot end up disagreeing about which surfaces a delegate is offered.
 *
 * Matches a destination and everything beneath it (`/measurements/123` rides
 * `/measurements`), with the dashboard matching exactly — otherwise `"/"`
 * would swallow every path in the app. A path no destination claims answers
 * `false`: a surface nobody has classified is not one to open inside somebody
 * else's record.
 */
export function isDestinationInSharedRecord(
  pathname: string,
  sections: readonly ShareDomain[] | null = null,
): boolean {
  return isSharedRecordPathPresentable(pathname, sections);
}

/**
 * The ordered destinations visible to this account — drops a module-gated
 * entry (mood, cycle, labs, coach, achievements …) when its module is
 * disabled in the account's resolved module map. Both bars start from this.
 * v1.18.0 — cycle is no longer a bespoke boolean: it is `requiresModule:
 * "cycle"` and reads the delegated `cycle` key from the same map.
 *
 * v1.36.0 — `sharedRecord` drops every entry that is not part of what sharing
 * covers, so a delegate is not offered a door the server will shut. Paint
 * only; see the `sharedRecord` field's docblock.
 */
export function visibleNavDestinations(
  modules: ModuleVisibilityMap | undefined,
  mounted = true,
  sharedRecord = false,
  sections: readonly ShareDomain[] | null = null,
): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) =>
    isNavDestinationVisible(d, modules, mounted, sharedRecord, sections),
  );
}

/**
 * The mobile bottom-nav's three always-visible primary slots
 * (Home · Meds · Insights). Every other feature destination falls into the
 * "More" hub. Kept here (not in the bar) so the headline F-1 invariant —
 * the hub is the shared feature list minus the primary slots, plus the
 * shared utility tail — is a tested model function, not inline bar logic.
 */
export const BOTTOM_NAV_PRIMARY_SLOT_HREFS: ReadonlyArray<string> = [
  "/",
  "/medications",
  "/insights",
];

export interface MobileMoreHubEntry {
  href: string;
  tKey: string;
  icon: LucideIcon;
}

/**
 * The ordered "More" hub for the mobile bottom-nav: every visible feature
 * destination that isn't a primary slot, in model order. Feature destinations
 * only — the account utilities (Settings, Notifications) are NOT appended here.
 * They live solely in the user/avatar menu (mobile top-bar dropdown; desktop
 * sidebar avatar menu + footer), so surfacing them in the More hub too would
 * duplicate a utility across two menus reachable from the same screen. The
 * desktop sidebar renders the same feature list inline, so the two bars cannot
 * drift into two hand-curated feature lists.
 */
export function mobileMoreHubDestinations(opts: {
  modules: ModuleVisibilityMap | undefined;
  /** Hydration gate — see `isNavDestinationVisible`. Defaults to mounted. */
  mounted?: boolean;
  /** v1.36.0 — acting on somebody else's record. Defaults to own. */
  sharedRecord?: boolean;
  /** Server-resolved scope for the active shared record. */
  sections?: readonly ShareDomain[] | null;
}): MobileMoreHubEntry[] {
  return visibleNavDestinations(
    opts.modules,
    opts.mounted ?? true,
    opts.sharedRecord ?? false,
    opts.sections ?? null,
  )
    .filter((d) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(d.href))
    .map((d) => ({ href: d.href, tKey: d.tKey, icon: d.icon }));
}

/**
 * Whether `href` is the active nav destination for the current `pathname`,
 * resolved against the full destination set so the most-specific entry
 * wins. Without this, a plain `startsWith("/insights")` would light up
 * Insights while the user is on its sibling `/insights/workouts`, which
 * is its own nav home (Coach lives at the top-level `/coach`).
 * The dashboard (`/`) only matches an exact path.
 */
export function isNavDestinationActive(
  href: string,
  pathname: string,
  destinations: ReadonlyArray<NavDestination> = NAV_DESTINATIONS,
): boolean {
  if (href === "/") return pathname === "/";
  const matches = (candidate: string) =>
    pathname === candidate || pathname.startsWith(`${candidate}/`);
  if (!matches(href)) return false;
  // A longer sibling that also matches is the more specific home — defer
  // to it (e.g. on `/insights/workouts`, `/insights` must NOT read active).
  const moreSpecific = destinations.some(
    (d) => d.href !== href && d.href.startsWith(`${href}/`) && matches(d.href),
  );
  return !moreSpecific;
}

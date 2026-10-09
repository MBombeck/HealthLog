/**
 * Which sections of a day the caller may see, decided once per request
 * (v1.42, #613).
 *
 * Two masks, and they stay two. The module mask is the record owner's choice
 * about what the product shows ("I switched cycle tracking off"); the sharing
 * mask is the owner's choice about what a delegate may read ("my sister sees
 * my medications"). A section the module mask hides is left out of the answer
 * without a word, as every other surface does. A section the sharing mask
 * withholds is named once in `sections` with `not_shared`, so the view can
 * say "some areas are not shared with you" instead of pretending the day was
 * empty there.
 *
 * Every section maps to the sharing domain the routes that own its rows
 * already declare (the sharing guard freezes those), so the day can never show
 * a delegate more of a section than its own list would. The environment rows
 * and the life events have no delegable route at all, so they map to no
 * domain and are read for the owner only.
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import { DAY_SECTION_KEYS, type DaySectionKey } from "@/lib/day/contract";
import { resolveModuleMap } from "@/lib/modules/gate";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import type { ModuleKey } from "@/lib/modules/registry";
import { surfaceModule } from "@/lib/modules/surface";
import { ENTIRE_RECORD, type ShareScope } from "@/lib/sharing/scope";

/**
 * The sharing domain each section belongs to, or `null` for rows no delegate
 * reaches through any route (read for the owner only).
 *
 * Mirrors the declarations of the routes that serve the same rows: readings,
 * sleep, workouts and check-up reminders are `measurements`; mood and the
 * screeners are `mind`; allergies, visits and vaccinations are
 * `profile`; symptoms ride `illness`. Life events, like the
 * environment rows, are owner-only in v1.42: their routes take no delegate
 * at any level, so no share (a `profile` one, a legacy whole-record one, or
 * MANAGE) shows them here either.
 *
 * The scores are `record`: each one is a composite read across sections
 * (the readiness blend folds in mood, the health score labs, medications and
 * mood beside the readings), and the routes that serve them declare the
 * whole record or admit no delegate at all. A grant scoped to some sections
 * never reaches them, so a scoped delegate sees `not_shared`; a grant over
 * the whole record does.
 */
export const DAY_SECTION_SHARE_DOMAIN: Readonly<
  Record<DaySectionKey, ShareScope | null>
> = Object.freeze({
  values: "measurements",
  sleep: "measurements",
  scores: ENTIRE_RECORD,
  mood: "mind",
  assessments: "mind",
  medications: "medications",
  illness: "illness",
  symptoms: "illness",
  allergies: "profile",
  labs: "labs",
  visits: "profile",
  vaccinations: "profile",
  checkups: "measurements",
  documents: "documents",
  workouts: "measurements",
  cycle: "cycle",
  environment: null,
  lifeEvents: null,
});

/** The module that owns a section, from the one surface map. */
export function daySectionModule(section: DaySectionKey): ModuleKey | null {
  return surfaceModule(`day-section:${section}`) ?? null;
}

/** What one request may read of a record's days. */
export interface DayAccess {
  /** Sections whose rows are read and returned. */
  readable: ReadonlySet<DaySectionKey>;
  /** Sections withheld by the grant, each named once. */
  notShared: readonly DaySectionKey[];
  /** The record's module switches, resolved once. */
  modules: Readonly<Record<ModuleKey, boolean>>;
  /** Sections hidden because their module is off (not sent on the web wire). */
  moduleOff: readonly DaySectionKey[];
}

/**
 * Resolve the readable sections from the module switches and the grant.
 *
 * `domainVisible` is the predicate `actingDomainVisibility` returns: always
 * true on the owner's own record, the grant's sections otherwise, and
 * `record` only for a grant over the whole record. `owner` is
 * true only when the caller reads their own record (no grant); it opens the
 * sections that map to no sharing domain.
 */
export function resolveDayAccessFrom(args: {
  modules: Readonly<Record<ModuleKey, boolean>>;
  domainVisible: (domain: ShareScope) => boolean;
  owner: boolean;
}): DayAccess {
  const readable = new Set<DaySectionKey>();
  const notShared: DaySectionKey[] = [];
  const moduleOff: DaySectionKey[] = [];
  for (const section of DAY_SECTION_KEYS) {
    const owner = daySectionModule(section);
    if (owner !== null && args.modules[owner] === false) {
      moduleOff.push(section);
      continue;
    }
    const domain = DAY_SECTION_SHARE_DOMAIN[section];
    const shared = domain === null ? args.owner : args.domainVisible(domain);
    if (shared) readable.add(section);
    else notShared.push(section);
  }
  return { readable, notShared, modules: args.modules, moduleOff };
}

/** {@link resolveDayAccessFrom} with the module map read for the record. */
export async function resolveDayAccess(args: {
  recordId: string;
  domainVisible: (domain: ShareScope) => boolean;
  owner: boolean;
}): Promise<DayAccess> {
  const modules = await resolveModuleMap(args.recordId);
  return resolveDayAccessFrom({ ...args, modules });
}

/**
 * Whether a reading of `type` may appear: its own module (from the one
 * ownership table) has to be on. The `values` and `sleep` sections are
 * checked by the caller; this narrows them type by type, so a switched-off
 * `recovery` module takes HRV out of the day while the core vitals stay.
 */
export function measurementTypeVisible(
  type: MeasurementType,
  modules: Readonly<Record<ModuleKey, boolean>>,
): boolean {
  const owner = moduleForMeasurementType(type);
  return owner === null || modules[owner] !== false;
}

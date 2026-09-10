/**
 * What a scoped grant is allowed to learn about a record's configuration.
 *
 * v1.38.14 made `GET /api/auth/me` publish the ACTIVE RECORD's module map and
 * cycle flag rather than the actor's, because every surface those two fields
 * gate shows the record's data. That is right for a whole-record grant and too
 * generous for a narrowed one: `accountAccess.active` is set for any live
 * grant, level and scope included, so a delegate scoped to `measurements`
 * would read whether the owner tracks their cycle, their mental-health
 * screeners, their illness episodes and their supplement intake — configuration
 * the grant does not open, and in the cycle flag's case a derivation of the
 * owner's recorded sex.
 *
 * So the map is masked to the sections the grant names, and the mask is the
 * reason this table can exist beside `scope.ts`'s standing rule that the
 * sharing vocabulary never converts to the module vocabulary. The rule guards
 * a direction: a module the owner enabled must never imply a section the owner
 * shared. Nothing here runs that way. A closed section answers `false` — the
 * same answer the client already gets for a module that is off — and an open
 * one answers whatever the gate resolved, never more. No value in this file
 * can turn a module ON, admit a read, or widen a grant; deleting the table
 * would leak, not lock.
 *
 * `null` means "this module is not one section of a record". Those keys are
 * masked off for every scoped grant, which is the same answer the browser's
 * own route inventory gives them: `/`, `/achievements` and the narrative
 * surfaces read across sections, and a selected-domain grant never opens one.
 */
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import type { ShareDomain } from "@/lib/sharing/scope";

/**
 * The section of a record each module's surfaces read, or `null` when they
 * read across sections.
 *
 * Typed as a total record over {@link MODULE_KEYS}, so a new module cannot
 * ship without an answer here — and the answer a hurried one gives is at worst
 * `null`, which discloses nothing.
 *
 * The section chosen is the one the browser's route inventory already puts the
 * module's page under (`src/lib/navigation/shared-record.ts`), so the chrome a
 * delegate is offered and the configuration they are told about agree.
 */
export const MODULE_SHARE_DOMAIN: Readonly<
  Record<ModuleKey, ShareDomain | null>
> = Object.freeze({
  cycle: "cycle",
  mood: "mind",
  sleep: "measurements",
  glucose: "measurements",
  workouts: "measurements",
  recovery: "measurements",
  labs: "labs",
  illness: "illness",
  // Reads across the record: the achievement engine counts every domain.
  achievements: null,
  // The assistant surfaces narrate the whole record, which is why a scoped
  // grant is never offered them.
  coach: null,
  insights: null,
  medications: "medications",
  // The export assembles every section it is given.
  doctorReport: null,
  // Weather and air quality are context for the record as a whole, not one
  // section of it.
  environment: null,
  // The account's own remote endpoint. Not a section of anybody's record.
  mcp: null,
  inboundDocuments: "documents",
  mentalHealth: "mind",
  nutrients: "measurements",
  // An immunization history is health background, the section `/vaccinations`
  // is presented under.
  vaccinations: "profile",
});

/** Does a grant carrying these sections open this one? `null` is the whole record. */
export function sectionsOpen(
  sections: readonly ShareDomain[] | null,
  domain: ShareDomain,
): boolean {
  return sections === null || sections.includes(domain);
}

/**
 * The module map as a grant carrying these sections may read it.
 *
 * `null` sections are the whole record and pass the map through untouched,
 * which keeps the own-record and whole-record payloads byte-identical to what
 * they were. Anything else answers `false` for every key outside the grant.
 */
export function maskModulesToSections(
  modules: Record<ModuleKey, boolean>,
  sections: readonly ShareDomain[] | null,
): Record<ModuleKey, boolean> {
  if (sections === null) return modules;
  const masked = {} as Record<ModuleKey, boolean>;
  for (const key of MODULE_KEYS) {
    const domain = MODULE_SHARE_DOMAIN[key];
    masked[key] =
      domain !== null && sectionsOpen(sections, domain) ? modules[key] : false;
  }
  return masked;
}

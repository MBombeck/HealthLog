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
import {
  MODULE_KEYS,
  isCodeDisabledModule,
  type ModuleKey,
} from "@/lib/modules/registry";
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

/**
 * Why a module's surfaces are not there.
 *
 * The boolean map answers "paint it or not", which is all a gate needs and
 * strictly less than a person needs. Three different situations collapse into
 * the same `false`: the record has the module switched off, the grant this
 * session is inside does not cover it, and the operator turned it off for the
 * whole instance. A client holding only the boolean has to guess between them,
 * so the empty state either says nothing or says something that may be untrue —
 * offering a delegate a switch they cannot reach, or telling an account to turn
 * on a module the operator removed.
 *
 * `enabled` is the module the client may paint. `disabled` is the record's own
 * switch. `not_granted` is the mask above: the active grant's sections do not
 * open this module's section, or the module reads across the record and no
 * scoped grant opens one. `unavailable` is the operator's instance-wide switch.
 */
export type ModuleAccessState =
  "enabled" | "disabled" | "not_granted" | "unavailable";

/**
 * Precedence, highest first: `unavailable` > `not_granted` > `disabled` >
 * `enabled`. It runs outside-in — what the operator decided, then what the
 * grant opens, then what the record chose — so the reason a client shows is
 * the one nothing further in can change. An operator-disabled module reads
 * `unavailable` for a delegate too, rather than `not_granted`, because the
 * switch that would have to move is the operator's either way.
 */
function resolveModuleAccess(
  key: ModuleKey,
  modules: Record<ModuleKey, boolean>,
  operatorAvailability: Record<ModuleKey, boolean>,
  sections: readonly ShareDomain[] | null,
): ModuleAccessState {
  // The instance layer, both halves of it: the operator's availability blob
  // and the code-level hard-off. `CODE_DISABLED_MODULE_KEYS` is empty today,
  // so this term changes no answer; it is here because a module switched off
  // in code is not available on this instance either, and without it such a
  // module would report itself as the record's own choice.
  if (isCodeDisabledModule(key) || operatorAvailability[key] === false) {
    return "unavailable";
  }
  const domain = MODULE_SHARE_DOMAIN[key];
  if (
    sections !== null &&
    (domain === null || !sectionsOpen(sections, domain))
  ) {
    return "not_granted";
  }
  return modules[key] ? "enabled" : "disabled";
}

/** Both maps the account payload publishes for the active record. */
export interface ModuleDisclosure {
  /** The boolean gate map, masked to the grant. Unchanged semantics. */
  modules: Record<ModuleKey, boolean>;
  /** The same answer with its reason attached. */
  moduleAccess: Record<ModuleKey, ModuleAccessState>;
}

/**
 * Build both maps for one record, as one grant may read them.
 *
 * The two halves are computed independently rather than one derived from the
 * other, and that is deliberate: `modules[key] === (moduleAccess[key] ===
 * "enabled")` is the contract every client leans on, and deriving one from the
 * other would turn the test of it into a tautology. `modules` keeps running
 * through {@link maskModulesToSections}, byte for byte what it was.
 *
 * `modules` is the ALREADY-RESOLVED map (`resolveModuleMap`), which has the
 * operator layer AND-ed in; `operatorAvailability` is that layer on its own
 * (`getOperatorModuleAvailability`), which is what makes the operator's
 * decision separable from the record's.
 */
export function buildModuleDisclosure(
  modules: Record<ModuleKey, boolean>,
  operatorAvailability: Record<ModuleKey, boolean>,
  sections: readonly ShareDomain[] | null,
): ModuleDisclosure {
  const moduleAccess = {} as Record<ModuleKey, ModuleAccessState>;
  for (const key of MODULE_KEYS) {
    moduleAccess[key] = resolveModuleAccess(
      key,
      modules,
      operatorAvailability,
      sections,
    );
  }
  return { modules: maskModulesToSections(modules, sections), moduleAccess };
}

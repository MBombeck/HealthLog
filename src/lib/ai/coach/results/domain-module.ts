/**
 * Which module owns the domain a stored Coach table is about, so a table
 * read after the module was switched off is withheld rather than served.
 *
 * The same ownership the Coach applies when it reads: the measurement-level
 * table in `MODULE_SCOPED_SOURCES`, plus the cycle and illness domains,
 * which the Coach gates on their own modules. Labs, medication compliance,
 * correlations and the full snapshot answer to no module there, so none
 * here either — gating them on this read would make a stored answer
 * stricter than the Coach that wrote it.
 */
import { MODULE_SCOPED_SOURCES } from "@/lib/modules/measurement-scope";
import type { ModuleKey } from "@/lib/modules/registry";
import type { CoachStepDomain } from "@/lib/ai/coach/types";

const OWNER_BY_DOMAIN: ReadonlyMap<string, ModuleKey> = (() => {
  const out = new Map<string, ModuleKey>([
    ["cycle", "cycle"],
    ["illness", "illness"],
    ["environment", "environment"],
  ]);
  for (const [key, sources] of Object.entries(MODULE_SCOPED_SOURCES)) {
    for (const source of sources ?? []) out.set(source, key as ModuleKey);
  }
  return out;
})();

export function moduleForCoachDomain(
  domain: CoachStepDomain,
): ModuleKey | null {
  return OWNER_BY_DOMAIN.get(domain) ?? null;
}

/** True when the domain's module is switched off in `modules`. */
export function isCoachDomainWithheld(
  domain: CoachStepDomain,
  modules: Readonly<Record<ModuleKey, boolean>>,
): boolean {
  const owner = moduleForCoachDomain(domain);
  return owner !== null && modules[owner] === false;
}

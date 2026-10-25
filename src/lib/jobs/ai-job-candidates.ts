/**
 * Cheap SQL prefilters for the AI crons.
 *
 * Every AI job resolves its capability per user (`aiCapabilityForJob`) before
 * it builds a snapshot, and the provider chokepoint re-checks it at the wire.
 * Those are the answers that count. What this file adds is the cheap part in
 * front of them: people who switched a module off are dropped from the
 * candidate query itself, so a nightly pass over the instance does not load
 * their capability inputs one by one only to be told no.
 *
 * `modulePreferencesJson` is a DISABLED allowlist: a module is off only when
 * its key holds JSON `false`. Selecting the "off" set is NULL-safe by
 * construction (an absent key, a NULL column or a non-object value never
 * compares equal to `false`), which a negated JSON-path filter would not be.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  AI_CAPABILITIES,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";
import { loadAssistantSwitches } from "@/lib/feature-flags";
import { resolveModuleMap } from "@/lib/modules/gate";
import type { ModuleKey } from "@/lib/modules/registry";

/** Ids of the accounts that switched `module` off for themselves. */
export async function userIdsWithModuleOff(
  prisma: Pick<PrismaClient, "$queryRaw">,
  module: ModuleKey,
): Promise<string[]> {
  // account-deletion: the accounts to leave out; the candidate queries using it filter.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "users"
     WHERE "module_preferences_json" -> ${module}::text = 'false'::jsonb`;
  return rows.map((row) => row.id);
}

/**
 * The provider-free half of a capability: the operator's switches and the
 * owning modules, and nothing that needs the provider machinery.
 *
 * For the one place that must not import that machinery at all, the
 * data-arrival spine, whose cost claim is that its module graph reaches no
 * provider (`data-arrival-provider-isolation.test.ts`). It decides whether a
 * follow-up job is worth enqueueing; the job itself then resolves the full
 * capability (`aiCapabilityForJob`) before it does anything, so this can only
 * ever say "no" early, never "yes" for good.
 */
export async function aiWorkNotRuledOut(
  userId: string,
  key: AiCapabilityKey,
): Promise<boolean> {
  const definition = AI_CAPABILITIES[key];
  const [switches, modules] = await Promise.all([
    loadAssistantSwitches(),
    resolveModuleMap(userId),
  ]);
  if (switches === null || !switches[definition.operatorSwitch]) return false;
  const owners = definition.modules.keys;
  if (owners.length === 0) return true;
  return definition.modules.mode === "all"
    ? owners.every((module) => modules[module])
    : owners.some((module) => modules[module]);
}

/**
 * The worker registry: every queue the worker runs, by group, in the order
 * the worker registers them. `reminder-worker.ts` walks it at boot;
 * `tests/integration/queue-registration-parity.test.ts` holds what it leaves
 * in pg-boss to the golden.
 */
import type { PgBoss } from "pg-boss";

import type { JobDefinition, JobGroup } from "./define-job";
import { INTEGRATION_SYNC_GROUP } from "./integration-sync";
import { MAINTENANCE_GROUP } from "./maintenance";
import { REMINDERS_GROUP } from "./reminders";
import {
  registerJobGroup,
  runBootDiscovery,
  type BoundLoader,
} from "./register";

export { preloadHandlers, type BoundLoader } from "./register";
import { ROLLUP_GROUP } from "./rollup";
import { STATUS_GROUP } from "./status";

export const JOB_GROUPS: readonly JobGroup[] = [
  INTEGRATION_SYNC_GROUP,
  STATUS_GROUP,
  ROLLUP_GROUP,
  REMINDERS_GROUP,
  MAINTENANCE_GROUP,
];

/** Every definition, across the groups. */
export function allJobDefinitions(): readonly JobDefinition[] {
  return JOB_GROUPS.flatMap((group) => group.jobs);
}

/**
 * Register every group in order. `onGroup` runs before each one, so the boot
 * can time the groups as steps; `onBound` receives every queue's handler
 * loader as it is bound. Returns every queue name created.
 */
export async function registerAllJobGroups(
  boss: PgBoss,
  onGroup: (group: JobGroup) => void = () => {},
  onBound: (bound: BoundLoader) => void = () => {},
): Promise<string[]> {
  const queues: string[] = [];
  for (const group of JOB_GROUPS) {
    onGroup(group);
    queues.push(...(await registerJobGroup(boss, group, onBound)));
  }
  return queues;
}

/**
 * Run the boot discovery of every group: rollup first, then the integration
 * backfills, then maintenance, the order the worker always used.
 */
export async function runAllBootDiscovery(): Promise<void> {
  for (const name of ["rollup", "integration_sync", "maintenance"] as const) {
    const group = JOB_GROUPS.find((g) => g.name === name);
    if (group?.discovery) await runBootDiscovery(group.discovery);
  }
}

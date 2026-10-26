/**
 * Reading the worker registry from a test: the declaration of one queue, the
 * group that holds it, the handler its loader resolves to, and a group's boot
 * discovery passes. Every helper fails loudly on a queue the registry does
 * not declare, so a test cannot pass by asserting on nothing.
 */
import type { PgBoss } from "pg-boss";

import { JOB_GROUPS } from "../index";
import type { JobDefinition, JobGroup, JobGroupName } from "../define-job";

export function jobOf(queue: string): JobDefinition {
  for (const group of JOB_GROUPS) {
    const job = group.jobs.find((j) => j.queue === queue);
    if (job) return job;
  }
  throw new Error(`the registry declares no queue "${queue}"`);
}

export function groupOf(queue: string): JobGroup {
  const group = JOB_GROUPS.find((g) => g.jobs.some((j) => j.queue === queue));
  if (!group) throw new Error(`the registry declares no queue "${queue}"`);
  return group;
}

export function groupNamed(name: JobGroupName): JobGroup {
  const group = JOB_GROUPS.find((g) => g.name === name);
  if (!group) throw new Error(`no registry group "${name}"`);
  return group;
}

/** The names of a group's boot discovery passes, in run order. */
export function discoveryOf(name: JobGroupName): string[] {
  return (groupNamed(name).discovery ?? []).map((pass) => pass.name);
}

/**
 * A boss that records sends and refuses everything else, for loaders that
 * close over it (the forwarders, the drain's follow-up).
 */
export function recordingBoss(): {
  boss: PgBoss;
  sends: Array<{ queue: string; data: unknown; options: unknown }>;
} {
  const sends: Array<{ queue: string; data: unknown; options: unknown }> = [];
  const boss = {
    send: async (queue: string, data: unknown, options: unknown) => {
      sends.push({ queue, data, options });
      return `job-${sends.length}`;
    },
  } as unknown as PgBoss;
  return { boss, sends };
}

/** The handler the queue's loader resolves to (its module is loaded). */
export async function loadedHandler(
  queue: string,
  boss: PgBoss = recordingBoss().boss,
): Promise<unknown> {
  return jobOf(queue).load({ boss });
}

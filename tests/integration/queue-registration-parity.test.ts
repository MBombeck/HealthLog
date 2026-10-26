/**
 * What the worker leaves in pg-boss when it registers its queues, pinned
 * byte for byte.
 *
 * The worker registers every queue at boot: it creates the queue (with its
 * de-duplication policy and retention), schedules its cron with the send
 * options the schedule carries, and binds a handler with its concurrency and
 * poll. None of that is visible to a unit test, and a change to any of it is
 * invisible in production until a job is dropped, doubled or never run. This
 * file runs the real registration against a real pg-boss and compares three
 * things with `__golden__/queue-registration.json`:
 *
 *   - every row of `pgboss.queue`, with the columns registration decides
 *     (policy, retries, expiry, retention, deletion);
 *   - every row of `pgboss.schedule` (cron, time zone, payload, send options);
 *   - every handler binding, with the work options it was bound with.
 *
 * The golden was written from the registrars as they stood before the
 * registration became a declarative registry, so this test is the proof that
 * the registry registers exactly what they did. A deliberate change to a
 * queue's registration rewrites the golden in the same commit
 * (`pnpm vitest run --config vitest.integration.config.mts -u <this file>`),
 * and the diff shows the change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";

import { getPrismaClient } from "./setup";

interface Binding {
  queue: string;
  options: Record<string, unknown>;
}

let boss: PgBoss;
const bindings: Binding[] = [];
const returned: string[] = [];

/** Sort an object's keys so the golden does not depend on spread order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

/**
 * The boss the registration sees: the real one, except that a handler
 * binding is recorded rather than started, so no worker polls while the
 * tables are read.
 */
function recordingBoss(real: PgBoss): PgBoss {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "work") {
        return async (queue: string, options: Record<string, unknown>) => {
          bindings.push({
            queue,
            options: sorted(options) as Record<string, unknown>,
          });
          return `work-${queue}`;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function registerEveryQueue(target: PgBoss): Promise<void> {
  const { registerAllJobGroups } = await import("@/lib/jobs/registry/index");
  returned.push(...(await registerAllJobGroups(target)));
}

beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schedule: false,
    supervise: false,
  });
  await boss.start();
  await registerEveryQueue(recordingBoss(boss));
}, 180_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe("queue registration", () => {
  it("leaves pg-boss exactly as the golden records it", async () => {
    const prisma = getPrismaClient();
    const queues = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT name, policy, retry_limit, retry_delay, retry_backoff,
             retry_delay_max, expire_seconds, retention_seconds,
             deletion_seconds, dead_letter, partition, heartbeat_seconds,
             notify
      FROM pgboss.queue
      -- pg-boss's own queues are its business, not the registration's.
      WHERE NOT starts_with(name, '__pgboss__')
      ORDER BY name
    `;
    const schedules = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT name, key, kind, cron, timezone, data, options
      FROM pgboss.schedule
      ORDER BY name, key
    `;

    const snapshot = {
      registeredQueueCount: returned.length,
      registeredQueues: [...returned].sort(),
      queues: queues.map(sorted),
      schedules: schedules.map(sorted),
      bindings: [...bindings].sort((a, b) => a.queue.localeCompare(b.queue)),
    };

    await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(
      "./__golden__/queue-registration.json",
    );
  });

  it("binds a handler to every queue it creates, once", () => {
    const bound = bindings.map((b) => b.queue);
    expect(new Set(bound).size).toBe(bound.length);
    expect([...bound].sort()).toEqual([...returned].sort());
    // A floor, so an empty registration cannot pass by matching an empty
    // golden.
    expect(returned.length).toBeGreaterThan(100);
  });

  it("loads a function for every handler it declares", async () => {
    // A handler module loads on its queue's first job; a broken import would
    // otherwise surface only when that job arrives in production.
    const { allJobDefinitions } = await import("@/lib/jobs/registry/index");
    const definitions = allJobDefinitions();
    expect(definitions.length).toBe(returned.length);
    const unloaded: string[] = [];
    for (const definition of definitions) {
      const handler = await definition.load({ boss });
      if (typeof handler !== "function") unloaded.push(definition.queue);
    }
    expect(unloaded).toEqual([]);
  });
});

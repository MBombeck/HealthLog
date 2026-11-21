/**
 * `DATA_CHANGED`: a silent sealed wake to the owner's iOS devices when a
 * server-side sync stored new readings (Withings, Garmin, Oura, WHOOP, Polar,
 * Strava, Google Health, Nightscout and the other cloud syncs, and the food
 * tracker bridges that post nutrition with a token). The app reloads its
 * stores, widgets and the Watch, so they are current without opening it.
 *
 * Envelope plaintext: `t: "DATA_CHANGED"`, silent, one hour,
 * `d: { domains, changedAt }` with `domains` sorted and distinct from
 * {@link DATA_DOMAINS}. No reading, no type, no count.
 *
 * Coalescing, per device, across processes (`push_data_changes`): the first
 * change after a quiet spell goes out at once; every change inside the next
 * five minutes merges its domains into one pending wake, and the minute job
 * `push-data-changed` sends it when the window closes. At most
 * {@link SENDS_PER_HOUR} wakes an hour per device; past that the pending one
 * waits for the hour to free up, merged, never dropped. Every wake also
 * counts against the device's shared silent budget (`wakes.ts`).
 *
 * Origin. A change caused by a device's own request (a "sync now" the app
 * started, `X-Device-Id` on the provider's sync route) is not added to that
 * device's pending wake: it already holds the result. Every other device of
 * the account still hears of it. Writes the app uploads itself (Apple
 * Health, its own measurement, workout and nutrition batches) never raise
 * this wake at all: they do not go through these seams.
 *
 * Best effort throughout: nothing here can fail the sync that caused it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { pruneWakes, sendWake, wakeableDevices } from "@/lib/push-relay/wakes";

export const DATA_DOMAINS = [
  "measurements",
  "sleep",
  "workouts",
  "nutrition",
] as const;

export type DataDomain = (typeof DATA_DOMAINS)[number];

/** The quiet spell after one send. */
export const COALESCE_WINDOW_MS = 5 * 60_000;
/** Wakes per device and hour. */
export const SENDS_PER_HOUR = 3;
const origin = new AsyncLocalStorage<string | null>();

/**
 * Run `fn` with the device that asked for it as the origin of every data
 * change it causes (`X-Device-Id`, the device's registered token).
 */
export function withDataChangeOrigin<T>(
  deviceToken: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return origin.run(deviceToken || null, fn);
}

/** The domain a measurement type belongs to. */
export function domainOfMeasurementType(type: MeasurementType): DataDomain {
  return type.startsWith("SLEEP_") ? "sleep" : "measurements";
}

/** The domains of a set of touched measurement types. */
export function domainsOfMeasurementTypes(
  types: Iterable<MeasurementType>,
): DataDomain[] {
  return [...new Set([...types].map(domainOfMeasurementType))].sort();
}

/** `now` as the wall time of the timestamp columns (stored as UTC). */
function sqlTime(now: Date): string {
  return now.toISOString();
}

/**
 * Record that new readings of `domains` were stored for `userId`, and send
 * each device its wake now if its window allows. Never throws: call it fire
 * and forget.
 */
export function noteDataChanged(
  userId: string,
  domains: readonly DataDomain[],
  options: { originDeviceToken?: string | null; now?: Date } = {},
): Promise<void> {
  const list = [...new Set(domains)]
    .filter((d) => (DATA_DOMAINS as readonly string[]).includes(d))
    .sort();
  if (list.length === 0) return Promise.resolve();
  const skip =
    options.originDeviceToken !== undefined
      ? options.originDeviceToken
      : (origin.getStore() ?? null);
  const now = options.now ?? new Date();
  return (async () => {
    try {
      const devices = (await wakeableDevices(userId)).filter(
        (d) => d.token !== skip,
      );
      for (const device of devices) {
        await addPending(device.id, list, now);
        await flushDataChange(device.id, now);
      }
    } catch (err) {
      getEvent()?.addWarning(
        `data_changed_note_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/** Merge `domains` into the device's pending wake. */
async function addPending(
  deviceId: string,
  domains: readonly string[],
  now: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "push_data_changes" ("device_id", "domains", "updated_at")
    VALUES (${deviceId}, ${[...domains]}::text[], ${sqlTime(now)}::timestamp(3))
    ON CONFLICT ("device_id") DO UPDATE SET
      "domains" = ARRAY(
        SELECT DISTINCT d
          FROM unnest("push_data_changes"."domains" || EXCLUDED."domains") AS d
         ORDER BY d
      ),
      "updated_at" = EXCLUDED."updated_at"`;
}

/**
 * Take the device's pending domains if its window is open: at least five
 * minutes since its last wake and fewer than three wakes in the last hour.
 * The row lock makes the claim exclusive, so two processes never both send.
 */
async function claim(deviceId: string, now: Date): Promise<string[] | null> {
  const at = sqlTime(now);
  const rows = await prisma.$queryRaw<Array<{ domains: string[] }>>`
    WITH due AS (
      SELECT "device_id", "domains", "sent_at"
        FROM "push_data_changes"
       WHERE "device_id" = ${deviceId}
         AND cardinality("domains") > 0
         AND (cardinality("sent_at") = 0
              OR "sent_at"[cardinality("sent_at")]
                 <= ${at}::timestamp(3) - make_interval(secs => ${COALESCE_WINDOW_MS / 1000}))
         AND (cardinality("sent_at") < ${SENDS_PER_HOUR}
              OR "sent_at"[cardinality("sent_at") - ${SENDS_PER_HOUR - 1}]
                 <= ${at}::timestamp(3) - interval '1 hour')
       FOR UPDATE
    )
    UPDATE "push_data_changes" AS p
       SET "domains" = ARRAY[]::text[],
           "sent_at" = ARRAY(
             SELECT s FROM (
               SELECT s FROM unnest(array_append(due."sent_at", ${at}::timestamp(3))) AS s
                ORDER BY s DESC
                LIMIT ${SENDS_PER_HOUR}
             ) AS kept ORDER BY s
           ),
           "updated_at" = ${at}::timestamp(3)
      FROM due
     WHERE p."device_id" = due."device_id"
    RETURNING due."domains"`;
  return rows[0]?.domains ?? null;
}

/**
 * Send the device its pending wake if its window is open. Returns whether a
 * wake went out (or waits at the relay), or null when nothing was due.
 */
export async function flushDataChange(
  deviceId: string,
  now: Date = new Date(),
): Promise<boolean | null> {
  const domains = await claim(deviceId, now);
  if (!domains) return null;
  const owner = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { userId: true },
  });
  // The account's gates are asked again: it may be pending deletion now, or
  // its APNs channel switched off.
  const device = owner
    ? (await wakeableDevices(owner.userId)).find((d) => d.id === deviceId)
    : undefined;
  if (!device) return false;
  const result = await sendWake(
    "DATA_CHANGED",
    [device],
    { domains: [...domains].sort(), changedAt: now.toISOString() },
    { now, collapseKey: "data-changed" },
  );
  if (result.overBudget.length > 0) {
    // The device's silent budget is spent: the domains wait for the next
    // window instead of being lost.
    await addPending(deviceId, domains, now);
    getEvent()?.addMeta("push_data_changed_over_budget", true);
  }
  return result.sent.length > 0;
}

/**
 * The minute pass: send every pending wake whose window has opened, then
 * prune the wake ledger. Returns how many devices were woken.
 */
export async function flushDueDataChanges(
  now: Date = new Date(),
): Promise<{ flushed: number; pruned: number }> {
  const pending = await prisma.pushDataChange.findMany({
    where: { NOT: { domains: { isEmpty: true } } },
    select: { deviceId: true },
    orderBy: { updatedAt: "asc" },
    take: 500,
  });
  let flushed = 0;
  for (const row of pending) {
    try {
      if (await flushDataChange(row.deviceId, now)) flushed += 1;
    } catch (err) {
      getEvent()?.addWarning(
        `data_changed_flush_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { flushed, pruned: await pruneWakes(now) };
}

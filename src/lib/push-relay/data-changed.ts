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
 * `push-data-changed` sends it when the window closes. The hourly limits are
 * the device's one silent budget (`wakes.ts`): past them the pending wake
 * waits for the hour to free up, merged, never dropped.
 *
 * Origin. A change caused by a device's own request (a "sync now" the app
 * started, `X-Device-Id` on the provider's sync route) is not added to that
 * device's pending wake: it already holds the result. Every other device of
 * the account still hears of it. Writes the app uploads itself (Apple
 * Health, its own measurement, workout and nutrition batches) never raise
 * this wake at all: they do not go through these seams.
 *
 * Best effort throughout: nothing here can fail the sync that caused it.
 *
 * A note that has a device to tell writes its own wide event
 * (`notification.data_changed.send`). It is called fire and forget, mostly
 * from a request that has answered by the time the relay did: what the send
 * annotated landed on an event that was already written, so a wake that
 * demonstrably reached a phone left no line in the log.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { FanOutTally } from "@/lib/jobs/fan-out-tally";
import { withBackgroundEvent } from "@/lib/logging/background";
import { getEvent } from "@/lib/logging/context";
import { flushOwedIntakeSyncs } from "@/lib/push-relay/medication-pushes";
import { owePendingDomains } from "@/lib/push-relay/owed-silent";
import { pruneWakes, sendWake, wakeableDevices } from "@/lib/push-relay/wakes";

export const DATA_DOMAINS = [
  "intakes",
  "measurements",
  "medications",
  "nutrition",
  "sleep",
  "workouts",
] as const;

export type DataDomain = (typeof DATA_DOMAINS)[number];

/** The quiet spell after one send. */
export const COALESCE_WINDOW_MS = 5 * 60_000;
/** The wide event a note with a device to tell writes for itself. */
const SEND_EVENT = "notification.data_changed.send";
const origin = new AsyncLocalStorage<string | null>();

/** The notes a batch holds back, by account and origin device. */
type PendingNotes = Map<
  string,
  {
    userId: string;
    skip: string | null;
    domains: Set<DataDomain>;
    now?: Date;
  }
>;
const batch = new AsyncLocalStorage<PendingNotes>();

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

/**
 * Run `fn`, a writer that stores many rows one at a time, and note its data
 * changes once at the end: every `noteDataChanged` inside merges into one
 * note per account and origin. Without it a history backfill read the
 * account's wakeable devices once per row it stored. The notes go out fire
 * and forget, as each would have.
 */
export async function batchDataChanges<T>(fn: () => Promise<T>): Promise<T> {
  if (batch.getStore()) return fn();
  const pending: PendingNotes = new Map();
  try {
    return await batch.run(pending, fn);
  } finally {
    for (const note of pending.values()) {
      void noteDataChanged(note.userId, [...note.domains], {
        originDeviceToken: note.skip,
        now: note.now,
      });
    }
  }
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
  const held = batch.getStore();
  if (held) {
    const key = `${userId}\u0000${skip ?? ""}`;
    const note = held.get(key) ?? { userId, skip, domains: new Set() };
    for (const domain of list) note.domains.add(domain as DataDomain);
    if (options.now) note.now = options.now;
    held.set(key, note);
    return Promise.resolve();
  }
  const now = options.now ?? new Date();
  return (async () => {
    try {
      const devices = (await wakeableDevices(userId)).filter(
        (d) => d.token !== skip,
      );
      // Nobody to tell: no event either, or every write of an account
      // without the app would log a no-op.
      if (devices.length === 0) return;
      await withBackgroundEvent(SEND_EVENT, async (evt) => {
        let sent = 0;
        let waiting = 0;
        let held = 0;
        for (const device of devices) {
          await owePendingDomains(device.id, list, now);
          const out = await flushDataChange(device.id, now);
          if (out === true) sent += 1;
          else if (out === null) waiting += 1;
          else held += 1;
        }
        evt.addMeta("data_changed_domains", list);
        evt.addMeta("data_changed_devices", devices.length);
        // Went out now (or waits at the relay for a retry).
        evt.addMeta("data_changed_sent", sent);
        // Inside the five-minute window of the last wake: the minute pass
        // sends the merged domains when it closes.
        evt.addMeta("data_changed_window_open", waiting);
        // The silent budget is spent, or the device has no route.
        evt.addMeta("data_changed_held", held);
      });
    } catch (err) {
      getEvent()?.addWarning(
        `data_changed_note_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/**
 * Take the device's pending domains if its window is open: at least five
 * minutes since its last wake, and no intake sync owed to it. The row lock
 * makes the claim exclusive, so two processes never both send. The hourly
 * limits are the silent budget's (`wakes.ts`), asked when the wake is sent;
 * the send time is stamped only once a wake went out, so a claim that sent
 * nothing costs no slot.
 *
 * An owed intake sync goes ahead of the wake: a dose decision waits on it,
 * and over the relay both draw on the same six silent pushes an hour. The
 * minute pass sends the sync first (`flushDueDataChanges`); the wake follows
 * once the sync is settled.
 */
async function claim(deviceId: string, now: Date): Promise<string[] | null> {
  const at = sqlTime(now);
  const rows = await prisma.$queryRaw<Array<{ domains: string[] }>>`
    WITH due AS (
      SELECT "device_id", "domains"
        FROM "push_data_changes"
       WHERE "device_id" = ${deviceId}
         AND cardinality("domains") > 0
         AND "intake_sync_owed_at" IS NULL
         AND (cardinality("sent_at") = 0
              OR "sent_at"[cardinality("sent_at")]
                 <= ${at}::timestamp(3) - make_interval(secs => ${COALESCE_WINDOW_MS / 1000}))
       FOR UPDATE
    )
    UPDATE "push_data_changes" AS p
       SET "domains" = ARRAY[]::text[],
           "updated_at" = ${at}::timestamp(3)
      FROM due
     WHERE p."device_id" = due."device_id"
    RETURNING due."domains"`;
  return rows[0]?.domains ?? null;
}

/** Stamp the wake that went out: the start of the device's next window. */
async function markSent(deviceId: string, now: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "push_data_changes"
       SET "sent_at" = ARRAY[${sqlTime(now)}::timestamp(3)]
     WHERE "device_id" = ${deviceId}`;
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
  let result;
  try {
    result = await sendWake(
      "DATA_CHANGED",
      [device],
      { domains: [...domains].sort(), changedAt: now.toISOString() },
      { now, collapseKey: "data-changed" },
    );
  } catch (err) {
    // The claim already took the domains; a failed send puts them back.
    await owePendingDomains(deviceId, domains, now);
    throw err;
  }
  if (result.sent.length === 0) {
    // Not sent (the silent budget is spent, the relay refused it, or no
    // route took it): the domains wait for the next window instead of being
    // lost. A wake the relay refused has put them back already; the merge
    // is idempotent.
    await owePendingDomains(deviceId, domains, now);
    if (result.overBudget.length > 0) {
      getEvent()?.addMeta("push_data_changed_over_budget", true);
    }
    return false;
  }
  await markSent(deviceId, now);
  return true;
}

/**
 * The minute pass: send every pending wake whose window has opened and every
 * owed intake sync whose budget freed up (`medication-pushes.ts`), then prune
 * the wake ledger. Returns how many devices were woken and synced, and the
 * tally of what was attempted and failed (`FanOutTally`): a failed device
 * puts its domains back and the pass carries on, and the run says so.
 */
export async function flushDueDataChanges(now: Date = new Date()): Promise<{
  flushed: number;
  owedSynced: number;
  pruned: number;
  tally: FanOutTally;
}> {
  const tally = new FanOutTally();
  // The owed intake syncs go first: a dose decision waits on them.
  let owedSynced = 0;
  try {
    owedSynced = await flushOwedIntakeSyncs(now);
  } catch (err) {
    tally.fail();
    getEvent()?.addWarning(
      `intake_sync_owed_flush_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const pending = await prisma.pushDataChange.findMany({
    where: { NOT: { domains: { isEmpty: true } } },
    select: { deviceId: true },
    orderBy: { updatedAt: "asc" },
    take: 500,
  });
  let flushed = 0;
  for (const row of pending) {
    try {
      const sent = await flushDataChange(row.deviceId, now);
      if (sent !== null) tally.ok();
      if (sent) flushed += 1;
    } catch (err) {
      tally.fail();
      getEvent()?.addWarning(
        `data_changed_flush_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { flushed, owedSynced, pruned: await pruneWakes(now), tally };
}

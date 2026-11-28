/**
 * The iPhone stall detector: per device, has its Apple Health upload gone
 * quiet against its own rhythm?
 *
 * A force-quit app gets no silent push and no background delivery from iOS,
 * so the server's six-hour catch-up wake (`push-relay/healthkit-catch-up.ts`)
 * cannot reach it; only a visible notification can. This pass decides when a
 * device has stalled, so the notice (`notice.ts`) can say so once.
 *
 * Only a device that ever delivered Apple Health data of a background type
 * (`Device.healthIngestAt`, stamped by the batch ingest) is judged, by the
 * stall rule (`cadence.ts`) with a 24-hour floor: the catch-up wake asks
 * first, at six. The cadence is learned from the hours the device delivered
 * in (`DeviceHealthIngestHour`), so a phone that uploads every hour and one
 * that uploads once a day are each held to their own rhythm, and a device used
 * now and then never qualifies.
 *
 * The flag (`Device.healthQuietSince`) is cleared by the next delivery
 * (`recordDeviceHealthIngest`), and by this pass once the device no longer
 * qualifies; clearing it clears the notice stamp with it, so the next stall
 * is told afresh.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { HISTORY_DAYS, judgeStall, learnCadence } from "./cadence";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The least an iPhone may stay quiet before it counts as stalled. */
export const DEVICE_STALL_FLOOR_MS = DAY_MS;

/**
 * How long delivery hours are kept: the history window, the floor before it,
 * and a day of slack.
 */
export const INGEST_HOUR_RETENTION_DAYS = HISTORY_DAYS + 2;

export interface DeviceStallFacts {
  judged: number;
  flagged: number;
  cleared: number;
  pruned: number;
}

type Db = Pick<PrismaClient, "device" | "deviceHealthIngestHour">;

/** The device platforms that deliver from a phone, and what each one feeds. */
export const STALL_PLATFORMS = ["ios", "android"] as const;

/** The connection a device's stall is told as. */
export function stallSourceForPlatform(
  platform: string,
): "apple-health" | "health-connect-app" {
  return platform === "android" ? "health-connect-app" : "apple-health";
}

/** One pass over every device that could have stalled. */
export async function runDeviceStallPass(
  prisma: Db,
  now: Date,
): Promise<DeviceStallFacts> {
  const facts: DeviceStallFacts = {
    judged: 0,
    flagged: 0,
    cleared: 0,
    pruned: 0,
  };
  const floorAgo = new Date(now.getTime() - DEVICE_STALL_FLOOR_MS);
  // A device that delivered within the floor is fresh, and its delivery
  // already cleared any flag; only the rest need a look.
  const devices = await prisma.device.findMany({
    where: {
      // iPhones and the Android devices running HealthLog Sync: one rule.
      platform: { in: [...STALL_PLATFORMS] },
      healthIngestAt: { not: null },
      OR: [
        { healthIngestAt: { lt: floorAgo } },
        { healthQuietSince: { not: null } },
      ],
      ...OWNED_BY_ACTIVE_ACCOUNT,
    },
    select: { id: true, healthIngestAt: true, healthQuietSince: true },
  });

  if (devices.length > 0) {
    // The history window ends where the floor begins, as the watchdog's
    // does: the history read is the one the silence is measured against.
    const historyFrom = new Date(floorAgo.getTime() - HISTORY_DAYS * DAY_MS);
    const hours = await prisma.deviceHealthIngestHour.findMany({
      where: {
        deviceId: { in: devices.map((d) => d.id) },
        hour: { gte: historyFrom },
      },
      select: { deviceId: true, hour: true },
    });
    const byDevice = new Map<string, Date[]>();
    for (const row of hours) {
      const list = byDevice.get(row.deviceId) ?? [];
      list.push(row.hour);
      byDevice.set(row.deviceId, list);
    }

    for (const device of devices) {
      facts.judged += 1;
      const verdict = judgeStall({
        floorMs: DEVICE_STALL_FLOOR_MS,
        lastAt: device.healthIngestAt,
        cadence: learnCadence(byDevice.get(device.id) ?? [], floorAgo),
        now,
      });
      if (verdict.kind === "stalled") {
        if (device.healthQuietSince) continue;
        // Guarded on the delivery it judged: a batch that landed meanwhile
        // has cleared the stall, and this write must not bring it back.
        const { count } = await prisma.device.updateMany({
          where: {
            id: device.id,
            healthIngestAt: device.healthIngestAt,
            healthQuietSince: null,
          },
          data: { healthQuietSince: verdict.since },
        });
        facts.flagged += count;
      } else if (device.healthQuietSince) {
        const { count } = await prisma.device.updateMany({
          where: { id: device.id, healthQuietSince: { not: null } },
          data: { healthQuietSince: null, healthQuietNotifiedAt: null },
        });
        facts.cleared += count;
      }
    }
  }

  const { count } = await prisma.deviceHealthIngestHour.deleteMany({
    where: {
      hour: {
        lt: new Date(now.getTime() - INGEST_HOUR_RETENTION_DAYS * DAY_MS),
      },
    },
  });
  facts.pruned = count;
  return facts;
}

/** The account's iPhones that are quiet now, for the Apple Health card. */
export async function loadQuietDevices(
  prisma: Pick<PrismaClient, "device">,
  userId: string,
): Promise<Array<{ model: string | null; quietSince: string }>> {
  const rows = await prisma.device.findMany({
    where: { userId, platform: "ios", healthQuietSince: { not: null } },
    select: { model: true, healthQuietSince: true },
    orderBy: { healthQuietSince: "asc" },
  });
  return rows.map((d) => ({
    model: d.model ?? null,
    quietSince: d.healthQuietSince!.toISOString(),
  }));
}

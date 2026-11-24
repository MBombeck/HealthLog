/**
 * The device's report of its running Live Activities (`liveActivityTokens`
 * on `POST /api/devices`), stored as the set of its tokens, each with the
 * dose it shows.
 *
 * An Activity the app started itself names its dose. One the relay started
 * (`HealthLogDoseAttributes`) knows no dose; it knows its start id, the `s`
 * attribute the relay copied from the start's ref, and an app that reads it
 * sends it as `startId`. The server then names the dose from that start's
 * own row (`push_relay_deliveries`), exactly, however many run.
 *
 * Without a start id (iOS builds up to 1.7, or a relay that writes no `s`),
 * the server can name a new relay-started token only when its records show
 * one relay start it could be: the relay-started tokens already named, and
 * the device's last start while the app has not registered it. A token the
 * server named before keeps that dose when the app posts it again. Anything
 * else is a guess: the token is kept without a dose and the relay pass ends
 * it.
 *
 * The report also tells the pass which rule the device runs under
 * (`Device.laStartIdsAt`): a relay-started Activity reported with its start
 * id sets it, one reported without clears it.
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  activitySlotWindow,
  sameActivitySlot,
} from "@/lib/push-relay/activity-slot";
import { LA_START_EVENT } from "@/lib/push-relay/live-activity-settle";

export interface ReportedActivity {
  token: string;
  medicationId?: string;
  relayStart?: boolean;
  startId?: string;
  slotInstant?: Date;
  statement?: Record<string, unknown>;
  signature?: string;
}

type Dose = { medicationId: string; slotInstant: Date | null };

type StartRow = {
  ref: string;
  status: string;
  medicationId: string | null;
  slotInstant: Date | null;
  laReportedAt: Date | null;
};

const START_SELECT = {
  ref: true,
  status: true,
  medicationId: true,
  slotInstant: true,
  laReportedAt: true,
} as const;

function sameDose(a: Dose, b: Dose): boolean {
  return (
    a.medicationId === b.medicationId &&
    (a.slotInstant === null || b.slotInstant === null
      ? a.slotInstant === b.slotInstant
      : sameActivitySlot(a.slotInstant, b.slotInstant))
  );
}

/**
 * The one relay start a relay-started token without its dose can be, or
 * null when the records show none or more than one: the relay-started
 * tokens already named, and the device's last start (in flight or accepted)
 * while the app has not registered it. A relay-started token on record
 * without a dose makes the records ambiguous.
 */
function singleRunningRelayStart(
  stored: ReadonlyArray<{
    medicationId: string | null;
    slotInstant: Date | null;
  }>,
  last: StartRow | null,
): Dose | null {
  const doses: Dose[] = [];
  const add = (dose: Dose) => {
    if (!doses.some((d) => sameDose(d, dose))) doses.push(dose);
  };
  for (const row of stored) {
    if (row.medicationId === null) return null;
    add({
      medicationId: row.medicationId,
      slotInstant: row.slotInstant,
    });
  }
  if (
    last &&
    (last.status === "pending" || last.status === "accepted") &&
    last.laReportedAt === null &&
    last.medicationId &&
    last.slotInstant
  ) {
    add({
      medicationId: last.medicationId,
      slotInstant: last.slotInstant,
    });
  }
  return doses.length === 1 ? doses[0]! : null;
}

/**
 * Replace the device's running Activities with `posted` (an empty list
 * clears them; omitted keeps them), naming each relay-started one's dose, and mark the starts
 * the app has now registered.
 */
export async function replaceLiveActivityTokens(
  tx: Prisma.TransactionClient,
  deviceId: string,
  posted: readonly ReportedActivity[] | undefined,
  now: Date = new Date(),
): Promise<void> {
  if (posted === undefined) return;
  // A token the app once registered as relay-started stays so when a later
  // post of the set omits `relayStart`: the mark is the Activity's
  // attributes type, which never changes. A dose the server named for a
  // token stays with it the same way.
  const storedRelay = await tx.liveActivityToken.findMany({
    where: { deviceId, relayStarted: true },
    select: { pushToken: true, medicationId: true, slotInstant: true },
  });
  const storedByToken = new Map(
    storedRelay.map((row) => [row.pushToken.toLowerCase(), row]),
  );
  await tx.liveActivityToken.deleteMany({ where: { deviceId } });

  const startIds = [
    ...new Set(posted.flatMap((a) => (a.startId ? [a.startId] : []))),
  ];
  const starts = new Map(
    (startIds.length > 0
      ? await tx.pushRelayDelivery.findMany({
          where: { deviceId, eventType: LA_START_EVENT, ref: { in: startIds } },
          select: START_SELECT,
        })
      : []
    ).map((row) => [row.ref, row]),
  );

  const isRelay = (a: ReportedActivity) =>
    a.relayStart === true ||
    a.startId !== undefined ||
    storedByToken.has(a.token.toLowerCase());
  // Posted without a dose, a start id, or a dose the server named before.
  const unnamed = posted.filter(
    (a) =>
      !a.medicationId &&
      !a.startId &&
      !storedByToken.get(a.token.toLowerCase())?.medicationId,
  );
  const last =
    unnamed.length === 1
      ? await tx.pushRelayDelivery.findFirst({
          where: { deviceId, eventType: LA_START_EVENT },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: START_SELECT,
        })
      : null;
  const running =
    unnamed.length === 1 ? singleRunningRelayStart(storedRelay, last) : null;

  const reported = new Set<string>();
  const rows = posted.map((a) => {
    const stored = storedByToken.get(a.token.toLowerCase());
    const start = a.startId ? starts.get(a.startId) : undefined;
    let dose: Dose | null;
    if (start) {
      // The server's own record of the start names the dose; a start that
      // gave its dose back (answered and reopened, or signed out) names
      // none, and the pass ends its Activity.
      reported.add(start.ref);
      dose = start.medicationId
        ? { medicationId: start.medicationId, slotInstant: start.slotInstant }
        : null;
    } else if (a.medicationId) {
      dose = {
        medicationId: a.medicationId,
        slotInstant: a.slotInstant ?? null,
      };
    } else if (stored?.medicationId) {
      dose = {
        medicationId: stored.medicationId,
        slotInstant: stored.slotInstant,
      };
    } else if (unnamed.includes(a) && running) {
      dose = running;
    } else {
      dose = null;
    }
    return { a, dose, relayStarted: isRelay(a) };
  });

  // A start the app registered holds no other start back any more, whether
  // the Activity runs on or the app drops it later: the one its start id
  // names, and those of each dose a relay-started token shows.
  const relayRows = rows.filter((r) => r.relayStarted);
  const shown = relayRows.flatMap(({ dose }) =>
    dose?.slotInstant
      ? [
          {
            medicationId: dose.medicationId,
            slotInstant: activitySlotWindow(dose.slotInstant),
          },
        ]
      : [],
  );
  if (reported.size > 0 || shown.length > 0) {
    await tx.pushRelayDelivery.updateMany({
      where: {
        deviceId,
        eventType: LA_START_EVENT,
        laReportedAt: null,
        OR: [
          ...(reported.size > 0 ? [{ ref: { in: [...reported] } }] : []),
          ...shown,
        ],
      },
      data: { laReportedAt: now },
    });
  }
  if (relayRows.some((r) => r.a.startId)) {
    await tx.device.update({
      where: { id: deviceId },
      data: { laStartIdsAt: now },
    });
  } else if (relayRows.some((r) => r.a.relayStart === true)) {
    await tx.device.update({
      where: { id: deviceId },
      data: { laStartIdsAt: null },
    });
  }

  if (rows.length === 0) return;
  await tx.liveActivityToken.createMany({
    data: rows.map(({ a, dose, relayStarted }) => ({
      deviceId,
      pushToken: a.token,
      medicationId: dose?.medicationId ?? null,
      slotInstant: dose?.slotInstant ?? null,
      relayStarted,
      ...(a.statement && a.signature
        ? {
            activityStatement: a.statement as Prisma.InputJsonObject,
            activitySignature: a.signature,
          }
        : {}),
    })),
    skipDuplicates: true,
  });
}

/**
 * Envelope receipts: the device says which pushes it opened, this server
 * learns which relay pushes never arrived.
 *
 * On `GET /api/sync/state` the app reports the newest envelope id it opened
 * per class (`openedAlert`, `openedSilent`). Envelope ids are ULIDs, ordered
 * by the time they were sealed, so every relay push to that device of that
 * class with a `ref` not after the reported id counts as confirmed. A push the
 * relay accepted that stays unconfirmed although the device reported well
 * after it was not delivered (`intakeSync: degraded`, `capability.ts`).
 *
 * Once an hour the counts, never the ids, go to the relay
 * (`POST /v1/receipts`): of the pushes it accepted more than six hours ago
 * for devices that reported since, how many were confirmed. That is what lets
 * the relay notice it answers `accepted` while sending nothing.
 */
import { prisma } from "@/lib/db";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REPORT_AGE_MS = 6 * 3600 * 1000;
const MAX_REPORTED = 100_000;

export interface OpenedEnvelopes {
  alert?: string;
  silent?: string;
}

/** Parse the receipt query parameters; malformed ids are ignored. */
export function openedFromQuery(params: URLSearchParams): OpenedEnvelopes {
  const pick = (name: string) => {
    const value = params.get(name)?.trim().toUpperCase();
    return value && ULID_RE.test(value) ? value : undefined;
  };
  return { alert: pick("openedAlert"), silent: pick("openedSilent") };
}

/** Record what the device opened and confirm the deliveries it covers. */
export async function recordOpenedEnvelopes(
  userId: string,
  deviceToken: string | null,
  opened: OpenedEnvelopes,
  now: Date = new Date(),
): Promise<boolean> {
  if (!deviceToken || (!opened.alert && !opened.silent)) return false;
  const device = await prisma.device.findFirst({
    where: { userId, token: deviceToken },
    select: { id: true },
  });
  if (!device) return false;
  await prisma.device.update({
    where: { id: device.id },
    data: {
      ...(opened.alert ? { envelopeOpenedAlertId: opened.alert } : {}),
      ...(opened.silent ? { envelopeOpenedSilentId: opened.silent } : {}),
      envelopeReportedAt: now,
    },
  });
  for (const [pushClass, id] of Object.entries(opened)) {
    if (!id) continue;
    await prisma.pushRelayDelivery.updateMany({
      where: {
        deviceId: device.id,
        pushClass,
        status: "accepted",
        confirmedAt: null,
        ref: { lte: id },
      },
      data: { confirmedAt: now },
    });
  }
  return true;
}

/**
 * The counts for the next receipt report, and the rows they cover (marked
 * reported once the relay took the report).
 */
export async function pendingReceiptCounts(now: Date = new Date()): Promise<{
  accepted: number;
  confirmed: number;
  ids: string[];
}> {
  const cutoff = new Date(now.getTime() - REPORT_AGE_MS);
  const rows = await prisma.pushRelayDelivery.findMany({
    where: {
      status: "accepted",
      receiptReportedAt: null,
      pushClass: { in: ["alert", "silent"] },
      acceptedAt: { lt: cutoff },
    },
    select: {
      id: true,
      acceptedAt: true,
      confirmedAt: true,
      device: { select: { envelopeReportedAt: true } },
    },
    take: MAX_REPORTED,
  });
  // Only devices that reported after the push can say whether it arrived.
  const judged = rows.filter(
    (r) =>
      r.acceptedAt &&
      r.device.envelopeReportedAt &&
      r.device.envelopeReportedAt > r.acceptedAt,
  );
  return {
    accepted: judged.length,
    confirmed: judged.filter((r) => r.confirmedAt !== null).length,
    ids: judged.map((r) => r.id),
  };
}

/** Mark the rows of a report the relay accepted. */
export async function markReceiptsReported(
  ids: string[],
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  await prisma.pushRelayDelivery.updateMany({
    where: { id: { in: ids } },
    data: { receiptReportedAt: now },
  });
}

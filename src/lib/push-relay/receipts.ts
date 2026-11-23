/**
 * Envelope receipts: the device says which pushes it opened, this server
 * learns which relay pushes never arrived.
 *
 * On `GET /api/sync/state` the app reports the newest envelope id it opened
 * per class (`openedAlert`, `openedSilent`). Envelope ids are ULIDs, ordered
 * by the time they were sealed, so every relay push to that device of that
 * class with a `ref` not after the reported id counts as confirmed. When the
 * newest alert the relay accepted stays unconfirmed although the device
 * reported well after it, it was not delivered (`intakeSync: degraded`,
 * `capability.ts`). Silent receipts are recorded too, but never judged: iOS
 * delivers silent pushes at its discretion.
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

/** The device a receipt report names, with the newest ids it reported. */
export interface ReceiptDevice {
  id: string;
  envelopeOpenedAlertId: string | null;
  envelopeOpenedSilentId: string | null;
}

/**
 * The caller's device a receipt report is for, or null when the request
 * names none or carries no valid id. A read: it runs beside the handshake's
 * other reads, and the write (`confirmOpenedEnvelopes`) does not hold the
 * answer up.
 */
export async function receiptDevice(
  userId: string,
  deviceToken: string | null,
  opened: OpenedEnvelopes,
): Promise<ReceiptDevice | null> {
  if (!deviceToken || (!opened.alert && !opened.silent)) return null;
  return prisma.device.findFirst({
    where: { userId, token: deviceToken },
    select: {
      id: true,
      envelopeOpenedAlertId: true,
      envelopeOpenedSilentId: true,
    },
  });
}

/** The later of two ULIDs (they sort by the time they were sealed). */
function newer(stored: string | null, reported: string | undefined) {
  if (!reported) return stored ?? undefined;
  return stored && stored > reported ? stored : reported;
}

/**
 * Record what the device opened and confirm the deliveries it covers: one
 * device write and one ledger write. The stored ids only move forward, so a
 * report that arrives late, behind a newer one, cannot pull them back.
 */
export async function confirmOpenedEnvelopes(
  device: ReceiptDevice,
  opened: OpenedEnvelopes,
  now: Date = new Date(),
): Promise<void> {
  const alert = newer(device.envelopeOpenedAlertId, opened.alert);
  const silent = newer(device.envelopeOpenedSilentId, opened.silent);
  const covered = [
    ...(opened.alert && alert
      ? [{ pushClass: "alert", ref: { lte: alert } }]
      : []),
    ...(opened.silent && silent
      ? [{ pushClass: "silent", ref: { lte: silent } }]
      : []),
  ];
  await Promise.all([
    prisma.device.update({
      where: { id: device.id },
      data: {
        ...(alert ? { envelopeOpenedAlertId: alert } : {}),
        ...(silent ? { envelopeOpenedSilentId: silent } : {}),
        envelopeReportedAt: now,
      },
    }),
    covered.length === 0
      ? null
      : prisma.pushRelayDelivery.updateMany({
          where: {
            deviceId: device.id,
            status: "accepted",
            confirmedAt: null,
            OR: covered,
          },
          data: { confirmedAt: now },
        }),
  ]);
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

/**
 * v1.23 — new-device / new-location sign-in alert.
 *
 * Called on every completed sign-in (password, MFA-verify, passkey). Computes
 * a coarse, one-way device fingerprint (see `device-fingerprint.ts`) and:
 *   - first sighting of the fingerprint → record it AND fire one notification
 *     through the dispatcher cascade (respecting the user's per-channel prefs),
 *   - any later sighting → bump `lastSeenAt` only, stay silent (dedupe).
 *
 * The whole thing is best-effort and is invoked fire-and-forget from the login
 * paths: a failure here must never block or fail a sign-in. The raw IP/UA are
 * never persisted — only the salted hash + a coarse label (and the audit row,
 * which already records IP/geo for `auth.*` events).
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { lookupIpLocation, lookupIpAsn } from "@/lib/geo";
import {
  coarseDeviceLabel,
  coarseLocationSignal,
  computeDeviceHash,
} from "@/lib/auth/device-fingerprint";
import {
  sendSecurityAlert,
  unknownLocationText,
} from "@/lib/auth/security-alert";
import { getEvent } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";

export interface RecordSignInResult {
  known: boolean;
  alerted: boolean;
}

export async function recordSignInDevice(params: {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * When false the device is recorded silently with no notification — used by
   * account registration, where the very first device should not trigger a
   * "new device" alert the moment the account is created.
   */
  alertOnNew?: boolean;
}): Promise<RecordSignInResult> {
  const { userId, ip, userAgent } = params;
  const alertOnNew = params.alertOnNew ?? true;

  try {
    // Coarse geo signal — best-effort. The location resolver is online-first
    // with its own timeout; a miss falls back to the ASN number so a device
    // on the same network still dedupes even without a city.
    let location: string | null = null;
    try {
      location = await lookupIpLocation(ip);
    } catch {
      location = null;
    }
    const coarseSignal =
      coarseLocationSignal(location) || lookupIpAsn(ip)?.asn?.toString() || "";

    const deviceHash = computeDeviceHash({ userId, userAgent, coarseSignal });
    const deviceLabel = coarseDeviceLabel(userAgent);
    const storedLabel = location ? `${deviceLabel} — ${location}` : deviceLabel;

    const existing = await prisma.userKnownDevice.findUnique({
      where: { userId_deviceHash: { userId, deviceHash } },
      select: { id: true },
    });

    if (existing) {
      await prisma.userKnownDevice
        .update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        })
        .catch(() => {});
      return { known: true, alerted: false };
    }

    // First sighting of THIS device. If the user has no known devices at all
    // the ledger is empty — this is the account's baseline (the first login
    // after the feature shipped, or an account whose registration predates the
    // ledger). Establish it silently: a "new device" alert only means anything
    // once there is at least one established device to contrast against, so we
    // never alert on the very first device a user is ever seen on.
    const knownDeviceCount = await prisma.userKnownDevice.count({
      where: { userId },
    });
    const isBaseline = knownDeviceCount === 0;

    // First sighting. Insert; if a concurrent first-login races us to the
    // unique (userId, deviceHash) index, swallow it and treat as already known
    // so we never double-alert.
    try {
      await prisma.userKnownDevice.create({
        data: { userId, deviceHash, label: storedLabel },
      });
    } catch (err) {
      // ONLY the unique-index race (a concurrent first-login inserting the
      // same (userId, deviceHash)) is a legitimate "already known" outcome —
      // swallow it and skip the alert so we never double-alert. Any other
      // failure (a real DB fault) must NOT be silently classified as a known
      // device, which would suppress the SECURITY_ALERT + audit row: rethrow
      // so the outer catch records it via `addWarning`.
      if (isP2002(err)) return { known: true, alerted: false };
      throw err;
    }

    if (!alertOnNew || isBaseline) return { known: false, alerted: false };

    await auditLog("auth.login.new_device", {
      userId,
      ipAddress: ip,
      details: { device: deviceLabel },
    });

    // Localised against the recipient's own locale and fanned out through
    // the dispatcher, which applies the per-channel SECURITY_ALERT prefs.
    await sendSecurityAlert(userId, "new_device", {
      device: deviceLabel,
      location: location ?? (await unknownLocationText(userId)),
    });

    return { known: false, alerted: true };
  } catch (err) {
    getEvent()?.addWarning(
      `recordSignInDevice failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { known: false, alerted: false };
  }
}

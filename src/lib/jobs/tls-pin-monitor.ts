/**
 * TLS leaf SPKI-change monitor.
 *
 * The native iOS client SPKI-pins the server's TLS LEAF certificate. When
 * the leaf auto-renews (e.g. Google Trust Services re-issues it) the leaf
 * keypair — and so the SPKI pin — changes, and a client shipped only the
 * old pin will refuse to connect on the next renewal: a silent outage.
 *
 * This job probes the served leaf on a schedule, computes the iOS SPKI pin
 * (`base64(sha256(DER subjectPublicKeyInfo))`), and compares it against the
 * operator's known-good set in `TLS_LEAF_SPKI_PINS` (comma-separated to
 * cover the dual-pin renewal window). When the served pin leaves that set,
 * it fires LOUD:
 *
 *   1. a `tls.pin.leaf_changed` wide-event annotation (old set + served pin),
 *   2. a `system.tls.pin_changed` audit-log row, and
 *   3. a high-priority `SYSTEM_ALERT` to every ADMIN user, reusing the same
 *      admin-fan-out idiom as the deploy webhook + integration-status alarm.
 *
 * The runbook at `docs/ops/tls-cert-pin.md` documents the operator / iOS
 * release-owner response (re-extract, dual-pin, ship to TestFlight) and how
 * to set the baseline.
 *
 * BASELINE SOURCE — env var, deliberately, NOT a persisted last-seen row.
 * A persisted auto-baseline would silently adopt the first rotated pin and
 * suppress the very alarm the pinned iOS client needs; the env baseline is
 * the single source of truth the operator also derives the shipped iOS pin
 * set from, and an unset baseline fails LOUD ("not configured"), never by
 * auto-adopting whatever it observed.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { PrismaClient } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import {
  fetchLeafSpki,
  parseKnownPins,
  isPinKnown,
  resolveAppTlsTarget,
  type LeafProbeResult,
} from "@/lib/tls/leaf-spki";

export interface TlsPinMonitorSummary {
  /** "ok" served pin is in the known set; "changed" it is not; "skipped" no target / no baseline; "probe_failed" the TLS probe threw. */
  outcome: "ok" | "changed" | "skipped" | "probe_failed";
  host: string | null;
  servedPin: string | null;
  knownPinCount: number;
  validTo: string | null;
}

/**
 * Fan out a high-priority SYSTEM_ALERT to every ADMIN user. Mirrors the
 * deploy-webhook + integration-status admin-alert idiom: the dispatcher
 * silently no-ops on a user with no configured channel, so this is safe
 * even before any operator notification channel is wired.
 */
async function alertAdminsOfPinChange(
  prisma: PrismaClient,
  host: string,
  probe: LeafProbeResult,
  knownPins: string[],
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", ...ACTIVE_ACCOUNT },
    select: { id: true },
  });

  if (admins.length === 0) {
    getEvent()?.addWarning(
      "No admin user configured to alert about TLS leaf SPKI change",
    );
    return;
  }

  for (const admin of admins) {
    await dispatchLocalisedNotification({
      userId: admin.id,
      titleKey: "notifications.admin.tlsPinChangedTitle",
      messageKey: "notifications.admin.tlsPinChangedBody",
      params: {
        host,
        servedPin: probe.pin,
        validTo: probe.validTo,
      },
      metadata: {
        source: "tls-pin-monitor",
        url: "/admin/system-status",
        host,
        servedPin: probe.pin,
        knownPins: knownPins.join(","),
        validTo: probe.validTo,
        fingerprint256: probe.fingerprint256,
      },
    });
  }
}

/**
 * One monitor pass. Resolves the target host from the app URL, probes the
 * served leaf, compares its SPKI pin against the baseline set, and on a
 * change emits the wide-event annotation + audit row + admin alert.
 *
 * Never throws on a probe / TLS error — a transient handshake failure
 * annotates `tls.pin.probe_failed` and returns; the alarm only fires on a
 * confirmed pin that is genuinely absent from the known set.
 */
export async function runTlsPinMonitor(
  prisma: PrismaClient,
): Promise<TlsPinMonitorSummary> {
  const evt = getEvent();
  const target = resolveAppTlsTarget();

  if (!target) {
    // No HTTPS app URL configured (plain-HTTP LAN/VPN self-host) — there is
    // no leaf to pin, so the monitor is a no-op.
    evt?.addMeta("tls_pin_outcome", "skipped_no_https_target");
    return {
      outcome: "skipped",
      host: null,
      servedPin: null,
      knownPinCount: 0,
      validTo: null,
    };
  }

  const knownPins = parseKnownPins(process.env.TLS_LEAF_SPKI_PINS);

  let probe: LeafProbeResult;
  try {
    probe = await fetchLeafSpki(target.host, target.port);
  } catch (err) {
    // Transient TLS / network failure — surface but do not alarm. A real
    // pin change is confirmed only by a successful probe returning a pin
    // outside the known set.
    evt?.setAction({ name: "tls.pin.probe_failed" });
    evt?.addMeta("tls_pin_outcome", "probe_failed");
    evt?.addMeta("tls_pin_host", target.host);
    evt?.addWarning(
      `tls-pin-monitor probe failed for ${target.host}:${target.port}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      outcome: "probe_failed",
      host: target.host,
      servedPin: null,
      knownPinCount: knownPins.length,
      validTo: null,
    };
  }

  if (knownPins.length === 0) {
    // Baseline not configured. Fail LOUD (no silent auto-adopt): record the
    // served pin so the operator can seed TLS_LEAF_SPKI_PINS, but treat as a
    // no-op alarm-wise — there is nothing to compare against yet.
    evt?.addMeta("tls_pin_outcome", "skipped_no_baseline");
    evt?.addMeta("tls_pin_host", target.host);
    evt?.addMeta("tls_pin_served", probe.pin);
    evt?.addWarning(
      `tls-pin-monitor: TLS_LEAF_SPKI_PINS is not configured; served leaf pin for ${target.host} is ${probe.pin} (set the env baseline to enable the alarm)`,
    );
    return {
      outcome: "skipped",
      host: target.host,
      servedPin: probe.pin,
      knownPinCount: 0,
      validTo: probe.validTo,
    };
  }

  if (isPinKnown(probe.pin, knownPins)) {
    evt?.addMeta("tls_pin_outcome", "ok");
    evt?.addMeta("tls_pin_host", target.host);
    return {
      outcome: "ok",
      host: target.host,
      servedPin: probe.pin,
      knownPinCount: knownPins.length,
      validTo: probe.validTo,
    };
  }

  // ── Alarm: the served leaf SPKI is not in the pinned set ──
  evt?.setAction({ name: "tls.pin.leaf_changed" });
  evt?.addMeta("tls_pin_outcome", "changed");
  evt?.addMeta("tls_pin_host", target.host);
  evt?.addMeta("tls_pin_served", probe.pin);
  evt?.addMeta("tls_pin_known", knownPins.join(","));
  evt?.addMeta("tls_pin_valid_to", probe.validTo);

  await auditLog("system.tls.pin_changed", {
    details: {
      host: target.host,
      port: target.port,
      servedPin: probe.pin,
      knownPins,
      validTo: probe.validTo,
      fingerprint256: probe.fingerprint256,
    },
  });

  try {
    await alertAdminsOfPinChange(prisma, target.host, probe, knownPins);
  } catch (err) {
    evt?.addWarning(
      `tls-pin-monitor admin alert failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    outcome: "changed",
    host: target.host,
    servedPin: probe.pin,
    knownPinCount: knownPins.length,
    validTo: probe.validTo,
  };
}

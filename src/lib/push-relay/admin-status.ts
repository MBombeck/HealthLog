/**
 * What the admin card and the one-time admin notice read
 * (`GET /api/admin/push-relay`).
 */
import { prisma } from "@/lib/db";
import {
  relayConfig,
  relayDocumentUrls,
  RELAY_TERMS_VERSION,
} from "@/lib/push-relay/config";
import { relayHealth } from "@/lib/push-relay/capability";
import { loadRegistration } from "@/lib/push-relay/registration";

/** The id of the one-time notice that the relay option exists. */
export const RELAY_NOTICE_ID = "push_relay_available";
export const RELAY_DOCS_URL =
  "https://docs.healthlog.dev/integrations/push-relay";

export async function adminRelayStatus(userId: string) {
  const config = relayConfig();
  const [row, admin, bound, consented] = await Promise.all([
    config.available ? loadRegistration(config) : null,
    prisma.user.findUnique({
      where: { id: userId },
      select: { adminNoticesDismissed: true },
    }),
    prisma.device.count({ where: { relayState: "bound" } }),
    prisma.device.count({ where: { relayConsentAt: { not: null } } }),
  ]);
  const health = relayHealth(row);
  const docs = config.origin ? relayDocumentUrls(config.origin) : null;
  return {
    allowed: config.allowed,
    available: config.available,
    unavailableReason: config.unavailableReason,
    relayHost: config.host || null,
    offered: row !== null,
    state: health.state,
    since: health.since?.toISOString() ?? null,
    reason: health.reason,
    instanceId: row?.instanceId ?? null,
    tier: row?.tier ?? null,
    notice: row?.noticeId ? { id: row.noticeId, level: row.noticeLevel } : null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    devices: { bound, consented },
    termsVersion: RELAY_TERMS_VERSION,
    termsUrl: docs?.termsUrl ?? null,
    privacyUrl: docs?.privacyUrl ?? null,
    docsUrl: RELAY_DOCS_URL,
    // The one-time notice: shown while the relay may be offered at all and
    // this admin has not dismissed it.
    noticePending:
      config.allowed &&
      !(admin?.adminNoticesDismissed ?? []).includes(RELAY_NOTICE_ID),
  };
}

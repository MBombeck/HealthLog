/**
 * The admin notice for a host whose login-IP lookups leave it: the offline
 * GeoLite2 tier is not configured and the online provider is still on.
 *
 * The notice is once per CONFIGURATION STATE. A module-level latch alone
 * re-sent it on every worker boot while the state never changed (issue #851:
 * same notice again and again on a host that has simply not mounted the
 * databases). The durable anchor is a per-admin `notification_events` claim,
 * the same ledger every other repeat-prone notice anchors in, released when
 * the state exits, i.e. when the databases are configured or the online
 * lookup is disabled. Entering the unconfigured state sends once; staying in
 * it is silent across restarts; leaving and re-entering sends again.
 *
 * When it runs is decided by the resolver in `src/lib/geo.ts`: on the first
 * public-IP lookup of a process, and again after a runtime database fetch.
 * The resolver does not import this module. It holds a slot that this module
 * fills (`registerOfflineGeoNotice`, called once at boot from
 * `src/instrumentation.ts`), because the lookup sits under `auditLog`, and an
 * import from it into the notification dispatcher closed a loop back to the
 * audit log through the dispatcher's own collaborators.
 */
import {
  offlineGeoReady,
  resolveGeoProviderHost,
  setOfflineGeoNotice,
} from "@/lib/geo";
import { envFlag } from "@/lib/env";
import { getEvent } from "@/lib/logging/context";
import {
  claimNotificationEvent,
  releaseNotificationEvent,
  CONFIG_NOTICE_EVENT_TYPE,
} from "@/lib/notifications/reminder-dedup";

/** Durable anchor identity for the offline-geo notice in `notification_events`. */
const OFFLINE_GEO_NOTICE_DEDUP_KEY = "geo:offline-unavailable";

/**
 * Where the admin notification sends someone who wants the offline tier.
 * The in-repo path is the durable one — the runbook ships with the source
 * that emits this link, so the two cannot drift apart.
 */
const GEOLITE2_DOCS_URL =
  "https://github.com/MBombeck/HealthLog/blob/main/docs/self-hosting/geolite2.md";

/**
 * Whether the host is in the state the notice describes: the offline tier
 * is not configured AND lookups still egress to the online provider. With
 * `IP_GEO_LOOKUP_DISABLED=1` there is no egress to warn about, so the
 * disabled host counts as having left the state — exactly like a host
 * that mounted the databases.
 */
function offlineGeoNoticeStateActive(): boolean {
  return !offlineGeoReady() && !envFlag("IP_GEO_LOOKUP_DISABLED");
}

/**
 * Evaluate the configuration state once: release the anchor when the state
 * does not hold, otherwise claim it per admin and send to each admin who did
 * not hold it yet. Never throws; the lookup that triggers it sits under a
 * fire-and-forget audit write.
 */
export async function evaluateOfflineGeoNotice(): Promise<void> {
  // Defer the resolve so we don't pay the cost of pulling the
  // Prisma client into the import graph until the first evaluation —
  // most calls are cache hits or private-IP short-circuits.
  try {
    const { prisma } = await import("@/lib/db");

    if (!offlineGeoNoticeStateActive()) {
      // The state the notice describes does not hold. Release any
      // persisted sent-anchor so a future re-entry into the unconfigured
      // state notifies again — this is the "state exit" edge.
      await releaseNotificationEvent(prisma, {
        eventType: CONFIG_NOTICE_EVENT_TYPE,
        dedupKey: OFFLINE_GEO_NOTICE_DEDUP_KEY,
      });
      return;
    }

    const { dispatchLocalisedNotification } =
      await import("@/lib/notifications/dispatch-localised");
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    if (admins.length === 0) {
      getEvent()?.addWarning(
        "geo: offline databases unavailable, no admin user configured to notify",
      );
      return;
    }
    for (const admin of admins) {
      // The anchor is unwindowed (`since` at epoch): it holds until the
      // state exit above releases it, however many restarts happen in
      // between. An admin who already has the anchor claimed nothing and
      // hears nothing.
      const claimed = await claimNotificationEvent(prisma, {
        recordUserId: admin.id,
        eventType: CONFIG_NOTICE_EVENT_TYPE,
        dedupKey: OFFLINE_GEO_NOTICE_DEDUP_KEY,
        since: new Date(0),
      });
      if (!claimed) continue;
      getEvent()?.addWarning(
        `geo: offline databases unavailable, every lookup goes online to ${resolveGeoProviderHost()} — notifying admin`,
      );
      await dispatchLocalisedNotification({
        userId: admin.id,
        titleKey: "notifications.admin.offlineGeoUnavailableTitle",
        messageKey: "notifications.admin.offlineGeoUnavailableBody",
        // The message names what the person reading it can actually do.
        // It used to point at a licence-key secret in this repository's
        // Actions settings, which nobody running the published image can
        // set (issue #659) — the reachable path is mounting your own
        // databases and pointing GEOLITE2_DIR at them.
        params: {
          host: resolveGeoProviderHost(),
          docsUrl: GEOLITE2_DOCS_URL,
        },
        metadata: {
          source: "geo-offline-detection",
          url: "/admin/system-status",
        },
      });
    }
  } catch (err) {
    // Never let a notification failure propagate — the auth-audit
    // caller is fire-and-forget.
    getEvent()?.addWarning(
      `geo: offline-geo notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Fill the resolver's slot, so its first public-IP lookup evaluates the notice. */
export function registerOfflineGeoNotice(): void {
  setOfflineGeoNotice(evaluateOfflineGeoNotice);
}

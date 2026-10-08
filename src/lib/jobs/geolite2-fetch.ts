/**
 * Runtime GeoLite2 fetch — pg-boss queue wiring (issue #659).
 *
 * The actual download + extract + place logic lives in
 * `src/lib/geo/geolite2-fetch.ts`; this module owns the queue name, the cron,
 * and the boot-discovery enqueue, mirroring the geo-backfill split
 * (`geo-backfill.ts` holds `runGeoBackfill`, `ops-handlers.ts` holds the
 * `boss.work` handler). Worker-only by construction — nothing here runs in the
 * web request path.
 *
 * Two triggers:
 *
 *   - BOOT: `enqueueGeolite2FetchBootDiscovery()` fires once at worker boot,
 *     only when a key is set and the offline tier is not already present. The
 *     first-run acquisition — pull `:latest`, set the key, restart, the
 *     databases appear without a manual mount.
 *   - CRON: monthly. MaxMind reissues GeoLite2 on the first Tuesday of each
 *     month; the 8th is safely past that, so a monthly refresh keeps a keyed
 *     host current. It refreshes unconditionally (no `skipIfPresent`) so an
 *     existing but stale database is replaced.
 */
import { envFlag } from "@/lib/env";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { offlineGeoReady } from "@/lib/geo";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

export const GEOLITE2_FETCH_QUEUE = "geolite2-fetch";

// Monthly on the 8th at 04:00 Europe/Berlin — past the first-Tuesday reissue
// window, inside the existing 02:xx-04:xx maintenance band. NOT `cronIsTheRetry`:
// a monthly cadence is far too long to be the retry, so the queue keeps
// pg-boss's default retries for a transient MaxMind hiccup.
export const GEOLITE2_FETCH_CRON = "0 4 8 * *";

export interface Geolite2FetchPayload {
  triggeredAt?: string;
  /** `"boot"` fetches only when no database is present yet; `"refresh"` always fetches. */
  mode?: "boot" | "refresh";
}

/**
 * Fire-and-forget boot discovery. Enqueues a single boot-mode fetch only when a
 * key is configured, egress is not disabled, and the offline tier is absent —
 * so a host that already has the databases (baked, mounted, or fetched on a
 * prior boot) enqueues nothing. The handler re-checks all three; gating here
 * just avoids a no-op job on the common keyless boot.
 */
export async function enqueueGeolite2FetchBootDiscovery(): Promise<{
  enqueued: number;
}> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0 };
  if (!process.env.MAXMIND_LICENSE_KEY?.trim()) return { enqueued: 0 };
  if (envFlag("IP_GEO_LOOKUP_DISABLED")) return { enqueued: 0 };
  if (offlineGeoReady()) return { enqueued: 0 };

  try {
    const payload: Geolite2FetchPayload = {
      mode: "boot",
      triggeredAt: new Date().toISOString(),
    };
    const jobId = await boss.send(GEOLITE2_FETCH_QUEUE, payload, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: "geolite2-fetch|boot",
    });
    const enqueued = jobId ? 1 : 0;
    annotate({
      action: { name: "geo.database.fetch.boot" },
      meta: { enqueued },
    });
    return { enqueued };
  } catch (err) {
    logCaught("geolite2.fetch.enqueue_failed", err);
    // A transient send failure is a no-op — the monthly cron and the next boot
    // both re-attempt.
    return { enqueued: 0 };
  }
}

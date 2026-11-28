/**
 * Which of a person's sources are quiet right now: the one answer the push,
 * the integration card and the Today rail all give.
 *
 * The stall rule (`cadence.ts`) decides, once an hour, when a source that
 * delivers on its own has gone quiet against its own rhythm, and stamps it:
 * `IntegrationWatch.silentSince` for a connection (the integration watchdog),
 * `Device.healthQuietSince` for an iPhone's Apple Health upload
 * (`devices.ts`). Every surface reads those stamps through this module, so
 * none of them grows its own idea of "quiet":
 *
 *   - a connection's stamp counts while it still stands (`silenceStands`:
 *     nothing newer than the source's floor arrived since the pass), and
 *     while the connection is not in a state that asks for something else
 *     (a reconnect, a resume, or the provider erroring, which the server
 *     retries and the card names in its own words);
 *   - an iPhone's stamp counts while no iPhone of the account delivers
 *     (`iphoneDelivers`): another phone that still uploads means the data is
 *     arriving.
 *
 * `src/__tests__/one-home-guard.test.ts` holds every surface
 * that shows a quiet source to this module, and every reader of the stamps
 * to a list.
 *
 * Pure. The loader that gathers the facts for one account lives in
 * `./quiet-load`.
 */
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import {
  CONNECTION_KEYS,
  type ConnectionHealth,
  type ConnectionKey,
} from "@/lib/integrations/connection-health";
import { SOURCE_PROFILES } from "@/lib/integrations/watchdog-classify";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

import { silenceStands } from "./cadence";
import { DEVICE_STALL_FLOOR_MS } from "./devices";

/**
 * The sources that can go quiet: every connection that delivers on its own.
 * One delivered on demand (Strava, Dawarich, a Health Connect folder) is
 * watched for errors only and never shown as quiet.
 */
export const STALL_SOURCES: readonly ConnectionKey[] = CONNECTION_KEYS.filter(
  (key) => SOURCE_PROFILES[key].kind !== "on_demand",
);

/**
 * The deep link of a source: its card on the integrations page, the same
 * path for every source and every client. A push straight to the device
 * carries it as `url`; a push over the relay carries only `source`, and a
 * client builds this path from it. The Today rail's item links here too.
 * Published in the `notifications.sync-stalled` feature doc; the anchors on
 * the page are held to it by `sync-stall-deeplink-guard.test.ts`.
 */
export function stallTapUrl(source: ConnectionKey): string {
  return `/settings/integrations#${source}`;
}

/** A source that is quiet now, and the last delivery it went quiet after. */
export interface QuietSource {
  source: ConnectionKey;
  since: Date;
}

/** What the rule reads for one connection (a subset of `ConnectionFacts`). */
export interface QuietConnectionFacts {
  key: ConnectionKey;
  silentSince: Date | null;
  lastDataAt: Date | null;
  health: ConnectionHealth | null;
}

/** What the rule reads for one of the account's iPhones. */
export interface QuietIphoneFacts {
  healthIngestAt: Date | null;
  healthQuietSince: Date | null;
}

/** Whether an iPhone delivered Apple Health data within the device floor. */
export function iphoneDelivers(
  healthIngestAt: Date | null,
  now: Date,
): boolean {
  return (
    healthIngestAt !== null &&
    now.getTime() - healthIngestAt.getTime() <= DEVICE_STALL_FLOOR_MS
  );
}

/**
 * Whether a connection's stamp makes it quiet. A connection that asks for a
 * reconnect or a resume, or whose provider keeps erroring, is in another
 * state, and every surface names that state instead.
 */
function connectionQuiet(facts: QuietConnectionFacts, now: Date): boolean {
  if (!STALL_SOURCES.includes(facts.key) || facts.health === null) {
    return false;
  }
  if (
    facts.health.state === "action_required" ||
    facts.health.reason === "provider_errors"
  ) {
    return false;
  }
  return silenceStands({
    silentSince: facts.silentSince,
    lastDataAt: facts.lastDataAt,
    floorMs: SOURCE_PROFILES[facts.key].silenceWindowMs,
    now,
  });
}

/**
 * Since when Apple Health is quiet by its iPhones, or null: a flagged phone
 * and none that still delivers. The latest stamp wins, since that is the last
 * delivery the account had.
 */
function iphonesQuietSince(
  iphones: readonly QuietIphoneFacts[],
  now: Date,
): Date | null {
  if (iphones.some((d) => iphoneDelivers(d.healthIngestAt, now))) return null;
  let latest: Date | null = null;
  for (const d of iphones) {
    if (d.healthQuietSince && (!latest || d.healthQuietSince > latest)) {
      latest = d.healthQuietSince;
    }
  }
  return latest;
}

/** Whether a source's silence is worth a word under the account's modules. */
export function stallSourceWanted(
  source: ConnectionKey,
  modules: SurfaceModuleMap | null | undefined,
): boolean {
  return isSurfaceVisible(`stall-source:${source}`, modules);
}

/** The quiet sources of one account, in `STALL_SOURCES` order. */
export function resolveQuietSources(input: {
  connections: readonly QuietConnectionFacts[];
  iphones: readonly QuietIphoneFacts[];
  /** The Android devices running HealthLog Sync, the same rule as iPhones. */
  androids?: readonly QuietIphoneFacts[];
  now: Date;
  /**
   * The account's modules: a source whose only module is off is not quiet
   * for anybody (`stall-source:<key>` in `src/lib/modules/surface.ts`).
   */
  modules?: SurfaceModuleMap;
}): QuietSource[] {
  const since = new Map<ConnectionKey, Date>();
  const mark = (key: ConnectionKey, at: Date) => {
    const prev = since.get(key);
    if (!prev || at > prev) since.set(key, at);
  };
  for (const facts of input.connections) {
    if (connectionQuiet(facts, input.now)) mark(facts.key, facts.silentSince!);
  }
  const iphones = iphonesQuietSince(input.iphones, input.now);
  if (iphones) mark("apple-health", iphones);
  const androids = iphonesQuietSince(input.androids ?? [], input.now);
  if (androids) mark("health-connect-app", androids);
  return STALL_SOURCES.filter(
    (key) => since.has(key) && stallSourceWanted(key, input.modules),
  ).map((source) => ({
    source,
    since: since.get(source)!,
  }));
}

/**
 * How a surface names the start of the quiet: "yesterday" when the last
 * delivery was on the person's previous local day (or later), its date
 * otherwise. Local days, so a DST change shifts nothing.
 */
export function quietSinceWording(
  since: Date,
  now: Date,
  tz: string,
): "yesterday" | "date" {
  const yesterday = shiftDateKey(userDayKey(now, tz), -1);
  return userDayKey(since, tz) >= yesterday ? "yesterday" : "date";
}

/** The start of the quiet as a short date ("Nov 19"), in the person's zone. */
export function quietSinceDate(
  since: Date,
  tz: string,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: tz,
  }).format(since);
}

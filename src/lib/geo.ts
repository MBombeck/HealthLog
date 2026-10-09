/**
 * IP geolocation lookup for audit-log enrichment.
 *
 * OFFLINE-FIRST resolver. The MaxMind GeoLite2 MMDBs at `/opt/geolite2/`
 * (or wherever `GEOLITE2_DIR` points) answer whenever they can, and the
 * online provider only ever sees an address they could not place. That
 * ordering is the whole reason an operator mounts the databases: a lookup
 * that resolves locally sends nothing anywhere. The databases stay OPTIONAL
 * — a self-host without them resolves every location through the online
 * provider, which needs no licence and works out of the box.
 *
 *   1. Private / loopback → null (no lookup).
 *   2. Per-IP cache hit → return immediately.
 *   3. Offline MMDB present → local read; on a hit the request ends here.
 *   4. Online lookup → only on an offline miss, and only when
 *      `IP_GEO_LOOKUP_DISABLED` is not set.
 *
 * It was the other way round from v1.18.10 until v1.37: online first, the
 * local databases as the fallback. The documentation described this order the
 * whole time, so a host with the MMDBs mounted was sending every login IP to a
 * third party while its own runbook said it was not.
 *
 * The legacy contract still holds: `lookupIpLocation` returns a
 * `"City, CC"` string or `null`, never throws. `lookupIpGeo` is the
 * unified resolver that returns location + autonomous-system number +
 * carrier organisation in one pass (v1.25.8): the carrier is mined from
 * the online provider's ISP field — so the admin login overview can render
 * its own carrier column even without the optional offline ASN MMDB — and
 * the offline `lookupIpAsn` MMDB read remains the authoritative source when
 * it is configured.
 *
 * Both helpers are safe to call from any request context. The MMDB
 * Reader is loaded lazily on first call and held in a module-level
 * cache; the file load is synchronous and not cheap, but it only
 * happens once per worker process.
 *
 * The base path is overridable via `GEOLITE2_DIR` (default
 * `/opt/geolite2`). When the DB files are missing the helpers silently
 * skip the offline tier — local dev without the MMDBs still works and
 * falls straight back to the online provider. A self-hoster running the
 * published image mounts their own `.mmdb` directory and points the
 * variable at it; `docs/self-hosting/geolite2.md` is the runbook and
 * `docker-compose.yml` carries the variable on its `environment:`
 * whitelist so a value in `.env` actually reaches the container.
 *
 * Default provider for the online lookup is ipwho.is (free, no key, HTTPS).
 * Both the ipwho.is shape (`success`/`country_code`) and the ip-api.com shape
 * (`status`/`countryCode`) are accepted, so swapping providers via
 * `IP_GEO_LOOKUP_URL` only requires matching one of those response shapes.
 * The URL must be HTTPS by default; a self-hoster can opt into a plain-HTTP
 * provider (e.g. the free, HTTP-only, often-more-accurate ip-api.com endpoint)
 * with `IP_GEO_ALLOW_INSECURE=true` — see `buildLookupUrl`. A non-ok HTTP
 * status (403/429/5xx) is surfaced on the wide event rather than swallowed,
 * so a future provider rejection is visible.
 *
 * Setting `IP_GEO_LOOKUP_DISABLED=1` disables the online lookup
 * entirely — used by deployments that do not want any IP egress to a
 * third-party service (V3 audit: GDPR Art. 32 + Art. 44, plaintext
 * HTTP IP egress). With egress disabled the resolver leans solely on
 * the offline MMDB tier (and returns null when that is also absent).
 *
 * Resolved locations are cached per IP in a small in-memory LRU
 * (`LOCATION_CACHE`) so a burst of audit events from the same client
 * does not hammer ipwho.is — the cache holds both hits and misses
 * (negative caching) for a bounded TTL.
 *
 * v1.4.16 A8a: the online-fallback body is decoded as UTF-8 explicitly
 * via `TextDecoder('utf-8')` instead of `Response.json()`, and an
 * `Accept-Language: de, en;q=0.5` hint is sent so providers return
 * native city names ("Nürnberg") rather than ASCII folds ("Nuremberg").
 * The previous path lost umlauts in production for at least one
 * maintainer-flagged login row that rendered as "Nrnberg" in
 * /admin/login-overview — see `docs/audit/v1416-summary.md`.
 *
 * v1.4.27 R5: the build no longer hard-fails on a missing
 * `MAXMIND_LICENSE_KEY` secret — the CI workflow drops an `.empty`
 * marker into the geo asset directory when the key is unset.
 * `offlineGeoReady()` is the canonical check used by `/api/version`
 * and the admin status surface, and the lookup paths fire an admin
 * notification on the first fallback so the maintainer hears about the
 * gap from the running app. The notification is once per CONFIGURATION
 * STATE, not once per process: the sent-anchor persists in the
 * `notification_events` ledger and is released when the state exits
 * (databases configured, or lookups disabled), so a worker restart does
 * not re-send while nothing changed (issue #851) and a genuine re-entry
 * into the unconfigured state does.
 */
import { envOr, envFlag } from "@/lib/env";
import fs from "node:fs";
import path from "node:path";
import { Reader as MmdbReader } from "mmdb-lib";
import type { AsnResponse, CityResponse } from "mmdb-lib/lib/reader/response";
import { getEvent } from "@/lib/logging/context";
import {
  claimNotificationEvent,
  releaseNotificationEvent,
  CONFIG_NOTICE_EVENT_TYPE,
} from "@/lib/notifications/reminder-dedup";
import { safeFetch } from "@/lib/safe-fetch";

interface IpwhoIsResponse {
  success?: boolean;
  city?: string;
  country_code?: string;
  // ipwho.is nests the network operator under `connection`. The free
  // endpoint populates `asn` (a number), `org`, and `isp`.
  connection?: { asn?: number; org?: string; isp?: string };
}

interface IpApiProResponse {
  status?: "success" | "fail";
  city?: string;
  countryCode?: string;
  // ip-api returns the operator at the top level: `isp` is the friendly
  // ISP name ("Deutsche Telekom AG"), `org` the registered org, and `as`
  // a combined "AS3320 Deutsche Telekom AG" string we mine for the number.
  isp?: string;
  org?: string;
  as?: string;
}

type GeoResponse = IpwhoIsResponse & IpApiProResponse;

/** Resolved geo facts for one IP — the cache + every caller speak this shape. */
interface GeoResolved {
  location: string | null;
  asn: number | null;
  carrier: string | null;
}

const PRIVATE_IP =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd|fe80|localhost|unknown)/;

// v1.25.5 — ipwho.is is the default online provider again (free, no key, no
// per-minute cap on the standard endpoint). The base is `https://ipwho.is`;
// `buildLookupUrl` appends `/<ip>` so the wire URL is `https://ipwho.is/<ip>`.
// The parser accepts BOTH the ipwho.is shape (`success` + `country_code`) and
// the ip-api.com shape (`status` + `countryCode`), so operators whose egress
// ipwho.is rejects can point `IP_GEO_LOOKUP_URL` at `https://ip-api.com/json`
// (or any keyed provider matching one of those shapes) with no code change.
// The offline GeoLite2 MMDB tier stays OPTIONAL, but it goes FIRST when it is
// there: this provider is consulted only for an address the local databases
// could not place, and not at all on a host that has them and hits.
const DEFAULT_GEO_URL = "https://ipwho.is";

// The host portion of DEFAULT_GEO_URL — the provider name the admin status
// surface shows when the offline tier is absent and the runtime resolves
// locations online.
const DEFAULT_GEO_HOST = "ipwho.is";

/**
 * Resolve the online geo provider HOST the runtime actually queries.
 *
 * Reads `IP_GEO_LOOKUP_URL` and returns its hostname (e.g. `ip-api.com`),
 * falling back to the default `ipwho.is` when the env is unset, blank, or
 * not a parseable URL. Pure and safe — never throws.
 *
 * `/api/version` surfaces this so the admin System-Snapshot can name the
 * real provider instead of a hardcoded "ipwho.is": an operator who points
 * `IP_GEO_LOOKUP_URL` at another provider sees that provider's host.
 */
export function resolveGeoProviderHost(): string {
  const raw = process.env.IP_GEO_LOOKUP_URL?.trim();
  if (!raw) return DEFAULT_GEO_HOST;
  try {
    return new URL(raw).host || DEFAULT_GEO_HOST;
  } catch {
    return DEFAULT_GEO_HOST;
  }
}

/**
 * How login IPs are placed on this host: from the mounted GeoLite2 databases,
 * by the online provider, or not at all (`IP_GEO_LOOKUP_DISABLED`).
 */
export function geoLookupMode(): "offline" | "online" | "off" {
  if (offlineGeoReady()) return "offline";
  return envFlag("IP_GEO_LOOKUP_DISABLED") ? "off" : "online";
}

/**
 * Whether the operator named the online provider (`IP_GEO_LOOKUP_URL`).
 * An explicit provider is a decision about where login IPs go; the default
 * is not, so the admin status only warns about the default.
 */
export function geoProviderChosen(): boolean {
  return Boolean(process.env.IP_GEO_LOOKUP_URL?.trim());
}

/**
 * Directory the offline MMDBs are read from.
 *
 * `GEOLITE2_DIR` is on the compose `environment:` whitelist, so an
 * operator who mounts their own databases can point the runtime at them
 * without rebuilding the image (`docs/self-hosting/geolite2.md`). Compose
 * substitutes an unset variable to the EMPTY STRING rather than leaving
 * it absent, and an empty string is not nullish — so trim and treat blank
 * as unset, otherwise a stack that merely lists the variable would read
 * the process working directory and silently lose the offline tier.
 */
export function geoLiteDir(): string {
  const configured = process.env.GEOLITE2_DIR?.trim();
  return configured ? configured : "/opt/geolite2";
}

// ── Per-IP location cache ────────────────────────────────────────────
//
// v1.15.12 E1: the online tier is now the baseline path, so a burst of
// audit events from the same address must not fan out one ipwho.is
// request each. We cache the resolved "City, CC" string per IP for a
// bounded TTL and also negative-cache misses (stored as null) so a
// non-resolving IP doesn't re-hit the provider every time. The map is a
// simple bounded FIFO — geo lookups are low-cardinality (a handful of
// distinct client IPs per worker) so an exact LRU is overkill.

const LOCATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
const LOCATION_CACHE_MAX = 512;
const GEO_CACHE = new Map<string, { value: GeoResolved; at: number }>();

function getCachedGeo(ip: string): GeoResolved | null {
  const hit = GEO_CACHE.get(ip);
  if (!hit) return null;
  if (Date.now() - hit.at > LOCATION_CACHE_TTL_MS) {
    GEO_CACHE.delete(ip);
    return null;
  }
  return hit.value;
}

function setCachedGeo(ip: string, value: GeoResolved): void {
  // Bound the map: drop the oldest insertion when full.
  if (GEO_CACHE.size >= LOCATION_CACHE_MAX) {
    const oldest = GEO_CACHE.keys().next().value;
    if (oldest !== undefined) GEO_CACHE.delete(oldest);
  }
  GEO_CACHE.set(ip, { value, at: Date.now() });
}

// ── Offline tier (MaxMind GeoLite2) ──────────────────────────────────
//
// Both readers are held in a process-local cache. We use `undefined`
// for "never tried", and `null` for "tried, file missing" so we don't
// pay the `existsSync + readFileSync + parse` cost on every lookup.

interface MmdbCache {
  city?: MmdbReader<CityResponse> | null;
  asn?: MmdbReader<AsnResponse> | null;
}

const cache: MmdbCache = {};

function loadMmdbReader<
  T extends import("mmdb-lib/lib/reader/response").Response,
>(file: string): MmdbReader<T> | null {
  try {
    const full = path.join(geoLiteDir(), file);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    return new MmdbReader<T>(buf);
  } catch {
    // Corrupt MMDB or unreadable file → fall back to online tier.
    // Never throw from the geo lookup path; the auth-audit caller is
    // fire-and-forget and a thrown error would propagate into an
    // unhandled rejection.
    return null;
  }
}

function getCityReader(): MmdbReader<CityResponse> | null {
  if (cache.city === undefined) {
    cache.city = loadMmdbReader<CityResponse>("GeoLite2-City.mmdb");
  }
  return cache.city;
}

function getAsnReader(): MmdbReader<AsnResponse> | null {
  if (cache.asn === undefined) {
    cache.asn = loadMmdbReader<AsnResponse>("GeoLite2-ASN.mmdb");
  }
  return cache.asn;
}

/**
 * Reset the lazy MMDB reader cache so the next lookup re-reads the files
 * from `geoLiteDir()`. The runtime GeoLite2 fetch (`src/lib/geo/geolite2-fetch.ts`)
 * calls this after it places freshly downloaded databases, so a running worker
 * picks them up without a restart — the readers latch `null` on the first miss,
 * so without this a process that booted before the files landed would keep
 * resolving online forever. Also clears the "offline unavailable"
 * notice-evaluation latch, so the next lookup re-evaluates the
 * configuration state — and, finding the offline tier present, releases
 * the persisted sent-anchor so a later loss of the databases notifies
 * again.
 */
export function resetGeoLite2ReaderCache(): void {
  cache.city = undefined;
  cache.asn = undefined;
  noticeEvaluatedThisProcess = false;
}

/**
 * Test-only — reset the lazy reader cache so a test can swap the
 * `GEOLITE2_DIR` between cases without leaking the previous Reader. Extends
 * the runtime reset with the per-IP location cache, which production has no
 * reason to drop.
 */
export function __resetGeoLite2CacheForTests(): void {
  resetGeoLite2ReaderCache();
  GEO_CACHE.clear();
}

// ── Offline readiness + once-per-state admin notification ────────────
//
// The CI workflow drops an `.empty` marker into the geo asset directory
// when the maintainer has not configured `MAXMIND_LICENSE_KEY`, in
// which case the City + ASN MMDBs are absent and every lookup goes to the
// online provider. `offlineGeoReady()` is the canonical truth used by
// `/api/version`, the admin status surface, and the resolver's own
// offline-first branch, so the three cannot disagree.
//
// The notification is once per CONFIGURATION STATE. A module-level latch
// alone re-sent it on every worker boot while the state never changed
// (issue #851: same notice again and again on a host that has simply not
// mounted the databases). The durable anchor is a per-admin
// `notification_events` claim — the same ledger every other repeat-prone
// notice anchors in — released when the state exits, i.e. when the
// databases are configured or the online lookup is disabled. Entering the
// unconfigured state sends once; staying in it is silent across restarts;
// leaving and re-entering sends again.
//
// `noticeEvaluatedThisProcess` remains as a cheap gate so the ledger is
// consulted once per worker boot (and again after a runtime database
// fetch resets it), not on every lookup. Test-only reset is folded into
// the cache reset above.

let noticeEvaluatedThisProcess = false;

/** Durable anchor identity for the offline-geo notice in `notification_events`. */
const OFFLINE_GEO_NOTICE_DEDUP_KEY = "geo:offline-unavailable";

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
 * Where the admin notification sends someone who wants the offline tier.
 * The in-repo path is the durable one — the runbook ships with the source
 * that emits this link, so the two cannot drift apart.
 */
const GEOLITE2_DOCS_URL =
  "https://github.com/MBombeck/HealthLog/blob/main/docs/self-hosting/geolite2.md";

export function offlineGeoReady(): boolean {
  try {
    const dir = geoLiteDir();
    if (fs.existsSync(path.join(dir, ".empty"))) return false;
    return fs.existsSync(path.join(dir, "GeoLite2-City.mmdb"));
  } catch {
    return false;
  }
}

async function evaluateOfflineGeoNotice(): Promise<void> {
  if (noticeEvaluatedThisProcess) return;
  noticeEvaluatedThisProcess = true;
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
        metadata: { source: "geo-offline-detection" },
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

/**
 * Pick the best-available localised city name from a GeoLite2
 * record. German first because the user-base is DACH-skewed; English
 * as a graceful fallback for cities that don't have a German exonym.
 * The Names map is incomplete in MaxMind for some small German
 * towns, so we accept any of the locales the MMDB layout exposes.
 */
function pickCityName(city: CityResponse["city"]): string | null {
  if (!city?.names) return null;
  return (
    city.names.de ?? city.names.en ?? city.names.fr ?? city.names.es ?? null
  );
}

/**
 * v1.25.8 — extract the network operator (carrier) + AS number from an
 * online provider response. The bundled offline GeoLite2-ASN MMDB is the
 * authoritative source when present, but it is OPTIONAL (not baked into the
 * default image), so on a host without it the carrier column stayed empty.
 * Both supported providers expose the operator inline — ip-api at the top
 * level (`isp`/`org`/`as`), ipwho.is under `connection` — so we mine it from
 * the same response the location lookup already fetched. No second request.
 */
function parseOnlineCarrier(data: GeoResponse): {
  asn: number | null;
  carrier: string | null;
} {
  const conn = data.connection;
  const carrier =
    data.isp?.trim() ||
    data.org?.trim() ||
    conn?.isp?.trim() ||
    conn?.org?.trim() ||
    null;

  let asn: number | null = null;
  if (typeof conn?.asn === "number") {
    asn = conn.asn;
  } else if (typeof data.as === "string") {
    // ip-api ships "AS3320 Deutsche Telekom AG" — keep just the number.
    const m = data.as.match(/AS(\d+)/i);
    if (m) asn = Number(m[1]);
  }

  return { asn, carrier: carrier || null };
}

function lookupIpLocationOffline(ip: string): string | null {
  const reader = getCityReader();
  if (!reader) return null;
  try {
    const row = reader.get(ip);
    if (!row) return null;
    const city = pickCityName(row.city);
    const cc = row.country?.iso_code ?? row.registered_country?.iso_code;
    if (!city || !cc) return null;
    return `${city}, ${cc}`;
  } catch {
    return null;
  }
}

function buildLookupUrl(ip: string): string {
  const base = envOr("IP_GEO_LOOKUP_URL", DEFAULT_GEO_URL).replace(/\/+$/, "");
  if (base.startsWith("https://")) {
    return `${base}/${encodeURIComponent(ip)}`;
  }
  // v1.25.6 — plain HTTP is refused BY DEFAULT (V3 audit: never leak the
  // looked-up IP over an unencrypted hop). A self-hoster who deliberately
  // wants a free HTTP-only provider — e.g. the free ip-api.com endpoint,
  // whose HTTPS form needs a paid key but whose geolocation is often more
  // accurate — opts in explicitly with `IP_GEO_ALLOW_INSECURE=true`. The
  // trade-off (the IP travels in clear over the server's own egress) is the
  // operator's to make; the default stays HTTPS-only for everyone else.
  if (
    base.startsWith("http://") &&
    process.env.IP_GEO_ALLOW_INSECURE === "true"
  ) {
    return `${base}/${encodeURIComponent(ip)}`;
  }
  // Any other scheme — or HTTP without the explicit opt-in — is refused with a
  // dummy URL the parser fails on (a clean miss, never a plaintext request).
  return `https://invalid.invalid/refused-non-https/${encodeURIComponent(ip)}`;
}

/**
 * Decode the raw response bytes as UTF-8, then JSON-parse. Bypasses
 * `Response.json()` so the result is independent of the upstream
 * `Content-Type: application/json; charset=…` value — relevant in
 * production where ipwho.is sits behind Cloudflare and an intermediate
 * proxy can re-serve the body without preserving the charset hint.
 * Falls back to whatever decoding errors `TextDecoder` produces (which
 * substitute U+FFFD rather than dropping bytes), so a malformed
 * response surfaces as a parse failure instead of silent character
 * loss.
 */
async function readUtf8Json(res: Response): Promise<unknown> {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);
  return JSON.parse(text);
}

async function lookupIpOnline(ip: string): Promise<GeoResolved | null> {
  if (envFlag("IP_GEO_LOOKUP_DISABLED")) return null;
  try {
    const res = await safeFetch(
      buildLookupUrl(ip),
      {
        headers: {
          // ipwho.is and ip-api both honour Accept-Language for the
          // city field. Without the hint, ip-api falls back to the
          // English ASCII fold ("Nuremberg" instead of "Nürnberg").
          // German first because the user-base is DACH-skewed; English
          // as a graceful fallback for cities that don't have a German
          // name. Quality 0.5 on the en fallback keeps providers from
          // tie-breaking the wrong way.
          "Accept-Language": "de, en;q=0.5",
          Accept: "application/json",
        },
      },
      // v1.11.2 — the lookup URL comes from the operator IP_GEO_LOOKUP_URL env;
      // pin the connect-time DNS check so it can't be pointed at a private /
      // metadata address (SSRF/rebinding).
      // v1.15.12 E1 — keep the online timeout below the audit-log 3 s race
      // window so a slow-but-successful lookup still lands before the race
      // resolves null and drops the location (the "—" symptom on apps01).
      { timeoutMs: 2_500, requirePublicHost: true },
    );
    if (!res.ok) {
      // v1.18.11 (W3) — a non-ok response (403 free-plan/CORS rejection,
      // 429 rate-limit, 5xx) is not a clean "this IP has no location": it is
      // a provider-level failure that, left silent, renders as "—" with no
      // signal anywhere. Surface it on the wide event so the next provider
      // rejection is visible instead of swallowed (the ipwho.is 403 that
      // caused the prod "—" never produced a single log line). Still return
      // null so the offline fallback / negative-cache path runs unchanged.
      getEvent()?.addWarning(
        `geo: online lookup returned HTTP ${res.status} — location not resolved`,
      );
      return null;
    }

    const data = (await readUtf8Json(res)) as GeoResponse;
    const ok =
      data.success === true ||
      data.status === "success" ||
      (data.city && (data.country_code ?? data.countryCode));
    if (!ok) return null;

    const city = data.city;
    const country = data.country_code ?? data.countryCode;
    const location = city && country ? `${city}, ${country}` : null;
    const { asn, carrier } = parseOnlineCarrier(data);

    return { location, asn, carrier };
  } catch {
    return null;
  }
}

/**
 * Resolve location + carrier + AS number for an IP in a single pass.
 *
 * OFFLINE FIRST. The order below is the one the documentation has always
 * described and the code did not do: for two releases the online provider was
 * queried first and the local databases were the fallback, so an operator who
 * had mounted the MMDBs precisely so that no address would leave the host was
 * sending every login IP to a third party anyway. The MMDBs answer; the online
 * provider only sees an address the local databases could not place.
 *
 *   1. Offline ASN MMDB → carrier + AS number when configured (authoritative:
 *      it carries the canonical org name the short-label folder expects).
 *   2. Offline City MMDB → location. Present and resolving means the request
 *      ends here, with no egress at all.
 *   3. Online lookup → only on an offline miss (databases absent, unreadable,
 *      or holding no row for this address). Fills the location, and the
 *      carrier/ASN when the offline tier had none, so a host without the
 *      databases still surfaces an operator in the admin sign-in overview.
 *
 * `IP_GEO_LOOKUP_DISABLED=1` remains the full off-switch for step 3 — with it
 * set, an offline miss resolves to null rather than reaching the network.
 *
 * Never throws; the auth-audit caller is fire-and-forget. The resolved
 * record (including all-null misses) is cached per IP for a bounded TTL.
 */
export async function lookupIpGeo(ip: string | null): Promise<GeoResolved> {
  const empty: GeoResolved = { location: null, asn: null, carrier: null };
  if (!ip || PRIVATE_IP.test(ip)) return empty;

  const cached = getCachedGeo(ip);
  if (cached) return cached;

  // Offline ASN MMDB first, and unconditionally: it is a local file read, and
  // it is also what fires the one-shot "no offline resolver" admin alert when
  // neither an ASN reader nor the offline tier is present.
  let asn: number | null = null;
  let carrier: string | null = null;
  const offlineAsn = lookupIpAsn(ip);
  if (offlineAsn) {
    asn = offlineAsn.asn;
    carrier = offlineAsn.carrier;
  }

  let location = offlineGeoReady() ? lookupIpLocationOffline(ip) : null;

  // The address the local databases could not place is the only one that
  // travels. A host with the MMDBs mounted and a hit makes no request at all.
  if (!location) {
    const online = await lookupIpOnline(ip);
    if (online) {
      location = online.location;
      if (asn === null) asn = online.asn;
      if (!carrier) carrier = online.carrier;
    }
  }

  const resolved: GeoResolved = { location, asn, carrier };
  setCachedGeo(ip, resolved);
  return resolved;
}

/**
 * Legacy thin wrapper — returns just the `"City, CC"` string (or null).
 * Kept for the session list + login-alert call sites that only need the
 * location; both route through the unified `lookupIpGeo` cache.
 */
export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  return (await lookupIpGeo(ip)).location;
}

/**
 * Resolve the autonomous-system number + carrier organisation for an
 * IP. Offline-only against the bundled GeoLite2-ASN MMDB — the public
 * `ipwho.is` endpoint does not expose an ASN field in its free tier,
 * so a miss returns `null` rather than falling back to an online
 * lookup.
 *
 * Private / loopback IPs return `null` without touching the reader.
 * Same gate the location helper applies.
 */
export function lookupIpAsn(
  ip: string | null,
): { asn: number; carrier: string | null } | null {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  // First public-IP lookup of the process evaluates the offline-geo
  // configuration state: unconfigured-with-egress sends the admin notice
  // (once per state, anchored durably), configured-or-disabled releases
  // the anchor so a later re-entry notifies again. Runs on the healthy
  // path too — that is where the state-exit edge is observed.
  void evaluateOfflineGeoNotice();
  const reader = getAsnReader();
  if (!reader) {
    // No offline ASN data. The online tier can still fill the carrier
    // from its ISP field, but the ASN number and the authoritative
    // carrier come from the MMDB.
    return null;
  }
  try {
    const row = reader.get(ip);
    if (!row) return null;
    const asn = row.autonomous_system_number;
    if (typeof asn !== "number") return null;
    const carrier = row.autonomous_system_organization || null;
    return { asn, carrier };
  } catch {
    return null;
  }
}

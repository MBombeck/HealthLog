/**
 * IP geolocation lookup for audit-log enrichment.
 *
 * v1.4.27 B3: offline-first resolver. The hot path is now a microsecond-
 * scale local read against the bundled MaxMind GeoLite2-City MMDB at
 * `/opt/geolite2/GeoLite2-City.mmdb` (and the matching GeoLite2-ASN
 * database for carrier lookups). The previous `ipwho.is` HTTPS path is
 * kept as the second-tier fallback for IPs the offline DB cannot
 * resolve (freshly-allocated ranges that lag the monthly GeoLite2
 * release roll).
 *
 *   1. Private / loopback / opt-out → null (no lookup).
 *   2. Offline MMDB hit → return immediately.
 *   3. Offline miss → fall back to the existing `ipwho.is` path.
 *
 * The legacy contract still holds: `lookupIpLocation` returns a
 * `"City, CC"` string or `null`, never throws. `lookupIpAsn` is the
 * new sibling that resolves the autonomous-system number + the carrier
 * organisation string (so the admin login overview can render a
 * carrier chip next to the auth provider).
 *
 * Both helpers are safe to call from any request context. The MMDB
 * Reader is loaded lazily on first call and held in a module-level
 * cache; the file load is synchronous and not cheap, but it only
 * happens once per worker process.
 *
 * The base path is overridable via `GEOLITE2_DIR` (default
 * `/opt/geolite2`). When the DB files are missing the helpers silently
 * skip the offline tier — local dev without the MMDBs still works and
 * falls straight back to the online provider.
 *
 * Default provider for the online fallback is ipwho.is (HTTPS, free,
 * no key). Both the response shape from ipwho.is and the fallback
 * ip-api.com pro endpoint are accepted, so swapping providers via
 * `IP_GEO_LOOKUP_URL` only requires matching one of those response
 * shapes.
 *
 * Setting `IP_GEO_LOOKUP_DISABLED=1` disables the online fallback
 * entirely — used by deployments that do not want any IP egress to a
 * third-party service (V3 audit: GDPR Art. 32 + Art. 44, plaintext
 * HTTP IP egress). The offline tier still runs because no egress is
 * involved.
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
 * and the admin status surface, and the lookup paths fire a one-shot
 * admin notification on the first fallback so the maintainer hears
 * about the gap from the running app.
 */
import fs from "node:fs";
import path from "node:path";
import { Reader as MmdbReader } from "mmdb-lib";
import type {
  AsnResponse,
  CityResponse,
} from "mmdb-lib/lib/reader/response";
import { getEvent } from "@/lib/logging/context";

interface IpwhoIsResponse {
  success?: boolean;
  city?: string;
  country_code?: string;
}

interface IpApiProResponse {
  status?: "success" | "fail";
  city?: string;
  countryCode?: string;
}

type GeoResponse = IpwhoIsResponse & IpApiProResponse;

const PRIVATE_IP =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd|fe80|localhost|unknown)/;

const DEFAULT_GEO_URL = "https://ipwho.is";

function geoLiteDir(): string {
  return process.env.GEOLITE2_DIR ?? "/opt/geolite2";
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

function loadMmdbReader<T extends import("mmdb-lib/lib/reader/response").Response>(
  file: string,
): MmdbReader<T> | null {
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
 * Test-only — reset the lazy reader cache so a test can swap the
 * `GEOLITE2_DIR` between cases without leaking the previous Reader.
 * Not exported from the public surface; the tests import via the
 * module-level alias.
 */
export function __resetGeoLite2CacheForTests(): void {
  cache.city = undefined;
  cache.asn = undefined;
  notifiedThisProcess = false;
}

// ── Offline readiness + one-shot admin notification ─────────────────
//
// The CI workflow drops an `.empty` marker into the geo asset directory
// when the maintainer has not configured `MAXMIND_LICENSE_KEY`, in
// which case the City + ASN MMDBs are absent and every lookup hits the
// online fallback. `offlineGeoReady()` is the canonical truth used by
// `/api/version` and the admin status surface so the two paths cannot
// disagree.
//
// `notifiedThisProcess` is a module-level latch so the admin only
// receives the "offline geo is disabled" notification once per worker
// boot — every subsequent fallback hit is silent. Test-only reset is
// folded into the cache reset above.

let notifiedThisProcess = false;

export function offlineGeoReady(): boolean {
  try {
    const dir = geoLiteDir();
    if (fs.existsSync(path.join(dir, ".empty"))) return false;
    return fs.existsSync(path.join(dir, "GeoLite2-City.mmdb"));
  } catch {
    return false;
  }
}

async function notifyOfflineGeoUnavailable(): Promise<void> {
  if (notifiedThisProcess) return;
  notifiedThisProcess = true;
  // Defer the resolve so we don't pay the cost of pulling the
  // Prisma client into the import graph until the first fallback —
  // most calls are cache hits or private-IP short-circuits.
  try {
    const [{ prisma }, { dispatchLocalisedNotification }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/notifications/dispatch-localised"),
    ]);
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
    getEvent()?.addWarning(
      "geo: offline databases unavailable, falling back to ipwho.is — notifying admins",
    );
    for (const admin of admins) {
      await dispatchLocalisedNotification({
        userId: admin.id,
        titleKey: "notifications.admin.offlineGeoUnavailableTitle",
        messageKey: "notifications.admin.offlineGeoUnavailableBody",
        params: {
          secretsUrl:
            "https://github.com/MBombeck/HealthLog/settings/secrets/actions",
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
    city.names.de ??
    city.names.en ??
    city.names.fr ??
    city.names.es ??
    null
  );
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
  const base = (process.env.IP_GEO_LOOKUP_URL ?? DEFAULT_GEO_URL).replace(
    /\/+$/,
    "",
  );
  if (!base.startsWith("https://")) {
    // V3 audit: never leak audit-event IPs over plaintext HTTP. Reject any
    // configuration that would do so by upgrading to https; if the operator
    // has explicitly opted into HTTP via env, we still refuse and return a
    // dummy URL the parser will fail on.
    return `https://invalid.invalid/refused-non-https/${encodeURIComponent(ip)}`;
  }
  return `${base}/${encodeURIComponent(ip)}`;
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

async function lookupIpLocationOnline(ip: string): Promise<string | null> {
  if (process.env.IP_GEO_LOOKUP_DISABLED === "1") return null;
  try {
    const res = await fetch(buildLookupUrl(ip), {
      signal: AbortSignal.timeout(3000),
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
    });
    if (!res.ok) return null;

    const data = (await readUtf8Json(res)) as GeoResponse;
    const ok =
      data.success === true ||
      data.status === "success" ||
      (data.city && (data.country_code ?? data.countryCode));
    if (!ok) return null;

    const city = data.city;
    const country = data.country_code ?? data.countryCode;
    if (!city || !country) return null;

    return `${city}, ${country}`;
  } catch {
    return null;
  }
}

export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;

  const offline = lookupIpLocationOffline(ip);
  if (offline) return offline;

  // First public-IP lookup that has to leave the offline tier — if the
  // offline DBs are missing entirely, send the one-shot admin alert so
  // the maintainer can wire `MAXMIND_LICENSE_KEY` when convenient. The
  // notification is fire-and-forget so the audit-log path stays fast.
  if (!offlineGeoReady()) {
    void notifyOfflineGeoUnavailable();
  }

  return lookupIpLocationOnline(ip);
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
  const reader = getAsnReader();
  if (!reader) {
    // No offline ASN data — alert once per process. There is no online
    // fallback for ASN, but the maintainer still wants to know the
    // carrier chip is going to stay empty until the secret is set.
    if (!offlineGeoReady()) {
      void notifyOfflineGeoUnavailable();
    }
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

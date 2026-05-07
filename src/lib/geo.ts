/**
 * IP geolocation lookup for audit-log enrichment.
 *
 * Default provider is ipwho.is (HTTPS, free, no key). Both the response
 * shape from ipwho.is and the fallback ip-api.com pro endpoint are
 * accepted, so swapping providers via IP_GEO_LOOKUP_URL only requires
 * matching one of those response shapes.
 *
 * Setting IP_GEO_LOOKUP_DISABLED=1 disables lookup entirely — used by
 * deployments that do not want any IP egress to a third-party service
 * (V3 audit: GDPR Art. 32 + Art. 44, plaintext HTTP IP egress).
 */

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

export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  if (process.env.IP_GEO_LOOKUP_DISABLED === "1") return null;

  try {
    const res = await fetch(buildLookupUrl(ip), {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GeoResponse;
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

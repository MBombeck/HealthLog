/**
 * IP geolocation lookup using ip-api.com (free, no API key needed).
 * Returns "City, CC" string or null on failure.
 * Only used for audit log enrichment — fire-and-forget, non-blocking.
 */

interface IpApiResponse {
  status: "success" | "fail";
  city?: string;
  countryCode?: string;
}

const PRIVATE_IP =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd|fe80|localhost|unknown)/;

export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,countryCode`,
      { signal: AbortSignal.timeout(3000) },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as IpApiResponse;
    if (data.status !== "success" || !data.city || !data.countryCode)
      return null;

    return `${data.city}, ${data.countryCode}`;
  } catch {
    return null;
  }
}

/**
 * Operator configuration of the push relay, and the constants of the wire
 * this server speaks.
 *
 * - `PUSH_RELAY_MODE`: `allowed` (default) shows the admin switch, `off` hides
 *   the relay entirely, the one-time admin notice included.
 * - `PUSH_RELAY_URL`: the relay origin, `https://push.healthlog.dev` by
 *   default. Only `https` is accepted.
 * - `PUSH_RELAY_KEYS`: the relay identity public keys (Ed25519, base64url,
 *   comma separated) for a relay other than the hosted one. The hosted
 *   relay's keys ship pinned in `HOSTED_RELAY_KEYS`.
 *
 * A relay response is acted on only when it is signed by a pinned key, so a
 * relay without pinned keys is not usable at all: `relayConfig()` then says
 * `available: false` and nothing is sent.
 */
import { fromBase64Url } from "@/lib/push-relay/encoding";

export const HOSTED_RELAY_URL = "https://push.healthlog.dev";

/**
 * The identity keys (`current`, `next`) of the relay the HealthLog project
 * runs. Pinned per release; an operator of their own relay sets
 * `PUSH_RELAY_KEYS` instead.
 */
export const HOSTED_RELAY_KEYS: readonly string[] = Object.freeze([]);

/** The version of the consent text the app shows on its opt-in card. */
export const RELAY_CONSENT_TEXT_VERSION = "2026-12-01";
/** The version of the relay terms the operator accepts with the switch. */
export const RELAY_TERMS_VERSION = "2026-12-01";
/** The client name and version every signed request names. */
export const RELAY_CLIENT_NAME = "healthlog";

/** Envelope versions and Live Activity events this server can send. */
export const ENVELOPE_VERSIONS: readonly number[] = Object.freeze([1]);
export const LIVE_ACTIVITY_EVENTS: readonly string[] = Object.freeze(["end"]);

/** Request deadline for one relay call (`spec`: batch wait 8 s, plus margin). */
export const RELAY_REQUEST_TIMEOUT_MS = 10_000;

/** Devices one account may bind through the relay. */
export const RELAY_DEVICES_PER_ACCOUNT = 5;

export interface RelayConfig {
  /** `PUSH_RELAY_MODE` is not `off`. */
  allowed: boolean;
  /** Allowed, and the relay has pinned identity keys. */
  available: boolean;
  /** Why the relay cannot be used, when it cannot. */
  unavailableReason: "mode_off" | "invalid_url" | "keys_unpinned" | null;
  origin: string;
  /** Lowercase host without port: the `host` field of every statement. */
  host: string;
  /** Pinned relay identity public keys, raw. */
  identityKeys: Buffer[];
}

function parseKeys(raw: string | undefined): Buffer[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => fromBase64Url(k.trim(), 32))
    .filter((k): k is Buffer => k !== null);
}

/** The relay configuration from the environment. */
export function relayConfig(
  env: Partial<Record<string, string | undefined>> = process.env,
): RelayConfig {
  const allowed = (env.PUSH_RELAY_MODE ?? "allowed").trim() !== "off";
  const rawUrl = (env.PUSH_RELAY_URL ?? "").trim() || HOSTED_RELAY_URL;
  let origin = "";
  let host = "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:" && !url.username && !url.password) {
      origin = url.origin;
      host = url.hostname.toLowerCase().replace(/\.$/, "");
    }
  } catch {
    /* refused below */
  }
  const hosted = origin === HOSTED_RELAY_URL;
  const identityKeys = hosted
    ? [
        ...parseKeys(env.PUSH_RELAY_KEYS),
        ...parseKeys(HOSTED_RELAY_KEYS.join(",")),
      ]
    : parseKeys(env.PUSH_RELAY_KEYS);
  const unavailableReason = !allowed
    ? "mode_off"
    : !origin
      ? "invalid_url"
      : identityKeys.length === 0
        ? "keys_unpinned"
        : null;
  return {
    allowed,
    available: unavailableReason === null,
    unavailableReason,
    origin,
    host,
    identityKeys,
  };
}

/** The relay's terms and privacy notice, served by the relay itself. */
export function relayDocumentUrls(origin: string): {
  termsUrl: string;
  privacyUrl: string;
} {
  return { termsUrl: `${origin}/terms`, privacyUrl: `${origin}/privacy` };
}

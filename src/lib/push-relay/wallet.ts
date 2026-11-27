/**
 * The relay's two Wallet endpoints (`spec/wallet.md` in healthlog-push), as
 * this server calls them (v1.50).
 *
 * - `POST /v1/wallet/apple/sign`: `{ v: 1, manifest }`, the exact bytes of a
 *   pass's `manifest.json` (file names and SHA-1 hashes, nothing else), and
 *   back a detached CMS signature by the project's Pass Type ID.
 * - `POST /v1/wallet/apple/notify`: `{ items: [{ ref, token }] }`, empty
 *   pass update pushes to the devices that registered a pass.
 *
 * Both go through `relayCall`, the one door for signed instance requests,
 * so the response signature, the nonce binding, the clock offset and the
 * instance's suspension or revocation are handled as for every other call.
 * A Wallet failure never opens the push breaker and never pauses pushes:
 * only the push path and the status probe speak for those.
 *
 * Nothing here logs a manifest, a token or a signature; the wide event gets
 * the outcome only.
 */
import { annotate } from "@/lib/logging/context";
import { relayConfig } from "@/lib/push-relay/config";
import { fromBase64Url, toBase64Url } from "@/lib/push-relay/encoding";
import { loadRegistration, relayCall } from "@/lib/push-relay/registration";
import { relayUsable } from "@/lib/push-relay/relay-state";

export const WALLET_SIGN_PATH = "/v1/wallet/apple/sign";
export const WALLET_NOTIFY_PATH = "/v1/wallet/apple/notify";

/** The wait a caller is told when the relay named none. */
export const WALLET_RELAY_RETRY_S = 60;
/** At most this many pushes per notify request. */
export const WALLET_NOTIFY_MAX = 50;

export type RelayWalletSignResult =
  | {
      ok: true;
      /** The DER SignedData. */
      signature: Uint8Array;
      passTypeIdentifier: string;
      teamIdentifier: string;
      signerSubjectO: string;
      certNotAfterDay: number;
    }
  | {
      ok: false;
      /** Closed: why, for the wide event and the tests. */
      reason: string;
      retryAfter: number;
    };

async function usableRegistration(purpose: "wallet_sign" | "wallet_notify") {
  const config = relayConfig();
  if (!config.available) return null;
  const row = await loadRegistration(config);
  if (!row || !relayUsable(row, purpose)) return null;
  return { row, config };
}

function failure(reason: string, retryAfter: number | null) {
  annotate({ meta: { wallet_relay_sign: reason } });
  return {
    ok: false as const,
    reason,
    retryAfter: Math.max(1, retryAfter ?? WALLET_RELAY_RETRY_S),
  };
}

/** Ask the project's signing service to sign `manifest`. */
export async function signManifestViaRelay(
  manifest: Uint8Array,
): Promise<RelayWalletSignResult> {
  const registered = await usableRegistration("wallet_sign");
  if (!registered) return failure("relay_not_registered", null);
  const result = await relayCall(
    registered.row,
    "POST",
    WALLET_SIGN_PATH,
    { v: 1, manifest: toBase64Url(Buffer.from(manifest)) },
    registered.config,
  );
  if (result.kind === "transport") return failure(result.reason, null);
  if (result.status !== 200 || !result.body) {
    const error =
      typeof result.body?.error === "string" ? result.body.error : "refused";
    return failure(`relay_${error}`, result.retryAfter);
  }
  const body = result.body as {
    signature: string;
    passTypeIdentifier: string;
    teamIdentifier: string;
    signerSubjectO: string;
    certNotAfterDay: number;
  };
  const signature = fromBase64Url(body.signature);
  // A SignedData is one DER SEQUENCE; anything else is not a signature.
  if (!signature || signature.length < 16 || signature[0] !== 0x30) {
    return failure("relay_signature_shape", null);
  }
  annotate({ meta: { wallet_relay_sign: "ok" } });
  return {
    ok: true,
    signature: new Uint8Array(signature),
    passTypeIdentifier: body.passTypeIdentifier,
    teamIdentifier: body.teamIdentifier,
    signerSubjectO: body.signerSubjectO,
    certNotAfterDay: body.certNotAfterDay,
  };
}

export interface WalletNotifyItem {
  /** 1 to 64 of `A-Z a-z 0-9 _ -`, unique in the request. */
  ref: string;
  /** The pass push token, hex, 64 to 200 characters. */
  token: string;
}

export type WalletNotifyResult =
  "accepted" | "unregistered" | "rejected" | "token_quota" | "unavailable";

const RESULTS: ReadonlySet<string> = new Set([
  "accepted",
  "unregistered",
  "rejected",
  "token_quota",
  "unavailable",
]);
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^(?:[0-9a-fA-F]{2}){32,100}$/;

/**
 * Send one empty update push per item, at most 50. Every item gets a
 * result: what the relay answered for it, else `unavailable` (try later).
 * `unregistered` means the caller drops that registration.
 */
export async function notifyWalletPasses(
  items: readonly WalletNotifyItem[],
): Promise<Map<string, WalletNotifyResult>> {
  const out = new Map<string, WalletNotifyResult>();
  if (items.length === 0) return out;
  if (items.length > WALLET_NOTIFY_MAX) {
    throw new Error(`at most ${WALLET_NOTIFY_MAX} pass pushes per request`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!REF.test(item.ref) || seen.has(item.ref) || !TOKEN.test(item.token)) {
      throw new Error("a pass push needs a unique ref and a hex token");
    }
    seen.add(item.ref);
    out.set(item.ref, "unavailable");
  }
  const registered = await usableRegistration("wallet_notify");
  if (!registered) return out;
  const result = await relayCall(
    registered.row,
    "POST",
    WALLET_NOTIFY_PATH,
    { items: items.map((i) => ({ ref: i.ref, token: i.token })) },
    registered.config,
  );
  if (result.kind !== "response" || result.status !== 200) {
    annotate({ meta: { wallet_relay_notify: "unavailable" } });
    return out;
  }
  const results = (result.body?.results ?? []) as Array<{
    ref: string;
    result: string;
  }>;
  for (const r of results) {
    if (out.has(r.ref) && RESULTS.has(r.result)) {
      out.set(r.ref, r.result as WalletNotifyResult);
    }
  }
  annotate({ meta: { wallet_relay_notify: "ok" } });
  return out;
}

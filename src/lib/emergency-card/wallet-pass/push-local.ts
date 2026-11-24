/**
 * Pass update pushes with the operator's own Pass Type ID (v1.50), for a
 * server that signs its passes locally (`WALLET_APPLE_*`).
 *
 * Apple Wallet learns that a pass changed from an empty push to the device's
 * pass push token: topic the Pass Type ID, body `{}`, no `apns-push-type`,
 * the production gateway, authenticated by the Pass Type ID certificate
 * itself (not by the app's token key). `@parse/node-apn` speaks that wire
 * already, so nothing here opens a connection of its own.
 *
 * Every item gets a result in the relay's closed set, so the caller treats
 * both ways the same: `unregistered` drops the registration, `accepted`
 * stamps it, anything else leaves the push owed for the next run. No token,
 * certificate or key is ever logged.
 */
import { createHash, KeyObject } from "node:crypto";

import apn from "@parse/node-apn";

import { annotate } from "@/lib/logging/context";
import type {
  WalletNotifyItem,
  WalletNotifyResult,
} from "@/lib/push-relay/wallet";

import type { LocalWalletIdentity } from "./local-signer";

/** The longest a batch of pushes may take before it counts as unavailable. */
export const LOCAL_PASS_PUSH_TIMEOUT_MS = 10_000;

/** APNs reasons that mean the token will never take a push again. */
const GONE = new Set([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
]);

let provider: { fingerprint: string; provider: apn.Provider } | null = null;

function keyPem(key: KeyObject | string): string {
  return typeof key === "string"
    ? key
    : (key.export({ type: "pkcs8", format: "pem" }) as string);
}

/** One provider per certificate; a new certificate closes the old one. */
function providerFor(identity: LocalWalletIdentity): apn.Provider {
  const fingerprint = createHash("sha256")
    .update(identity.signer.certificatePem)
    .digest("hex");
  if (provider?.fingerprint === fingerprint) return provider.provider;
  if (provider) void provider.provider.shutdown();
  const made = new apn.Provider({
    cert: identity.signer.certificatePem,
    key: keyPem(identity.signer.privateKey),
    production: true,
  });
  provider = { fingerprint, provider: made };
  return made;
}

/** For tests: forget the cached provider. */
export function resetLocalPassPushForTesting(): void {
  if (provider) void provider.provider.shutdown();
  provider = null;
}

function classify(failure: apn.ResponseFailure): WalletNotifyResult {
  const reason = failure.response?.reason ?? "";
  const status = Number(failure.status ?? 0);
  if (status === 410 || GONE.has(reason)) return "unregistered";
  if (status === 429) return "token_quota";
  if (status === 400 || status === 403 || status === 413) return "rejected";
  return "unavailable";
}

function boundedSend<T>(operation: Promise<T>): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve("timeout"),
      LOCAL_PASS_PUSH_TIMEOUT_MS,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Send one empty update push per item. */
export async function sendLocalPassPushes(
  identity: LocalWalletIdentity,
  items: readonly WalletNotifyItem[],
): Promise<Map<string, WalletNotifyResult>> {
  const out = new Map<string, WalletNotifyResult>();
  for (const item of items) out.set(item.ref, "unavailable");
  if (items.length === 0) return out;

  let result: Awaited<ReturnType<apn.Provider["send"]>> | "timeout";
  try {
    const note = new apn.Notification();
    note.topic = identity.passTypeIdentifier;
    // Exactly `{}` on the wire, and no push type: what Wallet expects.
    note.rawPayload = {};
    result = await boundedSend(
      providerFor(identity).send(
        note,
        items.map((i) => i.token),
      ),
    );
  } catch {
    annotate({ meta: { wallet_local_push: "unavailable" } });
    return out;
  }
  if (result === "timeout") {
    annotate({ meta: { wallet_local_push: "timeout" } });
    return out;
  }

  const byToken = new Map(items.map((i) => [i.token, i.ref]));
  for (const sent of result.sent) {
    const ref = byToken.get(sent.device);
    if (ref) out.set(ref, "accepted");
  }
  for (const failed of result.failed) {
    const ref = byToken.get(failed.device);
    if (ref) out.set(ref, classify(failed));
  }
  annotate({ meta: { wallet_local_push: "ok" } });
  return out;
}

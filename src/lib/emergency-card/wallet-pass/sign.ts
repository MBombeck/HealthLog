/**
 * Who signs this server's Apple Wallet passes, and the one call that signs a
 * manifest (v1.50).
 *
 * - `local`: the operator set `WALLET_APPLE_*` and the set holds together
 *   (`local-signer.ts`); the signature is made here (`cms.ts`).
 * - `relay`: the default. The project's signing service signs blind over the
 *   push relay (`push-relay/wallet.ts`); it gets the manifest only, never a
 *   file of the pass.
 * - `invalid`: `WALLET_APPLE_*` is set but unusable. Nothing signs; Wallet
 *   is unavailable until the operator fixes it. No fallback to the relay.
 *
 * A pass is bound to the identity that made it (its Pass Type ID is inside
 * it and Wallet checks it against the signature), so a pass is only signed
 * by the same kind of signer, under the same identifiers, it was made with.
 * Anything else answers "unavailable", which the routes turn into a 503.
 */
import { signManifestViaRelay } from "@/lib/push-relay/wallet";

import { signManifestLocally } from "./cms";
import {
  localWalletConfig,
  type LocalSignerProblem,
  type LocalWalletIdentity,
} from "./local-signer";
import { checkWalletManifest } from "./manifest-rules";

export type WalletSigningMode =
  | { kind: "local"; identity: LocalWalletIdentity }
  | { kind: "relay" }
  | { kind: "invalid"; problem: LocalSignerProblem };

export function walletSigningMode(
  env: Partial<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): WalletSigningMode {
  const local = localWalletConfig(env, now);
  if (local.state === "ready")
    return { kind: "local", identity: local.identity };
  if (local.state === "invalid") {
    return { kind: "invalid", problem: local.problem };
  }
  return { kind: "relay" };
}

/** What a pass was made with, as stored on its row. */
export interface PassIdentity {
  signer: "RELAY" | "LOCAL";
  passTypeIdentifier: string;
  teamIdentifier: string;
}

export type WalletSignResult =
  | { ok: true; signature: Uint8Array }
  | { ok: false; reason: string; retryAfter: number };

/** The wait after a refusal that will not clear by itself soon. */
const IDENTITY_RETRY_S = 3600;

/**
 * Sign `manifest` for a pass made with `pass`. Throws only on a manifest the
 * signing service would refuse, which is a bug on this side, not an outage.
 */
export async function signWalletManifest(
  manifest: Uint8Array,
  pass: PassIdentity,
  mode: WalletSigningMode = walletSigningMode(),
): Promise<WalletSignResult> {
  const verdict = checkWalletManifest(manifest);
  if (verdict !== "ok") throw new Error(`wallet manifest refused: ${verdict}`);

  if (pass.signer === "LOCAL") {
    if (
      mode.kind !== "local" ||
      mode.identity.passTypeIdentifier !== pass.passTypeIdentifier ||
      mode.identity.teamIdentifier !== pass.teamIdentifier
    ) {
      return {
        ok: false,
        reason: "signer_changed",
        retryAfter: IDENTITY_RETRY_S,
      };
    }
    return {
      ok: true,
      signature: signManifestLocally(manifest, mode.identity.signer),
    };
  }

  if (mode.kind !== "relay") {
    return {
      ok: false,
      reason: "signer_changed",
      retryAfter: IDENTITY_RETRY_S,
    };
  }
  const signed = await signManifestViaRelay(manifest);
  if (!signed.ok) {
    return { ok: false, reason: signed.reason, retryAfter: signed.retryAfter };
  }
  // The project renewed or replaced its identity: a signature under another
  // Pass Type ID would not install over this pass.
  if (
    signed.passTypeIdentifier !== pass.passTypeIdentifier ||
    signed.teamIdentifier !== pass.teamIdentifier
  ) {
    return {
      ok: false,
      reason: "signer_changed",
      retryAfter: IDENTITY_RETRY_S,
    };
  }
  return { ok: true, signature: signed.signature };
}

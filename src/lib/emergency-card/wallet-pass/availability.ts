/**
 * `emergencyCard.wallet.apple`: whether this server can make an Apple Wallet
 * pass of the card on screen right now, and the pass it already has (v1.50).
 * One resolution for `/api/auth/me` and `GET /api/emergency-card/wallet/apple`,
 * so the web and the app render the same answer and never recompute it.
 *
 * Available = the operator's external-access switch is on, the instance is
 * reached over https, and a signer is ready: `WALLET_APPLE_*` holds
 * together, or the relay is on, its state is `ok` and its last status said
 * it signs passes for this instance. Read from stored state only; nothing
 * here calls the relay.
 */
import { isApiGloballyEnabled } from "@/lib/app-settings";
import {
  relayConfig,
  WALLET_RELAY_CONSENT_TEXT_VERSION,
} from "@/lib/push-relay/config";
import { loadRegistration } from "@/lib/push-relay/registration";
import { storedRelayStatus } from "@/lib/push-relay/relay-status";

import { WALLET_CREATE_PATH, WALLET_UNAVAILABLE_REASONS } from "./constants";
import { walletSigningMode } from "./sign";
import {
  latestWalletPass,
  toWalletPassSummary,
  type WalletPassSummary,
} from "./service";

export type WalletAvailabilityReason =
  "ok" | (typeof WALLET_UNAVAILABLE_REASONS)[number];

export interface EmergencyWalletApple {
  available: boolean;
  reason: WalletAvailabilityReason;
  signer: "relay" | "local" | null;
  passTypeIdentifier: string | null;
  canCreate: boolean;
  createPath: typeof WALLET_CREATE_PATH;
  consentTextVersion: string | null;
  pass: WalletPassSummary | null;
}

/** Who would sign a new pass, and under which identifiers. */
export interface WalletSignerReadiness {
  reason: "ok" | "signer_off" | "relay_not_ready";
  signer: "RELAY" | "LOCAL" | null;
  passTypeIdentifier: string | null;
  teamIdentifier: string | null;
}

export async function walletSignerReadiness(): Promise<WalletSignerReadiness> {
  const mode = walletSigningMode();
  if (mode.kind === "local") {
    return {
      reason: "ok",
      signer: "LOCAL",
      passTypeIdentifier: mode.identity.passTypeIdentifier,
      teamIdentifier: mode.identity.teamIdentifier,
    };
  }
  const none = {
    signer: null,
    passTypeIdentifier: null,
    teamIdentifier: null,
  };
  // A WALLET_APPLE_* set that does not hold together is no signer at all.
  if (mode.kind === "invalid") return { reason: "signer_off", ...none };
  const config = relayConfig();
  if (!config.available) return { reason: "signer_off", ...none };
  const row = await loadRegistration(config);
  const wallet = storedRelayStatus(row?.relayStatus ?? null)?.wallet ?? null;
  const ready =
    Boolean(row?.instanceId) && row?.state === "ok" && wallet?.sign === true;
  return {
    reason: ready ? "ok" : "relay_not_ready",
    signer: "RELAY",
    passTypeIdentifier: wallet?.passTypeIdentifier ?? null,
    teamIdentifier: wallet?.teamIdentifier ?? null,
  };
}

export function isHttpsOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export async function resolveEmergencyWalletApple(input: {
  /** The record on screen. */
  recordUserId: string;
  /** The caller may administer this record's card (owner or guardian). */
  allowed: boolean;
  /** The instance origin this request reached, or null when unknown. */
  origin: string | null;
  authMethod: "cookie" | "bearer";
  now?: Date;
}): Promise<EmergencyWalletApple> {
  const base = {
    createPath: WALLET_CREATE_PATH,
  } as const;
  if (!input.allowed) {
    return {
      ...base,
      available: false,
      reason: "not_allowed",
      signer: null,
      passTypeIdentifier: null,
      canCreate: false,
      consentTextVersion: null,
      pass: null,
    };
  }
  const [apiOn, readiness, row] = await Promise.all([
    isApiGloballyEnabled(),
    walletSignerReadiness(),
    latestWalletPass(input.recordUserId),
  ]);
  const reason: WalletAvailabilityReason = !apiOn
    ? "api_disabled"
    : readiness.reason !== "ok"
      ? readiness.reason
      : !isHttpsOrigin(input.origin)
        ? "no_https_origin"
        : "ok";
  const available = reason === "ok";
  return {
    ...base,
    available,
    reason,
    signer:
      readiness.signer === "RELAY"
        ? "relay"
        : readiness.signer === "LOCAL"
          ? "local"
          : null,
    passTypeIdentifier: readiness.passTypeIdentifier,
    canCreate: available && input.authMethod === "cookie",
    consentTextVersion:
      readiness.signer === "RELAY" ? WALLET_RELAY_CONSENT_TEXT_VERSION : null,
    pass: row ? toWalletPassSummary(row, input.now) : null,
  };
}

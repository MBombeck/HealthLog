/**
 * `emergencyCard.wallet.apple`: whether this server can make an Apple Wallet
 * pass of the card on screen right now, and the pass it already has (v1.50).
 * One resolution for `/api/auth/me` and `GET /api/emergency-card/wallet/apple`,
 * so the web and the app render the same answer and never recompute it.
 *
 * Available = the operator's external-access switch is on, the instance is
 * reached over https, and a signer is ready: `WALLET_APPLE_*` holds
 * together, or the relay is usable for signing (`relayUsable(row,
 * "wallet_sign")`, the rule the signer itself reads: registered, not ended or
 * suspended, and its last status said it signs passes for this instance).
 * A push pause or an open breaker does not hold Wallet. Read from stored
 * state only; nothing here calls the relay.
 *
 * `state` is the same answer, split for rendering: `relay_off` is the case a
 * server without its own `WALLET_APPLE_*` is in until the relay is switched
 * on, and `relayAction` says what the caller can do about it (an admin
 * switches it on in place, anybody else asks the admin). A server that signs
 * with its own certificate never reads `relay_off`.
 */
import { isApiGloballyEnabled } from "@/lib/app-settings";
import {
  relayConfig,
  WALLET_RELAY_CONSENT_TEXT_VERSION,
} from "@/lib/push-relay/config";
import { loadRegistration } from "@/lib/push-relay/registration";
import { relayRefusal } from "@/lib/push-relay/relay-state";
import { storedRelayStatus } from "@/lib/push-relay/relay-status";

import {
  WALLET_CREATE_PATH,
  type WALLET_STATES,
  WALLET_UNAVAILABLE_REASONS,
} from "./constants";
import { walletSigningMode } from "./sign";
import {
  latestWalletPass,
  toWalletPassSummary,
  type WalletPassRow,
  type WalletPassSummary,
} from "./service";

export type WalletAvailabilityReason =
  "ok" | (typeof WALLET_UNAVAILABLE_REASONS)[number];

export type WalletState = (typeof WALLET_STATES)[number];

export interface EmergencyWalletApple {
  available: boolean;
  reason: WalletAvailabilityReason;
  state: WalletState;
  /** Only with `relay_off`: the caller switches the relay on, or asks. */
  relayAction: "enable" | "ask_admin" | null;
  /** The caller said no to the relay prompt (`relay-hint`). */
  relayHintDismissed: boolean;
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
  /** The relay would sign but this server is not registered there. */
  relayOff: boolean;
  signer: "RELAY" | "LOCAL" | null;
  passTypeIdentifier: string | null;
  teamIdentifier: string | null;
}

export async function walletSignerReadiness(): Promise<WalletSignerReadiness> {
  const mode = walletSigningMode();
  if (mode.kind === "local") {
    return {
      reason: "ok",
      relayOff: false,
      signer: "LOCAL",
      passTypeIdentifier: mode.identity.passTypeIdentifier,
      teamIdentifier: mode.identity.teamIdentifier,
    };
  }
  const none = {
    relayOff: false,
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
  const refusal = relayRefusal(row, "wallet_sign");
  return {
    reason: refusal === null ? "ok" : "relay_not_ready",
    relayOff: refusal === "not_registered",
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

/**
 * Why a new pass cannot be made at `origin`, or null when it can: the
 * signer's readiness first, then the https origin. The status below and the
 * creating POST both read it.
 */
export function walletUnavailableReason(
  readiness: Pick<WalletSignerReadiness, "reason">,
  origin: string | null,
): "signer_off" | "relay_not_ready" | "no_https_origin" | null {
  if (readiness.reason !== "ok") return readiness.reason;
  return isHttpsOrigin(origin) ? null : "no_https_origin";
}

/**
 * The one resolution of the record's Wallet state. The ready push reads it
 * too (`ready-push.ts`), handing in the pass it already read, so what the app
 * shows and when it is told "ready" never part.
 */
export async function resolveEmergencyWalletApple(input: {
  /** The record on screen. */
  recordUserId: string;
  /** The caller may administer this record's card (owner or guardian). */
  allowed: boolean;
  /** The instance origin this request reached, or null when unknown. */
  origin: string | null;
  authMethod: "cookie" | "bearer";
  /** The caller (not the record) is an admin of this server. */
  callerIsAdmin: boolean;
  /** The caller dismissed the relay prompt. */
  relayHintDismissed: boolean;
  /** The record's newest pass, when the caller read it already. */
  pass?: WalletPassRow | null;
  now?: Date;
}): Promise<EmergencyWalletApple> {
  const base = {
    createPath: WALLET_CREATE_PATH,
    relayHintDismissed: input.relayHintDismissed,
  } as const;
  if (!input.allowed) {
    return {
      ...base,
      available: false,
      reason: "not_allowed",
      state: "not_allowed",
      relayAction: null,
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
    input.pass !== undefined
      ? input.pass
      : latestWalletPass(input.recordUserId),
  ]);
  const reason: WalletAvailabilityReason = !apiOn
    ? "api_disabled"
    : (walletUnavailableReason(readiness, input.origin) ?? "ok");
  const available = reason === "ok";
  const state: WalletState =
    reason === "ok"
      ? "available"
      : reason === "signer_off"
        ? "not_configured"
        : reason === "relay_not_ready" && readiness.relayOff
          ? "relay_off"
          : reason;
  return {
    ...base,
    available,
    reason,
    state,
    relayAction:
      state === "relay_off"
        ? input.callerIsAdmin
          ? "enable"
          : "ask_admin"
        : null,
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

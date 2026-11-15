/**
 * What a failed briefing generation knows about its provider chain beyond
 * the reason (#1384): which configured provider failed first, whether that
 * provider refused the credential, and whether anything was sent at all.
 *
 * The nightly pass needs all three to settle an account honestly. A refusal
 * of the account's own credential is the account's matter, a refusal of the
 * operator's shared key is the operator's, and a chain whose every entry the
 * provider health ledger benched for background work (#1279) sent no request,
 * so the account was not attempted. Without them every such account read as
 * a failure, night after night.
 */
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";

export interface ChainFailureFacts {
  /**
   * The chain's first provider refused the credential (a dead Codex
   * sign-in, a revoked key). No retry can succeed until someone reconnects
   * or replaces it.
   */
  credentialExpired?: boolean;
  /** The chain entry that failed first, e.g. `openai-compatible`. */
  provider?: string;
  /** Every entry was benched for background work; no request left. */
  sentNothing?: boolean;
}

/** The facts of a thrown chain failure; empty for any other error. */
export function chainFailureFacts(error: unknown): ChainFailureFacts {
  if (!(error instanceof AllProvidersFailedError)) return {};
  const provider = error.attempts?.[0]?.providerType;
  return {
    ...(error.primaryCredentialExpired ? { credentialExpired: true } : {}),
    ...(provider ? { provider } : {}),
    ...(error.sentNothing ? { sentNothing: true } : {}),
  };
}

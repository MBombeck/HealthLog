"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";
import type {
  AiCapabilityKey,
  AiCapabilityState,
  AiProviderState,
} from "@/lib/ai/capabilities/types";
import { PROVIDER_DEFAULT_TIMEOUT_MS } from "@/lib/ai/effective-timeout";
import type { CoachReasoningState } from "@/lib/ai/reasoning/resolve";

/**
 * The web reader for the `ai` block on `GET /api/auth/me`.
 *
 * The server resolves every AI capability for the record this browser is
 * inside, from every layer that can say no, and publishes the answer with the
 * reason. This hook hands that answer to a surface and adds exactly one rule
 * of its own: until the answer is known, a capability is unavailable. While
 * `/me` is loading, when no query client is mounted (an isolated
 * presentational render), or when the payload carries no well-formed block,
 * the hook answers `check_failed`, so no AI surface paints and no model
 * request fires on first render only to be refused. Failing open was how AI
 * chrome used to flash and fire refusals before the switch set arrived.
 *
 * Never recompute a capability here or in a component; branch on
 * `available`, and on `reason` only to say why.
 */
const UNKNOWN: AiCapabilityState = Object.freeze({
  available: false,
  reason: "check_failed",
  onDeviceAllowed: false,
});

const NO_PROVIDER_STATE: AiProviderState = Object.freeze({
  configured: false,
  managedBy: null,
  canConfigure: false,
  responseTimeoutMs: PROVIDER_DEFAULT_TIMEOUT_MS,
});

/** One capability, for the record this browser is inside. */
export function useAiCapability(key: AiCapabilityKey): AiCapabilityState {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return UNKNOWN;
  // The branch is stable for the component's lifetime (a provider is either
  // mounted around it or not), so the conditional hook call is safe.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiCapabilityInner(key);
}

function useAiCapabilityInner(key: AiCapabilityKey): AiCapabilityState {
  const { user } = useAuth();
  return user?.ai?.capabilities?.[key] ?? UNKNOWN;
}

/** The account's provider state: configured, managed by whom, configurable here. */
export function useAiProviderState(): AiProviderState {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return NO_PROVIDER_STATE;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiProviderStateInner();
}

function useAiProviderStateInner(): AiProviderState {
  const { user } = useAuth();
  return user?.ai?.provider ?? NO_PROVIDER_STATE;
}

/**
 * v1.41 — the Coach's thinking depth, resolved on the server (`coachReasoning`
 * on `GET /api/auth/me`), or `null` while it is not known: `/me` loading, no
 * query client, or a server that does not publish it. Render the settings
 * from it; never recompute the cap or the switch.
 */
export function useCoachReasoning(): CoachReasoningState | null {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useCoachReasoningInner();
}

function useCoachReasoningInner(): CoachReasoningState | null {
  const { user } = useAuth();
  return user?.coachReasoning ?? null;
}

/**
 * The server's answer for one capability, or `null` while there is none yet
 * (`/me` loading, no signed-in account, no query client). For the few places
 * that act on an unavailable capability rather than just hiding: a Coach page
 * that sends its visitor elsewhere must not do so on the loading frame, when
 * `useAiCapability` already reads unavailable.
 */
export function useAiCapabilityAnswer(
  key: AiCapabilityKey,
): AiCapabilityState | null {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiCapabilityAnswerInner(key);
}

function useAiCapabilityAnswerInner(
  key: AiCapabilityKey,
): AiCapabilityState | null {
  const { user, isLoading } = useAuth();
  if (isLoading || !user) return null;
  return user.ai?.capabilities?.[key] ?? UNKNOWN;
}

/**
 * Every capability at once, or `null` until `/me` has answered. For the one
 * surface that explains the whole set (the operator notice in Settings → AI);
 * a surface that shows or hides one feature reads `useAiCapability`.
 */
export function useAiCapabilityMap(): Partial<
  Record<AiCapabilityKey, AiCapabilityState>
> | null {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiCapabilityMapInner();
}

function useAiCapabilityMapInner(): Partial<
  Record<AiCapabilityKey, AiCapabilityState>
> | null {
  const { user } = useAuth();
  return user?.ai?.capabilities ?? null;
}

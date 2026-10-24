/**
 * The Coach's error-code → i18n-key resolver, split out of `chat-bubble.tsx`
 * (file-size split, code motion). The bubble renders the key; an unknown code
 * falls back to the generic provider copy there.
 */
import { DEMO_READ_ONLY_CODE } from "@/lib/demo-refusal";

/**
 * Map server-emitted error codes to specific Coach i18n
 * keys. The chat route distinguishes the daily user-quota
 * (`coach.budget.exceeded`, returned as a JSON 429) from the provider
 * rate-limit (`coach.provider.rate_limited`, streamed as an SSE error
 * frame). Both used to surface as the generic provider-unavailable
 * copy; we now route each to its dedicated translation so the user
 * understands whether the limit is on their side (reset at UTC
 * midnight) or transient on the provider side (retry in ~5 min).
 *
 * Exported so the resolver can be pinned by unit tests without
 * standing up the whole thread renderer.
 */
export function errorCodeToI18nKey(code: string): string {
  switch (code) {
    case "coach.budget.exceeded":
      return "insights.coach.dailyLimitBody";
    case "coach.provider.rate_limited":
      return "insights.coach.providerRateLimitBody";
    case "coach.network":
      // A dropped network is the user's local
      // problem and needs a different next action ("come back online")
      // than a provider failure ("try again in a moment"). Split out
      // so the user sees the actionable copy in the offline branch.
      return "insights.coach.errorNetwork";
    case "coach.provider.credential_expired":
      // The user's primary AI provider credential is dead
      // (auth-class failure). The next action is "reconnect", not "try
      // again later", so it carries its own copy pointing at Settings.
      return "insights.coach.errorCredentialExpired";
    case "coach.provider.none":
      // No AI provider is configured anywhere, so "try again
      // in a moment" is the wrong instruction (it will 422 forever). Send
      // the user to guided setup with a one-line explainer + a Settings
      // link rendered alongside the bubble copy.
      return "insights.coach.errorNoProvider";
    case "coach.provider.reasoning_only":
      // #1276 — the model was reached and answered with its reasoning
      // only, even after being asked once more. "Try again in a moment"
      // would be the wrong advice; the copy names what happened.
      return "insights.coach.errorReasoningOnly";
    case "coach.provider.unavailable":
    case "coach.provider.empty":
    case "coach.stream":
      return "insights.coach.errorProvider";
    // The capability refusals (`meta.errorCode` on a 403/422/503
    // before the stream opens). Each says what is off and who can change it.
    case "consent.ai.required":
      return "insights.coach.errorConsent";
    case "ai.record.notPermitted":
      return "insights.coach.errorNotPermitted";
    case "ai.unavailable":
      return "insights.coach.errorUnavailable";
    case "ai.provider.none":
      return "insights.coach.errorNoProvider";
    case "module.disabled":
      return "insights.coach.errorCoachOff";
    // A demo deploy refuses every write, the chat POST included. That is
    // the demo's nature, not an outage, and the line says so.
    case DEMO_READ_ONLY_CODE:
      return "insights.coach.errorDemo";
    default:
      // The operator switched the Coach (or all AI) off on this server.
      if (code.startsWith("assistant.disabled.")) {
        return "insights.coach.errorOperatorOff";
      }
      // Forward-compat: try `insights.coach.<code>` for codes that
      // ship their own translation (e.g. legacy `errorProvider`).
      return `insights.coach.${code}`;
  }
}

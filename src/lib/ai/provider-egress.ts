/**
 * Which AI provider tags send a record off the machine, and through whose
 * credential. One definition, read by the consent gate
 * (`src/lib/ai/consent-guard.ts`) and the capability resolver
 * (`src/lib/ai/capabilities/resolve.ts`). They each kept their own copy
 * before, and a provider added to one list but not the other would have been
 * consented for in one place and not the other.
 */

/**
 * Provider tags that egress through a credential the operator holds, which
 * the user did not personally contract: the operator's global OpenAI key
 * (`admin-openai`) and the operator's shared Codex / ChatGPT-subscription
 * account (`admin-codex`). Both need an active consent receipt before any
 * health data leaves for them.
 */
export const OPERATOR_HELD_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "admin-openai",
  "admin-codex",
]);

/** The one provider tag that keeps its input on the operator's machine. */
export const LOCAL_PROVIDER_TYPE = "local";

export function isOperatorHeldProvider(providerType: string): boolean {
  return OPERATOR_HELD_PROVIDER_TYPES.has(providerType);
}

/**
 * True when this provider sends its input OFF the machine to a third-party AI
 * service. Only the self-hosted `local` provider keeps it on the operator's
 * own infrastructure.
 */
export function isExternalProvider(providerType: string): boolean {
  return providerType !== LOCAL_PROVIDER_TYPE;
}

/** Where the credential behind one chain entry comes from. */
export function providerOrigin(
  providerType: string,
): "user" | "local" | "server" {
  if (providerType === "local") return "local";
  if (providerType === "admin-openai" || providerType === "admin-codex") {
    return "server";
  }
  return "user";
}

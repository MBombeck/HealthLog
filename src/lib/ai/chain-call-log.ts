/**
 * #1404 — one log line per AI call, naming the chain and the provider that
 * served it, or the reason it did not.
 *
 * The chain runner already annotated the working provider on the request's
 * own line, but most callers never go through the runner: a document read, a
 * summary, a lab scan or a label read picks one entry of the chain and calls
 * it directly. Their calls left no trace at all, so "which chain served this,
 * and did the binding hold" was answerable only from the gateway's own log.
 *
 * The line is attached where every entry is built (`resolveProviderChain`),
 * so it covers every caller, whichever way it calls:
 *
 *   ai.chain.served  info  { chain, capability, provider }
 *   ai.chain.failed  warn  { chain, capability, provider, failure, code }
 *
 * `chain` is `main`, `default:<id>`, `pinned:<id>` or `guardian:<id>` (a
 * managed profile served by its guardian's chain, `guardian:default` for the
 * guardian's default chain, #1403): the id of the named
 * chain (chosen by the client, never its name, which is free text), with
 * `pinned` meaning the capability is attached to it and nothing else is
 * tried. `capability` is null for the default chain read without one.
 * `failure` is the closed vocabulary of `failure-kind.ts`, `code` a
 * code-shaped string or null; no message, prompt or reply reaches the line.
 *
 * The same two outcomes are noted on the witness of the background job the
 * call runs inside, when there is one (`job-failure/witness.ts`).
 */
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";
import { providerFailureKind } from "@/lib/ai/failure-kind";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import type { ChainSelection } from "@/lib/ai/named-chains";
import type { AIProvider, CompletionParams } from "@/lib/ai/types";
import { noteAiJobEvent } from "@/lib/ai/job-failure/witness";
import { annotate } from "@/lib/logging/context";
import { emitOutcome, emitSignal } from "@/lib/logging/signal";

export interface ChainLabel {
  /** `main`, `default:<id>` or `pinned:<id>`. */
  chain: string;
  capability: AiCapabilityKey | null;
}

/** The label of the chain a selection resolved to. */
export function chainLabelFor(
  selection: ChainSelection,
  capability: AiCapabilityKey | null,
): ChainLabel {
  return {
    chain:
      selection.kind === "main"
        ? "main"
        : `${selection.kind}:${selection.chainId}`,
    capability,
  };
}

const LOGGED = Symbol("ai.chain.logged");

/**
 * Wrap the provider's completion calls so each one writes its line. Mutates
 * and returns the instance (like `bindResponseTimeout`); a wrapper keeps the
 * enumerability of what it replaces (a class method is not an own key, so it
 * stays out of `Object.keys`), so the instance still compares and serialises
 * as before. A second call on the same instance does nothing.
 */
export function logChainCalls<P extends AIProvider>(
  provider: P,
  providerType: ProviderChainType,
  label: ChainLabel,
): P {
  const target = provider as P & { [LOGGED]?: true };
  if (target[LOGGED]) return provider;
  Object.defineProperty(target, LOGGED, { value: true });

  const meta = {
    chain: label.chain,
    capability: label.capability,
    provider: providerType,
  };
  const served = () => {
    noteAiJobEvent({
      type: "served",
      capability: label.capability,
      providerType,
    });
    emitOutcome({ action: "ai.chain.served", meta });
    annotate({
      meta: { ai_chain: label.chain, ai_chain_capability: label.capability },
    });
  };
  const failed = (error: unknown) => {
    const { failure, code } = providerFailureKind(error);
    // A cancelled call is the caller walking away, not the provider failing.
    if (failure === "aborted") return;
    // #1404 — and to the background job it ran inside, so the job's reporter
    // can name it (`job-failure/report.ts`).
    const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
    noteAiJobEvent({
      type: "failed",
      capability: label.capability,
      providerType,
      failure,
      httpStatus: typeof status === "number" ? status : null,
    });
    emitSignal({
      action: "ai.chain.failed",
      level: "warn",
      meta: { ...meta, failure, code },
    });
  };

  const enumerable = (name: string) =>
    Object.getOwnPropertyDescriptor(target, name)?.enumerable ?? false;

  const complete = provider.generateCompletion.bind(provider);
  Object.defineProperty(target, "generateCompletion", {
    configurable: true,
    writable: true,
    enumerable: enumerable("generateCompletion"),
    value: async (params: CompletionParams) => {
      try {
        const result = await complete(params);
        served();
        return result;
      } catch (error) {
        failed(error);
        throw error;
      }
    },
  });

  if (provider.generateCompletionStream) {
    const stream = provider.generateCompletionStream.bind(provider);
    Object.defineProperty(target, "generateCompletionStream", {
      configurable: true,
      writable: true,
      enumerable: enumerable("generateCompletionStream"),
      value: async (
        params: CompletionParams,
        onDelta: (delta: string) => void,
      ) => {
        try {
          const result = await stream(params, onDelta);
          served();
          return result;
        } catch (error) {
          failed(error);
          throw error;
        }
      },
    });
  }
  return provider;
}

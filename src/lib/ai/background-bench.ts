/**
 * #1279 — background work and a provider the health ledger has benched.
 *
 * An interactive walk keeps a benched provider at the tail of the chain, so a
 * person never loses their only provider to a cooldown. Background work has
 * nobody waiting and no reason to call a provider that just failed several
 * times in a row: a chain whose only entry answered every call with reasoning
 * and no answer was called by every background job, all day, because the tail
 * is still walked. So a job leaves every benched provider out until its
 * window lifts (a job-rationed call a person waits on, the on-demand
 * briefing, passes `interactive` and walks it at the tail like any
 * interactive call), and the window grows while the failures continue
 * (`hardFailureCooldownMs` in `provider-health-ledger.ts`). The ledger is
 * durable, so the bench holds across workers and restarts.
 *
 * The local floor is left out only once it is paused, past a brief backoff:
 * it costs no money, but a model that never answers still occupies the
 * machine it runs on.
 */
import { emitSignal } from "@/lib/logging/signal";
import type { ProviderChainType } from "./provider-chain";
import type { ProviderSkipHint } from "./provider-health-ledger";

export interface BenchedProvider<C> {
  candidate: C;
  hint: ProviderSkipHint;
}

/**
 * Split a chain into what background work walks and what it leaves out.
 * `isFloor` names the providers that are never benched for a person (the
 * local model).
 */
export function partitionForBackgroundWork<
  C extends { providerType: ProviderChainType },
>(
  providers: readonly C[],
  skips: ReadonlyMap<ProviderChainType, ProviderSkipHint>,
  isFloor: (type: ProviderChainType) => boolean,
): { walkable: C[]; benched: Array<BenchedProvider<C>> } {
  const walkable: C[] = [];
  const benched: Array<BenchedProvider<C>> = [];
  for (const candidate of providers) {
    const hint = skips.get(candidate.providerType);
    const leftOut =
      hint !== undefined &&
      (!isFloor(candidate.providerType) || hint.reason === "paused");
    if (leftOut) benched.push({ candidate, hint });
    else walkable.push(candidate);
  }
  return { walkable, benched };
}

/**
 * One `ai.chain.background_paused` line per bench window, per process: the
 * first background job that finds the provider benched says so, the rest
 * mark it on their own event only. Keyed by user and provider, holding the
 * window's end, so a new window logs once more.
 */
const LOGGED_SLOT = Symbol.for("healthlog.ai.backgroundBenchLogged");
const logged: Map<string, number> = ((globalThis as Record<symbol, unknown>)[
  LOGGED_SLOT
] ??= new Map()) as Map<string, number>;

export function signalBackgroundBench(
  userId: string,
  providerType: ProviderChainType,
  hint: ProviderSkipHint,
): void {
  const key = `${userId}\u0000${providerType}`;
  const until = hint.retryAt?.getTime() ?? 0;
  if (logged.get(key) === until) return;
  logged.set(key, until);
  emitSignal({
    action: "ai.chain.background_paused",
    level: "warn",
    meta: {
      provider: providerType,
      reason: hint.reason,
      retry_in_minutes:
        until > 0
          ? Math.max(0, Math.ceil((until - Date.now()) / 60_000))
          : null,
    },
  });
}

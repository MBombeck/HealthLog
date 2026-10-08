import { safeFetch } from "@/lib/safe-fetch";
import { aiEgressPolicyFor } from "./local-host-allowlist";

/**
 * Does an OpenAI-compatible endpoint still offer the configured model?
 *
 * The operator's provider pointed at an OAuth proxy that installs
 * `openai-oauth@latest` on every restart. One restart later the proxy listed
 * only newer model names, the configured one was gone, and every call
 * answered HTTP 500 with a body that named nothing. From the outside that
 * reads as "the provider is down", and the fix (pick a model the endpoint
 * offers) is invisible.
 *
 * `GET {baseUrl}/models` answers the question for free: it is the standard
 * listing every OpenAI-compatible server implements, it bills nothing, and
 * it needs the same bearer as a completion. The answer is cached for a few
 * minutes per endpoint and model, so a burst of failures probes once.
 *
 * Tri-state on purpose. `unknown` (no listing route, a non-JSON answer, the
 * probe itself failing) never claims the model is missing: only an endpoint
 * that answered with a list that does not contain the name earns
 * `not_listed`.
 */
export type ModelListing = "listed" | "not_listed" | "unknown";

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; value: ModelListing }>();

/** Test-only: forget every cached answer. */
export function clearModelListingCache(): void {
  cache.clear();
}

export async function probeModelListing(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** See `OpenAIClient`'s `operatorTrusted`. */
  operatorTrusted?: boolean;
  now?: number;
}): Promise<ModelListing> {
  const now = input.now ?? Date.now();
  const key = `${input.baseUrl}\u0000${input.model}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await probeOnce(input);
  cache.set(key, { at: now, value });
  return value;
}

async function probeOnce(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  operatorTrusted?: boolean;
}): Promise<ModelListing> {
  const url = `${input.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = input.apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await safeFetch(
      url,
      { method: "GET", headers },
      {
        timeoutMs: PROBE_TIMEOUT_MS,
        ...aiEgressPolicyFor(url, { operatorTrusted: input.operatorTrusted }),
      },
    );
    if (!res.ok) return "unknown";
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
    } | null;
    if (!json || !Array.isArray(json.data)) return "unknown";
    const ids = json.data
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { id?: unknown }).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return "unknown";
    return ids.includes(input.model) ? "listed" : "not_listed";
  } catch {
    // The probe is a diagnosis, never a gate: a failed probe says nothing.
    return "unknown";
  }
}

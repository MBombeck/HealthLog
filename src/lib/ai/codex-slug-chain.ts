/**
 * The Codex slug ladder: which ChatGPT-auth model slugs the client tries, in
 * order, and the slug the vision gate reasons about before a request runs.
 * The walk itself (which statuses move to the next rung, the positive cache)
 * lives in `codex-client.ts` and `codex-slug-cache.ts`; docs/codex-protocol-spec.md
 * §7b describes the whole defence.
 */
import { getCachedCodexSlug } from "./codex-slug-cache";

/**
 * Default fallback chain. Override via `CODEX_MODEL_FALLBACK_CHAIN`
 * (comma-separated); `CODEX_MODEL` is folded into position 0 when set,
 * duplicates dropped. The backend rotates its ChatGPT-auth slugs without
 * notice: by 2026-10-24 it rejected everything from `gpt-5.5` down.
 *
 * `gpt-5.6-terra` stays first because it is the slug verified against the
 * backend. The upstream catalog (`codex-rs/models-manager/models.json`)
 * names `gpt-6-sol` as its upgrade, and the last rotation retired a whole
 * line at once, so the gpt-6 rungs come next rather than terra's siblings:
 * `gpt-6-sol` (terra's named successor), `gpt-6.1-sol` (the catalog's
 * default, also offered on plans `gpt-6-sol` is not), `gpt-6-luna` (the
 * lighter one). `gpt-6-astra`, the frontier tier, is left out: it spends a
 * plan's allowance fastest for no gain on these prompts.
 */
export const DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.6-terra", // verified against the backend 2026-10-24
  "gpt-6-sol", // terra's upgrade in the upstream catalog
  "gpt-6.1-sol", // the catalog default, on every plan
  "gpt-6-luna", // lighter gpt-6 sibling
  "gpt-5.6-luna", // lighter sibling on terra's line
  "gpt-5.6-sol", // heavier sibling on terra's line
  "gpt-5.5", // previous default, kept as the last rung while plans differ
] as const;

/**
 * The slug the codex vision gate reasons about *before* a request runs: the
 * cached working slug if one is live, else the first chain entry. Lets the
 * Lab-OCR capability resolver decide whether codex can read images without
 * standing up a client or making a network call. Best-effort — the actual
 * routed slug may differ once the chain walk runs, which the runtime probe +
 * graceful fallback (text/local OCR) covers.
 */
export function resolveCodexVisionSlug(): string | null {
  const cached = getCachedCodexSlug();
  if (cached) return cached;
  return loadFallbackChain()[0] ?? null;
}

/** The chain a client walks: the env override or the default, `CODEX_MODEL` first. */
export function loadFallbackChain(): string[] {
  const envChain = process.env.CODEX_MODEL_FALLBACK_CHAIN?.trim();
  const fromEnv = envChain
    ? envChain
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_SLUG_FALLBACK_CHAIN];
  const pinned = process.env.CODEX_MODEL?.trim();
  const merged = pinned ? [pinned, ...fromEnv] : fromEnv;
  // Stable de-duplication.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of merged) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    result.push(slug);
  }
  return result;
}
